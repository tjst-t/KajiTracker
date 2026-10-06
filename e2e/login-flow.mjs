// 本物のブラウザ（Chromium）と Chrome の仮想パスキーで、ログインと Family の流れを最初から最後まで通す。
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

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const PHONE = { width: 390, height: 844 };

const family = `辻下家${Date.now() % 10000}`; // 何度流しても名前が重ならないように

const out = execSync("npm run -s bootstrap-link", { cwd: ROOT }).toString();
const link = out.match(/http:\/\/localhost:5173\/#login=\S+/)[0];

const browser = await chromium.launch();
const errors = [];
let step = "";
const ok = (s) => console.log(`ok: ${s}`);

async function device(viewport, userAgent) {
  const ctx = await browser.newContext({ viewport, userAgent, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  // ログインしていない端末の /api/me が 401 を返すのは正常なので数えない
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 401") && errors.push(`[${step}] console: ${m.text()}`));
  page.on("dialog", (d) => d.accept()); // confirm() は「OK」
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return page;
}
const h1 = (page, name) => page.getByRole("heading", { level: 1, name }).waitFor();
const todayOf = (page, fam) => page.getByText(`${fam}の当番表`).waitFor();

try {
  // ---- 最初の1人 ----
  step = "bootstrap";
  const phone = await device(PHONE, IPHONE);
  await phone.goto(link);
  await phone.getByLabel("名前").fill("たくみ");
  await phone.screenshot({ path: `${SHOTS}/01-bootstrap-name.png` });
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("heading", { name: "この端末のパスキーを作る" }).waitFor();
  if (phone.url().includes("#login=")) throw new Error("札が URL に残っている");
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  await h1(phone, "たくみさん、まず Family を作りましょう");
  await phone.screenshot({ path: `${SHOTS}/02-family-create.png` });
  await phone.getByLabel("Family の名前").fill(family);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await todayOf(phone, family);
  ok("最初の1人 → パスキー → Family を作る");

  // ---- 端末を追加（PC） ----
  step = "add-device";
  await phone.getByRole("button", { name: "設定", exact: true }).click();
  await phone.getByRole("button", { name: "端末を追加" }).click();
  await phone.getByAltText("端末を追加の QR コード").waitFor();
  await phone.screenshot({ path: `${SHOTS}/03-add-device.png` });
  const deviceLink = await phone.getByLabel("端末を追加のリンク").inputValue();
  const pc = await device({ width: 1280, height: 800 }, WINDOWS);
  await pc.goto(deviceLink);
  await pc.getByLabel(/パスキーの名前/).fill("書斎の PC");
  await pc.getByRole("button", { name: "パスキーを作る" }).click();
  await todayOf(pc, family);
  await phone.getByText(/Windows の Chromeが入りました/).waitFor({ timeout: 10000 });
  await phone.getByRole("button", { name: "閉じる" }).click();
  ok("端末を追加（PC で入り、スマホに「入りました」）");

  // ---- 家族を招待（妻・初めて） ----
  step = "invite";
  await phone.getByRole("button", { name: "家族", exact: true }).click();
  await h1(phone, family);
  await phone.getByRole("button", { name: "家族を招待" }).click();
  await phone.getByAltText("家族を招待の QR コード").waitFor();
  await phone.screenshot({ path: `${SHOTS}/04-invite-qr.png` });
  const inviteLink = await phone.getByLabel("家族を招待のリンク").inputValue();
  const wife = await device(PHONE, ANDROID);
  await wife.goto(inviteLink);
  await wife.getByRole("heading", { name: `たくみさんが「${family}」に招待しています` }).waitFor();
  if (wife.url().includes("#invite=")) throw new Error("招待が URL に残っている");
  await wife.getByLabel("名前").fill("はなこ");
  await wife.screenshot({ path: `${SHOTS}/05-invite-accept.png` });
  await wife.getByRole("button", { name: "パスキーを作って参加する" }).click();
  await todayOf(wife, family);
  await phone.getByText("はなこさんが入りました").waitFor({ timeout: 10000 });
  await phone.getByRole("button", { name: "閉じる" }).click();
  await phone.getByText("はなこ", { exact: true }).waitFor();
  ok("招待の QR から妻が初めて登録して参加、たくみに「入りました」");

  // ---- 役割と回復の札 ----
  step = "roles";
  await phone.getByRole("button", { name: "管理者にする" }).click();
  await phone.getByText("はなこさんを管理者にしました").waitFor();
  await phone.getByRole("button", { name: "ログインできなくなったとき" }).click();
  await phone.getByAltText(/ログインの札の QR コード/).waitFor();
  await phone.screenshot({ path: `${SHOTS}/06-recovery.png` });
  const recoveryLink = await phone.getByLabel(/ログインの札のリンク/).inputValue();
  const wifeNew = await device(PHONE, IPHONE);
  await wifeNew.goto(recoveryLink);
  await wifeNew.getByRole("button", { name: "パスキーを作る" }).click();
  await todayOf(wifeNew, family);
  await phone.getByText(/iPhone の Safariで入りました/).waitFor({ timeout: 10000 });
  await phone.getByRole("button", { name: "閉じる" }).click();
  await wifeNew.getByRole("button", { name: "設定", exact: true }).click();
  await wifeNew.getByText("たくみさんが出した札で入った").waitFor();
  ok("妻を管理者に → 回復の札で妻の新しい iPhone が入る（「たくみさんが出した札」と残る）");
  await phone.screenshot({ path: `${SHOTS}/07-family.png`, fullPage: true });

  // ---- 2つ目の Family と切り替え ----
  step = "second-family";
  await phone.getByLabel("新しい Family の名前").fill("実家");
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await h1(phone, "実家");
  await phone.getByLabel("Family を切り替える").selectOption({ label: family });
  await h1(phone, family);
  const header = await phone.evaluate(() => ({ y: scrollY, top: document.querySelector(".topbar").getBoundingClientRect().top }));
  console.log("スクロールとヘッダーの位置:", JSON.stringify(header));
  if (header.top !== 0) throw new Error(`ヘッダーが上に留まっていない: ${JSON.stringify(header)}`);
  await phone.screenshot({ path: `${SHOTS}/08-switch.png` });
  ok("2つ目の Family を作って切り替え");

  // ---- ログアウトしてパスキーでログイン ----
  step = "relogin";
  await phone.getByRole("button", { name: "設定", exact: true }).click();
  await phone.getByRole("button", { name: "ログアウト" }).click();
  await phone.getByRole("button", { name: "パスキーでログイン" }).click();
  await h1(phone, "設定");
  await wife.getByRole("button", { name: "設定", exact: true }).click();
  await wife.getByRole("button", { name: "ログアウト" }).click();
  await wife.getByRole("button", { name: "パスキーでログイン" }).click();
  await h1(wife, "設定");
  ok("たくみ・妻とも、ログアウトしてパスキーでログインし直せる");
  await pc.getByRole("button", { name: "家族", exact: true }).click();
  await h1(pc, family);
  await pc.screenshot({ path: `${SHOTS}/09-family-pc.png`, fullPage: true });
} catch (e) {
  console.log(`止まった場所: ${step}`);
  errors.push(String(e));
}

await browser.close();
if (errors.length) {
  console.log("エラー:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ALL OK");
