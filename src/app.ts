import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { closedBilling, localBilling, type BillingPort } from "./modules/billing/index.js";
import { recordVitals, setAlerts } from "./modules/clinical/index.js";
import { closedMessaging, localMessaging, type MessagingPort } from "./modules/messaging/index.js";
import {
  bookAppointment,
  cancelAppointment,
  clientClaimsPaid,
  commitImport,
  confirmAttendanceIntent,
  correctLedger,
  createWalkIn,
  dryRunImport,
  eraseOwnedClinic,
  exportClinic,
  listSlots,
  markAttended,
  maskedPatient,
  moveStage,
  openClinic,
  placeTestBooking,
  publicProfile,
  queueBoard,
  reverseImport,
  saveWizard,
  sendOtp,
  sendReminder,
  settleWebhook,
  unmaskPhone,
  verifyOtp,
  wizardState,
} from "./modules/scheduling/index.js";
import { applySync } from "./modules/sync/index.js";
import {
  resolveClinicId,
  resolvePatientSession,
  resolveStaffSession,
  subscribeQueue,
  unsubscribeQueue,
} from "./db/tenant.js";

type RequestWithRaw = FastifyRequest & { rawBody?: Buffer };

function adapters(): { messaging: MessagingPort; billing: BillingPort } {
  const secret = process.env.LOCAL_ADAPTER_SECRET;
  if (!secret) return { messaging: closedMessaging(), billing: closedBilling() };
  return { messaging: localMessaging(), billing: localBilling(secret) };
}

function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const name = host.split(":")[0] ?? "";
  const labels = name.split(".");
  if (labels.length < 2 || labels[0] === "www") return null;
  return labels[0];
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

async function clinicFromHost(req: FastifyRequest): Promise<string> {
  const slug = slugFromHost(req.headers.host);
  if (!slug) {
    throw Object.assign(new Error("clinic host is required"), { statusCode: 404 });
  }
  const id = await resolveClinicId(slug);
  if (!id) throw Object.assign(new Error("clinic not found"), { statusCode: 404 });
  return id;
}

async function staffFrom(req: FastifyRequest): Promise<{ clinicId: string; userId: string; role: string }> {
  const token = bearer(req);
  if (!token) throw Object.assign(new Error("staff session required"), { statusCode: 401 });
  const session = await resolveStaffSession(token);
  if (!session) throw Object.assign(new Error("staff session required"), { statusCode: 401 });
  return session;
}

/** Health, the public portal, onboarding, and the clinic floor. No M3 routes. */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const ports = adapters();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    (req as RequestWithRaw).rawBody = buf;
    try {
      const text = buf.toString("utf8");
      done(null, text.length === 0 ? {} : JSON.parse(text) as unknown);
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : "error";
    reply.code(status).send({ error: message });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/onboarding", async (req) => {
    const body = req.body as {
      legalName: string; slug: string; vertical: string; email: string; password: string; ownerName: string;
    };
    return openClinic(body);
  });

  app.get("/api/onboarding", async (req) => wizardState((await staffFrom(req)).clinicId));

  app.patch("/api/onboarding/:step", async (req) => {
    const staff = await staffFrom(req);
    const body = req.body as { skip?: boolean } & Record<string, unknown>;
    await saveWizard(staff.clinicId, (req.params as { step: string }).step, body, Boolean(body.skip));
    return { ok: true };
  });

  app.post("/api/onboarding/test-booking", async (req) => {
    const staff = await staffFrom(req);
    return placeTestBooking(staff.clinicId, ports.messaging);
  });

  app.get("/api/export", async (req) => exportClinic((await staffFrom(req)).clinicId));

  app.post("/api/erase", async (req, reply) => {
    const staff = await staffFrom(req);
    await eraseOwnedClinic(staff.clinicId, staff.role);
    return reply.code(200).send({ ok: true });
  });

  app.get("/api/portal/profile", async (req) => {
    const clinicId = await clinicFromHost(req);
    const lang = String((req.query as { lang?: string }).lang ?? "en");
    return publicProfile(clinicId, lang);
  });

  app.get("/api/portal/slots", async (req) => {
    const clinicId = await clinicFromHost(req);
    const query = req.query as { practitionerId: string; day: string; mode?: "clinic" | "video" };
    return listSlots(clinicId, query.practitionerId, query.day, query.mode ?? "clinic");
  });

  app.post("/api/portal/otp", async (req, reply) => {
    const clinicId = await clinicFromHost(req);
    const body = req.body as { phone: string; lang?: string };
    await sendOtp(clinicId, body.phone, body.lang ?? "en", ports.messaging);
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/portal/otp/verify", async (req) => {
    const clinicId = await clinicFromHost(req);
    const body = req.body as { phone: string; code: string; name?: string; lang?: string };
    return verifyOtp(clinicId, body.phone, body.code, body.name, body.lang ?? "en");
  });

  app.post("/api/portal/bookings", async (req) => {
    const clinicId = await clinicFromHost(req);
    const token = bearer(req);
    if (!token) throw Object.assign(new Error("patient session required"), { statusCode: 401 });
    const session = await resolvePatientSession(token);
    if (!session || session.clinicId !== clinicId) {
      throw Object.assign(new Error("patient session required"), { statusCode: 401 });
    }
    const body = req.body as {
      practitionerId: string; start: string; end: string; mode: "clinic" | "video"; lang?: string;
    };
    return bookAppointment(clinicId, session.patientId, {
      practitionerId: body.practitionerId,
      start: body.start,
      end: body.end,
      mode: body.mode,
      lang: body.lang ?? "en",
    }, ports.billing, ports.messaging);
  });

  app.post("/api/portal/bookings/:id/cancel", async (req) => {
    const clinicId = await clinicFromHost(req);
    const lang = String((req.query as { lang?: string }).lang ?? "en");
    return cancelAppointment(clinicId, (req.params as { id: string }).id, lang);
  });

  app.post("/api/portal/bookings/:id/client-paid", async (_req, reply) => {
    return reply.code(202).send(await clientClaimsPaid());
  });

  app.post("/api/payments/webhook", async (req, reply) => {
    const raw = (req as RequestWithRaw).rawBody ?? Buffer.from("");
    const signature = String(req.headers["x-practix-signature"] ?? "");
    if (!ports.billing.verify(raw, signature)) {
      return reply.code(401).send({ error: "bad signature" });
    }
    const body = req.body as {
      provider: string; providerEventId: string; appointmentId: string; clinicId: string;
    };
    const result = await settleWebhook(body.clinicId, {
      provider: body.provider,
      providerEventId: body.providerEventId,
      appointmentId: body.appointmentId,
    }, body, ports.messaging);
    return reply.code(200).send(result);
  });

  app.post("/api/appointments/:id/reminder", async (req) => {
    const staff = await staffFrom(req);
    await sendReminder(staff.clinicId, (req.params as { id: string }).id, ports.messaging);
    return { ok: true };
  });

  app.post("/api/appointments/:id/confirm", async (req) => {
    const staff = await staffFrom(req);
    await confirmAttendanceIntent(staff.clinicId, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/appointments/:id/attend", async (req) => {
    const staff = await staffFrom(req);
    await markAttended(staff.clinicId, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/ledger/:id/correct", async (req) => {
    const staff = await staffFrom(req);
    const body = req.body as { reason: string };
    await correctLedger(staff.clinicId, (req.params as { id: string }).id, body.reason);
    return { ok: true };
  });

  app.post("/api/imports/dry-run", async (req) => {
    const staff = await staffFrom(req);
    return dryRunImport(staff.clinicId, req.body as {
      filename: string; text?: string; xlsxBase64?: string; mapping?: { name?: string; phone?: string };
    });
  });

  app.post("/api/imports/:id/commit", async (req) => {
    const staff = await staffFrom(req);
    return commitImport(staff.clinicId, (req.params as { id: string }).id, staff);
  });

  app.post("/api/imports/:id/reverse", async (req) => {
    const staff = await staffFrom(req);
    await reverseImport(staff.clinicId, (req.params as { id: string }).id, staff);
    return { ok: true };
  });

  app.get("/api/queue", async (req) => queueBoard((await staffFrom(req)).clinicId));

  app.post("/api/walk-ins", async (req) => {
    const staff = await staffFrom(req);
    const body = req.body as { phone: string; name: string; practitionerId: string };
    return createWalkIn(staff.clinicId, body);
  });

  app.post("/api/queue/:id/stage", async (req) => {
    const staff = await staffFrom(req);
    const body = req.body as { stageId: string };
    await moveStage(staff.clinicId, (req.params as { id: string }).id, body.stageId);
    return { ok: true };
  });

  app.get("/api/patients/:id", async (req) => {
    const staff = await staffFrom(req);
    return maskedPatient(staff.clinicId, (req.params as { id: string }).id);
  });

  app.post("/api/patients/:id/unmask", async (req) => {
    const staff = await staffFrom(req);
    return unmaskPhone(staff.clinicId, (req.params as { id: string }).id, staff);
  });

  app.put("/api/patients/:id/alerts", async (req) => {
    const staff = await staffFrom(req);
    const body = req.body as { alerts: string[] };
    await setAlerts(staff.clinicId, (req.params as { id: string }).id, body.alerts);
    return { ok: true };
  });

  app.post("/api/vitals", async (req) => {
    const staff = await staffFrom(req);
    return recordVitals(staff.clinicId, req.body as {
      patientId: string; appointmentId?: string; bpSystolic?: number; bpDiastolic?: number;
      pulse?: number; sugar?: number; weightG?: number;
    });
  });

  app.post("/api/sync", async (req) => {
    const staff = await staffFrom(req);
    const body = req.body as { ops: { id: string; kind: string; updatedAt: string; body: Record<string, unknown> }[] };
    return applySync(staff.clinicId, body.ops);
  });

  app.register(websocket);
  app.get("/api/queue/live", { websocket: true }, (socket, req) => {
    const fn = (raw: string) => {
      socket.send(raw);
    };
    void (async () => {
      const slug = slugFromHost(req.headers.host);
      const clinicId = slug ? await resolveClinicId(slug) : null;
      const wrapped = (raw: string) => {
        const msg = JSON.parse(raw) as { clinicId?: string };
        if (msg.clinicId === clinicId) fn(raw);
      };
      await subscribeQueue(wrapped);
      socket.on("close", () => unsubscribeQueue(wrapped));
    })();
  });

  return app;
}
