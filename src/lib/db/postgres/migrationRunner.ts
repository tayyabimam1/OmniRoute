/**
 * Minimal Postgres migration runner — fresh-install only.
 *
 * Deliberately does NOT replicate src/lib/db/migrationRunner.ts's renumbering/
 * retroactive-guard/mass-abort logic: that machinery exists only to reconcile
 * years of SQLite schema history on pre-existing databases. This pipeline targets
 * a fresh Aiven Postgres database with no prior schema, so it only needs to apply
 * numbered .sql files in order, once, tracked in a schema_migrations table.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPgPool } from "./pool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
}

function getMigrationFiles(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        throw new Error(
          `[postgres-migration] Migration filename does not match NNN_description.sql: ${filename}`
        );
      }
      return {
        version: match[1],
        name: match[2],
        filePath: path.join(MIGRATIONS_DIR, filename),
      };
    });
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedVersions(): Promise<Set<string>> {
  const pool = getPgPool();
  const result = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => row.version));
}

/**
 * Applies all pending migrations in order. Each file runs inside its own
 * transaction (all-or-nothing per file). Returns the number applied.
 */
export async function runPgMigrations(): Promise<number> {
  await ensureMigrationsTable();

  const files = getMigrationFiles();
  const applied = await getAppliedVersions();
  const pending = files.filter((f) => !applied.has(f.version));

  if (pending.length === 0) return 0;

  const pool = getPgPool();
  let count = 0;

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.filePath, "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
      await client.query("COMMIT");
      count++;
      console.log(`[postgres-migration] Applied: ${migration.version}_${migration.name}`);
    } catch (err) {
      await client.query("ROLLBACK");
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[postgres-migration] FAILED: ${migration.version}_${migration.name} — ${message}`
      );
      throw err;
    } finally {
      client.release();
    }
  }

  return count;
}
