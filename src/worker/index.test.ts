import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("/api/health", () => {
  it("D1 にマイグレーションが当たった状態で ok を返す", async () => {
    const res = await exports.default.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; tables: number }>();
    expect(body.ok).toBe(true);
    // users・chores・logs など 14 個のテーブル（＋マイグレーションの管理表）
    expect(body.tables).toBeGreaterThanOrEqual(14);
  });
});
