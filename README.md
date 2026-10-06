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
```

テーブルを変えたら `src/worker/db/schema.ts` を直して `npm run db:generate`。
`wrangler.jsonc` を変えたら `npm run cf-typegen`。
