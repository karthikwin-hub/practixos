import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { buildApp } from "../../src/app.ts";
import { closedMessaging } from "../../src/modules/messaging/index.ts";
import { closedBilling } from "../../src/modules/billing/index.ts";
import { closedCalendar } from "../../src/modules/calendar/index.ts";

/**
 * @spec §4.3 — the client is a static PWA. Dexie is read before the network,
 * and the service worker is the offline shell.
 */
test("the client is a static PWA that reads Dexie before the network", () => {
  const db = readFileSync("web/src/db.ts", "utf8");
  const sw = readFileSync("web/public/sw.js", "utf8");
  const main = readFileSync("web/src/main.tsx", "utf8");
  const pkg = readFileSync("web/package.json", "utf8");
  assert.match(db, /dexie/i);
  assert.match(db, /outbox/);
  assert.match(sw, /caches/);
  assert.match(main, /serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(pkg, /"vite"/);
  assert.equal(pkg.includes("next"), false);
});

/**
 * @spec §4.5 — messaging, billing and calendar are separate ports. A throw
 * from one does not fail an unrelated request.
 */
test("a closed port does not fail an unrelated request", async () => {
  const previous = process.env.LOCAL_ADAPTER_SECRET;
  delete process.env.LOCAL_ADAPTER_SECRET;
  const app = buildApp();
  try {
    await assert.rejects(closedMessaging().dispatch({
      to: "+910000000000", lang: "en", template: "t", body: "b", channel: "whatsapp",
    }));
    assert.throws(() => closedBilling().intent("ref", 100));
    assert.equal(closedCalendar().verify(Buffer.from("{}"), "nope"), false);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    const hook = await app.inject({
      method: "POST",
      url: "/api/payments/webhook",
      payload: {},
    });
    assert.equal(hook.statusCode, 401);
    const again = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(again.statusCode, 200);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.LOCAL_ADAPTER_SECRET;
    else process.env.LOCAL_ADAPTER_SECRET = previous;
  }
});

/**
 * @spec §6.1 — the client tokens are the prototype's paper, ink, accent,
 * type and radius scale.
 */
test("clinical.css uses the prototype tokens", () => {
  const prototype = readFileSync("prototype/PractixOS.html", "utf8");
  const client = readFileSync("web/src/clinical.css", "utf8");
  for (const token of ["--paper:#FBFAF7", "--ink:#14211F", "--accent:#0B4F4A", "--r-s:6px", "--r-m:10px", "--r-l:16px", "--dur:170ms"]) {
    assert.equal(prototype.includes(token), true, token);
    assert.equal(client.includes(token), true, token);
  }
  const shell = readFileSync("web/src/main.tsx", "utf8");
  const residue = readFileSync("web/src/styles.css", "utf8");
  assert.equal(shell.includes("styles.css"), false);
  assert.equal(residue.includes("tailwindcss"), false);
  assert.equal(residue.includes("#f4f1ea"), false);
});

/**
 * @spec §6.3 — subsetted Indic woff2 files are self-hosted, with unicode-range
 * and font-display: swap. The shell does not load a CDN or a system-font stack.
 */
test("Indic fonts are self-hosted subsets", () => {
  const fonts = readFileSync("web/src/fonts.css", "utf8");
  const shell = readFileSync("web/src/main.tsx", "utf8");
  assert.match(fonts, /font-display:\s*swap/);
  assert.match(fonts, /unicode-range:[^;]*U\+0900-097F/);
  assert.match(fonts, /unicode-range:[^;]*U\+0C00-0C7F/);
  assert.match(fonts, /unicode-range:[^;]*U\+0980-09FE/);
  assert.equal(fonts.includes("fonts.googleapis.com"), false);
  assert.match(shell, /fonts\.css/);
  for (const file of ["devanagari-3.woff2", "telugu-6.woff2", "bengali-0.woff2"]) {
    assert.equal(existsSync(`web/public/fonts/${file}`), true, file);
  }
});

/**
 * @spec §6.4 — a reversible staff action offers undo for eight seconds, with
 * no confirm dialog. Vitals, fees and tooth numbers use the numeric keypad.
 * Motion stays inside 150–200 ms.
 */
test("undo lasts eight seconds and numbers stay on a keypad", () => {
  const app = readFileSync("web/src/App.tsx", "utf8");
  const css = readFileSync("web/src/clinical.css", "utf8");
  assert.match(app, /setTimeout\(\(\) => setUndo\(null\), 8000\)/);
  assert.match(app, /offerUndo\(/);
  assert.equal(app.includes("window.confirm"), false);
  assert.equal(app.includes("confirm("), false);
  assert.match(app, /label = "Vitals"/);
  assert.match(app, /label="Fee"/);
  assert.match(app, /label="Tooth number"/);
  assert.match(css, /--dur:170ms/);
  assert.match(css, /prefers-reduced-motion/);
});

/**
 * @spec §6.2 — six registers share the chrome: Board, Slate, Chairside,
 * Quiet Room, Route Card and Doorway.
 */
test("the six registers are distinct modes", () => {
  const app = readFileSync("web/src/App.tsx", "utf8");
  const css = readFileSync("web/src/clinical.css", "utf8");
  const screens = readFileSync("web/layout-screens.json", "utf8");
  for (const mode of ["board", "slate", "chairside", "quiet", "route", "doorway"]) {
    assert.match(app, new RegExp(`return "${mode}"`));
    assert.match(css, new RegExp(`data-mode="${mode}"`));
  }
  assert.match(app, /route\.startsWith\("#\/book"\) && !token\(\)/);
  assert.match(screens, /"label": "doorway",\s+"auth": false/);
  assert.match(css, /\[data-mode="slate"\][\s\S]*min-height:64px/);
  assert.match(app, /Session notes are sealed/);
  assert.match(app, /600000/);
});
