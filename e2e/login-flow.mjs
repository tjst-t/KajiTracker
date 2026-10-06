// 本物のブラウザ（Chromium）と Chrome の仮想パスキーで、ログインの流れを最初から最後まで通す。
// 開発サーバ（npm run dev、ポート 5173）を起こしてから `npm run e2e`。
// 初回は `npx playwright install --with-deps chromium` が要る。
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });

const out = execSync("npm run -s bootstrap-link", { cwd: ROOT }).toString();
const link = out.match(/http:\/\/localhost:5173\/#login=\S+/)[0];
console.log("bootstrap link ok");

const browser = await chromium.launch();
const errors = [];

async function device(viewport, userAgent) {
  const ctx = await browser.newContext({ viewport, userAgent, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return page;
}

const phone = await device({ width: 390, height: 844 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");

// 最初の1人
await phone.goto(link);
await phone.getByLabel("名前").fill("たくみ");
await phone.screenshot({ path: `${SHOTS}/01-bootstrap-name.png` });
await phone.getByRole("button", { name: "はじめる" }).click();
await phone.getByRole("heading", { name: "この端末のパスキーを作る" }).waitFor();
if (phone.url().includes("#login=")) throw new Error("札が URL に残っている");
await phone.screenshot({ path: `${SHOTS}/02-create-passkey.png` });
await phone.getByRole("button", { name: "パスキーを作る" }).click();
await phone.getByRole("heading", { name: "たくみさん、こんにちは" }).waitFor();
console.log("bootstrap → passkey → home ok");

// 設定と端末を追加
await phone.getByRole("button", { name: "設定" }).click();
await phone.getByText("iPhone の Safari").first().waitFor();
await phone.screenshot({ path: `${SHOTS}/03-settings.png`, fullPage: true });
await phone.getByRole("button", { name: "端末を追加" }).click();
await phone.getByAltText("端末を追加するための QR コード").waitFor();
await phone.screenshot({ path: `${SHOTS}/04-add-device.png` });
const deviceLink = await phone.getByLabel("端末を追加するためのリンク").inputValue();
console.log("device ticket ok");

// PC で入る
const pc = await device({ width: 1280, height: 800 }, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
await pc.goto(deviceLink);
await pc.getByRole("heading", { name: "この端末のパスキーを作る" }).waitFor();
await pc.getByLabel(/パスキーの名前/).fill("書斎の PC");
await pc.getByRole("button", { name: "パスキーを作る" }).click();
await pc.getByRole("heading", { name: "たくみさん、こんにちは" }).waitFor();
console.log("pc redeem → passkey → home ok");

// スマホ側に「入りました」が出る
await phone.getByText(/Windows の Chromeが入りました/).waitFor({ timeout: 10000 });
await phone.screenshot({ path: `${SHOTS}/05-device-joined.png` });
console.log("phone sees joined ok");
await phone.getByRole("button", { name: "閉じる" }).click();
await phone.getByText("書斎の PC").waitFor();

// ログアウトしてパスキーでログイン
await phone.getByRole("button", { name: "ログアウト" }).click();
await phone.getByRole("button", { name: "パスキーでログイン" }).waitFor();
await phone.screenshot({ path: `${SHOTS}/06-login.png` });
await phone.getByRole("button", { name: "パスキーでログイン" }).click();
// ログアウト前にいた「設定」の画面に戻る
await phone
  .getByRole("heading", { name: "設定", level: 1 })
  .waitFor({ timeout: 10000 })
  .catch(async (e) => {
    console.log("画面:", await phone.locator("main").innerText());
    throw e;
  });
console.log("logout → passkey login ok");

// PC の画面（広い幅）
await pc.getByRole("button", { name: "設定" }).click();
await pc.getByText("書斎の PC").waitFor();
await pc.screenshot({ path: `${SHOTS}/07-settings-pc.png`, fullPage: true });

await browser.close();
if (errors.length) {
  console.log("ブラウザのエラー:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ALL OK");
