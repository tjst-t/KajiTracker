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

  // ---- やり方（Markdown）：フォームで書く → 詳細に整形して出る → 今日の札の「やり方」で開く。HTML は実行されない ----
  step = "howto";
  const alerts = [];
  for (const p of [pcPage, phone]) p.on("dialog", (d) => d.type() === "alert" && alerts.push(d.message()));
  const xss = async (p) => {
    if (alerts.length || (await p.evaluate(() => window.__xss))) throw new Error(`やり方の HTML が実行された: ${alerts}`);
  };
  await pcPage.getByText("やり方はまだありません。編集から書けます。").waitFor();
  await phone.getByRole("button", { name: "今日", exact: true }).click();
  const sheet = phone.locator(".fuda-wrap", { hasText: "シーツとまくらカバー" });
  await sheet.waitFor();
  const heightBefore = (await sheet.boundingBox()).height;
  if (await sheet.getByRole("button", { name: /のやり方$/ }).count()) throw new Error("やり方が無いのに札に「やり方」がある");

  await pcPage.getByRole("button", { name: "編集" }).click();
  await h1(pcPage, "家事を編集");
  const howtoText = [
    "# 手順",
    "- [ ] シーツを外す",
    "- [x] **洗剤**を入れる",
    "",
    "[洗濯表示の見かた](https://example.com/wash)",
    "",
    "<script>window.__xss = 1; alert('script')</script>",
    '<img src="x" onerror="window.__xss = 2; alert(\'img\')">',
    "[押すと](javascript:window.__xss=3)",
  ].join("\n");
  await pcPage.getByLabel("やり方（Markdown）").fill(howtoText);
  const preview = pcPage.getByRole("region", { name: "プレビュー" });
  await preview.getByRole("heading", { level: 3, name: "手順" }).waitFor();
  if (!(await pcPage.getByLabel("やり方（Markdown）").isVisible()) || !(await preview.isVisible())) throw new Error("PC 幅で入力とプレビューが並んでいない");
  await xss(pcPage);
  await pcPage.screenshot({ path: `${SHOTS}/16a-form-howto-pc.png`, fullPage: true });
  await pcPage.getByRole("button", { name: "保存する" }).click();
  await h1(pcPage, "シーツとまくらカバー");
  const howto = pcPage.locator(".howto .md");
  await howto.getByRole("heading", { level: 3, name: "手順" }).waitFor();
  await howto.getByRole("img", { name: "やることの印" }).waitFor();
  await howto.getByRole("img", { name: "済みの印" }).waitFor();
  await howto.locator("strong", { hasText: "洗剤" }).waitFor();
  const a = howto.getByRole("link", { name: "洗濯表示の見かた" });
  if ((await a.getAttribute("target")) !== "_blank" || !(await a.getAttribute("rel")).includes("noopener")) throw new Error("リンクが新しいタブ・noopener でない");
  const bad = await howto.evaluate((e) => e.querySelectorAll("script, img, input, [onerror]").length + [...e.querySelectorAll("a")].filter((x) => x.href.startsWith("javascript:")).length);
  if (bad) throw new Error(`やり方に script・img・input・javascript: のリンクが ${bad} 個ある`);
  await pcPage.getByText(/最後に直した人 たくみ・/).waitFor();
  await pcPage.waitForTimeout(300);
  await xss(pcPage);
  await pcPage.screenshot({ path: `${SHOTS}/16b-detail-howto.png`, fullPage: true });
  ok("やり方：フォームで見出し・チェックリスト・リンクを書くと、PC ではプレビューが並び、詳細に整形されて出る（最後に直した人つき）");

  // 今日の札の「やり方」で開く（札の大きさは変わらない）
  await phone.reload();
  await sheet.waitFor();
  await sheet.getByRole("button", { name: "シーツとまくらカバーのやり方" }).waitFor();
  const heightAfter = (await sheet.boundingBox()).height;
  if (Math.abs(heightAfter - heightBefore) > 1) throw new Error(`「やり方」で札の高さが変わった（${heightBefore} → ${heightAfter}）`);
  await phone.screenshot({ path: `${SHOTS}/16c-today-howto-button.png` });
  await sheet.getByRole("button", { name: "シーツとまくらカバーのやり方" }).click();
  const hd = phone.getByRole("dialog", { name: "シーツとまくらカバーのやり方" });
  await hd.getByRole("heading", { level: 3, name: "手順" }).waitFor();
  await hd.getByRole("link", { name: "洗濯表示の見かた" }).waitFor();
  await phone.waitForTimeout(300);
  await xss(phone);
  await phone.screenshot({ path: `${SHOTS}/16d-today-howto-dialog.png` });
  await hd.getByRole("button", { name: "閉じる" }).click();
  await hd.waitFor({ state: "detached" }).catch(() => hd.waitFor({ state: "hidden" }));
  ok("今日の札に小さな「やり方」（札の高さは同じ）、押すとダイアログで整形して出る。script・img onerror は実行されない");

  // スマホ幅のフォームは「書く／見る」の切り替え
  await sheet.getByRole("link", { name: "シーツとまくらカバー" }).click();
  await h1(phone, "シーツとまくらカバー");
  await phone.getByRole("button", { name: "編集" }).click();
  await h1(phone, "家事を編集");
  const ta = phone.getByLabel("やり方（Markdown）");
  if ((await ta.inputValue()) !== howtoText) throw new Error("編集のフォームに、保存したやり方が入っていない");
  if (await phone.getByRole("region", { name: "プレビュー" }).isVisible()) throw new Error("スマホ幅の「書く」でプレビューが見えている");
  await phone.getByRole("tab", { name: "見る" }).click();
  await phone.getByRole("region", { name: "プレビュー" }).getByRole("heading", { name: "手順" }).waitFor();
  if (await ta.isVisible()) throw new Error("スマホ幅の「見る」で入力欄が見えている");
  await phone.locator(".howto-editor").screenshot({ path: `${SHOTS}/16e-form-howto-phone.png` });
  await phone.getByRole("tab", { name: "書く" }).click();
  await ta.waitFor();
  await phone.getByRole("button", { name: "やめる" }).click();
  await xss(phone);
  ok("スマホ幅のフォームは「書く／見る」で切り替える");

  // ---- 第何週の何曜日：第1・第3 の 土・日（トグルで複数） ----
  step = "add-nth-weekday";
  /** トグル（チェックボックス）を labels のものだけ入れる */
  const toggleOnly = async (scope, all, on) => {
    for (const name of all) {
      const box = scope.getByLabel(name, { exact: true });
      if ((await box.isChecked()) === on.includes(name)) continue;
      // スマホ幅では、画面の下の端のトグルが下に固定したタブの裏に入るので、真ん中まで動かしてから押す
      await box.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await box.setChecked(on.includes(name), { force: true });
    }
  };
  await addChore(phone, async () => {
    await phone.getByLabel("家事の名前").fill("お風呂の大掃除");
    await phone.getByText("カレンダーで決まった日").click();
    await phone.getByLabel(/^決め方/).selectOption("monthly_nth_weekday");
    await toggleOnly(phone, [..."日月火水木金土"], []);
    await phone.getByText("曜日を1つ以上選んでください").waitFor();
    if (await phone.getByRole("button", { name: "登録する" }).isEnabled()) throw new Error("曜日が0個なのに登録できる");
    await toggleOnly(phone, ["第1", "第2", "第3", "第4", "第5", "最終"], ["第1", "第3"]);
    await toggleOnly(phone, [..."日月火水木金土"], ["土", "日"]);
    await phone.getByText("毎月 第1・第3 土・日曜。次の期限は").waitFor();
    await phone.getByLabel("月の決め方").selectOption("months");
    await phone.getByText("月を1つ以上選んでください").waitFor();
    await phone.screenshot({ path: `${SHOTS}/15b-form-months.png`, fullPage: true });
    await phone.getByLabel("月の決め方").selectOption("monthly");
    await phone.screenshot({ path: `${SHOTS}/15a-form-nth-weekday.png`, fullPage: true });
  });
  await h1(phone, "お風呂の大掃除");
  await phone.getByText("毎月 第1・第3 土・日曜").first().waitFor();
  await phone.screenshot({ path: `${SHOTS}/15c-detail-nth-weekday.png`, fullPage: true });
  ok("第何週の何曜日：第1・第3、土・日をトグルで選んで登録すると、詳細に「毎月 第1・第3 土・日曜」");

  // ---- まとめて登録：よくある家事から選ぶ＋手で1行（曜日で）＋不備の行 ----
  step = "bulk";
  // PC 幅は「家事を表で編集」の表（bulk-grid-flow で確かめる）。ここではスマホ幅の1行ずつの画面を、登録フォームのリンクから通す
  await pcPage.setViewportSize({ width: 600, height: 900 });
  await pcPage.getByRole("button", { name: "家事", exact: true }).click();
  await pcPage.getByRole("button", { name: "家事を登録" }).click();
  await pcPage.getByRole("link", { name: "表でまとめて登録" }).click();
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
  await dlg.getByLabel(/^決め方/).selectOption("monthly_day");
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
