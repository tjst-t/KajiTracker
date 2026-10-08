// まとめて登録の表（PC 幅）を本物のブラウザで通す：貼り付け・範囲に同じ値・角を引っぱって埋める・読めない周期の赤・
// 日付のカレンダー・周期の選ぶ画面・登録。スマホ幅では1行ずつの画面のまま。
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

  await page.getByRole("button", { name: "家事", exact: true }).click();
  await page.getByRole("button", { name: "まとめて登録" }).click();
  await h1(page, "まとめて登録");
  const grid = page.locator(".bulk-grid .dsg-container");
  await grid.waitFor();
  const cell = (row, field) => page.locator(`[data-cell="${row}-${field}"]`);
  const text = async (row, field) => (await cell(row, field).locator(".bulk-grid__text").innerText()).trim();
  const expectText = async (row, field, want) => {
    const got = await text(row, field);
    if (!(want instanceof RegExp ? want.test(got) : got === want)) throw new Error(`${row}行目の${field}が「${got}」（ほしいのは ${want}）`);
  };
  const popover = page.locator(".grid-popover");

  // ---- (1) Excel 形式（タブ区切り）の3行を貼り付ける ----
  step = "paste";
  await cell(1, "name").click();
  const tsv = "窓ふき\tキッチン\t10日ごと\n玄関の掃除\tげんかん\t3日\n洗面台\t風呂\t毎月 1日\n";
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, tsv);
  await expectText(1, "name", "窓ふき");
  await expectText(2, "group", "げんかん");
  await expectText(3, "schedule", "毎月 1日");
  if (!(await cell(2, "group").evaluate((e) => e.classList.contains("is-invalid")))) throw new Error("無いグループが赤くない");
  await page.getByText("2行目・グループ：「げんかん」というグループはありません").waitFor();
  await page.getByRole("button", { name: "3件を登録" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/30-grid-pasted.png` });
  ok("タブ区切りの3行を貼り付けると3行に入り、無いグループは赤くなる");

  // ---- (2) グループの列の3マスを選んで、候補の一覧から同じ値を選ぶ ----
  step = "range-pick";
  // マウスで1〜3行目のグループを引っぱって選び（押して離すだけではないので一覧は開かない）、Enter で一覧を開く
  const center = async (loc) => {
    const b = await loc.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  await page.mouse.move(...(await center(cell(1, "group"))));
  await page.mouse.down();
  await page.mouse.move(...(await center(cell(3, "group"))), { steps: 6 });
  await page.mouse.up();
  if (await popover.count()) throw new Error("範囲を選んだだけで一覧が開いた");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "1行目のグループを選ぶ" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/31-grid-group-list.png` });
  await popover.getByRole("option", { name: "掃除" }).click();
  for (const r of [1, 2, 3]) await expectText(r, "group", "掃除");
  if (await page.locator(".bulk-grid__cell.is-invalid").count()) throw new Error("グループを選んだのに赤いマスが残る");
  ok("グループの3マスを選んで一覧から「掃除」を選ぶと、3マスとも「掃除」になる");

  // ---- (3) 1行目の周期を角を引っぱって下の2行に埋める ----
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
  // 元に戻す・やり直す
  await page.keyboard.press("ControlOrMeta+z");
  await expectText(3, "schedule", "毎月 1日");
  await page.keyboard.press("ControlOrMeta+y");
  await expectText(3, "schedule", "10日ごと");
  ok("角を引っぱると、1行目の周期が下の2行に入る（Ctrl+Z で戻し、Ctrl+Y でやり直せる）");

  // ---- (4) 読めない周期が赤くなり、直すと消える ----
  step = "invalid-schedule";
  await cell(2, "schedule").click();
  await popover.waitFor();
  await page.keyboard.type("ほぼ毎日");
  await page.keyboard.press("Enter");
  await popover.waitFor({ state: "detached" });
  if (!(await cell(2, "schedule").evaluate((e) => e.classList.contains("is-invalid")))) throw new Error("読めない周期が赤くない");
  const why = await cell(2, "schedule").getAttribute("title");
  if (!why?.includes("周期として読めません")) throw new Error(`理由が出ない: ${why}`);
  await page.getByText("2行目・周期：「ほぼ毎日」は周期として読めません").waitFor();
  await page.screenshot({ path: `${SHOTS}/32-grid-invalid.png` });
  await cell(2, "schedule").click();
  await page.keyboard.type("毎日");
  await page.keyboard.press("Enter");
  await popover.waitFor({ state: "detached" });
  await expectText(2, "schedule", "毎日");
  if (await cell(2, "schedule").evaluate((e) => e.classList.contains("is-invalid"))) throw new Error("直したのに赤い");
  ok("読めない周期は赤くなって理由が出て、「毎日」に直すと消える");

  // ---- (5) 最初の期限のマスを押してカレンダーから日付を選ぶ ----
  step = "date-pick";
  const target = jst(5);
  await cell(1, "due").click();
  await page.getByRole("dialog", { name: "1行目の最初の期限を選ぶ" }).waitFor();
  if (target.slice(0, 7) !== jst().slice(0, 7)) await popover.getByRole("button", { name: "次の月" }).click();
  await page.screenshot({ path: `${SHOTS}/33-grid-date.png` });
  await popover.getByRole("button", { name: new RegExp(`^${Number(target.slice(5, 7))}月${Number(target.slice(8, 10))}日（`) }).click();
  await popover.waitFor({ state: "detached" });
  await expectText(1, "due", new RegExp(`^${md(target)}（`));
  ok(`最初の期限のマスを押し、カレンダーから ${md(target)} を選ぶ`);

  // ---- (6) 周期のマスを押して小さな画面から「毎週 月・木」を選ぶ ----
  step = "schedule-pick";
  await cell(3, "schedule").click();
  const dlg = page.getByRole("dialog", { name: "3行目の周期を選ぶ" });
  await dlg.waitFor();
  await dlg.getByText("カレンダーで決まった日").click();
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
  await page.mouse.click(10, 10);
  await page.screenshot({ path: `${SHOTS}/35-grid-ready.png` });
  ok("周期の小さな画面で「毎週 月・木」を選ぶと、マスに「毎週 月・木曜」、最初の期限は次の予定日が薄く出る");

  // ---- (7) 登録して一覧に出る ----
  step = "submit";
  await page.getByRole("button", { name: "3件を登録" }).click();
  await page.getByText("3件の家事を登録しました").waitFor();
  for (const name of ["窓ふき", "玄関の掃除", "洗面台"]) await page.getByRole("link", { name }).waitFor();
  await page.getByRole("heading", { level: 2, name: /^掃除/ }).waitFor();
  await page.getByRole("cell", { name: "毎週 月・木曜" }).waitFor();
  await page.getByRole("cell", { name: "10日ごと" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/36-grid-registered.png`, fullPage: true });
  ok("3件を登録すると、一覧の「掃除」に3件出る");

  // ---- おまけ：範囲を選んで打ち Ctrl/⌘+Enter で範囲に同じ値、よくある家事は表の末尾に足す ----
  step = "ctrl-enter";
  await page.getByRole("button", { name: "家事", exact: true }).click();
  await page.getByRole("button", { name: "まとめて登録" }).click();
  await grid.waitFor();
  await page.mouse.move(...(await center(cell(1, "name"))));
  await page.mouse.down();
  await page.mouse.move(...(await center(cell(3, "name"))), { steps: 6 });
  await page.mouse.up();
  await page.keyboard.type("x");
  await page.keyboard.type("yz");
  await page.keyboard.press("ControlOrMeta+Enter");
  for (const r of [1, 2, 3]) await expectText(r, "name", "xyz");
  await page.getByRole("button", { name: "よくある家事から選ぶ" }).click();
  await page.getByRole("button", { name: /件を表に足す$/ }).click();
  await expectText(1, "name", "xyz");
  await expectText(4, "name", "シンクの排水口");
  await expectText(4, "schedule", "7日ごと");
  await page.screenshot({ path: `${SHOTS}/38-grid-templates.png` });
  ok("範囲を選んで打ち Ctrl+Enter で3行に同じ名前、よくある家事は表の末尾に足される");

  // ---- (8) スマホ幅では1行ずつの画面 ----
  step = "phone";
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${ORIGIN}/chores/bulk`);
  await h1(phone, "まとめて登録");
  await phone.getByLabel("1行目の家事の名前").waitFor();
  if (await phone.locator(".bulk-grid").count()) throw new Error("スマホ幅なのに表が出る");
  await phone.screenshot({ path: `${SHOTS}/37-bulk-phone.png`, fullPage: true });
  // 幅を広げると表に切り替わる
  await phone.setViewportSize({ width: 1024, height: 844 });
  await phone.locator(".bulk-grid .dsg-container").waitFor();
  ok("スマホ幅では1行ずつの画面、広げると表になる");
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
