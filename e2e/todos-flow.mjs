// TODO：すばやく足す → 詳細で期限・メモ（Markdown）・サブタスク → 一覧の遅れと進み具合 → 今日の画面の TODO の札
// → 札の「済み」で残りのサブタスクもまとめて済みに → 一覧の「済み」へ → 取り消す、を本物のブラウザで通す。
// 妻の端末でも同じ TODO が見えるか、PC で崩れないかも見る。
// 開発サーバを起こしてから `node e2e/todos-flow.mjs`（`npm run e2e` にも入っている）。
// 別のポートなら E2E_ORIGIN=http://localhost:5188 のように渡す（.dev.vars の ORIGINS にも足す）。
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.BASE ?? process.env.E2E_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
const jst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);

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

/** 横にはみ出していないか */
async function noOverflow(page, where) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  if (sw > iw) throw new Error(`${where}: 横にはみ出している（${sw} > ${iw}）`);
}

const tab = (page, name) => page.getByRole("navigation", { name: "画面" }).getByRole("button", { name, exact: true });
const h1 = (page, name) => page.getByRole("heading", { level: 1, name }).waitFor();
const view = (page, name) => page.getByRole("tablist", { name: "TODO の表示" }).getByRole("tab", { name });
const row = (page, title) => page.locator(".todo-row", { hasText: title });
const subtaskTitles = (page) => page.getByRole("list", { name: "サブタスクの一覧" }).locator(".subtask__title").evaluateAll((els) => els.map((e) => e.value));

const TITLE = "役所に電話";

try {
  step = "setup";
  const { page: phone } = await device({ width: 390, height: 844 });
  await phone.goto(link);
  await phone.getByLabel("名前").fill("たくみ");
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  await phone.getByLabel("Family の名前").fill(`TODOテスト${Date.now() % 10000}`);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await phone.getByRole("heading", { name: "まだ家事がありません" }).waitFor();

  step = "invite";
  await tab(phone, "その他").click();
  await phone.getByRole("link", { name: /^家族/ }).click();
  await phone.getByRole("button", { name: "家族を招待" }).click();
  const inviteLink = await phone.getByLabel("家族を招待のリンク").inputValue();
  await phone.getByRole("button", { name: "閉じる" }).click();
  const { page: wife } = await device({ width: 390, height: 844 });
  await wife.goto(inviteLink);
  await wife.getByLabel("名前").fill("はなこ");
  await wife.getByRole("button", { name: "次へ" }).click();
  await wife.getByRole("button", { name: "パスキーを作って参加する" }).click();
  await tab(wife, "その他").waitFor();
  ok("たくみが Family を作り、はなこが参加");

  // ---- すばやく足す ----
  step = "quick-add";
  await tab(phone, "TODO").click();
  await h1(phone, "TODO");
  if (new URL(phone.url()).pathname !== "/todos") throw new Error(`URL が /todos でない: ${phone.url()}`);
  await phone.getByText("TODO はありません").waitFor();
  await phone.getByLabel("TODO を足す").fill(TITLE);
  await phone.getByLabel("TODO を足す").press("Enter");
  await row(phone, TITLE).waitFor();
  if ((await phone.getByLabel("TODO を足す").inputValue()) !== "") throw new Error("足したあと入力欄が空にならない");
  await phone.getByLabel("TODO を足す").fill("電球を買う");
  await phone.getByLabel("TODO を足す").press("Enter");
  await row(phone, "電球を買う").waitFor();
  ok("「TODO を足す」に題名だけ入れて Enter で足せる");

  // ---- 詳細：期限を昨日、メモを Markdown、サブタスク3つ ----
  step = "detail";
  await phone.getByRole("link", { name: TITLE }).click();
  await h1(phone, TITLE);
  if (!/^\/todos\/[^/]+$/.test(new URL(phone.url()).pathname)) throw new Error(`URL が /todos/:id でない: ${phone.url()}`);
  await phone.getByLabel("期限", { exact: true }).fill(jst(-1));
  const group = await phone.getByLabel("グループ").locator("option").nth(1).innerText();
  await phone.getByLabel("グループ").selectOption({ index: 1 });
  await phone.getByLabel("担当").selectOption({ label: "はなこ" });
  await phone.getByLabel("メモ（Markdown）").fill("## 持ち物\n- **印鑑**\n- 本人確認書類\n\n窓口は平日 9〜17時");
  await phone.getByRole("button", { name: "保存する" }).click();
  await phone.getByText("保存しました").waitFor();
  await phone.getByLabel("1日遅れ").waitFor();
  await phone.getByRole("tablist", { name: "メモの表示" }).getByRole("tab", { name: "見る" }).click();
  const preview = phone.getByRole("region", { name: "プレビュー" });
  await preview.getByRole("heading", { name: "持ち物" }).waitFor();
  if ((await preview.locator("strong").innerText()) !== "印鑑") throw new Error("メモの太字が出ない");
  ok(`詳細で期限を昨日・グループ「${group}」・担当はなこ・メモ（Markdown）を保存。「見る」で見出しと太字が出る`);

  step = "subtasks";
  const add = phone.getByLabel("サブタスクを足す");
  for (const t of ["番号を調べる", "電話する", "メモを残す", "消すもの"]) {
    await add.fill(t);
    await add.press("Enter");
    await phone.getByRole("textbox", { name: `サブタスク「${t}」の題名` }).waitFor();
    if ((await add.inputValue()) !== "") throw new Error("サブタスクを足したあと入力欄が空にならない");
  }
  if (!(await add.evaluate((e) => e === document.activeElement))) throw new Error("サブタスクを足したあと、入力欄にフォーカスが残らない");
  await phone.getByRole("button", { name: "サブタスク「消すもの」を消す" }).click();
  await phone.getByRole("textbox", { name: "サブタスク「消すもの」の題名" }).waitFor({ state: "detached" });
  // 並べ替え：「メモを残す」を上へ → 戻す
  await phone.getByRole("button", { name: "メモを残すを上へ" }).click();
  await phone.waitForFunction(() => [...document.querySelectorAll(".subtask__title")].map((e) => e.value).join(",") === "番号を調べる,メモを残す,電話する");
  await phone.getByRole("button", { name: "メモを残すを下へ" }).click();
  await phone.waitForFunction(() => [...document.querySelectorAll(".subtask__title")].map((e) => e.value).join(",") === "番号を調べる,電話する,メモを残す");
  // 題名をその場で直す
  const t2 = phone.getByRole("textbox", { name: "サブタスク「電話する」の題名" });
  await t2.fill("窓口に電話する");
  await t2.press("Enter");
  await phone.getByRole("textbox", { name: "サブタスク「窓口に電話する」の題名" }).waitFor();
  const subs = await subtaskTitles(phone);
  if (subs.join(",") !== "番号を調べる,窓口に電話する,メモを残す") throw new Error(`サブタスクが違う: ${subs}`);
  await phone.getByRole("img", { name: "サブタスク 0/3 済み" }).waitFor();
  await noOverflow(phone, "TODO の詳細");
  await phone.screenshot({ path: `${SHOTS}/50-todo-detail.png`, fullPage: true });
  ok("サブタスクを Enter で続けて足し、消す・上へ／下へ・題名をその場で直せる（0/3）");

  // ---- 一覧：1日遅れ・0/3 ----
  step = "list";
  await phone.getByRole("link", { name: "TODO", exact: true }).click();
  await h1(phone, "TODO");
  const r = row(phone, TITLE);
  await r.getByLabel("1日遅れ").waitFor();
  await r.getByRole("img", { name: "サブタスク 0/3 済み" }).waitFor();
  await r.getByText("担当 はなこ").waitFor();
  await r.getByText(group, { exact: true }).waitFor();
  const order = await phone.locator(".todo-row__title").allInnerTexts();
  if (order.join(",") !== `${TITLE},電球を買う`) throw new Error(`遅れているものが上に来ない: ${order}`);
  await noOverflow(phone, "TODO の一覧");
  await phone.screenshot({ path: `${SHOTS}/51-todos-list.png`, fullPage: true });
  // グループで絞る
  await phone.getByLabel("グループで絞る").selectOption({ label: group });
  await row(phone, "電球を買う").waitFor({ state: "detached" });
  await r.waitFor();
  await phone.getByLabel("グループで絞る").selectOption({ label: "グループなし" });
  await row(phone, TITLE).waitFor({ state: "detached" });
  await row(phone, "電球を買う").waitFor();
  await phone.getByLabel("グループで絞る").selectOption({ label: "すべて" });
  ok(`一覧に「1日遅れ」の判子と「0/3」、担当・グループ。遅れが上。グループ「${group}」で絞れる`);

  // ---- 一覧のチェックで済み → 数秒「取り消す」 ----
  step = "list-undo";
  await phone.getByRole("button", { name: "「電球を買う」を済みにする" }).click();
  await row(phone, "電球を買う").waitFor({ state: "detached" });
  await phone.getByRole("status").getByText("「電球を買う」を済みにしました").waitFor();
  await phone.screenshot({ path: `${SHOTS}/52-todos-undo.png` });
  await phone.getByRole("status").getByRole("button", { name: "取り消す" }).click();
  await row(phone, "電球を買う").waitFor();
  ok("一覧のチェックで済み、直後の「取り消す」で戻る");

  // ---- サブタスク2つ済み ----
  step = "subtasks-done";
  await phone.getByRole("link", { name: TITLE }).click();
  await h1(phone, TITLE);
  await phone.getByRole("button", { name: "「番号を調べる」を済みにする" }).click();
  await phone.getByRole("button", { name: "「番号を調べる」を未完了に戻す" }).waitFor();
  await phone.getByRole("button", { name: "「窓口に電話する」を済みにする" }).click();
  await phone.getByRole("img", { name: "サブタスク 2/3 済み" }).waitFor();
  ok("詳細でサブタスクを2つ済みに（2/3）");

  // ---- 今日の画面に TODO の札 ----
  step = "today";
  await tab(phone, "今日").click();
  await phone.getByRole("heading", { name: "やること" }).waitFor();
  const fuda = phone.locator(".fuda-wrap--todo", { hasText: TITLE });
  await fuda.locator(".fuda__kind", { hasText: "TODO" }).waitFor();
  await fuda.getByLabel("1日遅れ").waitFor();
  await fuda.getByRole("img", { name: "サブタスク 2/3 済み" }).waitFor();
  await fuda.locator(".fuda__group", { hasText: group }).waitFor();
  if ((await phone.locator(".fuda-wrap--todo", { hasText: "電球を買う" }).count()) !== 0) throw new Error("期限の無い TODO が札に出ている");
  await noOverflow(phone, "今日");
  await phone.screenshot({ path: `${SHOTS}/53-today-todo.png`, fullPage: true });
  ok("今日の画面に TODO の札（左上に「TODO」、1日遅れの判子、2/3）。期限の無い TODO は出ない");

  // ---- 札の「済み」→ まとめて済みにするか聞かれる → はい ----
  step = "fuda-done";
  await fuda.getByRole("button", { name: "済み", exact: true }).click();
  const ask = phone.getByRole("dialog", { name: "残りのサブタスクもまとめて済みにしますか？" });
  await ask.getByText("まだ1つ残っています").waitFor();
  await phone.screenshot({ path: `${SHOTS}/54-today-ask.png` });
  await ask.getByRole("button", { name: "はい、まとめて済みにする" }).click();
  await fuda.getByRole("button", { name: "取り消す" }).waitFor();
  // 今日の「やること」はこの札だけなので、全部済んだ「皆済」が出る（中身は celebration-flow で確かめる）
  const kaisai = phone.getByRole("dialog", { name: "今日の当番、ぜんぶ済みました" });
  await kaisai.getByRole("button", { name: "閉じる" }).click();
  await kaisai.waitFor({ state: "hidden" });
  await phone.waitForTimeout(700);
  await phone.screenshot({ path: `${SHOTS}/55-today-flipped.png` });
  await phone.waitForTimeout(7000);
  if ((await phone.locator(".fuda-wrap--todo", { hasText: TITLE }).count()) !== 0) throw new Error("済みにした TODO が札に残っている");
  ok("札の「済み」で、残りのサブタスクもまとめて済みにするか聞かれ、はいで札が裏返り、数秒で消える");

  // ---- 一覧の「済み」に移る。はなこの端末でも見える ----
  step = "done-list";
  await tab(phone, "TODO").click();
  await h1(phone, "TODO");
  await row(phone, "電球を買う").waitFor();
  if ((await row(phone, TITLE).count()) !== 0) throw new Error("済みにした TODO が未完了に残っている");
  await view(phone, "済み").click();
  const done = row(phone, TITLE);
  await done.getByRole("img", { name: "サブタスク 3/3 済み" }).waitFor();
  await done.getByText(/たくみに済み$/).waitFor();
  await phone.screenshot({ path: `${SHOTS}/56-todos-done.png`, fullPage: true });

  await tab(wife, "TODO").click();
  await h1(wife, "TODO");
  await row(wife, "電球を買う").waitFor();
  await view(wife, "済み").click();
  await row(wife, TITLE).getByRole("img", { name: "サブタスク 3/3 済み" }).waitFor();
  ok("一覧の「済み」に移り（3/3、たくみに済み）、はなこの端末でも同じ TODO が見える");

  // ---- 取り消す（未完了に戻す） ----
  step = "reopen";
  await phone.getByRole("button", { name: `「${TITLE}」を未完了に戻す` }).click();
  await row(phone, TITLE).waitFor({ state: "detached" });
  await view(phone, "未完了").click();
  await row(phone, TITLE).getByLabel("1日遅れ").waitFor();
  // はなこが読み直すと、未完了に戻っている
  await view(wife, "未完了").click();
  await row(wife, TITLE).getByLabel("1日遅れ").waitFor();
  await noOverflow(wife, "TODO の一覧（はなこ）");
  await wife.screenshot({ path: `${SHOTS}/57-todos-wife.png`, fullPage: true });
  ok("「済み」の一覧から未完了に戻せる（はなこの端末でも戻っている）");

  // ---- PC でも崩れない ----
  step = "pc";
  const { page: pc } = await device({ width: 1280, height: 860 });
  await pc.context().addCookies(await phone.context().cookies());
  await pc.goto(`${BASE}/todos`);
  await row(pc, TITLE).waitFor();
  await noOverflow(pc, "TODO の一覧（PC）");
  await pc.screenshot({ path: `${SHOTS}/58-todos-pc.png`, fullPage: true });
  await pc.getByRole("link", { name: TITLE }).click();
  await h1(pc, TITLE);
  // PC ではメモの入力とプレビューが左右に並ぶ
  const tb = await pc.getByLabel("メモ（Markdown）").boundingBox();
  const pb = await pc.getByRole("region", { name: "プレビュー" }).boundingBox();
  if (!(pb.x > tb.x + tb.width - 2 && Math.abs(pb.y - tb.y) < 4)) throw new Error("PC でメモの入力とプレビューが左右に並ばない");
  await noOverflow(pc, "TODO の詳細（PC）");
  await pc.screenshot({ path: `${SHOTS}/59-todo-detail-pc.png`, fullPage: true });
  await pc.goto(`${BASE}/`);
  await pc.locator(".fuda-wrap--todo", { hasText: TITLE }).waitFor();
  await pc.screenshot({ path: `${SHOTS}/60-today-pc.png`, fullPage: true });
  ok("PC：一覧・詳細（メモは左右に並ぶ）・今日の画面が崩れない");

  // ---- 消す ----
  step = "delete";
  await pc.goto(`${BASE}/todos`);
  await pc.getByRole("link", { name: "電球を買う" }).click();
  await h1(pc, "電球を買う");
  await pc.getByRole("button", { name: "消す", exact: true }).click();
  await h1(pc, "TODO");
  await row(pc, TITLE).waitFor();
  if ((await row(pc, "電球を買う").count()) !== 0) throw new Error("消した TODO が残っている");
  ok("詳細の「消す」で TODO を消せる");
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
