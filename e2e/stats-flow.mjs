// 統計の画面（期間の切り替え・分担・守り具合・推移・ランキング）と、家事の詳細の実施カレンダーを本物のブラウザで通す。
// 開発サーバを起こしてから `node e2e/stats-flow.mjs`（`npm run e2e` の最後にも流れる）。
// 別の URL の開発サーバなら BASE=http://localhost:5199 のように渡す（その URL を .dev.vars の ORIGINS に入れておく）。
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.BASE ?? "http://localhost:5173").replace(/\/$/, "");

const jst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const weekdayOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();

const linkOut = execSync(`npm run -s bootstrap-link -- --origin ${BASE}`, { cwd: ROOT }).toString();
const link = linkOut.match(/https?:\/\/\S+\/#login=\S+/)[0];
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

/** 画面の中から API を呼ぶ（Cookie はその端末のもの） */
async function call(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api${path}`, {
        method,
        headers: { "X-Kaji-Client": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
      return j;
    },
    { method, path, body },
  );
}

/** 横にはみ出していないか */
async function noOverflow(page, where) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  if (sw > iw) throw new Error(`${where}: 横にはみ出している（${sw} > ${iw}）`);
}

try {
  step = "setup";
  const { page: phone } = await device({ width: 390, height: 844 });
  await phone.goto(link);
  await phone.getByLabel("名前").fill("たくみ");
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  const family = `統計テスト${Date.now() % 10000}`;
  await phone.getByLabel("Family の名前").fill(family);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await phone.getByRole("heading", { name: "まだ家事がありません" }).waitFor();

  // ---- タブ：スマホの下の固定タブに5つ並ぶ ----
  step = "tabs";
  const tabs = phone.getByRole("navigation", { name: "画面" }).getByRole("button");
  const labels = await tabs.allInnerTexts();
  if (labels.join(",") !== "今日,家事,統計,家族,設定") throw new Error(`タブの並びが違う: ${labels}`);
  for (const t of await tabs.all()) {
    const b = await t.boundingBox();
    if (!b || b.x < 0 || b.x + b.width > 390 || b.height > 56) throw new Error(`タブが収まっていない: ${JSON.stringify(b)}`);
  }
  ok("タブは「今日・家事・統計・家族・設定」、390px でも1行に収まる");

  // ---- 空の統計 ----
  step = "empty";
  await phone.getByRole("button", { name: "統計", exact: true }).click();
  await h1(phone, "統計");
  if (!phone.url().endsWith("/stats")) throw new Error(`URL が /stats でない: ${phone.url()}`);
  await phone.getByText("この期間はまだ記録がありません").waitFor();
  await phone.screenshot({ path: `${SHOTS}/20-stats-empty.png` });
  ok("記録が無いときは空の案内");

  // ---- 家族を招待（はなこ） ----
  step = "invite";
  await phone.getByRole("button", { name: "家族", exact: true }).click();
  await h1(phone, family);
  await phone.getByRole("button", { name: "家族を招待" }).click();
  const inviteLink = await phone.getByLabel("家族を招待のリンク").inputValue();
  await phone.getByRole("button", { name: "閉じる" }).click();
  const { page: wife } = await device({ width: 390, height: 844 });
  await wife.goto(inviteLink);
  await wife.getByLabel("名前").fill("はなこ");
  await wife.getByRole("button", { name: "パスキーを作って参加する" }).click();
  await wife.getByRole("button", { name: "統計", exact: true }).waitFor();
  ok("はなこが参加");

  // ---- 家事と記録を入れる（過去80日ぶん） ----
  step = "seed";
  const [fam] = await call(phone, "GET", "/families");
  const add = (name, schedule) => call(phone, "POST", `/families/${fam.id}/chores`, { name, schedule });
  const gomi = await add("ゴミ出し", { type: "interval", intervalDays: 3, firstDueOn: jst(-80) });
  const furo = await add("風呂掃除", { type: "calendar", rule: { kind: "weekly", weekdays: [weekdayOf(jst(-70))], every: 1, anchor: jst(-70) } });
  const sentaku = await add("洗濯", { type: "interval", intervalDays: 2, firstDueOn: jst(-60) });
  await add("換気扇の掃除", { type: "interval", intervalDays: 90, firstDueOn: jst(30) });
  const log = (page, chore, d) => call(page, "POST", `/chores/${chore.id}/logs`, { doneOn: jst(d) });
  // ゴミ出し：ふたりで交互、ときどき遅れる
  for (let d = -80, i = 0; d <= -1; d += i % 4 === 3 ? 5 : 3, i++) await log(i % 3 ? phone : wife, gomi, d);
  // 風呂掃除：週1、ときどき遅れたりやらなかったり（たくみ）
  for (let d = -70, i = 0; d <= 0; d += 7, i++) if (i % 4 !== 2) await log(phone, furo, Math.min(0, d + (i % 3 === 1 ? 2 : 0)));
  // 洗濯：ほとんどはなこ
  for (let d = -60, i = 0; d <= -1; d += 2 + (i % 5 === 4 ? 2 : 0), i++) await log(i % 6 === 5 ? phone : wife, sentaku, d);
  ok("家事4つと記録を入れた");

  // ---- 統計（スマホ） ----
  step = "stats-phone";
  await phone.getByRole("button", { name: "統計", exact: true }).click();
  await phone.reload();
  await h1(phone, "統計");
  for (const name of ["分担", "家事ごとの担当", "期限の守り具合", "回数の推移", "よく遅れる家事"]) await phone.getByRole("heading", { level: 2, name }).waitFor();
  await phone.locator(".hbars__row", { hasText: "はなこ" }).getByText(/\d+回・\d+%/).waitFor();
  await phone.getByText("期限までにできた").waitFor();
  await noOverflow(phone, "統計（今月・スマホ）");
  await phone.screenshot({ path: `${SHOTS}/21-stats-month-phone.png`, fullPage: true });

  await phone.getByRole("tab", { name: "3か月" }).click();
  await phone.getByText("月ごと", { exact: true }).waitFor();
  await phone.locator(".ranking__row").first().waitFor();
  await noOverflow(phone, "統計（3か月・スマホ）");
  await phone.screenshot({ path: `${SHOTS}/22-stats-3months-phone.png`, fullPage: true });

  await phone.getByRole("tab", { name: "全期間" }).click();
  await phone.getByText(/^全期間（/).waitFor();
  await noOverflow(phone, "統計（全期間・スマホ）");
  ok("統計：今月・3か月・全期間で、分担・担当・守り具合・推移・ランキングが出る（390px ではみ出さない）");

  // ---- 統計（PC） ----
  step = "stats-pc";
  // PC は同じログイン（Cookie）のまま、幅だけ変えて開く
  const pcPage = await phone.context().newPage();
  await pcPage.setViewportSize({ width: 1280, height: 800 });
  await pcPage.goto(`${BASE}/stats`);
  await h1(pcPage, "統計");
  await pcPage.getByRole("tab", { name: "3か月" }).click();
  await pcPage.getByText("月ごと", { exact: true }).waitFor();
  await noOverflow(pcPage, "統計（PC）");
  await pcPage.screenshot({ path: `${SHOTS}/23-stats-pc.png`, fullPage: true });
  ok("統計：1280px でも崩れない");

  // ---- 家事の詳細：実施カレンダー ----
  step = "calendar";
  await phone.goto(`${BASE}/chores/${furo.id}`);
  await h1(phone, "風呂掃除");
  await phone.getByRole("list", { name: "印の見方" }).waitFor();
  await phone.locator(".hcal__month").first().waitFor();
  if ((await phone.locator(".hcal__day.is-done").count()) < 5) throw new Error("やった日の印が少ない");
  if ((await phone.locator(".hcal__day.due-missed").count()) < 1) throw new Error("やらずに過ぎた回の印が無い");
  await noOverflow(phone, "詳細（スマホ）");
  await phone.screenshot({ path: `${SHOTS}/24-calendar-phone.png`, fullPage: true });
  await pcPage.goto(`${BASE}/chores/${gomi.id}`);
  await h1(pcPage, "ゴミ出し");
  await pcPage.locator(".hcal__month").first().waitFor();
  await noOverflow(pcPage, "詳細（PC）");
  await pcPage.screenshot({ path: `${SHOTS}/25-calendar-pc.png`, fullPage: true });
  ok("家事の詳細の「これまで」に実施カレンダー（やった日・予定日・やらずに過ぎた回）");
} catch (e) {
  console.log(`止まった場所: ${step}`);
  errors.push(String(e).split("\n").slice(0, 8).join("\n"));
}

await browser.close();
if (errors.length) {
  console.log("エラー:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ALL OK");
