import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { argon2id } from "hash-wasm";

/** Argon2id parameters from §4.4.4. A 4-digit PIN alone is not the key. */
export const vaultKdf = {
  memoryKib: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface VaultPayload {
  salt: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
}

/**
 * There is no administrator override and no decrypt path that omits the PIN.
 * `serverSecret` is read from a file outside the database.
 */
export function loadServerSecret(secretPath = process.env.VAULT_SERVER_SECRET_PATH): Buffer {
  if (!secretPath) {
    throw new Error("VAULT_SERVER_SECRET_PATH is not set");
  }
  return readFileSync(secretPath);
}

export async function encryptNote(
  plaintext: string,
  pin: string,
  serverSecret: Buffer,
): Promise<VaultPayload> {
  const salt = randomBytes(16);
  const key = await deriveKey(pin, serverSecret, salt);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  return { salt, nonce, ciphertext };
}

export async function decryptNote(
  payload: VaultPayload,
  pin: string,
  serverSecret: Buffer,
): Promise<string> {
  const key = await deriveKey(pin, serverSecret, payload.salt);
  const tag = payload.ciphertext.subarray(payload.ciphertext.length - 16);
  const body = payload.ciphertext.subarray(0, payload.ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, payload.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

async function deriveKey(pin: string, serverSecret: Buffer, salt: Buffer): Promise<Buffer> {
  const pinBytes = Buffer.from(pin, "utf8");
  const password = Buffer.concat([pinBytes, serverSecret]);
  const hash = await argon2id({
    password,
    salt,
    parallelism: vaultKdf.parallelism,
    iterations: vaultKdf.iterations,
    memorySize: vaultKdf.memoryKib,
    hashLength: vaultKdf.hashLength,
    outputType: "binary",
  });
  return Buffer.from(hash);
}
