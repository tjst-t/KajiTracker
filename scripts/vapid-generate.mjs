#!/usr/bin/env node
// Web Push の VAPID 鍵（P-256）を作って、.dev.vars に貼れる形で出す。
// 本番では `npx wrangler secret put VAPID_PUBLIC_KEY` などで同じ値を入れる。
//
//   npm run vapid:generate                       # 宛先は mailto:admin@example.com
//   npm run vapid:generate -- mailto:you@example.com
const subject = process.argv[2] ?? "mailto:admin@example.com";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
const { d: privateKey } = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);
