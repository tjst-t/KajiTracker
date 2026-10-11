// 買い物：2人（2つの端末）で、お店ごとのリストに足す → 相手の画面に数秒で出る → カゴに入れる → 買い物を終える
// → よく買うものからワンタップで戻す（売り場も同じ）、を本物のブラウザで通す。
// 開発サーバを起こしてから `node e2e/shopping-flow.mjs`（`npm run e2e` にも入っている）。
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

const shopTab = (page) => page.getByRole("navigation", { name: "画面" }).getByRole("button", { name: "買い物", exact: true });
const store = (page, name) => page.getByRole("tablist", { name: "お店" }).getByRole("tab", { name: new RegExp(`^${name}`) });
/** 売り場の見出しの下の品物（押すとカゴに入る・戻る） */
const item = (page, section, name) =>
  page.getByRole("region", { name: section, exact: true }).getByRole("button", { name: new RegExp(`^${name}`) });
const chips = (page) => page.getByRole("group", { name: "よく買うもの" });

async function addItem(page, name, note, section) {
  await page.getByLabel("品物を足す").fill(name);
  if (note) await page.getByLabel("数量・メモ").fill(note);
  if (section) await page.getByLabel("売り場", { exact: true }).selectOption({ label: section });
  await page.getByRole("button", { name: "足す", exact: true }).click();
}

try {
  step = "setup";
  const { page: phone } = await device({ width: 390, height: 844 });
  await phone.goto(link);
  await phone.getByLabel("名前").fill("たくみ");
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  const family = `買い物テスト${Date.now() % 10000}`;
  await phone.getByLabel("Family の名前").fill(family);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await phone.getByRole("heading", { name: "まだ家事がありません" }).waitFor();

  step = "invite";
  await phone.getByRole("button", { name: "その他", exact: true }).click();
  await phone.getByRole("link", { name: /^家族/ }).click();
  await phone.getByRole("button", { name: "家族を招待" }).click();
  const inviteLink = await phone.getByLabel("家族を招待のリンク").inputValue();
  await phone.getByRole("button", { name: "閉じる" }).click();
  const { page: wife } = await device({ width: 390, height: 844 });
  await wife.goto(inviteLink);
  await wife.getByLabel("名前").fill("はなこ");
  await wife.getByRole("button", { name: "次へ" }).click();
  await wife.getByRole("button", { name: "パスキーを作って参加する" }).click();
  await wife.getByRole("button", { name: "その他", exact: true }).waitFor();
  ok("たくみが Family を作り、はなこが参加");

  // ---- 買い物の画面：最初からスーパー・コストコ・IKEA ----
  step = "lists";
  await shopTab(phone).click();
  if (new URL(phone.url()).pathname !== "/shopping") throw new Error(`URL が /shopping でない: ${phone.url()}`);
  await store(phone, "スーパー").waitFor();
  const tabs = await phone.getByRole("tablist", { name: "お店" }).getByRole("tab").allInnerTexts();
  if (tabs.join(",") !== "スーパー,コストコ,IKEA") throw new Error(`リストの並びが違う: ${tabs}`);
  if ((await store(phone, "スーパー").getAttribute("aria-selected")) !== "true") throw new Error("最初はスーパーが選ばれていない");
  await phone.getByText("このリストは空です").waitFor();
  const sections = await phone.getByLabel("売り場", { exact: true }).locator("option").allInnerTexts();
  if (!sections.includes("乳製品・卵") || sections[0] !== "売り場なし") throw new Error(`売り場の候補が違う: ${sections}`);
  await noOverflow(phone, "買い物（空）");
  await phone.screenshot({ path: `${SHOTS}/40-shopping-empty.png` });
  ok("/shopping にスーパー・コストコ・IKEA のタブ、売り場の候補に「売り場なし」と最初の売り場");

  // ---- たくみがスーパーに牛乳・卵を足す ----
  step = "add";
  await shopTab(wife).click();
  await store(wife, "スーパー").waitFor();
  await addItem(phone, "牛乳", "2本", "乳製品・卵");
  await addItem(phone, "卵", "", "乳製品・卵");
  await addItem(phone, "食パン", "6枚切り", "");
  await item(phone, "乳製品・卵", "牛乳").waitFor();
  await item(phone, "乳製品・卵", "卵").waitFor();
  await item(phone, "売り場なし", "食パン").waitFor();
  if ((await phone.getByLabel("品物を足す").inputValue()) !== "") throw new Error("足したあと入力欄が空にならない");
  const t0 = Date.now();
  await item(wife, "乳製品・卵", "牛乳").waitFor({ timeout: 8000 });
  await item(wife, "乳製品・卵", "卵").waitFor({ timeout: 8000 });
  ok(`たくみが足した牛乳・卵が、はなこの画面に ${((Date.now() - t0) / 1000).toFixed(1)} 秒で出る`);
  await store(wife, "スーパー 3").waitFor({ timeout: 8000 });
  await phone.screenshot({ path: `${SHOTS}/41-shopping-added.png`, fullPage: true });

  // ---- はなこがタップでカゴに入れる ----
  step = "cart";
  await item(wife, "乳製品・卵", "牛乳").click();
  await item(wife, "乳製品・卵", "卵").click();
  for (const n of ["牛乳", "卵"]) if ((await item(wife, "乳製品・卵", n).getAttribute("aria-pressed")) !== "true") throw new Error(`${n} がカゴに入っていない`);
  // もう一度で戻る、さらにもう一度でカゴへ
  await item(wife, "売り場なし", "食パン").click();
  await item(wife, "売り場なし", "食パン").click();
  await wife.waitForTimeout(300);
  if ((await item(wife, "売り場なし", "食パン").getAttribute("aria-pressed")) !== "false") throw new Error("食パンが戻らない");
  await wife.getByRole("button", { name: "買い物を終える（2点）" }).waitFor();
  // カゴに入れたものは、その売り場の下に（未購入のあと）並ぶ
  await wife.waitForTimeout(1500);
  await addItem(wife, "ヨーグルト", "", "乳製品・卵");
  const order = await wife.getByRole("region", { name: "乳製品・卵", exact: true }).locator(".memo__name").allInnerTexts();
  if (order.join(",") !== "ヨーグルト,牛乳,卵") throw new Error(`カゴのものが下に並ばない: ${order}`);
  const deco = await wife.locator(".memo__item.is-in-cart .memo__text").first().evaluate((e) => getComputedStyle(e).textDecorationLine + " " + getComputedStyle(e).opacity);
  if (!deco.includes("line-through") || !deco.endsWith("0.5")) throw new Error(`カゴのものが薄く・取り消し線になっていない: ${deco}`);
  await wife.screenshot({ path: `${SHOTS}/42-shopping-cart.png`, fullPage: true });
  // たくみの画面にもカゴが揃う
  await phone.getByRole("button", { name: "買い物を終える（2点）" }).waitFor({ timeout: 8000 });
  if ((await item(phone, "乳製品・卵", "牛乳").getAttribute("aria-pressed")) !== "true") throw new Error("たくみの画面で牛乳がカゴに入っていない");
  ok("はなこがタップでカゴへ（もう一度で戻る）。カゴは売り場の下に薄く・取り消し線。たくみの画面にも数秒で揃う");

  // ---- 買い物を終える ----
  step = "checkout";
  await wife.getByRole("button", { name: "買い物を終える（2点）" }).click();
  await wife.getByText("2点を買いました").waitFor();
  await chips(wife).getByRole("button", { name: "牛乳" }).waitFor();
  await chips(wife).getByRole("button", { name: "卵" }).waitFor();
  const left = await wife.locator(".memo__name").allInnerTexts();
  if (left.join(",") !== "ヨーグルト,食パン") throw new Error(`買い物を終えたあとのリストが違う: ${left}`);
  await item(wife, "売り場なし", "食パン").waitFor();
  await wife.getByRole("button", { name: "買い物を終える（0点）" }).waitFor();
  await wife.screenshot({ path: `${SHOTS}/43-shopping-done.png`, fullPage: true });
  ok("「買い物を終える」でカゴの2点がリストから外れ、よく買うものに牛乳・卵が出る。カゴに入れていない食パンは残る");

  // ---- 打ち始めると候補、ワンタップで戻す（売り場も同じ） ----
  step = "frequent";
  await shopTab(phone).click();
  await chips(phone).getByRole("button", { name: "牛乳" }).waitFor({ timeout: 8000 });
  await phone.getByLabel("品物を足す").fill("牛");
  await phone.getByText("前に買ったもの").waitFor();
  const cands = await chips(phone).getByRole("button").allInnerTexts();
  if (cands.map((s) => s.replace("＋", "").trim()).join(",") !== "牛乳") throw new Error(`打ち始めの候補が違う: ${cands}`);
  await phone.screenshot({ path: `${SHOTS}/44-shopping-typing.png` });
  await phone.getByLabel("品物を足す").fill("牛乳");
  const sel = await phone.getByLabel("売り場", { exact: true }).evaluate((s) => s.options[s.selectedIndex].text);
  if (sel !== "乳製品・卵") throw new Error(`名前を打つと前の売り場が選ばれない: ${sel}`);
  await phone.getByLabel("品物を足す").fill("");
  await chips(phone).getByRole("button", { name: "牛乳" }).click();
  await item(phone, "乳製品・卵", "牛乳").waitFor();
  if ((await chips(phone).getByRole("button", { name: "牛乳" }).count()) !== 0) throw new Error("リストにある牛乳がまだ候補に出ている");
  await item(wife, "乳製品・卵", "牛乳").waitFor({ timeout: 8000 });
  ok("打ち始めると「前に買ったもの」に候補。よく買うものの牛乳をワンタップで、前と同じ乳製品・卵に戻せる（はなこの画面にも出る）");

  // ---- コストコのリストは別 ----
  step = "costco";
  await store(phone, "コストコ").click();
  await phone.getByText("このリストは空です").waitFor();
  if ((await chips(phone).count()) !== 0) throw new Error("コストコにスーパーのよく買うものが出ている");
  await addItem(phone, "トイレットペーパー", "1箱", "日用品");
  await item(phone, "日用品", "トイレットペーパー").waitFor();
  await store(phone, "コストコ 1").waitFor();
  await store(phone, "スーパー").click();
  await item(phone, "乳製品・卵", "牛乳").waitFor();
  if ((await phone.getByRole("button", { name: /^トイレットペーパー/ }).count()) !== 0) throw new Error("スーパーにコストコの品物が出ている");
  ok("コストコのリストは別（よく買うものも品物も混ざらない）");

  // ---- 消す ----
  step = "remove";
  await phone.getByRole("button", { name: "「食パン」を消す" }).click();
  await item(wife, "売り場なし", "食パン").waitFor({ state: "detached", timeout: 8000 });
  ok("× で品物を消すと、相手の画面からも消える");

  // ---- リストと売り場を編集 ----
  step = "editor";
  await phone.getByText("リストと売り場を編集").click();
  await phone.getByLabel("新しいリスト").fill("ドラッグストア");
  await phone.getByRole("button", { name: "足す", exact: true }).nth(1).click();
  await phone.getByText("リストを足しました").waitFor();
  await store(phone, "ドラッグストア").waitFor();
  if ((await store(phone, "ドラッグストア").getAttribute("aria-selected")) !== "true") throw new Error("足したリストが選ばれない");
  await phone.getByRole("heading", { name: "「ドラッグストア」の売り場" }).waitFor();
  await phone.getByLabel("新しい売り場").fill("薬");
  await phone.getByRole("button", { name: "足す", exact: true }).nth(2).click();
  await phone.getByText("売り場を足しました").waitFor();
  await phone.getByRole("button", { name: "薬を上へ" }).waitFor();
  await phone.getByRole("button", { name: "IKEAを上へ" }).click();
  await phone.getByText("並べ替えました").waitFor();
  const tabs2 = await phone.getByRole("tablist", { name: "お店" }).getByRole("tab").allInnerTexts();
  if (tabs2.map((s) => s.replace(/\d+$/, "").trim()).join(",") !== "スーパー,IKEA,コストコ,ドラッグストア") throw new Error(`並べ替えが効かない: ${tabs2}`);
  await noOverflow(phone, "買い物（編集）");
  await phone.screenshot({ path: `${SHOTS}/45-shopping-editor.png`, fullPage: true });
  ok("「リストと売り場を編集」でリストを足し・並べ替え、売り場を足せる");

  // ---- PC でも崩れない ----
  step = "pc";
  await store(phone, "スーパー").click();
  const { page: pc } = await device({ width: 1280, height: 860 });
  // たくみのセッションの Cookie をそのまま使い、PC の幅で見た目を確かめる
  await pc.context().addCookies(await phone.context().cookies());
  await pc.goto(`${BASE}/shopping`);
  await item(pc, "乳製品・卵", "牛乳").waitFor();
  await noOverflow(pc, "買い物（PC）");
  const box = await pc.getByLabel("品物を足す").boundingBox();
  const sbox = await pc.getByLabel("売り場", { exact: true }).boundingBox();
  if (Math.abs(box.y - sbox.y) > 4) throw new Error("PC では足す欄が1行に並ばない");
  await pc.screenshot({ path: `${SHOTS}/46-shopping-pc.png`, fullPage: true });
  await noOverflow(wife, "買い物（スマホ）");
  await wife.screenshot({ path: `${SHOTS}/47-shopping-phone.png`, fullPage: true });
  ok("PC では足す欄が1行に並び、横にはみ出さない");
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
