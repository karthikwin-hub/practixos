import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");

export function up(pgm) {
  pgm.sql(readFileSync(path.join(sqlDir, "005_m4.sql"), "utf8"));
}

export function down(pgm) {
  pgm.sql(readFileSync(path.join(sqlDir, "005_m4_down.sql"), "utf8"));
}
