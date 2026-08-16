// Manual runnable migration trigger — pragmatic tier.
// Run: DATABASE_URL="postgres://..." node --import tsx/esm scripts/ad-hoc/run-pg-migrations.mjs
import { runPgMigrations } from "../../src/lib/db/postgres/migrationRunner.ts";
import { closePgPool } from "../../src/lib/db/postgres/pool.ts";

const count = await runPgMigrations();
console.log(`[run-pg-migrations] Applied ${count} migration(s).`);
await closePgPool();
