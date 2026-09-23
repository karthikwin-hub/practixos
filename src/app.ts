import Fastify, { type FastifyInstance } from "fastify";

/** M0 serves a health check only. Business routes arrive in later milestones. */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
