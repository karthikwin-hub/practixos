import pg from "pg";

/**
 * The only sanctioned application path to tenant-scoped data (§4.4.1).
 *
 * `pool` is exported so the isolation gate can issue a context-free query on
 * this same pool. Application code must not call `pool.query` or `pool.connect`;
 * the ESLint rule rejects that outside this file.
 */
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.APP_DATABASE_URL;
    if (!connectionString) {
      throw new Error("APP_DATABASE_URL is not set");
    }
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }
  return pool;
}

export async function endPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function withTenant<T>(
  clinicId: string,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await getPool().connect();
  try {
    await tx.query("BEGIN");
    // set_config's third argument = true means SET LOCAL. Parameterised,
    // because string-interpolating a tenant id into this statement would
    // hand an attacker the isolation boundary itself.
    await tx.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}
