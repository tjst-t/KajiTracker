import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// テストごとのストレージは分かれているので、毎回マイグレーションを当てる
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
