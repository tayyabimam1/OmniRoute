import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_BRIDGE_BROKER_PATH,
  buildVideoBridgeBrokerHeaders,
  extractVideoFramesViaBroker,
  isVideoBridgeBrokerInternalRequest,
  resolveVideoBridgeBrokerBaseUrl,
} from "../../src/lib/guardrails/videoBridgeBrokerClient.ts";
import { createVideoExtractionQueue } from "../../src/lib/guardrails/videoBridgeBrokerQueue.ts";
import { AUTHZ_HEADER_PEER_LOCALITY } from "../../src/server/authz/headers.ts";

test("broker origin is pinned to the active loopback listener and ignores client-controlled origins", () => {
  const previousPort = process.env.PORT;
  const previousScheme = process.env.OMNIROUTE_INTERNAL_SCHEME;
  process.env.PORT = "21128";
  delete process.env.OMNIROUTE_INTERNAL_SCHEME;
  try {
    assert.equal(
      resolveVideoBridgeBrokerBaseUrl("https://attacker.example/v1"),
      "http://127.0.0.1:21128"
    );
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousScheme === undefined) delete process.env.OMNIROUTE_INTERNAL_SCHEME;
    else process.env.OMNIROUTE_INTERNAL_SCHEME = previousScheme;
  }
});

test("broker authentication is exact-path, token-bound, and trusted-loopback only", () => {
  const headers = new Headers({
    ...buildVideoBridgeBrokerHeaders(),
    [AUTHZ_HEADER_PEER_LOCALITY]: "loopback",
  });
  const trusted = new Request(`http://localhost${VIDEO_BRIDGE_BROKER_PATH}`, {
    method: "POST",
    headers,
  });
  assert.equal(isVideoBridgeBrokerInternalRequest(trusted, VIDEO_BRIDGE_BROKER_PATH), true);

  const remote = new Request(`http://localhost${VIDEO_BRIDGE_BROKER_PATH}`, {
    method: "POST",
    headers: buildVideoBridgeBrokerHeaders(),
  });
  assert.equal(isVideoBridgeBrokerInternalRequest(remote, VIDEO_BRIDGE_BROKER_PATH), false);
  assert.equal(
    isVideoBridgeBrokerInternalRequest(trusted, "/api/modality-bridge/video/runtime"),
    false
  );
});

test("broker client sends only bounded bytes and fixed parameters to the pinned route", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const response = await extractVideoFramesViaBroker(
    Buffer.from("safe-video"),
    { frameCount: 2, timeoutMs: 5_000 },
    {
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return Response.json({
          durationSeconds: 4,
          frames: [
            { timestampSeconds: 1, dataUri: "data:image/jpeg;base64,QQ==" },
            { timestampSeconds: 3, dataUri: "data:image/jpeg;base64,Qg==" },
          ],
        });
      },
    }
  );

  assert.match(requestedUrl, /\/api\/modality-bridge\/video\/extract\?frames=2$/);
  assert.equal(new URL(requestedUrl).hostname, "127.0.0.1");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(
    (requestedInit?.headers as Record<string, string>)["Content-Type"],
    "application/octet-stream"
  );
  assert.deepEqual(Buffer.from(requestedInit?.body as Uint8Array), Buffer.from("safe-video"));
  assert.equal(response.frames.length, 2);
});

test("broker client cancels an unbounded response stream before it can exceed the cap", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("1234"));
      controller.enqueue(Buffer.from("5"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    () =>
      extractVideoFramesViaBroker(
        Buffer.from("safe-video"),
        { frameCount: 1, timeoutMs: 5_000 },
        {
          fetchImpl: async () => new Response(body),
          maxResponseBytes: 4,
        }
      ),
    /response exceeded its byte limit/
  );
  assert.equal(cancelled, true);
});

test("broker queue bounds pending jobs and queued bytes", async () => {
  const queue = createVideoExtractionQueue({ concurrency: 1, maxPending: 1, maxQueuedBytes: 8 });
  let release!: () => void;
  const active = queue.run(4, () => new Promise<void>((resolve) => (release = resolve)));
  const pending = queue.run(8, async () => undefined);
  await assert.rejects(() => queue.run(1, async () => undefined), /queue capacity/);
  release();
  await Promise.all([active, pending]);
});

test("broker queue removes an aborted pending item and never executes it", async () => {
  const queue = createVideoExtractionQueue({ concurrency: 1, maxPending: 2, maxQueuedBytes: 16 });
  let release!: () => void;
  const active = queue.run(4, () => new Promise<void>((resolve) => (release = resolve)));
  const controller = new AbortController();
  let executed = false;
  const pending = queue.run(
    4,
    async () => {
      executed = true;
    },
    controller.signal
  );
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
  release();
  await active;
  assert.equal(executed, false);
});
