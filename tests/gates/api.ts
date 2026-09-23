import type { FastifyInstance } from "fastify";
import { signBody } from "../../src/modules/billing/index.ts";
import { buildApp } from "../../src/app.ts";
import { endPool } from "../../src/db/tenant.ts";
import { applyGateEnv, resetDatabase, withSuperuser } from "./harness.ts";

export const adapterSecret = "m1-test-secret";

export async function boot(poolMax = 8): Promise<FastifyInstance> {
  applyGateEnv(poolMax);
  process.env.LOCAL_ADAPTER_SECRET = adapterSecret;
  await resetDatabase();
  return buildApp();
}

export async function shutdown(app: FastifyInstance): Promise<void> {
  await app.close();
  await endPool();
}

export async function owner(app: FastifyInstance, slug: string, vertical = "dental"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboarding",
    payload: {
      legalName: slug,
      slug,
      vertical,
      email: `owner@${slug}.test`,
      password: "correct horse battery",
      ownerName: "Owner",
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`onboarding ${res.statusCode} ${res.body}`);
  }
  return res.json().token as string;
}

export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function finishDental(app: FastifyInstance, token: string): Promise<{ practitionerId: string }> {
  const headers = auth(token);
  await app.inject({
    method: "PATCH",
    url: "/api/onboarding/practitioners",
    headers,
    payload: { practitioners: [{ fullName: "Dr Rao" }] },
  });
  await app.inject({
    method: "PATCH",
    url: "/api/onboarding/chairs",
    headers,
    payload: { chairs: [{ label: "Chair 1" }] },
  });
  await app.inject({
    method: "PATCH",
    url: "/api/onboarding/hours",
    headers,
    payload: {
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "09:00", closes: "17:00" })),
      breaks: [],
    },
  });
  await app.inject({
    method: "PATCH",
    url: "/api/onboarding/fees",
    headers,
    payload: { standardFeePaise: 50000, followupDays: 7 },
  });
  await app.inject({
    method: "PATCH",
    url: "/api/onboarding/languages",
    headers,
    payload: { languages: ["en", "mr", "te", "bn", "kok"] },
  });
  const state = await app.inject({ method: "GET", url: "/api/onboarding", headers });
  return { practitionerId: state.json().practitioners[0].id as string };
}

export async function otp(app: FastifyInstance, host: string, phone: string, name: string, lang = "en"): Promise<string> {
  const sent = await app.inject({
    method: "POST",
    url: "/api/portal/otp",
    headers: { host },
    payload: { phone, lang },
  });
  if (sent.statusCode !== 202) throw new Error(sent.body);
  const code = await withSuperuser(async (client) => {
    const res = await client.query<{ body: string }>(
      `SELECT body FROM message_outbox WHERE phone_e164 = $1 AND template = 'otp' ORDER BY created_at DESC LIMIT 1`,
      [phone.startsWith("+") ? phone : `+91${phone}`],
    );
    const match = res.rows[0].body.match(/(\d{6})\s*$/);
    if (!match) throw new Error("otp missing");
    return match[1];
  });
  const verified = await app.inject({
    method: "POST",
    url: "/api/portal/otp/verify",
    headers: { host },
    payload: { phone, code, name, lang },
  });
  if (verified.statusCode !== 200) throw new Error(verified.body);
  return verified.json().token as string;
}

export function webhook(app: FastifyInstance, body: unknown): Promise<{ statusCode: number; json: () => unknown }> {
  const raw = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: "/api/payments/webhook",
    headers: {
      "content-type": "application/json",
      "x-practix-signature": signBody(adapterSecret, raw),
    },
    payload: raw,
  });
}
