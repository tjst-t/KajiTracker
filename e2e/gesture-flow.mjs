// パスキーを使う全部の入口で、ボタンの click の中で最初に WebAuthn（navigator.credentials.create / get）を
// 呼んでいるかを確かめる。Safari は、押してから通信を待ったあとで呼ぶと NotAllowedError で断る（iPhone で招待から
// 登録できなかった）。Playwright の WebKit では仮想パスキーが使えないので、Chromium の仮想パスキーで流しつつ、
// 画面の中で click・fetch・create/get の順番を記録して確かめる：
//   - create / get は click の処理の中（click のイベントが終わる前）で呼ばれている
//   - click から create / get までのあいだに fetch が無い（options は click より前に取ってある）
// 開発サーバを起こしてから `node e2e/gesture-flow.mjs`（別のポートなら E2E_ORIGIN=http://localhost:5174）。
import { execFileSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:5173";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const PHONE = { width: 390, height: 844 };

const stamp = Date.now() % 100000;
const me = `ジェスチャ${stamp}`;
const family = `押した流れ家${stamp}`;
const link = execSync(`npm run -s bootstrap-link -- --origin ${ORIGIN}`, { cwd: ROOT }).toString().match(/http:\/\/localhost:\d+\/#login=\S+/)[0];

/** ローカルの D1 で、この人のセッションを「step-up が要る」状態にする（入ってから11分・確認から6分たった） */
function needStepUp(displayName) {
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  const sql = `UPDATE sessions SET created_at = '${old}', step_up_at = '${old}' WHERE user_id IN (SELECT id FROM users WHERE display_name = '${displayName}')`;
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

// 画面に入れる記録係。click の捕捉で「押した流れの中」に入り、window の bubble（最後）で出る
const RECORDER = () => {
  const log = (window.__gesture = []);
  let inClick = false;
  addEventListener(
    "click",
    (e) => {
      inClick = true;
      log.push({ t: "click", label: e.target?.closest?.("button")?.textContent ?? "" });
      setTimeout(() => (inClick = false)); // stopPropagation されたときの保険
    },
    true,
  );
  addEventListener("click", () => (inClick = false), false);
  const fetch0 = window.fetch;
  window.fetch = function (input, init) {
    log.push({ t: "fetch", url: String(input?.url ?? input), inClick });
    return fetch0.call(this, input, init);
  };
  for (const m of ["create", "get"]) {
    const orig = navigator.credentials[m].bind(navigator.credentials);
    navigator.credentials[m] = (opts) => {
      log.push({ t: m, inClick });
      return orig(opts);
    };
  }
};

const browser = await chromium.launch();
const errors = [];
let step = "";
const ok = (s) => console.log(`ok: ${s}`);
/** 統計・家族・設定は「その他」タブの中から開く */
async function openMore(page, name) {
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
}
const STEP_UP_STEPS = ["settings-passkey", "step-up"];

async function device() {
  const ctx = await browser.newContext({ viewport: PHONE, userAgent: IPHONE, deviceScaleFactor: 2 });
  await ctx.addInitScript(RECORDER);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  // ログインしていない端末の 401 と、step-up が要る段でわざと受ける 403（step_up_required）は数えない
  const expected = (t) => t.includes("status of 401") || (STEP_UP_STEPS.includes(step) && t.includes("status of 403"));
  page.on("console", (m) => m.type() === "error" && !expected(m.text()) && errors.push(`[${step}] console: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  page.__clearPasskeys = () => cdp.send("WebAuthn.clearCredentials", { authenticatorId });
  return page;
}

/** ここまでの記録を取り出して確かめ、空にする。WebAuthn を呼んだ回数を返す */
async function checkGestures(page, where, expected) {
  const log = await page.evaluate(() => window.__gesture.splice(0));
  let calls = 0;
  log.forEach((e, i) => {
    if (e.t !== "create" && e.t !== "get") return;
    calls++;
    const clickAt = log.findLastIndex((x, j) => j < i && x.t === "click");
    if (clickAt < 0) return errors.push(`[${where}] ${e.t} が click なしで呼ばれた`);
    if (!e.inClick) errors.push(`[${where}] ${e.t} が「${log[clickAt].label}」の click の処理の外で呼ばれた`);
    const between = log.slice(clickAt + 1, i).filter((x) => x.t === "fetch");
    if (between.length) errors.push(`[${where}] 「${log[clickAt].label}」の click から ${e.t} までに fetch: ${between.map((x) => x.url).join(", ")}`);
    const opts = log.slice(0, clickAt).findLast((x) => x.t === "fetch" && x.url.includes("/options"));
    if (!opts) errors.push(`[${where}] 「${log[clickAt].label}」より前に options を取っていない`);
  });
  if (calls !== expected) errors.push(`[${where}] WebAuthn の呼び出しが ${calls} 回（${expected} 回のはず）`);
  return calls;
}

const h1 = (page, name) => page.getByRole("heading", { level: 1, name }).waitFor();

try {
  // ---- 札で入った直後のパスキー作成 ----
  step = "ticket";
  const phone = await device();
  await phone.goto(link);
  await phone.getByLabel("名前").fill(me);
  await phone.getByRole("button", { name: "はじめる" }).click();
  await phone.getByRole("button", { name: "パスキーを作る" }).click();
  await h1(phone, `${me}さん、まず Family を作りましょう`);
  await checkGestures(phone, step, 1);
  await phone.getByLabel("Family の名前").fill(family);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await phone.getByText(`${family}の当番表`).waitFor();
  ok("札で入った直後：「パスキーを作る」の click の中で create");

  // ---- ログイン ----
  step = "login";
  await openMore(phone, "設定");
  await phone.getByRole("button", { name: "ログアウト" }).click();
  await phone.getByRole("button", { name: "パスキーでログイン" }).click();
  await h1(phone, "設定");
  await checkGestures(phone, step, 1);
  ok("ログイン：画面を出したときに options、「パスキーでログイン」の click の中で get");

  // ---- 設定の「この端末のパスキーを作る」：step-up が要るときは2段 ----
  step = "settings-passkey";
  needStepUp(me);
  await phone.reload();
  await h1(phone, "設定");
  await phone.getByRole("button", { name: "この端末のパスキーを作る" }).click();
  await phone.getByText("パスキーを作る前に、ほかの端末のパスキーでもう一度確認してください").waitFor();
  await phone.getByRole("button", { name: "パスキーで確認する" }).click();
  await phone.getByRole("button", { name: "パスキーを作る", exact: true }).waitFor();
  await phone.__clearPasskeys(); // 同じ仮想パスキーに2つ目は作れないので、空にしてから作る
  await phone.getByRole("button", { name: "パスキーを作る", exact: true }).click();
  await phone.getByText("この端末のパスキーを作りました").waitFor();
  await checkGestures(phone, step, 2);
  ok("設定：step-up が要るときは「パスキーで確認する」→「パスキーを作る」と押し、どちらも click の中で");

  // ---- step-up（端末を追加の前の確認） ----
  step = "step-up";
  needStepUp(me);
  await phone.reload();
  await h1(phone, "設定");
  await phone.getByRole("button", { name: "端末を追加" }).click();
  await phone.getByRole("heading", { name: "パスキーでもう一度確認してください" }).waitFor();
  await phone.getByRole("button", { name: "パスキーで確認する" }).click();
  await phone.getByAltText("端末を追加の QR コード").waitFor();
  await checkGestures(phone, step, 1);
  await phone.getByRole("button", { name: "閉じる" }).click();
  ok("step-up：確認の段を出したときに options、「パスキーで確認する」の click の中で get");

  // ---- 招待：名前 →「次へ」→「パスキーを作って参加する」 ----
  step = "invite-new";
  await openMore(phone, "家族");
  await h1(phone, family);
  await phone.getByRole("button", { name: "家族を招待" }).click();
  const invite1 = await phone.getByLabel("家族を招待のリンク").inputValue();
  await phone.getByRole("button", { name: "閉じる" }).click();
  const wife = await device();
  await wife.goto(invite1);
  await wife.getByLabel("名前").fill(`はなこ${stamp}`);
  await wife.getByRole("button", { name: "次へ" }).click();
  await wife.getByRole("button", { name: "パスキーを作って参加する" }).click();
  await wife.getByText(`${family}の当番表`).waitFor();
  await checkGestures(wife, step, 1);
  ok("招待（はじめて）：「次へ」で options、「パスキーを作って参加する」の click の中で create");

  // ---- 招待：アカウントを持っている ----
  step = "invite-existing";
  await phone.getByLabel("新しい Family の名前").fill(`${family}の実家`);
  await phone.getByRole("button", { name: "Family を作る" }).click();
  await h1(phone, `${family}の実家`);
  await phone.getByRole("button", { name: "家族を招待" }).click();
  const invite2 = await phone.getByLabel("家族を招待のリンク").inputValue();
  await phone.getByRole("button", { name: "閉じる" }).click();
  await openMore(wife, "設定");
  await wife.getByRole("button", { name: "ログアウト" }).click();
  await wife.getByRole("button", { name: "パスキーでログイン" }).waitFor();
  await wife.evaluate(() => window.__gesture.splice(0));
  await wife.goto(invite2);
  await wife.getByRole("tab", { name: "アカウントを持っている" }).click();
  await wife.getByRole("button", { name: "パスキーでログインして参加する" }).click();
  await wife.getByText(`${family}の実家の当番表`).waitFor();
  await checkGestures(wife, step, 1);
  ok("招待（アカウントあり）：タブを出したときに options、「パスキーでログインして参加する」の click の中で get");
} catch (e) {
  console.log(`止まった場所: ${step}`);
  errors.push(String(e));
}

await browser.close();
if (errors.length) {
  console.log("エラー:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ALL OK");
