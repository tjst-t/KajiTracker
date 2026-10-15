// 完了の演出：1件済ませると大きな「済」の判子・小さな紙吹雪・「＋1」・知らせ「ゴミ出し 完了！」と「今日 1/2」、
// 全部済むと花丸が描かれて判子「よくできました」・左右からの紙吹雪・「今日の当番、ぜんぶ完了！」（1日1回）。
// 動きを減らす設定（reduced motion）と、設定の「完了の演出」オフでは canvas も動きも出さない。
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
const allDone = (page) => page.getByRole("dialog", { name: "今日の当番、ぜんぶ完了！" });
const toast = (page) => page.getByRole("status").filter({ hasText: "完了！" });
/** 「皆済」という文字がどこにも無いか */
async function noKaisai(page, where) {
  if (await page.evaluate(() => document.documentElement.outerHTML.includes("皆済"))) throw new Error(`${where}: 「皆済」が出ている`);
}
/** 動きを止めているとき：canvas・＋1・揺れ・花丸を描く動きが無い */
async function quiet(page, where) {
  if ((await page.locator("canvas").count()) !== 0) throw new Error(`${where}: 紙吹雪の canvas が出た`);
  if ((await page.locator(".plus-one, .is-stamping, .is-stamped, .is-bumping, .day-progress__shine").count()) !== 0) throw new Error(`${where}: 判子・＋1・跳ねが動いた`);
}

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

  // ---- 1件目：大きな判子・小さな紙吹雪・＋1・知らせ・進み具合 ----
  step = "first";
  await fuda(page, "ゴミ出し").getByRole("button", { name: "やった" }).click();
  const stamp = fuda(page, "ゴミ出し").locator(".hanko--done.is-stamping");
  await stamp.waitFor();
  const stampedAt = Date.now();
  if (!(await fuda(page, "ゴミ出し").evaluate((el) => el.classList.contains("is-stamped")))) throw new Error("札の枠が光るクラスが無い");
  const burst = page.locator("canvas.confetti--burst");
  await burst.waitFor({ state: "attached", timeout: 1000 });
  if ((await burst.getAttribute("aria-hidden")) !== "true") throw new Error("紙吹雪の canvas に aria-hidden が無い");
  const plus = fuda(page, "ゴミ出し").locator(".plus-one");
  if ((await plus.textContent()) !== "＋1") throw new Error(`「＋1」が無い: ${await plus.textContent()}`);
  await toast(page).getByText("ゴミ出し 完了！").waitFor({ timeout: 1000 });
  if ((await toast(page).getByRole("button").count()) !== 0) throw new Error("知らせにボタンがある");
  await page.waitForTimeout(Math.max(0, 560 - (Date.now() - stampedAt)));
  await page.screenshot({ path: `${SHOTS}/70-stamp.png` });
  await page.waitForTimeout(180);
  await page.screenshot({ path: `${SHOTS}/71-stamp-confetti.png` });
  await headingHas(page, "今日 1/2");
  if ((await page.locator(".day-progress__num b.is-bumping").count()) !== 1) throw new Error("数字が跳ねない");
  if ((await page.locator(".day-progress__shine").count()) !== 1) throw new Error("棒に光が走らない");
  if ((await allDone(page).count()) !== 0) throw new Error("1件目でぜんぶ完了が出た");
  await burst.waitFor({ state: "detached", timeout: 2500 });
  const burstMs = Date.now() - stampedAt;
  if (burstMs > 2200) throw new Error(`小さな紙吹雪が長い: ${burstMs}ms`);
  await toast(page).getByText("ゴミ出し 完了！").waitFor({ state: "detached", timeout: 2500 });
  await noKaisai(page, "1件目");
  ok(`1件目で判子が押され、小さな紙吹雪（${burstMs}ms で消える）・「＋1」・知らせ「ゴミ出し 完了！」、見出しが「今日 1/2」で跳ねる`);

  // ---- 2件目：花丸と「よくできました」、左右からの紙吹雪 ----
  step = "all-done";
  await fuda(page, "洗濯").getByRole("button", { name: "やった" }).click();
  await allDone(page).waitFor();
  const opened = Date.now();
  const cannons = page.locator("canvas.confetti--cannons");
  await cannons.waitFor({ state: "attached", timeout: 1000 });
  if ((await cannons.getAttribute("aria-hidden")) !== "true") throw new Error("紙吹雪の canvas に aria-hidden が無い");
  if ((await allDone(page).getAttribute("aria-modal")) !== "true") throw new Error("ぜんぶ完了の画面に aria-modal が無い");
  if (!(await allDone(page).evaluate((el) => el.classList.contains("is-moving")))) throw new Error("ぜんぶ完了の画面が動いていない");
  const strokes = allDone(page).locator(".hanamaru__draw path");
  if ((await strokes.count()) < 8) throw new Error("花丸の線が無い");
  const dash = await strokes.first().evaluate((el) => getComputedStyle(el).strokeDasharray);
  if (dash === "none") throw new Error("花丸が筆で描かれていない（stroke-dasharray が無い）");
  const seal = await allDone(page).locator(".hanamaru__seal").textContent();
  if (seal?.replace(/\s/g, "") !== "よくできました") throw new Error(`判子が「よくできました」でない: ${seal}`);
  await page.waitForTimeout(Math.max(0, 600 - (Date.now() - opened)));
  await page.screenshot({ path: `${SHOTS}/72-hanamaru-drawing.png` });
  await page.waitForTimeout(Math.max(0, 1180 - (Date.now() - opened)));
  await page.screenshot({ path: `${SHOTS}/73-hanamaru-stamp.png` });
  if (!(await page.evaluate(() => document.activeElement?.textContent === "閉じる"))) throw new Error("閉じるにフォーカスが無い");
  await allDone(page).getByText("今日済ませたのは2件").waitFor();
  await allDone(page).getByRole("listitem", { name: "たくみ 2件" }).locator(".hanamaru-mark").waitFor();
  await page.waitForTimeout(Math.max(0, 2200 - (Date.now() - opened)));
  await page.screenshot({ path: `${SHOTS}/74-hanamaru-confetti.png` });
  await cannons.waitFor({ state: "detached", timeout: 7000 });
  const took = Date.now() - opened;
  if (took < 3500 || took > 5800) throw new Error(`紙吹雪の長さがおかしい: ${took}ms`);
  await page.waitForTimeout(800);
  if (!(await allDone(page).isVisible())) throw new Error("ぜんぶ完了の画面が自動で閉じた");
  await page.screenshot({ path: `${SHOTS}/75-hanamaru-after.png` });
  await noKaisai(page, "ぜんぶ完了");
  await allDone(page).getByRole("button", { name: "閉じる" }).click();
  await allDone(page).waitFor({ state: "hidden" });
  ok(`2件目で花丸と判子「よくできました」・「今日の当番、ぜんぶ完了！」（dialog・閉じるにフォーカス）、内訳「たくみ ✿2」、左右の紙吹雪は ${took}ms で消える`);

  // ---- 取り消して済ませ直しても、2回目は出ない ----
  step = "again";
  await fuda(page, "洗濯").getByRole("button", { name: "取り消す" }).click();
  await headingHas(page, "今日 1/2");
  await fuda(page, "洗濯").getByRole("button", { name: "やった" }).click();
  await headingHas(page, "今日 2/2");
  await page.waitForTimeout(1000);
  if ((await allDone(page).count()) !== 0) throw new Error("同じ日にぜんぶ完了が2回出た");
  ok("取り消して済ませ直しても、同じ日にはぜんぶ完了を出さない");

  // ---- 並べ直したあと、「やること」に静かな花丸 ----
  step = "quiet";
  await page.locator(".all-clear--hanamaru", { hasText: "今日はぜんぶ完了" }).waitFor({ timeout: 10000 });
  await page.locator(".all-clear__mark").waitFor();
  await noKaisai(page, "静かな花丸");
  await page.screenshot({ path: `${SHOTS}/76-quiet-hanamaru.png` });
  ok("6秒たって並べ直すと、「やること」に小さな花丸と「今日はぜんぶ完了」");

  // ---- 動きを減らす設定：canvas・揺れ・＋1・跳ねなし。花丸と判子は描き終わった形で、知らせは出る。Esc で閉じる ----
  step = "reduced";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => localStorage.removeItem("kaji.allDone"));
  await addTodayChore(page, "風呂掃除");
  await openToday(page);
  await fuda(page, "風呂掃除").getByRole("button", { name: "やった" }).click();
  await allDone(page).waitFor();
  await toast(page).getByText("風呂掃除 完了！").waitFor({ timeout: 1000 });
  await page.waitForTimeout(400);
  await quiet(page, "reduced motion");
  if (await allDone(page).evaluate((el) => el.classList.contains("is-moving"))) throw new Error("動きを減らす設定でぜんぶ完了が動いた");
  if ((await strokes.first().evaluate((el) => getComputedStyle(el).strokeDasharray)) !== "none") throw new Error("動きを減らす設定で花丸を描く動きがある");
  await allDone(page).getByText("今日済ませたのは3件").waitFor();
  await page.screenshot({ path: `${SHOTS}/77-hanamaru-reduced.png` });
  await page.keyboard.press("Escape");
  await allDone(page).waitFor({ state: "hidden" });
  ok("reduced motion：花丸と判子は描き終わった形で、知らせ「風呂掃除 完了！」は出る。canvas・＋1・跳ねは無い。Esc で閉じる");

  // ---- 設定で「完了の演出」をオフ ----
  step = "setting-off";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${ORIGIN}/settings`);
  await h1(page, "設定");
  const toggle = page.getByLabel("完了の演出");
  if (!(await toggle.isChecked())) throw new Error("完了の演出が初めからオンでない");
  await toggle.uncheck();
  await page.evaluate(() => localStorage.removeItem("kaji.allDone"));
  await addTodayChore(page, "皿洗い");
  await openToday(page);
  await fuda(page, "皿洗い").getByRole("button", { name: "やった" }).click();
  await fuda(page, "皿洗い").locator(".hanko--done").waitFor();
  await toast(page).getByText("皿洗い 完了！").waitFor({ timeout: 1000 });
  await allDone(page).waitFor();
  await page.waitForTimeout(400);
  await quiet(page, "演出オフ");
  if (await allDone(page).evaluate((el) => el.classList.contains("is-moving"))) throw new Error("演出オフでぜんぶ完了が動いた");
  await allDone(page).getByRole("button", { name: "閉じる" }).click();
  ok("設定で「完了の演出」をオフにすると、canvas・判子の動き・＋1 が無く、知らせと花丸は出る");

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
