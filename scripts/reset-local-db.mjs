#!/usr/bin/env node
// ローカルの D1 を空に戻す。ただしログイン情報（users・passkeys・sessions）と Family（families・family_members）は
// バックアップして復元する。家事・記録・招待・札などは消える。
//
//   npm run db:reset:local
//   npm run db:reset:local -- --persist-to /tmp/kaji-test   # 別の置き場所で試す
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const pi = args.indexOf("--persist-to");
const persistTo = pi >= 0 ? args[pi + 1] : join(ROOT, ".wrangler", "state");
const persistArgs = pi >= 0 ? ["--persist-to", persistTo] : [];
const TABLES = ["users", "passkeys", "sessions", "families", "family_members"]; // 外部キーの順（参照される側が先）

const wrangler = (...a) =>
  execFileSync("npx", ["wrangler", ...a, ...persistArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }).toString();

// 1. バックアップ（行を読み出して INSERT 文にする）
const backupDir = join(ROOT, ".wrangler", "backups");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(backupDir, `login-family-${stamp}.sql`);
const d1Dir = join(persistTo, "v3", "d1");
const sqlValue = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
if (existsSync(d1Dir)) {
  const lines = [];
  for (const t of TABLES) {
    const out = wrangler("d1", "execute", "DB", "--local", "--json", "--command", `SELECT * FROM ${t}`);
    const rows = JSON.parse(out)[0]?.results ?? [];
    for (const r of rows) {
      const cols = Object.keys(r);
      lines.push(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(r[c])).join(", ")});`);
    }
  }
  writeFileSync(backup, lines.join("\n"));
  console.log(`ログイン情報と Family をバックアップしました（${lines.length} 行）：${backup}`);
} else {
  console.log("データベースがまだ無いので、バックアップは取りません");
}

// 2. 空にしてマイグレーションを当てる
rmSync(d1Dir, { recursive: true, force: true });
wrangler("d1", "migrations", "apply", "DB", "--local");
console.log("データベースを空に戻しました");

// 3. 復元
if (existsSync(backup) && readFileSync(backup, "utf8").trim()) {
  wrangler("d1", "execute", "DB", "--local", "--file", backup);
  console.log("ログイン情報と Family を復元しました");
}
console.log("開発サーバを起こし直してください（Service「dev」）");
