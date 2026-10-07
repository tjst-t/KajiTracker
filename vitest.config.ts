import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // テスト専用の VAPID 鍵（npm run vapid:generate で作ったもの。本番では使わない）
            VAPID_PUBLIC_KEY: "BBbgOno4cSW24D75HZYrZK1PvwZCP1cJMp-_CweutEubGD0yAwkeLInZagCCm8nKTkfQ4ND8wh1x93ek9ULXIt0",
            VAPID_PRIVATE_KEY: "EEM21FQ9yJE-Uc915Lk5sVBYZbu1efwyDuzMFZFetzs",
            VAPID_SUBJECT: "mailto:test@example.com",
          },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
