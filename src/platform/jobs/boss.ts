import { PgBoss } from "pg-boss";
import { getPool } from "../../db/tenant.js";
import { closedMessaging, localMessaging } from "../../modules/messaging/index.js";
import { materialiseRecalls } from "../../modules/vertical/index.js";

/**
 * Audited exemption from the withTenant lint rule.
 * pg-boss owns its queue tables and has no request context.
 * A tenant-scoped job carries clinic_id and runs inside withTenant.
 */
export async function startBoss(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const boss = new PgBoss(url);
  await boss.start();
  if (!(await boss.getQueue("recall"))) await boss.createQueue("recall");
  await boss.work("recall", async () => {
    const messaging = process.env.LOCAL_ADAPTER_SECRET ? localMessaging() : closedMessaging();
    const clinics = await getPool().query<{ list_clinic_ids: string }>(`SELECT list_clinic_ids()`);
    for (const clinic of clinics.rows) {
      await materialiseRecalls(clinic.list_clinic_ids, messaging);
    }
  });
  await boss.schedule("recall", "0 * * * *");
}
