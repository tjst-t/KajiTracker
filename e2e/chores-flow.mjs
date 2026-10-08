// 家事の登録・今日の画面（当番札・ワンタップ・取り消し）・家事の詳細・一覧を本物のブラウザで通す。
// 開発サーバを起こしてから `npm run e2e`（login-flow のあとに流れる）。
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
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

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

async function addChore(page, fill) {
  await page.getByRole("button", { name: "家事", exact: true }).click();
  await page.getByRole("button", { name: "家事を登録" }).click();
  await h1(page, "家事を登録");
  await fill();
  await page.getByRole("button", { name: "登録する" }).click();
}

try {
  step = "setup";
  const { page: phone, ctx } = await device({ width: 390, height: 844 });
  await phone.goto(link);
  await phone.getByLabel("名前").fill("たくみ");
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  await phone.getByLabel("Family の名前").fill(`家事テスト${Date.now() % 10000}`);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await phone.getByRole("heading", { name: "まだ家事がありません" }).waitFor();
  await phone.screenshot({ path: `${SHOTS}/10-today-empty.png` });
  ok("Family を作ると、今日の画面に「まだ家事がありません」");

  // ---- 家事を登録：前回からの日数（3日前が期限＝3日遅れ） ----
  step = "add-interval";
  await addChore(phone, async () => {
    await phone.getByLabel("家事の名前").fill("ゴミ出し");
    await phone.getByLabel("グループ").selectOption({ label: "ゴミ捨て" });
    await phone.getByLabel("何日ごと").fill("7");
    await phone.getByLabel("最初の期限").fill(jst(-3));
    await phone.getByText("もう 3日 過ぎています").waitFor();
    await phone.screenshot({ path: `${SHOTS}/11-form-interval.png`, fullPage: true });
  });
  await h1(phone, "ゴミ出し");
  ok("前回からの日数の家事を登録（プレビューに「もう 3日 過ぎています」）");

  // ---- カレンダー固定：今日の曜日、毎週 ----
  step = "add-calendar";
  const wd = "日月火水木金土"[new Date(jst() + "T00:00:00Z").getUTCDay()];
  await addChore(phone, async () => {
    await phone.getByLabel("家事の名前").fill("シーツ交換");
    await phone.getByText("カレンダーで決まった日").click();
    for (const w of "日月火水木金土") {
      const box = phone.getByLabel(w, { exact: true });
      if ((await box.isChecked()) !== (w === wd)) await box.setChecked(w === wd, { force: true });
    }
    await phone.getByText(`毎週 ${wd}曜。次の期限は`).waitFor();
  });
  await h1(phone, "シーツ交換");

  // 隔週・最初の予定日つき（来週の同じ曜日から）
  await addChore(phone, async () => {
    await phone.getByLabel("家事の名前").fill("換気扇の掃除");
    await phone.getByText("カレンダーで決まった日").click();
    await phone.getByLabel("何週ごと").selectOption("2");
    await phone.getByLabel(/最初の予定日/).fill(jst(7));
    await phone.screenshot({ path: `${SHOTS}/12-form-calendar.png`, fullPage: true });
  });
  await h1(phone, "換気扇の掃除");
  ok("カレンダー固定（毎週・隔週＋最初の予定日）を登録");

  // ---- 今日の画面：当番札 ----
  step = "today";
  await phone.getByRole("button", { name: "今日", exact: true }).click();
  await phone.getByRole("heading", { name: "やること" }).waitFor();
  const fudaNames = await phone.locator(".fuda:not(.fuda--back) .fuda__name").allInnerTexts();
  if (fudaNames.join(",") !== "ゴミ出し,シーツ交換") throw new Error(`札の並びが違う: ${fudaNames}`);
  await phone.getByLabel("3日遅れ").waitFor();
  await phone.getByLabel("今日まで").waitFor();
  await phone.locator(".fuda-wrap", { hasText: "ゴミ出し" }).locator(".fuda__group", { hasText: "ゴミ捨て" }).waitFor();
  await phone.getByText("換気扇の掃除").waitFor(); // 近いうち
  await phone.screenshot({ path: `${SHOTS}/13-today.png`, fullPage: true });
  ok("今日の画面：遅れ（3日遅れの判子）が先、今日のものが次。隔週は「近いうち」");

  // ---- ワンタップ → 裏返る → 取り消す ----
  step = "done-undo";
  const gomi = phone.locator(".fuda-wrap", { hasText: "ゴミ出し" });
  await gomi.getByRole("button", { name: "やった" }).click();
  await gomi.getByText(`${md(jst())}（`).waitFor();
  await phone.waitForTimeout(700);
  await phone.screenshot({ path: `${SHOTS}/14-flipped.png` });
  await gomi.getByRole("button", { name: "取り消す" }).click();
  await gomi.getByLabel("3日遅れ").waitFor();
  ok("「やった」で札が裏返り、「取り消す」で元に戻る");

  // もう一度押して、6秒待つと並べ直される
  await gomi.getByRole("button", { name: "やった" }).click();
  await phone.waitForTimeout(7000);
  const after = await phone.locator(".fuda:not(.fuda--back) .fuda__name").allInnerTexts();
  if (after.includes("ゴミ出し")) throw new Error("ゴミ出しが札に残っている");
  await phone.locator(".rows .list__item", { hasText: "ゴミ出し" }).getByText("あと7日").waitFor();
  ok("押して6秒たつと、ゴミ出しは「近いうち（あと7日）」へ移る");

  // ---- 詳細：さかのぼって記録・統計 ----
  step = "detail";
  await phone.getByRole("link", { name: "ゴミ出し" }).click();
  await h1(phone, "ゴミ出し");
  await phone.getByLabel(/やった日/).fill(jst(-10));
  await phone.getByRole("button", { name: /にやった$/ }).click();
  await phone.getByText(/に記録しました/).waitFor();
  await phone.getByText("やった回数").waitFor();
  await phone.screenshot({ path: `${SHOTS}/15-detail.png`, fullPage: true });
  ok("家事の詳細：さかのぼって記録すると、これまでと統計に出る");

  // ---- PC の一覧 ----
  step = "pc";
  const pcPage = await ctx.newPage();
  await pcPage.setViewportSize({ width: 1280, height: 800 });
  await pcPage.goto(`${ORIGIN}/chores`);
  await h1(pcPage, "家事");
  await pcPage.getByRole("cell", { name: "隔週 " + wd + "曜" }).waitFor();
  await pcPage.screenshot({ path: `${SHOTS}/16-chores-pc.png`, fullPage: true });
  await pcPage.getByRole("link", { name: "シーツ交換" }).click();
  await pcPage.getByRole("button", { name: "編集" }).click();
  await h1(pcPage, "家事を編集");
  await pcPage.getByLabel("家事の名前").fill("シーツとまくらカバー");
  await pcPage.getByRole("button", { name: "保存する" }).click();
  await h1(pcPage, "シーツとまくらカバー").catch(async (e) => {
    console.log("画面:", (await pcPage.locator("main").innerText()).slice(0, 600));
    throw e;
  });
  ok("PC の一覧（表）から編集して保存");

  // ---- まとめて登録：よくある家事から選ぶ＋手で1行（曜日で）＋不備の行 ----
  step = "bulk";
  // PC 幅のまとめて登録は表（bulk-grid-flow で確かめる）。ここではスマホ幅の1行ずつの画面を通す
  await pcPage.setViewportSize({ width: 600, height: 900 });
  await pcPage.getByRole("button", { name: "家事", exact: true }).click();
  await pcPage.getByRole("button", { name: "まとめて登録" }).click();
  await h1(pcPage, "まとめて登録");
  await pcPage.getByRole("button", { name: "よくある家事から選ぶ" }).click();
  await pcPage.getByRole("heading", { name: "よくある家事から選ぶ" }).waitFor();
  await pcPage.screenshot({ path: `${SHOTS}/17-templates.png` });
  // キッチンと風呂だけ残す
  for (const box of await pcPage.locator(".templates fieldset").all()) {
    const legend = await box.locator("legend").innerText();
    if (!["キッチン", "風呂"].includes(legend)) for (const cb of await box.getByRole("checkbox").all()) await cb.uncheck();
  }
  await pcPage.getByRole("button", { name: "9件を表に足す" }).click();
  // 手で1行：名前を入れ、曜日・日付で（毎月1日）
  const n = 10;
  await pcPage.getByLabel(`${n}行目の家事の名前`).fill("玄関マットを洗う");
  await pcPage.getByLabel(`${n}行目のグループ`).selectOption({ label: "掃除" });
  await pcPage.getByRole("button", { name: `${n}行目を曜日・日付で決める` }).click();
  const dlg = pcPage.getByRole("dialog");
  await dlg.getByLabel("決め方").selectOption("monthly_day");
  await dlg.locator("label.field", { hasText: /^日付/ }).locator("select").selectOption("1");
  await dlg.getByRole("button", { name: "決める" }).click();
  await pcPage.getByRole("button", { name: `${n}行目の周期を変える` }).getByText("毎月 1日").waitFor();
  // 不備：1行目の日数を0に
  await pcPage.getByLabel("1行目の何日ごと", { exact: true }).fill("0");
  await pcPage.screenshot({ path: `${SHOTS}/18-bulk.png`, fullPage: true });
  await pcPage.getByRole("button", { name: "10件を登録" }).click();
  await pcPage.getByText("1件の行に不備があります").waitFor();
  await pcPage.locator(".row-note .error").first().waitFor();
  await pcPage.getByLabel("1行目の何日ごと", { exact: true }).fill("7");
  await pcPage.getByRole("button", { name: "10件を登録" }).click();
  await pcPage.getByText("10件の家事を登録しました").waitFor();
  await pcPage.setViewportSize({ width: 1280, height: 800 });
  ok("まとめて登録：よくある家事9件＋手で1件（毎月1日）、不備の行を直して10件登録");

  // ---- 一覧：グループの見出しと絞り込み ----
  step = "groups";
  await pcPage.getByRole("heading", { level: 2, name: /^キッチン/ }).waitFor();
  await pcPage.getByRole("heading", { level: 2, name: /^ゴミ捨て/ }).waitFor();
  await pcPage.screenshot({ path: `${SHOTS}/19-chores-grouped.png`, fullPage: true });
  await pcPage.getByLabel("グループで絞る").selectOption({ label: "風呂" });
  const heads = await pcPage.locator(".group-heading").allInnerTexts();
  if (heads.length !== 1 || !heads[0].startsWith("風呂")) throw new Error(`絞り込みが効いていない: ${heads}`);
  await pcPage.getByLabel("グループで絞る").selectOption("");
  // グループを足して名前を変える
  await pcPage.getByText("グループを編集").click();
  await pcPage.getByLabel("新しいグループ").fill("庭");
  await pcPage.getByRole("button", { name: "足す" }).click();
  await pcPage.getByText("グループを足しました").waitFor();
  await pcPage.getByLabel("グループ「風呂」の名前").fill("お風呂");
  await pcPage.locator(".group-row", { has: pcPage.getByLabel("グループ「風呂」の名前") }).getByRole("button", { name: "保存" }).click();
  await pcPage.getByRole("heading", { level: 2, name: /^お風呂/ }).waitFor();
  ok("一覧はグループごとの見出し、絞り込み、グループの追加と名前の変更");
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
