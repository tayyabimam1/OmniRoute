// Pragmatic-tier sanity check (see docs/superpowers/specs/2026-08-16-postgres-migration-design.md).
// Not a test suite — one script that fails loudly (non-zero exit) if the Postgres
// migration pipeline is broken. Run against a real, empty Aiven database:
//   DATABASE_URL="postgres://..." STORAGE_ENCRYPTION_KEY="..." \
//     node --import tsx/esm scripts/ad-hoc/verify-pg-migration.mjs
import { runPgMigrations } from "../../src/lib/db/postgres/migrationRunner.ts";
import { getPgPool, closePgPool } from "../../src/lib/db/postgres/pool.ts";
import { encrypt, decrypt } from "../../src/lib/db/encryption.ts";

async function main() {
  await runPgMigrations();
  const pool = getPgPool();

  // 1. Plain-column round-trip: insert + read one row in provider_nodes.
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO provider_nodes (id, type, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    ["verify-node-1", "custom", "verify-sanity-node", now, now]
  );
  const nodeResult = await pool.query("SELECT * FROM provider_nodes WHERE id = $1", [
    "verify-node-1",
  ]);
  if (nodeResult.rows.length !== 1 || nodeResult.rows[0].name !== "verify-sanity-node") {
    throw new Error("[verify-pg-migration] FAILED: provider_nodes round-trip mismatch");
  }
  console.log("[verify-pg-migration] OK — provider_nodes plain-column round-trip");

  // 2. Encrypted-field round-trip: encrypt a fake API key, store it in
  // provider_connections.api_key, read it back, decrypt, compare to original.
  const plaintextApiKey = "sk-verify-sanity-check-12345";
  const encryptedApiKey = encrypt(plaintextApiKey);

  await pool.query(
    `INSERT INTO provider_connections (id, provider, api_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    ["verify-conn-1", "verify-provider", encryptedApiKey, now, now]
  );
  const connResult = await pool.query("SELECT api_key FROM provider_connections WHERE id = $1", [
    "verify-conn-1",
  ]);
  const storedEncrypted = connResult.rows[0]?.api_key;
  const decrypted = decrypt(storedEncrypted);

  if (decrypted !== plaintextApiKey) {
    throw new Error(
      `[verify-pg-migration] FAILED: encrypted round-trip mismatch. ` +
        `Expected "${plaintextApiKey}", got "${decrypted}"`
    );
  }
  console.log("[verify-pg-migration] OK — provider_connections encrypted-field round-trip");

  // Cleanup the sanity rows so re-runs stay idempotent.
  await pool.query("DELETE FROM provider_nodes WHERE id = $1", ["verify-node-1"]);
  await pool.query("DELETE FROM provider_connections WHERE id = $1", ["verify-conn-1"]);

  console.log("[verify-pg-migration] ALL CHECKS PASSED");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool();
  });
