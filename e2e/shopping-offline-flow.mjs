// 買い物を電波の弱い店で：電波が無い間に品物を足す・カゴに入れる・数量メモを直す・買い物を終える → すぐ画面に出て「未送信」
// → 読み直しても端末のデータで出る → つながったら送られて未送信が消え、相手の画面にも出る。
// 電波が無い間に相手が同じ品物を消しても壊れないこと、ログインが切れても消さずにログインし直すと送ることも確かめる。
// 開発サーバを起こしてから `node e2e/shopping-offline-flow.mjs`（`npm run e2e` にも入っている）。
// 開発サーバは画面の殻をキャッシュしないので、読み直しは /api だけを落として確かめる。
// preview（`npm run preview`、E2E_ORIGIN=http://localhost:4173）なら、本当に電波を切ったまま読み直す。
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
// 電波を切っている間の読み込みの失敗、ログイン切れの 401、相手が消した品物への送り直しの 404 は、わざと起こしているもの
const expected = /status of 40[14]|ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to fetch/;

async function device(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ja-JP" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !expected.test(m.text()) && errors.push(`[${step}] console: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { page, ctx };
}

const shopTab = (page) => page.getByRole("navigation", { name: "画面" }).getByRole("button", { name: "買い物", exact: true });
const store = (page, name) => page.getByRole("tablist", { name: "お店" }).getByRole("tab", { name: new RegExp(`^${name}`) });
const item = (page, section, name) =>
  page.getByRole("region", { name: section, exact: true }).getByRole("button", { name: new RegExp(`^${name}`) });
const names = (page) => page.locator(".memo__name").allInnerTexts();
const banner = (page) => page.locator(".sync-banner");

async function addItem(page, name, note, section) {
  await page.getByLabel("品物を足す").fill(name);
  if (note) await page.getByLabel("数量・メモ").fill(note);
  if (section) await page.getByLabel("売り場", { exact: true }).selectOption({ label: section });
  await page.getByRole("button", { name: "足す", exact: true }).click();
}

async function expectNames(page, want, where) {
  const deadline = Date.now() + 10_000;
  let got;
  while (Date.now() < deadline) {
    got = (await names(page)).join(",");
    if (got === want) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`${where}: 品物が「${want}」でなく「${got}」`);
}

try {
  step = "setup";
  const { page: phone, ctx: phoneCtx } = await device({ width: 390, height: 844 });
  await phone.goto(link);
  await phone.getByLabel("名前").fill("たくみ");
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  await phone.getByLabel("Family の名前").fill(`オフライン${Date.now() % 10000}`);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await phone.getByRole("heading", { name: "まだ家事がありません" }).waitFor();
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

  // ---- つながっている間に開いておく（端末に入る） ----
  step = "online";
  await shopTab(phone).click();
  await store(phone, "スーパー").waitFor();
  await addItem(phone, "牛乳", "", "乳製品・卵");
  await addItem(phone, "卵", "", "乳製品・卵");
  await item(phone, "乳製品・卵", "卵").waitFor();
  await shopTab(wife).click();
  await item(wife, "乳製品・卵", "卵").waitFor({ timeout: 8000 });
  await phone.waitForTimeout(1500); // 送り終えて読み直し、端末に入るまで
  if ((await banner(phone).count()) !== 0) throw new Error("つながっているのに上の知らせが出ている");
  ok("つながっている間に牛乳・卵を足し、はなこの画面にも出る（上の知らせは出ない）");

  // ---- 電波を切る：足す・カゴに入れる・数量メモ ----
  step = "offline";
  await phoneCtx.setOffline(true);
  const t0 = Date.now();
  await addItem(phone, "バター", "", "乳製品・卵");
  await item(phone, "乳製品・卵", "バター").waitFor({ timeout: 1000 });
  await item(phone, "乳製品・卵", "牛乳").click();
  if ((await item(phone, "乳製品・卵", "牛乳").getAttribute("aria-pressed")) !== "true") throw new Error("電波が無いとカゴに入らない");
  await phone.getByRole("button", { name: "「卵」の数量やメモを直す" }).click();
  await phone.getByLabel("「卵」の数量やメモ").fill("10個入り");
  await phone.getByRole("button", { name: "決める" }).click();
  await item(phone, "乳製品・卵", "卵 10個入り").waitFor({ timeout: 1000 });
  await banner(phone).getByText("電波がありません。この端末に保存して、つながったら送ります（未送信 3 件）").waitFor({ timeout: 3000 });
  await phone.screenshot({ path: `${SHOTS}/50-shopping-offline.png`, fullPage: true });
  ok(`電波が無くても、足す・カゴ・数量メモがすぐ画面に出て（${Date.now() - t0}ms）、上に「電波がありません…（未送信 3 件）」`);

  // ---- その間に、はなこが牛乳を消す（たくみはカゴに入れた） ----
  step = "conflict";
  await wife.getByRole("button", { name: "「牛乳」を消す" }).click();
  await item(wife, "乳製品・卵", "牛乳").waitFor({ state: "detached" });
  await phone.waitForTimeout(1500);
  if ((await item(wife, "乳製品・卵", "バター").count()) !== 0) throw new Error("送っていないバターがはなこの画面に出ている");
  ok("電波が無い間に、はなこが（たくみがカゴに入れた）牛乳を消す");

  // ---- 読み直しても端末のデータで出る ----
  step = "reload";
  const shellCached = await phone.evaluate(async () => (await caches.keys()).some((k) => k.startsWith("kajitracker-shell")));
  if (shellCached) {
    // preview：本当に電波を切ったまま（殻は Service Worker のキャッシュから）
    await phone.reload();
  } else {
    // 開発サーバ：殻はキャッシュされないので、/api だけを落として読み直す
    await phone.route("**/api/**", (r) => r.abort("internetdisconnected"));
    await phoneCtx.setOffline(false);
    await phone.reload();
  }
  await item(phone, "乳製品・卵", "バター").waitFor();
  await item(phone, "乳製品・卵", "卵 10個入り").waitFor();
  if ((await item(phone, "乳製品・卵", "牛乳").getAttribute("aria-pressed")) !== "true") throw new Error("読み直したらカゴの印が消えた");
  await banner(phone).getByText("（未送信 3 件）").waitFor();
  if (!shellCached) {
    await phoneCtx.setOffline(true);
    await phone.unroute("**/api/**");
  }
  ok(`電波が無いまま読み直しても、端末のデータ（バター・卵 10個入り・カゴの牛乳）と未送信 3 件が出る${shellCached ? "" : "（/api を落として）"}`);

  // ---- 電波が無いまま、買い物を終える ----
  step = "checkout";
  await item(phone, "乳製品・卵", "バター").click();
  await phone.getByRole("button", { name: "買い物を終える（2点）" }).click();
  await phone.getByText("2点を買いました").waitFor();
  await expectNames(phone, "卵", "電波が無いまま買い物を終えたあと");
  await banner(phone).getByText("（未送信 5 件）").waitFor();
  // もう一度足しておく（つながったら相手に出るもの）
  await addItem(phone, "食パン", "6枚切り", "");
  await item(phone, "売り場なし", "食パン").waitFor();
  await banner(phone).getByText("（未送信 6 件）").waitFor();
  ok("電波が無いまま「買い物を終える（2点）」で、カゴの牛乳・バターがリストから外れる（未送信 6 件）");

  // ---- つながったら送られる ----
  step = "sync";
  await phoneCtx.setOffline(false);
  await banner(phone).first().waitFor({ state: "detached", timeout: 30_000 });
  await expectNames(phone, "卵,食パン", "つながったあと（たくみ）");
  await item(phone, "乳製品・卵", "卵 10個入り").waitFor();
  await expectNames(wife, "卵,食パン", "つながったあと（はなこ）");
  await item(wife, "乳製品・卵", "卵 10個入り").waitFor();
  await item(wife, "売り場なし", "食パン 6枚切り").waitFor();
  // バターは買った記録に入り、よく買うものに出る。はなこが消した牛乳は、たくみがカゴに入れていても記録されない
  const chips = wife.getByRole("group", { name: "よく買うもの" });
  await chips.getByRole("button", { name: "バター" }).waitFor({ timeout: 8000 });
  if ((await chips.getByRole("button", { name: "牛乳" }).count()) !== 0) throw new Error("はなこが消した牛乳が、買った記録に入っている");
  if ((await phone.getByRole("alert").count()) !== 0) throw new Error(`エラーが出ている: ${await phone.getByRole("alert").allInnerTexts()}`);
  await phone.screenshot({ path: `${SHOTS}/51-shopping-synced.png`, fullPage: true });
  ok("つながると送られて未送信が消え、はなこの画面にも食パン・卵 10個入りが出る。消された牛乳へのカゴの印は捨てられ、壊れない");

  // ---- ログインが切れていたら、消さずにログインし直すと送る ----
  step = "auth";
  const cookies = await phoneCtx.cookies();
  await phoneCtx.clearCookies();
  await addItem(phone, "ジャム", "", "");
  await banner(phone).getByText("ログインし直すと送ります（未送信 1 件）").waitFor({ timeout: 8000 });
  await item(phone, "売り場なし", "ジャム").waitFor();
  await phone.screenshot({ path: `${SHOTS}/52-shopping-auth.png`, fullPage: true });
  await phoneCtx.addCookies(cookies);
  await phone.getByRole("button", { name: "ログインし直す" }).click();
  await banner(phone).first().waitFor({ state: "detached", timeout: 10_000 });
  await item(wife, "売り場なし", "ジャム").waitFor({ timeout: 8000 });
  ok("ログインが切れると「ログインし直すと送ります（未送信 1 件）」。データは消えず、ログインし直すと送られる");
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
