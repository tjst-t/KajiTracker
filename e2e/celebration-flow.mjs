// 完了の演出：1件済ませると「済」の判子が押される動きと「今日 1/2」、全部済むと「皆済」の画面と紙吹雪（1日1回）。
// 動きを減らす設定（reduced motion）と、設定の「完了の演出」オフでは静かになる。
// 開発サーバを起こしてから `npm run e2e`（todos-flow のあとに流れる）。
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });

const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:5173";
const jst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);

const link = execSync(`npm run -s bootstrap-link -- --origin ${ORIGIN}`, { cwd: ROOT }).toString().match(/http:\/\/localhost:\d+\/#login=\S+/)[0];
const browser = await chromium.launch();
const errors = [];
let step = "";
const ok = (s) => console.log(`ok: ${s}`);

async function device(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ja-JP" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 401") && errors.push(`[${step}] console: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { page, ctx };
}
const h1 = (page, name) => page.getByRole("heading", { level: 1, name }).waitFor();
const tab = (page, name) => page.getByRole("navigation", { name: "画面" }).getByRole("button", { name, exact: true });

/** 今日が期限の家事（7日ごと、最初の期限が今日）を登録して、今日の画面へ */
async function addTodayChore(page, name) {
  await tab(page, "家事").click();
  await page.getByRole("button", { name: "家事を登録" }).click();
  await h1(page, "家事を登録");
  await page.getByLabel("家事の名前").fill(name);
  await page.getByLabel("何日ごと").fill("7");
  await page.getByLabel("最初の期限").fill(jst());
  await page.getByRole("button", { name: "登録する" }).click();
  await h1(page, name);
}
async function openToday(page) {
  await tab(page, "今日").click();
  await page.getByRole("heading", { name: "やること" }).waitFor();
}
const heading = (page) => page.getByRole("heading", { name: /^やること/ });
async function headingHas(page, text) {
  await page.waitForFunction((t) => document.querySelector("#t-due")?.textContent?.includes(t), text, { timeout: 5000 }).catch(async () => {
    throw new Error(`見出しに「${text}」が無い: ${await heading(page).textContent()}`);
  });
}
const fuda = (page, name) => page.locator(".fuda-wrap", { hasText: name });
const kaisai = (page) => page.getByRole("dialog", { name: "今日の当番、ぜんぶ済みました" });

try {
  step = "setup";
  const { page } = await device({ width: 390, height: 844 });
  await page.goto(link);
  await page.getByLabel("名前").fill("たくみ");
  await page.getByRole("button", { name: "はじめる" }).click();
  await page.getByRole("button", { name: "パスキーを作る" }).click();
  await page.getByLabel("Family の名前").fill(`演出テスト${Date.now() % 10000}`);
  await page.getByRole("button", { name: "Family を作る" }).click();
  await page.getByRole("heading", { name: "まだ家事がありません" }).waitFor();
  await addTodayChore(page, "ゴミ出し");
  await addTodayChore(page, "洗濯");
  await openToday(page);
  await headingHas(page, "今日 0/2");
  ok("今日が期限の家事を2件。見出しの横に「今日 0/2」");

  // ---- 1件目：判子が押される動き・進み具合 ----
  step = "first";
  await fuda(page, "ゴミ出し").getByRole("button", { name: "やった" }).click();
  const stamp = fuda(page, "ゴミ出し").locator(".hanko--done.is-stamping");
  await stamp.waitFor();
  if (!(await fuda(page, "ゴミ出し").evaluate((el) => el.classList.contains("is-stamped")))) throw new Error("札の枠が光るクラスが無い");
  await page.waitForTimeout(480);
  await page.screenshot({ path: `${SHOTS}/70-stamp.png` });
  await headingHas(page, "今日 1/2");
  if ((await kaisai(page).count()) !== 0) throw new Error("1件目で皆済が出た");
  ok("1件目の「やった」で「済」の判子が押される動き（is-stamping）、見出しが「今日 1/2」");

  // ---- 2件目：皆済の画面と紙吹雪 ----
  step = "kaisai";
  await fuda(page, "洗濯").getByRole("button", { name: "やった" }).click();
  await kaisai(page).waitFor();
  const opened = Date.now();
  const canvas = page.locator("canvas.kaisai__confetti");
  await canvas.waitFor({ state: "attached", timeout: 1000 });
  if ((await canvas.getAttribute("aria-hidden")) !== "true") throw new Error("紙吹雪の canvas に aria-hidden が無い");
  if ((await kaisai(page).getAttribute("aria-modal")) !== "true") throw new Error("皆済の画面に aria-modal が無い");
  await page.waitForTimeout(550);
  await page.screenshot({ path: `${SHOTS}/71-kaisai.png` });
  if (!(await page.evaluate(() => document.activeElement?.textContent === "閉じる"))) throw new Error("閉じるにフォーカスが無い");
  await kaisai(page).getByText("今日済ませたのは 2件").waitFor();
  await kaisai(page).getByText("たくみ 2").waitFor();
  await canvas.waitFor({ state: "detached", timeout: 4000 });
  const took = Date.now() - opened;
  if (took < 1500 || took > 3500) throw new Error(`紙吹雪の長さがおかしい: ${took}ms`);
  await page.waitForTimeout(1200);
  if (!(await kaisai(page).isVisible())) throw new Error("皆済の画面が自動で閉じた");
  await page.screenshot({ path: `${SHOTS}/72-kaisai-after.png` });
  await kaisai(page).getByRole("button", { name: "閉じる" }).click();
  await kaisai(page).waitFor({ state: "hidden" });
  ok(`2件目で「皆済」の画面（dialog・閉じるにフォーカス）、紙吹雪は ${took}ms で消え、内訳「たくみ 2」。閉じるで閉じる`);

  // ---- 取り消して済ませ直しても、2回目は出ない ----
  step = "again";
  await fuda(page, "洗濯").getByRole("button", { name: "取り消す" }).click();
  await headingHas(page, "今日 1/2");
  await fuda(page, "洗濯").getByRole("button", { name: "やった" }).click();
  await headingHas(page, "今日 2/2");
  await page.waitForTimeout(1000);
  if ((await kaisai(page).count()) !== 0) throw new Error("同じ日に皆済が2回出た");
  ok("取り消して済ませ直しても、同じ日には皆済を出さない");

  // ---- 並べ直したあと、「やること」に静かな皆済 ----
  step = "quiet";
  await page.locator(".all-clear--kaisai", { hasText: "今日の当番は、ぜんぶ済みました" }).waitFor({ timeout: 10000 });
  await page.locator(".all-clear__seal").waitFor();
  await page.screenshot({ path: `${SHOTS}/73-quiet-kaisai.png` });
  ok("6秒たって並べ直すと、「やること」に小さな皆済の判子と一言");

  // ---- 動きを減らす設定：紙吹雪・動きなし。判子と文は出る。Esc で閉じる ----
  step = "reduced";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => localStorage.removeItem("kaji.kaisai"));
  await addTodayChore(page, "風呂掃除");
  await openToday(page);
  await fuda(page, "風呂掃除").getByRole("button", { name: "やった" }).click();
  await kaisai(page).waitFor();
  await page.waitForTimeout(400);
  if ((await page.locator("canvas").count()) !== 0) throw new Error("動きを減らす設定で紙吹雪が出た");
  if ((await fuda(page, "風呂掃除").locator(".is-stamping").count()) !== 0) throw new Error("動きを減らす設定で判子が動いた");
  if (await kaisai(page).evaluate((el) => el.classList.contains("is-moving"))) throw new Error("動きを減らす設定で皆済が動いた");
  await kaisai(page).getByText("今日済ませたのは 3件").waitFor();
  await page.screenshot({ path: `${SHOTS}/74-kaisai-reduced.png` });
  await page.keyboard.press("Escape");
  await kaisai(page).waitFor({ state: "hidden" });
  ok("reduced motion：皆済の判子と文は出るが、紙吹雪・判子の動きは無い。Esc で閉じる");

  // ---- 設定で「完了の演出」をオフ ----
  step = "setting-off";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${ORIGIN}/settings`);
  await h1(page, "設定");
  const toggle = page.getByLabel("完了の演出");
  if (!(await toggle.isChecked())) throw new Error("完了の演出が初めからオンでない");
  await toggle.uncheck();
  await addTodayChore(page, "皿洗い");
  await openToday(page);
  await fuda(page, "皿洗い").getByRole("button", { name: "やった" }).click();
  await fuda(page, "皿洗い").locator(".hanko--done").waitFor();
  if ((await fuda(page, "皿洗い").locator(".is-stamping").count()) !== 0) throw new Error("演出オフで判子が動いた");
  if (await fuda(page, "皿洗い").evaluate((el) => el.classList.contains("is-stamped"))) throw new Error("演出オフで札が光った");
  ok("設定で「完了の演出」をオフにすると、判子の動きのクラスが付かない");

  // 設定を戻しておく（同じ端末で別の流れを試すときのため）
  await page.goto(`${ORIGIN}/settings`);
  await page.getByLabel("完了の演出").check();

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("ALL OK");
} catch (e) {
  console.error(`NG [${step}]`, e);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
