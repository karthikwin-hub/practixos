import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { boot, finishDental, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/** @spec FR-2.1, FR-2.2, FR-2.4, FR-3.1 — offline check-in, vitals and queue movement reconcile. */
test("cutting the network leaves the floor working and it reconciles", async () => {
  const app = await boot();
  const token = await owner(app, "offline");
  const { practitionerId } = await finishDental(app, token);
  await app.listen({ port: 3098, host: "127.0.0.1" });
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174", "--strictPort"], {
    cwd: "web",
    env: { ...process.env, VITE_API: "http://127.0.0.1:3098" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteLog = "";
  vite.stdout?.on("data", (chunk: Buffer) => { viteLog += chunk.toString(); });
  vite.stderr?.on("data", (chunk: Buffer) => { viteLog += chunk.toString(); });
  let browser: Browser | undefined;
  try {
    await waitFor(vite, /Local:/, () => viteLog);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    await context.addInitScript(({ staffToken, practitioner }) => {
      localStorage.setItem("practix.token", staffToken);
      localStorage.setItem("practix.practitionerId", practitioner);
    }, { staffToken: token, practitioner: practitionerId });
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://127.0.0.1:5174/#/setup");
    await page.getByRole("button", { name: "Create clinic" }).waitFor();
    await assertNoOverflow(page);
    await page.goto("http://offline.localhost:5174/#/book");
    await page.getByRole("button", { name: "मराठी" }).click();
    await assertNoOverflow(page);
    await page.goto("http://127.0.0.1:5174/#/desk");
    await page.getByRole("heading", { name: "Waiting Room" }).waitFor();
    await assertNoOverflow(page);
    await context.setOffline(true);
    await page.getByLabel("Mobile").fill("9822011111");
    await page.getByLabel("Name").fill("Offline Pat");
    await page.getByRole("button", { name: "Add walk-in" }).click();
    await page.getByRole("button", { name: "Vitals" }).click();
    await page.getByRole("dialog", { name: "Vitals" }).waitFor();
    await assertNoOverflow(page);
    for (const key of ["1", "2", "0", "/", "8", "0", "/", "7", "2", "/", "9", "0", "/", "6", "0", "0", "0", "0"]) {
      await page.getByRole("button", { name: key, exact: true }).click();
    }
    await page.getByRole("button", { name: "Save vitals" }).click();
    await page.getByText("Offline Pat").waitFor();
    const before = await withSuperuser(async (client) => {
      return client.query(`SELECT 1 FROM patients WHERE full_name = 'Offline Pat'`);
    });
    assert.equal(before.rowCount, 0);
    await page.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("button", { name: "In Consultation" }).click();
    await page.waitForFunction(async () => {
      const kinds = await new Promise<string[]>((resolve) => {
        const req = indexedDB.open("practixos");
        req.onsuccess = () => {
          const database = req.result;
          const all = database.transaction("outbox", "readonly").objectStore("outbox").getAll();
          all.onsuccess = () => resolve((all.result as { kind: string }[]).map((row) => row.kind));
        };
      });
      return kinds.includes("queue_move");
    });
    await context.setOffline(false);
    const synced = page.waitForResponse((res) => res.url().includes("/api/sync") && res.ok());
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await synced;
    const row = await withSuperuser(async (client) => {
      return client.query<{ full_name: string; state: string; pulse: number | null }>(
        `SELECT p.full_name, a.state, v.pulse
         FROM patients p
         JOIN appointments a ON a.patient_id = p.id
         LEFT JOIN vitals v ON v.patient_id = p.id
         WHERE p.full_name = 'Offline Pat'`,
      );
    });
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].state, "in_consult");
    assert.equal(row.rows[0].pulse, 72);
  } finally {
    await browser?.close();
    stopChild(vite);
    await shutdown(app);
  }
});

async function assertNoOverflow(page: import("playwright").Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
}

function stopChild(child: ChildProcess): void {
  if (child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function waitFor(child: ChildProcess, pattern: RegExp, log: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vite did not start\n${log()}`)), 30_000);
    const onData = (chunk: Buffer) => {
      if (pattern.test(chunk.toString())) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited ${code}\n${log()}`));
    });
    void once(child, "error").then(([err]) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
