import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");

function read(name) {
  return readFileSync(path.join(sqlDir, name), "utf8");
}

// Split on semicolons that end a statement. Role files have no function bodies.
function statements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.split("\n").every((line) => {
      const trimmed = line.trim();
      return trimmed === "" || trimmed.startsWith("--");
    }));
}

export function up(pgm) {
  // CREATE ROLE cannot run inside a transaction block.
  pgm.noTransaction();
  for (const statement of statements(read("001_roles.sql"))) {
    pgm.sql(statement);
  }
  pgm.sql(read("002_schema.sql"));
}

export function down(pgm) {
  pgm.noTransaction();
  pgm.sql(read("002_schema_down.sql"));
  for (const statement of statements(read("001_roles_down.sql"))) {
    pgm.sql(statement);
  }
}
