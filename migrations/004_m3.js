import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");

export function up(pgm) {
  pgm.sql(readFileSync(path.join(sqlDir, "004_m3.sql"), "utf8"));
}

export function down(pgm) {
  pgm.sql(readFileSync(path.join(sqlDir, "004_m3_down.sql"), "utf8"));
}
