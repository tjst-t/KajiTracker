#!/usr/bin/env node
// 最初の1人のための「1回だけ・10分だけ」のログインの札を作り、URL を出す。
// API からはこの札を作れない（D1 に直接入れる）。考え方は banto の login-link と同じ。
//
//   npm run bootstrap-link                                   # ローカルの D1、http://localhost:5173
//   npm run bootstrap-link -- --origin https://dev-xxx.example # ローカルの D1、別の画面の URL で
//   npm run bootstrap-link -- --remote --origin https://kaji.tjstkm.net
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const oi = args.indexOf("--origin");
const origin = (oi >= 0 ? args[oi + 1] : "http://localhost:5173").replace(/\/$/, "");

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "DB",
    ...(remote ? ["--remote", "--env", "production"] : ["--local"]),
    "--command",
    `INSERT INTO login_tickets (id, kind, expires_at) VALUES ('${hash}', 'bootstrap', '${expiresAt}')`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);

console.log(`\nこの URL を10分以内に開いてください（1回だけ使えます）：\n\n  ${origin}/#login=${token}\n`);
