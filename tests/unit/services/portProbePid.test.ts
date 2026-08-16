/**
 * `resolvePortPid` output parsing and probe fallback (#10431).
 *
 * The regression these guard is that `resolvePortPid` used to shell out to
 * `lsof` alone. On a host without it, `spawn` raises ENOENT, the handler turned
 * that into `null`, and an adopted service silently kept `pid: null` forever.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseLsofPid,
  parseNetstatPid,
  parseSsPid,
  resolvePortPid,
} from "@/lib/services/portProbe";

/** Absolute path of `command`, or null when it is not on PATH. */
function which(command: string): string | null {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

test("parseLsofPid reads the first pid line", () => {
  assert.equal(parseLsofPid("596922\n"), 596922);
  assert.equal(parseLsofPid("\n  596922  \n123\n"), 596922);
});

test("parseLsofPid returns null for empty or non-numeric output", () => {
  assert.equal(parseLsofPid(""), null);
  assert.equal(parseLsofPid("\n \n"), null);
  assert.equal(parseLsofPid("lsof: command not found\n"), null);
});

test("parseSsPid reads the pid out of the users:(...) column", () => {
  const line =
    'LISTEN 0      511          127.0.0.1:20128      0.0.0.0:*    users:(("node",pid=596922,fd=18))\n';
  assert.equal(parseSsPid(line), 596922);
});

test("parseSsPid returns null when ss reports no process column", () => {
  // Without ownership of the socket (or CAP_NET_ADMIN) ss prints the row but
  // no users:(...) column, which must not be read as a match.
  assert.equal(parseSsPid("LISTEN 0 511 127.0.0.1:20128 0.0.0.0:*\n"), null);
  assert.equal(parseSsPid(""), null);
});

test("parseNetstatPid matches on the local address, not the foreign one", () => {
  const stdout = [
    "Active Internet connections (only servers)",
    "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
    "tcp        0      0 127.0.0.1:9999          0.0.0.0:20128           LISTEN      111/other",
    "tcp        0      0 127.0.0.1:20128         0.0.0.0:*               LISTEN      596922/node",
    "",
  ].join("\n");
  assert.equal(parseNetstatPid(stdout, 20128), 596922);
});

test("parseNetstatPid ignores non-listening rows and unknown ports", () => {
  const stdout =
    "tcp        0      0 127.0.0.1:20128         1.2.3.4:5555            ESTABLISHED 596922/node\n";
  assert.equal(parseNetstatPid(stdout, 20128), null);
  assert.equal(parseNetstatPid("", 20128), null);
});

test("resolvePortPid finds the pid holding a port", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(29994, "127.0.0.1", resolve));
  try {
    assert.equal(await resolvePortPid(29994), process.pid);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resolvePortPid returns null for a port nobody holds", async () => {
  assert.equal(await resolvePortPid(29993), null);
});

test("resolvePortPid still resolves a pid on a host without lsof", async (t) => {
  // The reported environment: ss and/or netstat present, lsof absent. Emulated
  // by pointing PATH at a directory holding only the fallbacks, so `spawn`
  // raises the same ENOENT for lsof that a slim image would.
  const fallbacks = ["ss", "netstat"]
    .map((command) => ({ command, real: which(command) }))
    .filter((entry): entry is { command: string; real: string } => entry.real !== null);

  if (fallbacks.length === 0) {
    t.skip("neither ss nor netstat is installed");
    return;
  }

  const shim = mkdtempSync(path.join(tmpdir(), "portprobe-"));
  const originalPath = process.env.PATH;
  const server = createServer();

  try {
    for (const { command, real } of fallbacks) {
      symlinkSync(real, path.join(shim, command));
    }

    // Guard the guard: if lsof were still reachable the assertion below would
    // pass for the wrong reason.
    assert.throws(
      () =>
        execFileSync("/bin/sh", ["-c", "command -v lsof"], {
          stdio: "ignore",
          env: { PATH: shim },
        }),
      "lsof must not resolve on the shimmed PATH"
    );

    process.env.PATH = shim;
    await new Promise<void>((resolve) => server.listen(29992, "127.0.0.1", resolve));
    assert.equal(await resolvePortPid(29992), process.pid);
  } finally {
    process.env.PATH = originalPath;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(shim, { recursive: true, force: true });
  }
});
