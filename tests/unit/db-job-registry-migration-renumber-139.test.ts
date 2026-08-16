import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-job-migration-"));
const originalMigrationsDir = process.env.OMNIROUTE_MIGRATIONS_DIR;
process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;

fs.writeFileSync(
  path.join(migrationsDir, "139_ccr_blocks.sql"),
  "CREATE TABLE ccr_blocks (principal_id TEXT PRIMARY KEY);"
);
fs.writeFileSync(
  path.join(migrationsDir, "146_job_registry.sql"),
  [
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY);",
    "CREATE TABLE IF NOT EXISTS job_runs (id INTEGER PRIMARY KEY);",
    "CREATE TABLE job_registry_reexecuted (id INTEGER PRIMARY KEY);",
  ].join(" ")
);

const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");

test.after(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
  if (originalMigrationsDir === undefined) delete process.env.OMNIROUTE_MIGRATIONS_DIR;
  else process.env.OMNIROUTE_MIGRATIONS_DIR = originalMigrationsDir;
});

test("job registry previously applied on 139 is rehomed so CCR can claim that slot", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY);
      CREATE TABLE job_runs (id INTEGER PRIMARY KEY);
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _omniroute_migrations (version, name) VALUES ('139', 'job_registry');
    `);

    assert.equal(runMigrations(db), 1);
    assert.deepEqual(
      db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
      [
        { version: "139", name: "ccr_blocks" },
        { version: "146", name: "job_registry" },
      ]
    );
    assert.ok(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ccr_blocks'")
        .get()
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_registry_reexecuted'"
        )
        .get(),
      undefined,
      "tracked legacy Job Registry must reconcile to 146 without replaying the migration"
    );
  } finally {
    db.close();
  }
});

test("untracked Job Registry tables do not suppress pending migration 146", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY);
      CREATE TABLE job_runs (id INTEGER PRIMARY KEY);
      CREATE TABLE ccr_blocks (principal_id TEXT PRIMARY KEY);
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _omniroute_migrations (version, name)
      VALUES ('139', 'ccr_blocks');
    `);

    assert.equal(runMigrations(db), 1);

    assert.deepEqual(
      db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
      [
        { version: "139", name: "ccr_blocks" },
        { version: "146", name: "job_registry" },
      ]
    );

    assert.ok(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_registry_reexecuted'"
        )
        .get(),
      "a genuinely pending 146 migration must execute even when jobs and job_runs already exist"
    );
  } finally {
    db.close();
  }
});
