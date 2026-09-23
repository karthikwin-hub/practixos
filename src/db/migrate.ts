import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

/**
 * Audited exemption from the withTenant lint rule. The migration runner
 * connects as the DDL role, outside any tenant context.
 *
 * CREATE ROLE cannot run inside a transaction block, so roles are separate
 * statements and the runner is told not to wrap them. The schema batch is
 * plain SQL in migrations/sql/.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../migrations");

export async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Number.POSITIVE_INFINITY,
    // Roles cannot be created inside the default single transaction.
    singleTransaction: false,
    log: () => undefined,
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isDirectRun()) {
  migrate().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
