// 家事を表で編集（PC 幅）を本物のブラウザで通す：列の並び・貼り付け・範囲に同じ値・角を引っぱって埋める・読めない周期の赤・
// 日付のカレンダー・周期の選ぶ画面・新しい行の追加。登録済みの行の変更と新しい行の追加と削除を1回の保存で。
// 最後の行に入ると行が増える・「行をまとめて追加」・/chores/bulk は /chores/table へ・「保存して編集を続ける」。スマホ幅では1行ずつ足す画面。
// 開発サーバを起こしてから `npm run e2e`（別のポートなら E2E_ORIGIN=http://localhost:5191 node e2e/bulk-grid-flow.mjs）。
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
/** 次に出る確かめ（confirm）を「キャンセル」にする。ふだんは OK */
let dismissNext = false;
let lastDialog = "";

async function device(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ja-JP" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 401") && errors.push(`[${step}] console: ${m.text()}`));
  page.on("dialog", (d) => {
    lastDialog = d.message();
    if (dismissNext) {
      dismissNext = false;
      return d.dismiss();
    }
    return d.accept();
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { page, ctx };
}
const h1 = (page, name) => page.getByRole("heading", { level: 1, name }).waitFor();

try {
  step = "setup";
  const { page, ctx } = await device({ width: 1280, height: 900 });
  await page.goto(link);
  await page.getByLabel("名前").fill("たくみ");
  await page.getByRole("button", { name: "はじめる" }).click();
  await page.getByRole("button", { name: "パスキーを作る" }).click();
  await page.getByLabel("Family の名前").fill(`表テスト${Date.now() % 10000}`);
  await page.getByRole("button", { name: "Family を作る" }).click();
  await page.getByRole("heading", { name: "まだ家事がありません" }).waitFor();

  // ---- (1) 一覧の「表で編集」で開く。列はグループから ----
  step = "open";
  await page.getByRole("button", { name: "家事", exact: true }).click();
  await h1(page, "家事");
  if (await page.getByRole("button", { name: "まとめて登録" }).count()) throw new Error("一覧に「まとめて登録」が残っている");
  if (await page.getByRole("button", { name: "表で直す" }).count()) throw new Error("一覧に「表で直す」が残っている");
  await page.getByRole("button", { name: "表で編集" }).click();
  await h1(page, "家事を表で編集");
  if (new URL(page.url()).pathname !== "/chores/table") throw new Error(`URL が ${page.url()}`);
  const grid = page.locator(".bulk-grid .dsg-container");
  await grid.waitFor();
  const heads = (await grid.locator(".dsg-cell-header").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  const wantHeads = ["グループ", "家事の名前", "周期", "期限", "担当", "通知の時刻", "やり方", "無効", "削除"];
  if (heads.join(",") !== wantHeads.join(",")) throw new Error(`列の並びが「${heads.join("・")}」`);
  const cell = (row, field) => page.locator(`[data-cell="${row}-${field}"]`);
  const text = async (row, field) => (await cell(row, field).locator(".bulk-grid__text").innerText()).trim();
  /** 表が描き直すまで少し待ちながら読む */
  const expectText = async (row, field, want) => {
    let got = "";
    for (let i = 0; i < 20; i++) {
      got = await text(row, field).catch(() => "");
      if (want instanceof RegExp ? want.test(got) : got === want) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`${row}行目の${field}が「${got}」（ほしいのは ${want}）`);
  };
  const rowCount = () => grid.locator("[data-gutter]").evaluateAll((es) => Math.max(0, ...es.map((e) => Number(e.dataset.gutter))));
  const popover = page.locator(".grid-popover");
  await page.getByRole("button", { name: "変更はありません" }).waitFor();
  ok("一覧の「表で編集」で開くと、見出しは「家事を表で編集」、列はグループ・家事の名前・周期・期限・担当・通知の時刻・やり方・無効・削除の順");

  // ---- (5) Excel 形式（タブ区切り）の3行を新しい行に貼り付ける（最後の行をこえたら行が増える） ----
  step = "paste";
  await cell(1, "group").click();
  await popover.waitFor();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  const tsv = "キッチン\t窓ふき\t10日ごと\nげんかん\t玄関の掃除\t3日\n風呂\t洗面台\t毎月 1日\n";
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, tsv);
  await expectText(1, "name", "窓ふき");
  await expectText(2, "group", "げんかん");
  await expectText(3, "schedule", "毎月 1日");
  if ((await rowCount()) < 4) throw new Error(`貼り付けたのに行が足りない（${await rowCount()}行）`);
  if (!(await grid.locator('[data-gutter="1"]').evaluate((e) => e.classList.contains("bulk-grid__new")))) throw new Error("新しい行に「新」の印が無い");
  if (!(await cell(2, "group").evaluate((e) => e.classList.contains("is-invalid")))) throw new Error("無いグループが赤くない");
  await page.getByText("2行目（玄関の掃除）・グループ：「げんかん」というグループはありません").waitFor();
  await page.getByRole("button", { name: "3件の追加を保存" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/30-grid-pasted.png` });
  ok("タブ区切りの3行を貼り付けると3行に入り（行が足りなければ増える）、無いグループは赤くなる");

  // ---- グループの列の3マスを選んで、候補の一覧から同じ値を選ぶ ----
  step = "range-pick";
  const center = async (loc) => {
    const b = await loc.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const dragSelect = async (from, to) => {
    await page.mouse.move(...(await center(from)));
    await page.mouse.down();
    await page.mouse.move(...(await center(to)), { steps: 6 });
    await page.mouse.up();
  };
  await dragSelect(cell(1, "group"), cell(3, "group"));
  if (await popover.count()) throw new Error("範囲を選んだだけで一覧が開いた");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "1行目のグループを選ぶ" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/31-grid-group-list.png` });
  await popover.getByRole("option", { name: "掃除" }).click();
  for (const r of [1, 2, 3]) await expectText(r, "group", "掃除");
  if (await page.locator(".bulk-grid__cell.is-invalid").count()) throw new Error("グループを選んだのに赤いマスが残る");
  ok("グループの3マスを選んで一覧から「掃除」を選ぶと、3マスとも「掃除」になる");

  // ---- 1行目の周期を角を引っぱって下の2行に埋める ----
  step = "fill-handle";
  await cell(1, "schedule").click();
  await popover.waitFor();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  const handle = page.locator(".dsg-expand-rows-indicator");
  const hb = await handle.boundingBox();
  const tb = await cell(3, "schedule").boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
  await page.mouse.up();
  await expectText(2, "schedule", "10日ごと");
  await expectText(3, "schedule", "10日ごと");
  await page.keyboard.press("ControlOrMeta+z");
  await expectText(3, "schedule", "毎月 1日");
  await page.keyboard.press("ControlOrMeta+y");
  await expectText(3, "schedule", "10日ごと");
  ok("角を引っぱると、1行目の周期が下の2行に入る（Ctrl+Z で戻し、Ctrl+Y でやり直せる）");

  // ---- 読めない周期が赤くなり、直すと消える ----
  step = "invalid-schedule";
  await cell(2, "schedule").click();
  await popover.waitFor();
  await page.keyboard.type("ほぼ毎日");
  await page.keyboard.press("Enter");
  await popover.waitFor({ state: "detached" });
  if (!(await cell(2, "schedule").evaluate((e) => e.classList.contains("is-invalid")))) throw new Error("読めない周期が赤くない");
  const why = await cell(2, "schedule").getAttribute("title");
  if (!why?.includes("周期として読めません")) throw new Error(`理由が出ない: ${why}`);
  await page.getByText("2行目（玄関の掃除）・周期：「ほぼ毎日」は周期として読めません").waitFor();
  await page.screenshot({ path: `${SHOTS}/32-grid-invalid.png` });
  await cell(2, "schedule").click();
  await page.keyboard.type("毎日");
  await page.keyboard.press("Enter");
  await popover.waitFor({ state: "detached" });
  await expectText(2, "schedule", "毎日");
  if (await cell(2, "schedule").evaluate((e) => e.classList.contains("is-invalid"))) throw new Error("直したのに赤い");
  ok("読めない周期は赤くなって理由が出て、「毎日」に直すと消える");

  // ---- 期限のマスを押してカレンダーから日付を選ぶ ----
  step = "date-pick";
  const target = jst(5);
  await cell(1, "due").click();
  await page.getByRole("dialog", { name: "1行目の期限を選ぶ" }).waitFor();
  if (target.slice(0, 7) !== jst().slice(0, 7)) await popover.getByRole("button", { name: "次の月" }).click();
  await page.screenshot({ path: `${SHOTS}/33-grid-date.png` });
  await popover.getByRole("button", { name: new RegExp(`^${Number(target.slice(5, 7))}月${Number(target.slice(8, 10))}日（`) }).click();
  await popover.waitFor({ state: "detached" });
  await expectText(1, "due", new RegExp(`^${md(target)}（`));
  ok(`期限のマスを押し、カレンダーから ${md(target)} を選ぶ`);

  // ---- 周期の小さな画面で「月を選ぶ」：1・4・7・10月の第1土曜 ----
  step = "schedule-months";
  await cell(3, "schedule").click();
  const dlg = page.getByRole("dialog", { name: "3行目の周期を選ぶ" });
  await dlg.waitFor();
  await dlg.getByText("カレンダーで決まった日").click();
  await dlg.getByLabel(/^決め方/).selectOption("monthly_nth_weekday");
  for (const w of "日月火水木金土") {
    const box = dlg.getByLabel(w, { exact: true });
    if ((await box.isChecked()) !== (w === "土")) await box.setChecked(w === "土", { force: true });
  }
  await dlg.getByLabel("月の決め方").selectOption("months");
  for (const m of [1, 4, 7, 10]) await dlg.getByLabel(`${m}月`, { exact: true }).setChecked(true, { force: true });
  await dlg.getByText("1・4・7・10月 第1土曜", { exact: true }).waitFor();
  await page.screenshot({ path: `${SHOTS}/34a-grid-schedule-months.png` });
  await dlg.getByRole("button", { name: "決める" }).click();
  await popover.waitFor({ state: "detached" });
  await expectText(3, "schedule", "1・4・7・10月 第1土曜");
  await expectText(3, "due", /^次は /);
  ok("周期の小さな画面で「月を選ぶ」→ 1・4・7・10月を選ぶと、マスに「1・4・7・10月 第1土曜」");

  // ---- 周期のマスを押して小さな画面から「毎週 月・木」を選ぶ ----
  step = "schedule-pick";
  await cell(3, "schedule").click();
  await dlg.waitFor();
  await dlg.getByLabel(/^決め方/).selectOption("weekly");
  for (const w of "日月火水木金土") {
    const box = dlg.getByLabel(w, { exact: true });
    if ((await box.isChecked()) !== "月木".includes(w)) await box.setChecked("月木".includes(w), { force: true });
  }
  await dlg.getByText("毎週 月・木曜", { exact: true }).waitFor();
  await page.screenshot({ path: `${SHOTS}/34-grid-schedule.png` });
  await dlg.getByRole("button", { name: "決める" }).click();
  await popover.waitFor({ state: "detached" });
  await expectText(3, "schedule", "毎週 月・木曜");
  await expectText(3, "due", /^次は /);
  // 新しい行では、無効・削除は使えない
  await expectText(3, "archived", "—");
  await expectText(3, "delete", "—");
  await page.mouse.click(10, 10);
  await page.screenshot({ path: `${SHOTS}/35-grid-ready.png` });
  ok("周期の小さな画面で「毎週 月・木」を選ぶと、マスに「毎週 月・木曜」、期限は次の予定日が薄く出る。新しい行の無効・削除は「—」");

  step = "submit";
  await page.getByRole("button", { name: "3件の追加を保存" }).click();
  await h1(page, "家事");
  await page.getByText("3件を追加しました").waitFor();
  for (const name of ["窓ふき", "玄関の掃除", "洗面台"]) await page.getByRole("link", { name }).waitFor();
  await page.getByRole("heading", { level: 2, name: /^掃除/ }).waitFor();
  await page.getByRole("cell", { name: "毎週 月・木曜" }).waitFor();
  await page.getByRole("cell", { name: "10日ごと" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/36-grid-registered.png`, fullPage: true });
  ok("保存すると一覧に戻って「3件を追加しました」、一覧の「掃除」に3件出る");

  // ---- (2) 登録済みの担当を変え、新しい行に2件書き、1件を削除にして、1回で保存 ----
  step = "unified-save";
  await page.getByRole("button", { name: "表で編集" }).click();
  await h1(page, "家事を表で編集");
  await grid.waitFor();
  // 並びはグループの並び順・名前の順。最後に空の新しい行
  const names = [];
  for (const r of [1, 2, 3]) names.push(await text(r, "name"));
  if (names.join(",") !== ["洗面台", "窓ふき", "玄関の掃除"].sort((a, b) => a.localeCompare(b, "ja")).join(",")) throw new Error(`並びが「${names.join("・")}」`);
  if ((await rowCount()) !== 4) throw new Error(`行の数が ${await rowCount()}（登録済み3＋空1のはず）`);
  const [first, , gone] = names;

  await cell(1, "assignee").click();
  await page.getByRole("dialog", { name: "1行目の担当を選ぶ" }).waitFor();
  await popover.getByRole("option", { name: "たくみ" }).click();
  if (!(await cell(1, "assignee").evaluate((e) => e.classList.contains("is-changed")))) throw new Error("1行目の担当に変えた印が無い");
  if (await cell(1, "name").evaluate((e) => e.classList.contains("is-changed"))) throw new Error("変えていないマスに印が付いた");

  for (const [row, name, sched] of [
    [4, "排水口", "14日ごと"],
    [5, "換気扇", "毎週 土"],
  ]) {
    await cell(row, "name").click();
    await page.keyboard.press("Enter");
    await page.keyboard.type(name);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await popover.waitFor();
    await page.keyboard.type(sched);
    await page.keyboard.press("Enter");
    await popover.waitFor({ state: "detached" });
    await expectText(row, "name", name);
  }
  await cell(3, "delete").click();
  if (!(await cell(3, "delete").locator("input").isChecked())) throw new Error("3行目の削除にチェックが入らない");
  if (!(await cell(3, "name").evaluate((e) => !!e.closest(".dsg-row.is-deleted")))) throw new Error("3行目が削除の見た目にならない");
  const saveBtn = page.getByRole("button", { name: "2件の追加・1件の変更・1件の削除を保存" });
  await saveBtn.waitFor();
  await page.mouse.click(10, 10);
  await page.screenshot({ path: `${SHOTS}/39-table-unified.png` });

  // 保存しないで離れようとすると確かめる。やめると残る
  dismissNext = true;
  await page.getByRole("button", { name: "家事", exact: true }).click();
  if (!lastDialog.includes("保存していない変更")) throw new Error(`確かめが出ない: ${lastDialog}`);
  await h1(page, "家事を表で編集");
  await expectText(4, "name", "排水口");

  // 無効のマスは押すと入り切りし、Ctrl+Z で戻る
  await cell(2, "archived").click();
  if (!(await cell(2, "archived").locator("input").isChecked())) throw new Error("無効のマスを押してもチェックが入らない");
  await page.getByRole("button", { name: "2件の追加・2件の変更・1件の削除を保存" }).waitFor();
  await page.keyboard.press("ControlOrMeta+z");
  if (await cell(2, "archived").locator("input").isChecked()) throw new Error("Ctrl+Z で無効が戻らない");

  // 確かめでやめると何も保存しない。OK すると全部まとめて保存して一覧へ
  dismissNext = true;
  await saveBtn.click();
  if (!lastDialog.includes(gone) || !lastDialog.includes("元に戻せません") || !lastDialog.includes("『無効』")) throw new Error(`確かめの文が違う: ${lastDialog}`);
  await saveBtn.waitFor();
  await saveBtn.click();
  await h1(page, "家事");
  await page.getByText("2件を追加・1件を変更・1件を削除しました").waitFor();
  for (const n of [first, "排水口", "換気扇"]) await page.getByRole("link", { name: n }).waitFor();
  if (await page.getByRole("link", { name: gone }).count()) throw new Error(`消したのに一覧に「${gone}」が残る`);
  const who = await page.locator('td[data-label="担当"]').allInnerTexts();
  if (who.filter((t) => t.trim() === "たくみ").length !== 1) throw new Error(`一覧の担当が「${who.join("、")}」`);
  await page.screenshot({ path: `${SHOTS}/40-table-saved.png`, fullPage: true });
  ok("登録済みの担当を変え、新しい行に2件書き、1件を削除にして「2件の追加・1件の変更・1件の削除を保存」→ 確かめ → 一覧に反映");

  // ---- (3) 最後の行に矢印キーで移ると行が1つ増える ----
  step = "auto-row";
  await page.getByRole("button", { name: "表で編集" }).click();
  await h1(page, "家事を表で編集");
  await grid.waitFor();
  const before = await rowCount();
  if (before !== 5) throw new Error(`行の数が ${before}（登録済み4＋空1のはず）`);
  await cell(before - 1, "name").click();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((n) => Math.max(...[...document.querySelectorAll("[data-gutter]")].map((e) => Number(e.dataset.gutter))) === n, before + 1);
  ok(`最後の行に矢印キーで移ると、行が1つ増える（${before} → ${before + 1}）`);

  // ---- (4) 行をまとめて追加：10 を入れると10行増え、最初に足した行の名前のマスへ ----
  step = "add-rows";
  const n0 = await rowCount();
  await page.getByRole("button", { name: "行をまとめて追加" }).click();
  const addDlg = page.getByRole("dialog", { name: "行をまとめて追加" });
  await addDlg.waitFor();
  if ((await addDlg.getByRole("spinbutton").inputValue()) !== "5") throw new Error("足す行の数の初期値が 5 ではない");
  await page.keyboard.press("Escape");
  await addDlg.waitFor({ state: "detached" });
  if ((await rowCount()) !== n0) throw new Error("Esc でやめたのに行が増えた");
  await page.getByRole("button", { name: "行をまとめて追加" }).click();
  await addDlg.getByRole("spinbutton").fill("10");
  await page.screenshot({ path: `${SHOTS}/41-add-rows.png` });
  await page.keyboard.press("Enter");
  await addDlg.waitFor({ state: "detached" });
  await page.waitForFunction((n) => Math.max(...[...document.querySelectorAll("[data-gutter]")].map((e) => Number(e.dataset.gutter))) === n, n0 + 10);
  await page.keyboard.type("xyz");
  await page.keyboard.press("Enter");
  await expectText(n0 + 1, "name", "xyz");
  await page.screenshot({ path: `${SHOTS}/42-rows-added.png` });
  ok(`「行をまとめて追加」で 10 を入れると10行増え（${n0} → ${n0 + 10}）、最初に足した行の名前のマスに打てる`);

  // 新しい行は右クリックの「この行を消す」で消せる。登録済みの行には出さない
  step = "context-menu";
  await cell(1, "name").click({ button: "right" });
  const menu = page.locator(".dsg-context-menu");
  await menu.waitFor();
  if (await menu.getByText("この行を消す").count()) throw new Error("登録済みの行に「この行を消す」が出る");
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  await menu.waitFor({ state: "detached" });
  await cell(n0 + 1, "name").click({ button: "right" });
  await menu.getByText("この行を消す").click();
  if ((await text(n0 + 1, "name")) === "xyz") throw new Error("「この行を消す」で行が消えない");
  ok("新しい行は右クリックの「この行を消す」で消せる（登録済みの行には出ない）");

  // よくある家事は新しい行として末尾に足す。範囲を選んで打ち Ctrl/⌘+Enter で範囲に同じ値
  step = "templates";
  await page.getByRole("button", { name: "よくある家事から選ぶ" }).click();
  await page.getByRole("button", { name: /件を表に足す$/ }).click();
  await expectText(5, "name", "シンクの排水口");
  await expectText(5, "schedule", "7日ごと");
  await dragSelect(cell(5, "notify"), cell(7, "notify"));
  await page.keyboard.type("7:00");
  await page.keyboard.press("ControlOrMeta+Enter");
  for (const r of [5, 6, 7]) await expectText(r, "notify", "7:00");
  await page.mouse.click(10, 10);
  await page.screenshot({ path: `${SHOTS}/38-grid-templates.png` });
  ok("よくある家事は新しい行として末尾に足され、範囲を選んで打ち Ctrl+Enter で3行に同じ値が入る");

  // ---- (6) /chores/bulk を開くと /chores/table に移る ----
  step = "redirect";
  await page.goto(`${ORIGIN}/chores/bulk`);
  await h1(page, "家事を表で編集");
  if (new URL(page.url()).pathname !== "/chores/table") throw new Error(`URL が ${page.url()}`);
  ok("/chores/bulk を開くと /chores/table に移る");

  // ---- (8) 「保存して編集を続ける」：画面に残って表を読み直し、続けて直して保存できる ----
  step = "save-continue";
  await grid.waitFor();
  const n1 = await rowCount();
  await cell(n1, "name").click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("床ふき");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await popover.waitFor();
  await page.keyboard.type("7日ごと");
  await page.keyboard.press("Enter");
  await popover.waitFor({ state: "detached" });
  await expectText(n1, "name", "床ふき");
  await page.getByRole("button", { name: "1件の追加を保存" }).waitFor();
  await page.getByRole("button", { name: "保存して編集を続ける" }).click();
  await page.getByRole("status").filter({ hasText: "1件を追加しました" }).waitFor();
  await h1(page, "家事を表で編集");
  await page.getByRole("button", { name: "変更はありません" }).waitFor();
  if (!(await page.getByRole("button", { name: "保存して編集を続ける" }).isDisabled())) throw new Error("変更が無いのに「保存して編集を続ける」が押せる");
  if ((await rowCount()) !== n1 + 1) throw new Error(`読み直した行の数が ${await rowCount()}（${n1 + 1} のはず）`);
  let floor = 0;
  for (let r = 1; r <= n1; r++) if ((await text(r, "name")) === "床ふき") floor = r;
  if (!floor) throw new Error("保存した「床ふき」が登録済みの行に無い");
  if (await grid.locator(`[data-gutter="${floor}"]`).evaluate((e) => e.classList.contains("bulk-grid__new"))) throw new Error("保存した行に「新」の印が残る");
  if (!(await grid.locator(`[data-gutter="${n1 + 1}"]`).evaluate((e) => e.classList.contains("bulk-grid__new")))) throw new Error("最後の空の行が新しい行でない");
  await page.screenshot({ path: `${SHOTS}/43-table-continued.png` });

  // 続けて担当を変え、もう一度「保存して編集を続ける」。そのあとは確かめ無しで離れられる
  await cell(floor, "assignee").click();
  await page.getByRole("dialog", { name: `${floor}行目の担当を選ぶ` }).waitFor();
  await popover.getByRole("option", { name: "たくみ" }).click();
  await page.getByRole("button", { name: "1件の変更を保存" }).waitFor();
  await page.getByRole("button", { name: "保存して編集を続ける" }).click();
  await page.getByRole("status").filter({ hasText: "1件を変更しました" }).waitFor();
  await page.getByRole("button", { name: "変更はありません" }).waitFor();
  await expectText(floor, "assignee", "たくみ");
  if (await cell(floor, "assignee").evaluate((e) => e.classList.contains("is-changed"))) throw new Error("保存したのに変えた印が残る");
  lastDialog = "";
  await page.getByRole("button", { name: "家事", exact: true }).click();
  await h1(page, "家事");
  if (lastDialog) throw new Error(`保存したのに離れる確かめが出た: ${lastDialog}`);
  await page.getByRole("link", { name: "床ふき" }).waitFor();
  ok("「保存して編集を続ける」で画面に残って「1件を追加しました」、足した行は登録済みになり、続けて担当を変えて保存でき、離れるときの確かめも出ない");

  // ---- やり方のマス：押すと書く欄とプレビューの画面。「決める」で「あり」になり、保存すると詳細に出る ----
  step = "howto-cell";
  await page.getByRole("button", { name: "表で編集" }).click();
  await h1(page, "家事を表で編集");
  await grid.waitFor();
  await expectText(floor, "name", "床ふき");
  await expectText(floor, "howto", "—");
  await cell(floor, "howto").click();
  const howtoDlg = page.getByRole("dialog", { name: "床ふきのやり方" });
  await howtoDlg.waitFor();
  await howtoDlg.getByLabel("やり方（Markdown）").fill("## 道具\n- [ ] モップ\n\n| 場所 | 回数 |\n| --- | --- |\n| 廊下 | 2 |\n\n<img src=x onerror=\"window.__xss=1\">");
  await howtoDlg.getByRole("region", { name: "プレビュー" }).getByRole("heading", { name: "道具" }).waitFor();
  await howtoDlg.getByRole("region", { name: "プレビュー" }).getByRole("cell", { name: "廊下" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/44-table-howto.png` });
  await howtoDlg.getByRole("button", { name: "決める" }).click();
  await howtoDlg.waitFor({ state: "detached" });
  await expectText(floor, "howto", "あり");
  if (!(await cell(floor, "howto").evaluate((e) => e.classList.contains("is-changed")))) throw new Error("やり方のマスに変えた印が無い");
  // やめると変わらない
  await cell(floor, "howto").click();
  await howtoDlg.waitFor();
  await howtoDlg.getByLabel("やり方（Markdown）").fill("書きかけ");
  await howtoDlg.getByRole("button", { name: "やめる" }).click();
  await howtoDlg.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "1件の変更を保存" }).click();
  await h1(page, "家事");
  await page.getByRole("link", { name: "床ふき" }).click();
  await h1(page, "床ふき");
  // 「## 見出し」は画面の h2 の下に入るよう h4 になる
  await page.locator(".howto .md").getByRole("heading", { level: 4, name: "道具" }).waitFor();
  await page.getByText(/最後に直した人 たくみ・/).waitFor();
  if (await page.locator(".howto img").count()) throw new Error("やり方に img が出た");
  if (await page.evaluate(() => window.__xss)) throw new Error("やり方の HTML が実行された");
  await page.goto(`${ORIGIN}/chores/table`);
  await h1(page, "家事を表で編集");
  await page.locator(".bulk-grid .dsg-container").waitFor();
  await expectText(floor, "howto", "あり");
  ok("やり方のマスを押すと書く欄とプレビュー（見出し・表）、「決める」で「あり」、やめると変わらず、保存すると詳細に整形されて出る（img は出ない）");

  // ---- (7) スマホ幅では1行ずつ足す画面 ----
  step = "phone";
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${ORIGIN}/chores/table`);
  await h1(phone, "まとめて登録");
  await phone.getByLabel("1行目の家事の名前").waitFor();
  if (await phone.locator(".bulk-grid").count()) throw new Error("スマホ幅なのに表が出る");
  await phone.screenshot({ path: `${SHOTS}/37-bulk-phone.png`, fullPage: true });
  await phone.goto(`${ORIGIN}/chores`);
  await h1(phone, "家事");
  if (await phone.getByRole("button", { name: "表で編集" }).count()) throw new Error("スマホ幅なのに「表で編集」が出る");
  await phone.goto(`${ORIGIN}/chores/table`);
  await phone.setViewportSize({ width: 1024, height: 844 });
  await h1(phone, "家事を表で編集");
  await phone.locator(".bulk-grid .dsg-container").waitFor();
  ok("スマホ幅では1行ずつ足す画面（一覧に「表で編集」は出ない）、広げると表になる");
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
