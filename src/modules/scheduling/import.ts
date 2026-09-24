import ExcelJS from "exceljs";
import { withTenant } from "../../db/tenant.js";
import { toE164 } from "../../platform/phone.js";
import { fail } from "./service.js";

interface ParsedRow {
  row: number;
  name: string;
  phone: string | null;
  reason?: string;
}

export async function dryRunImport(
  clinicId: string,
  input: { filename: string; text?: string; xlsxBase64?: string; mapping?: { name?: string; phone?: string } },
): Promise<unknown> {
  const grid = input.xlsxBase64
    ? await readXlsx(Buffer.from(input.xlsxBase64, "base64"))
    : parseCsv(input.text ?? "");
  if (grid.length < 2) fail(400, "the file needs a header and one row");
  const header = grid[0];
  const nameCol = column(header, input.mapping?.name, /name/i);
  const phoneCol = column(header, input.mapping?.phone, /phone|mobile|mob|contact/i);
  if (nameCol < 0 || phoneCol < 0) fail(400, "map a name column and a phone column");
  return withTenant(clinicId, async (tx) => {
    const create: ParsedRow[] = [];
    const merge: ParsedRow[] = [];
    const reject: ParsedRow[] = [];
    for (let i = 1; i < grid.length; i += 1) {
      const cells = grid[i];
      const name = cells[nameCol]?.trim() ?? "";
      const phone = toE164(cells[phoneCol] ?? "");
      if (!name || !phone) {
        reject.push({ row: i + 1, name, phone, reason: "name and a valid Indian mobile are required" });
        continue;
      }
      const existing = await tx.query<{ full_name: string }>(
        `SELECT full_name FROM patients WHERE clinic_id = $1 AND phone_e164 = $2 AND self_managing`,
        [clinicId, phone],
      );
      if (existing.rows[0]) {
        merge.push({ row: i + 1, name, phone, reason: existing.rows[0].full_name });
      } else {
        create.push({ row: i + 1, name, phone });
      }
    }
    const summary = { create, merge, reject };
    const batch = await tx.query<{ id: string }>(
      `INSERT INTO import_batches (clinic_id, status, summary) VALUES ($1,'dry_run',$2) RETURNING id`,
      [clinicId, JSON.stringify(summary)],
    );
    return { batchId: batch.rows[0].id, ...summary };
  });
}

export async function commitImport(
  clinicId: string,
  batchId: string,
  actor: { userId: string; role: string },
): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const batch = await tx.query<{ status: string; summary: { create: ParsedRow[] } }>(
      `SELECT status, summary FROM import_batches WHERE id = $1`,
      [batchId],
    );
    if (batch.rows[0]?.status !== "dry_run") fail(409, "commit follows a dry run");
    const ids: string[] = [];
    for (const row of batch.rows[0].summary.create) {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO patients (clinic_id, full_name, phone_e164) VALUES ($1,$2,$3) RETURNING id`,
        [clinicId, row.name, row.phone],
      );
      ids.push(inserted.rows[0].id);
    }
    await tx.query(
      `UPDATE import_batches SET status = 'committed', created_ids = $2, committed_at = now() WHERE id = $1`,
      [batchId, ids],
    );
    await tx.query(
      `INSERT INTO audit_log (clinic_id, actor_id, actor_role, action, subject, detail)
       VALUES ($1,$2,$3,'import',$4,$5)`,
      [clinicId, actor.userId, actor.role, batchId, JSON.stringify({ created: ids.length })],
    );
    return { created: ids.length };
  });
}

export async function reverseImport(
  clinicId: string,
  batchId: string,
  actor: { userId: string; role: string },
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const batch = await tx.query<{ status: string; created_ids: string[]; committed_at: Date }>(
      `SELECT status, created_ids, committed_at FROM import_batches WHERE id = $1`,
      [batchId],
    );
    const row = batch.rows[0];
    if (row?.status !== "committed") fail(409, "only a committed import can be reversed");
    if (Date.now() - new Date(row.committed_at).getTime() > 86_400_000) fail(409, "the reversal window has closed");
    await tx.query(`DELETE FROM patients WHERE id = ANY($1::uuid[]) AND clinic_id = $2`, [row.created_ids, clinicId]);
    await tx.query(`UPDATE import_batches SET status = 'reversed' WHERE id = $1`, [batchId]);
    await tx.query(
      `INSERT INTO audit_log (clinic_id, actor_id, actor_role, action, subject, detail)
       VALUES ($1,$2,$3,'import_reverse',$4,$5)`,
      [clinicId, actor.userId, actor.role, batchId, JSON.stringify({ removed: row.created_ids.length })],
    );
  });
}

function parseCsv(text: string): string[][] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => line.split(",").map((cell) => cell.trim()));
}

async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as never);
  const sheet = book.worksheets[0];
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values = row.values as unknown[];
    rows.push(values.slice(1).map((cell) => String(cell ?? "")));
  });
  return rows;
}

function column(header: string[], mapped: string | undefined, guess: RegExp): number {
  if (mapped) {
    const index = header.findIndex((item) => item.toLowerCase() === mapped.toLowerCase());
    if (index >= 0) return index;
  }
  return header.findIndex((item) => guess.test(item));
}
