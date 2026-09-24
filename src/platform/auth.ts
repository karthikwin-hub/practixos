import { randomBytes, timingSafeEqual } from "node:crypto";
import { argon2id } from "hash-wasm";

/**
 * Staff passwords are Argon2id. Better Auth's generated schema and its default
 * hasher would bypass the plain-SQL rule and the password rule, so sessions
 * live in staff_sessions instead of a generated auth schema.
 */
const memorySize = 19 * 1024;
const iterations = 2;

export async function hashSecret(secret: string, salt: Uint8Array = randomBytes(16)): Promise<{
  hash: string;
  salt: Uint8Array;
}> {
  const hash = await argon2id({
    password: secret,
    salt: salt as never,
    parallelism: 1,
    iterations,
    memorySize,
    hashLength: 32,
    outputType: "hex",
  });
  return { hash, salt };
}

export async function secretMatches(secret: string, hash: string, salt: Buffer): Promise<boolean> {
  const next = await hashSecret(secret, salt);
  const a = Buffer.from(next.hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}
