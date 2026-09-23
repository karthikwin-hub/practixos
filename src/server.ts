import { buildApp } from "./app.js";
import { startBoss } from "./platform/jobs/boss.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

await startBoss();
await app.listen({ port, host: "0.0.0.0" });
