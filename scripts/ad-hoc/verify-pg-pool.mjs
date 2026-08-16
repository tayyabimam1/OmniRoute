// Manual runnable check for the Postgres pool — pragmatic tier, not a node:test suite.
// Run: DATABASE_URL="postgres://..." node scripts/ad-hoc/verify-pg-pool.mjs
import { getPgPool, closePgPool } from "../../src/lib/db/postgres/pool.ts";

const pool = getPgPool();
const result = await pool.query("SELECT 1 AS ok");

if (result.rows[0]?.ok !== 1) {
  console.error("[verify-pg-pool] FAILED — unexpected result:", result.rows);
  process.exit(1);
}

console.log("[verify-pg-pool] OK — connected to Postgres and ran SELECT 1");
await closePgPool();
