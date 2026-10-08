// public/icons/icon.svg から PWA のアイコン（PNG）を作る：`node scripts/make-icons.mjs`
// - icon-192.png・icon-512.png：角丸の中に収まる普通のアイコン（OS が角を丸める前提で、地は四角のまま）
// - icon-maskable-512.png：maskable。安全域（中央 80%）に図柄が入るよう、図柄を縮めて地を広げる
// - apple-touch-icon.png（180）：iOS のホーム画面
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public", "icons");
const svg = readFileSync(join(DIR, "icon.svg"), "utf8");
const BG = "#2F4F6F";

const targets = [
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.8 },
  { file: "apple-touch-icon.png", size: 180, scale: 1 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, size, scale } of targets) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * scale);
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:${BG};display:grid;place-items:center">
      <div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div>
    </body></html>`,
  );
  await page.screenshot({ path: join(DIR, file), clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`wrote public/icons/${file}`);
}
await browser.close();
