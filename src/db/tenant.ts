import pg from "pg";

/**
 * The only sanctioned application path to tenant-scoped data (§4.4.1).
 *
 * `pool` is exported so the isolation gate can issue a context-free query on
 * this same pool. Application code must not call `pool.query` or `pool.connect`;
 * the ESLint rule rejects that outside this file.
 */
let pool: pg.Pool | undefined;
let listener: pg.PoolClient | undefined;
const queueWaiters = new Set<(raw: string) => void>();

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
  if (listener) {
    listener.release();
    listener = undefined;
    queueWaiters.clear();
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Public slug lookup. The definer returns an id only; it does not read patients. */
export async function resolveClinicId(slug: string): Promise<string | null> {
  const res = await getPool().query<{ id: string | null }>(
    "SELECT resolve_clinic_id($1) AS id",
    [slug],
  );
  return res.rows[0]?.id ?? null;
}

/** Inserts one clinic row. RLS cannot see an id that does not exist yet. */
export async function provisionClinic(
  slug: string,
  legalName: string,
  vertical: string,
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    "SELECT provision_clinic($1, $2, $3) AS id",
    [slug, legalName, vertical],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error("provision_clinic returned no id");
  return id;
}

export async function resolveStaffSession(
  token: string,
): Promise<{ clinicId: string; userId: string; role: string; identityId: string | null } | null> {
  const res = await getPool().query<{ clinic_id: string; user_id: string; role: string; identity_id: string | null }>(
    "SELECT clinic_id, user_id, role, identity_id FROM resolve_staff_session($1)",
    [token],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { clinicId: row.clinic_id, userId: row.user_id, role: row.role, identityId: row.identity_id };
}

export async function lookupIdentity(email: string): Promise<{
  id: string; fullName: string; passwordHash: string; passwordSalt: Buffer;
} | null> {
  const res = await getPool().query<{ id: string; full_name: string; password_hash: string; password_salt: Buffer }>(
    "SELECT id, full_name, password_hash, password_salt FROM lookup_identity($1)",
    [email],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id, fullName: row.full_name, passwordHash: row.password_hash, passwordSalt: row.password_salt };
}

export async function membershipsFor(identityId: string): Promise<{
  clinicId: string; userId: string; role: string; slug: string; displayName: string; practitionerId: string | null;
}[]> {
  const res = await getPool().query<{
    clinic_id: string; user_id: string; role: string; slug: string; display_name: string; practitioner_id: string | null;
  }>(
    "SELECT clinic_id, user_id, role, slug, display_name, practitioner_id FROM identity_memberships($1)",
    [identityId],
  );
  return res.rows.map((row) => ({
    clinicId: row.clinic_id,
    userId: row.user_id,
    role: row.role,
    slug: row.slug,
    displayName: row.display_name,
    practitionerId: row.practitioner_id,
  }));
}

export async function createIdentitySession(token: string, identityId: string): Promise<void> {
  await getPool().query("SELECT create_identity_session($1,$2)", [token, identityId]);
}

export async function resolveIdentitySession(token: string): Promise<string | null> {
  const res = await getPool().query<{ identity_id: string }>(
    "SELECT identity_id FROM resolve_identity_session($1)",
    [token],
  );
  return res.rows[0]?.identity_id ?? null;
}

export async function resolvePatientSession(
  token: string,
): Promise<{ clinicId: string; patientId: string } | null> {
  const res = await getPool().query<{ clinic_id: string; patient_id: string }>(
    "SELECT clinic_id, patient_id FROM resolve_patient_session($1)",
    [token],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { clinicId: row.clinic_id, patientId: row.patient_id };
}

/** Deletes one clinic's operational rows. The ledger and audit_log stay append-only. */
export async function eraseClinic(clinicId: string): Promise<void> {
  await getPool().query("SELECT erase_clinic($1)", [clinicId]);
}

export async function queueNotify(
  tx: pg.PoolClient,
  clinicId: string,
  payload: unknown,
): Promise<void> {
  await tx.query("SELECT pg_notify('practix_queue', $1)", [
    JSON.stringify({ clinicId, payload }),
  ]);
}

export async function subscribeQueue(fn: (raw: string) => void): Promise<void> {
  queueWaiters.add(fn);
  if (listener) return;
  listener = await getPool().connect();
  await listener.query("LISTEN practix_queue");
  listener.on("notification", (msg) => {
    const raw = msg.payload ?? "";
    for (const waiter of queueWaiters) waiter(raw);
  });
}

export function unsubscribeQueue(fn: (raw: string) => void): void {
  queueWaiters.delete(fn);
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
