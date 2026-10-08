# KajiTracker

周期の違う家事を、記録と通知で管理する Web アプリ（PWA）。Cloudflare Workers で動く。

- 仕様：[docs/spec.md](docs/spec.md)
- 設計（データ・期限の計算・画面・API）：[docs/design.md](docs/design.md)

## ローカルで動かす

```sh
npm install
npm run db:migrate:local   # ローカルの D1 にマイグレーションを当てる
npm run dev                # http://localhost:5173 （/api/health で API を確かめられる）
npm test                   # Workers のランタイムでテスト
npm run bootstrap-link     # 最初の1人のためのログインの札（10分・1回）を出す
npm run db:reset:local     # ローカルの D1 を空に戻す（ログイン情報と Family はバックアップして復元する）
npm run e2e                # 本物のブラウザ（Chromium）と仮想パスキーでログインの流れを通す
```

`npm run e2e` は開発サーバを起こしてから（統計と実施カレンダーは `e2e/stats-flow.mjs`）。初回は `npx playwright install --with-deps chromium`。
開発サーバを別の URL（banto の公開など）から開くときは、`.dev.vars` の `ORIGINS` にその URL を足す。
`e2e/push-flow.mjs`（通知のオン・オフ）は VAPID の鍵（下）が要る。別のポートで起こしたときは `E2E_ORIGIN=http://localhost:5174` のように渡す。
ヘッドレスの Chromium は本物のプッシュサービスにつながらないので、購読（`pushManager.subscribe`）だけ偽物に差し替えて、画面と API の流れを確かめている。
`npm run e2e:pwa` は `npm run preview`（ビルドしたものを http://localhost:4173 で配る）を起こしてから。マニフェスト・Service Worker の登録・インストールできるか・オフラインで殻が開くか・/api がキャッシュされないかを確かめる。
Chromium が「Socket path too long」で落ちるときは `TMPDIR=/tmp` を付けて流す。

### PWA

マニフェストは `public/manifest.webmanifest`、Service Worker は `public/sw.js`（手書き。通知と画面の殻のキャッシュ）。
アイコンは `public/icons/icon.svg` を直して `node scripts/make-icons.mjs` で PNG を作り直す。
`public/sw.js` のキャッシュの作りを変えたら、中の `CACHE_VERSION` を上げる（古いキャッシュが消える）。
開発サーバでは `/sw.js?dev` で登録され、キャッシュを使わない。

テーブルを変えたら `src/worker/db/schema.ts` を直して `npm run db:generate`。
`wrangler.jsonc` を変えたら `npm run cf-typegen`。

### 通知（Web Push）の鍵

通知には VAPID の鍵が要る。初めに1回だけ作って、`.dev.vars`（git には入らない）に書く。

```sh
npm run --silent vapid:generate -- mailto:you@example.com >> .dev.vars
```

`.dev.vars` に `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT` の3行が入る。本番では同じ値を
`npx wrangler secret put VAPID_PUBLIC_KEY`（ほかの2つも）で入れる。鍵を作り直すと、いまの購読は全部使えなくなる。
テストでは `vitest.config.ts` のテスト用の鍵を使う。

### 当日の通知（Cron）を手で起こす

本番では 15 分ごとに Cron が `scheduled()` を起こし、日本時間のいまの時刻帯 `[HH:MM, HH:MM+15分)` に
送る時刻が来た家事を通知する（`src/worker/push/plan.ts`）。ローカルでは自動では起きないので、手で起こす。

```sh
# Vite の開発サーバ（npm run dev）：いまの時刻で起こす
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"
# 時刻を指定する（time は UTC のミリ秒。例は 2026-10-07 07:00 日本時間）
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*&time=$(date -d '2026-10-07T07:00+09:00' +%s)000"

# wrangler dev のとき：--test-scheduled をつけると /__scheduled で起こせる
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

送った家事は `notifications_sent` に入り、同じ期限ではもう送らない。試し直すときはその行を消す
（`npx wrangler d1 execute DB --local --command "DELETE FROM notifications_sent"`）。
