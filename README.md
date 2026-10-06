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

`npm run e2e` は開発サーバを起こしてから。初回は `npx playwright install --with-deps chromium`。
開発サーバを別の URL（banto の公開など）から開くときは、`.dev.vars` の `ORIGINS` にその URL を足す。

テーブルを変えたら `src/worker/db/schema.ts` を直して `npm run db:generate`。
`wrangler.jsonc` を変えたら `npm run cf-typegen`。
