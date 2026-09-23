import pg from "pg";
import { migrate } from "../../src/db/migrate.ts";

export const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://postgres:ci@127.0.0.1:55432/practixos_test";

export const appDatabaseUrl =
  process.env.APP_DATABASE_URL ??
  "postgres://app_rw:app_rw_local@127.0.0.1:55432/practixos_test";

export function applyGateEnv(poolMax: number): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_DATABASE_URL = appDatabaseUrl;
  process.env.PG_POOL_MAX = String(poolMax);
}

export async function resetDatabase(): Promise<void> {
  await migrate();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      TRUNCATE TABLE
        recovered_revenue, payment_events, message_outbox, deposits, vitals, sync_applied,
        import_batches, otp_challenges, patient_sessions, staff_sessions, staff_users,
        appointments, vault_notes, patients, queue_stages, clinic_modules, working_hours,
        break_windows, practitioners, chairs, audit_log, clinics
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await client.end();
  }
}

export async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
