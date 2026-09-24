import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const families = [
  ["Noto Sans Devanagari", "devanagari"],
  ["Noto Sans Telugu", "telugu"],
  ["Noto Sans Bengali", "bengali"],
];

const query = families.map(([name]) => `family=${encodeURIComponent(name)}:wght@400`).join("&");
const cssUrl = `https://fonts.googleapis.com/css2?${query}&display=swap`;
const css = await fetch(cssUrl, {
  headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" },
}).then((res) => {
  if (!res.ok) throw new Error(`font css ${res.status}`);
  return res.text();
});

const dir = "web/public/fonts";
await mkdir(dir, { recursive: true });
const blocks = css.split("@font-face").slice(1);
const out = [];
let n = 0;
for (const block of blocks) {
  const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
  const slug = families.find(([name]) => name === family)?.[1];
  const src = /url\((https:[^)]+)\)/.exec(block)?.[1];
  const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
  if (!slug || !src || !range) continue;
  const file = `${slug}-${n}.woff2`;
  n += 1;
  const bytes = Buffer.from(await fetch(src).then((res) => res.arrayBuffer()));
  await writeFile(join(dir, file), bytes);
  out.push(`@font-face{font-family:"${family}";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/${file}") format("woff2");unicode-range:${range};}`);
}
await writeFile("web/src/fonts.css", `${out.join("\n")}\n`);
console.log(`wrote ${out.length} faces`);
