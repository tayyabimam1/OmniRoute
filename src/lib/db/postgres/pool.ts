/**
 * Postgres connection pool (Aiven, or any standard Postgres host).
 *
 * Separate from src/lib/db/core.ts (the existing better-sqlite3 singleton) —
 * this module is additive until a later cutover plan switches core.ts to use it.
 */

import fs from "fs";
import { Pool } from "pg";

let _pool: Pool | null = null;

/**
 * Builds the SSL option for the Aiven connection. Verifies the server certificate
 * against Aiven's project CA (download it from the Aiven console → your Postgres
 * service → "Connection information" → CA certificate, save it, point
 * PGSSLROOTCERT at the file) — Aiven's cert is signed by a private per-project CA,
 * so Node's default trust store will not validate it without this.
 *
 * PGSSLROOTCERT is required whenever sslmode=require is present. Skipping
 * verification (rejectUnauthorized:false) permits a MITM to intercept provider
 * API keys/tokens in transit, so it is only available via an explicit opt-in env
 * var, never a silent default.
 */
function buildSslOption(
  connectionString: string
): { rejectUnauthorized: boolean; ca?: string } | undefined {
  if (!connectionString.includes("sslmode=require")) return undefined;

  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, "utf-8") };
  }

  if (process.env.PG_ALLOW_INSECURE_TLS === "true") {
    console.warn(
      "[postgres] PGSSLROOTCERT not set — connecting with certificate verification " +
        "disabled (PG_ALLOW_INSECURE_TLS=true). This permits a MITM to read provider " +
        "credentials in transit. Set PGSSLROOTCERT to Aiven's downloaded CA cert instead."
    );
    return { rejectUnauthorized: false };
  }

  throw new Error(
    "[postgres] DATABASE_URL requires sslmode=require but PGSSLROOTCERT is not set. " +
      "Download the CA certificate from the Aiven console (your Postgres service → " +
      "Connection information → CA certificate), save it locally, and set " +
      "PGSSLROOTCERT=/path/to/ca.pem. (Or set PG_ALLOW_INSECURE_TLS=true to skip " +
      "verification — not recommended, permits MITM.)"
  );
}

/**
 * Returns the shared Postgres connection pool, creating it on first call.
 * Throws if DATABASE_URL is not set — callers must configure it before use.
 */
export function getPgPool(): Pool {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    throw new Error(
      "[postgres] DATABASE_URL is not set. Expected format: " +
        "postgres://user:pass@host:port/dbname?sslmode=require"
    );
  }

  _pool = new Pool({
    connectionString,
    ssl: buildSslOption(connectionString),
  });

  return _pool;
}

/** Closes the pool. For test/script teardown only — not called in normal server operation. */
export async function closePgPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
