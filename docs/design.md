# KajiTracker 設計メモ（データ・期限の計算・画面・API）

最終更新：2026-10-06
仕様は `docs/spec.md`。このメモは「どう作るか」を書く。

## 1. データの形（D1 / SQLite）

日付は日本時間の `YYYY-MM-DD` の文字列（`date`）、時刻は UTC の ISO 文字列（`timestamp`）で持つ。
ID は ULID などのランダムな文字列。札・招待・セッションの値は、サーバには SHA-256 のハッシュだけを置く。

### ユーザーとログイン

**users**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| display_name | text | 表示名 |
| webauthn_user_id | text | WebAuthn の user.id（ランダム 32 byte、base64url） |
| notify_time | text | 通知の時刻 `HH:MM`（日本時間）。既定 `20:00` |
| created_at | timestamp | |

**passkeys**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | credential id（base64url） |
| user_id | text FK | |
| public_key | text | COSE 形式の公開鍵（base64url） |
| counter | integer | 署名回数（複製の検出には使わない） |
| transports | text | JSON 配列 |
| name | text | 登録のときの名前（無ければ User-Agent から作る） |
| created_at / last_used_at | timestamp | |

**sessions**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | Cookie の値の SHA-256 |
| user_id | text FK | |
| via | text | `passkey` / `device_ticket`（端末を追加）/ `recovery_ticket`（管理者が出した札）/ `bootstrap`（最初の1人） |
| issued_by_user_id | text NULL | `recovery_ticket` のとき、札を出した管理者 |
| device_label | text | User-Agent から作った大まかな端末名 |
| step_up_at | timestamp NULL | 最後にパスキーを通した時刻（step-up の判定） |
| created_at / last_used_at | timestamp | 30日の判定は last_used_at（書き込みは1時間に1回まで） |

**login_tickets**（端末を追加・回復・最初の1人の札）
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | 札の値の SHA-256 |
| kind | text | `device` / `recovery` / `bootstrap` |
| user_id | text NULL | 入る先のユーザー（`bootstrap` は NULL。引き換えたときに作る） |
| issued_by_user_id | text NULL | 出した人（`bootstrap` は NULL） |
| expires_at | timestamp | 出してから10分 |
| used_at | timestamp NULL | |
| used_device_label | text NULL | 出した側の画面に「端末が入りました」を出すため |

**webauthn_challenges**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| challenge | text | |
| purpose | text | `register` / `authenticate` / `step_up` |
| user_id | text NULL | |
| expires_at | timestamp | 5分 |

challenge の id は短命の Cookie（`__Host-kaji-chal`）で画面に持たせる。

Cookie の名前：https の画面では `__Host-kaji-session`／`__Host-kaji-chal`。http の localhost（開発）では Secure を付けられないので `kaji-session`／`kaji-chal`。

画面のオリジンは `ORIGINS`（カンマ区切り）で持ち、要求の Origin ヘッダがそのどれかと一致しなければ断る。パスキーの RP ID は一致したオリジンのホスト名。本番は `https://kaji.tjstkm.net` だけにする。開発では `.dev.vars` で localhost と banto の公開 URL を並べる。

**rate_limits**
| 列 | 型 | 説明 |
|---|---|---|
| key | text | 例 `redeem:<IP>` |
| window_start | integer | 分単位の時刻 |
| count | integer | |
PK は (key, window_start)。

### Family

**families**：id, name, created_at

**family_members**
| 列 | 型 | 説明 |
|---|---|---|
| family_id / user_id | text | PK は2つの組 |
| role | text | `admin` / `member` |
| joined_at | timestamp | |

抜けた・外された人は行を消す。記録は users を指したまま残るので、統計には名前で出る。

**invites**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | 招待の値の SHA-256 |
| family_id | text FK | |
| created_by | text FK | |
| expires_at | timestamp | 24時間 |
| used_at / used_by | | 1回だけ |

### 家事と記録

**chores**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| family_id | text FK | |
| name | text | |
| schedule_type | text | `interval`（前回からの日数）/ `calendar`（カレンダーで固定） |
| interval_days | integer NULL | `interval` のとき |
| first_due_on | date NULL | `interval` のとき、登録で指定した最初の期限 |
| calendar_rule | text NULL | `calendar` のとき。JSON（下を参照） |
| assignee_user_id | text NULL | 担当者。抜けたら NULL に戻す |
| notify_time | text NULL | 家事ごとの通知の時刻。あれば人の時刻より優先 |
| archived_at | timestamp NULL | しまった家事（一覧と通知から外す。記録と統計は残す） |
| created_by / created_at / updated_at | | |

`calendar_rule` の形：
```jsonc
// 毎週（every=2 で隔週）。weekdays は 0=日〜6=土
{ "kind": "weekly", "weekdays": [0], "every": 1, "anchor": "2026-10-04" }
// 毎月第n○曜日（nth=-1 で最終○曜日）。every=3 で3か月ごと
{ "kind": "monthly_nth_weekday", "nth": 1, "weekday": 0, "every": 1, "anchor": "2026-10-04" }
// 毎月○日（day=-1 で月末）。その月に無い日（31日など）は月末に寄せる
{ "kind": "monthly_day", "day": 1, "every": 1, "anchor": "2026-10-04" }
```
`anchor` は予定日を数え始める日。anchor より前には予定日を作らない（登録したとたんに「遅れ」が出ないように）。
- 毎週・毎月（every=1）は、登録した日を anchor にする。
- 隔週・nか月ごと（every≥2）は、登録画面で「最初の予定日」を選んでもらい、それを anchor にする。週・月の数え始めは anchor の週（日曜始まり）・月なので、登録した日を anchor にすると「その週の過ぎた日曜」が数え始めになり、最初の予定日が思ったより1回分先になることがあるため。

**chore_groups**（家事のグループ）
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| family_id | text FK | |
| name | text | 例：キッチン |
| sort_order | integer | 並び順 |
Family を作ると「キッチン・風呂・トイレ・洗濯・ゴミ捨て・掃除」を入れる。chores.group_id がこれを指す（NULL ならグループなし。グループを消すと NULL に戻す）。

**logs**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| chore_id | text FK | |
| family_id | text FK | 統計の絞り込み用 |
| user_id | text FK | やった人（＝記録したアカウント） |
| done_on | date | やった日。さかのぼって入れられる |
| created_at | timestamp | |
| deleted_at | timestamp NULL | 取り消し。統計と期限の計算から外す |

### 通知

**push_subscriptions**
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| user_id | text FK | |
| endpoint | text UNIQUE | |
| p256dh / auth | text | |
| device_label | text | |
| created_at / last_success_at | timestamp | |
送ったときに 404・410 が返ったら消す。

**notifications_sent**：(user_id, chore_id, due_on) を PK にして、同じ期限で二度送らないようにする。

## 2. 期限の計算

純粋な関数（`src/shared/schedule.ts`）にまとめ、画面・API・Cron で同じものを使う。テストを厚く書く。

入力：家事の設定、取り消していない記録（`done_on` の昇順）、今日（日本時間）。
出力：次の期限（`due_on`）、状態（`overdue` で遅れ日数 / `today` / `upcoming`）、統計用の「回」の一覧。

### 前回からの日数（interval）
- 記録が無い：期限 ＝ `first_due_on`
- 記録がある：期限 ＝ いちばん新しい `done_on` ＋ N日
- 遅れ日数 ＝ 今日 − 期限（正のとき）

### カレンダーで固定（calendar）
- 予定日の列 O1, O2, … を規則から作る。
- 今日以前で最新の予定日を O とする。
  - O 以降の記録があれば、O の回は済み。次の期限は O の次の予定日。
  - 無ければ O の回が「期限が来ている」。遅れ日数 ＝ 今日 − O。
- 次の予定日が来たら、前の回は「やらなかった」として打ち切る（統計で未実施）。
- **前倒し（2026-10-06 決定）**：O の回がもう済んでいるときに記録したら、それは次の予定日の分として数える。たとえば「毎週日曜」を土曜にやったら、翌日曜の分を済ませたことにする。前倒しできるのは次の1回分だけ。

### 統計用の「回」
- interval：記録ごとに「その時点の期限」と「やった日」を組にする。期限内なら守れた回、過ぎていれば遅れ日数。
- calendar：予定日ごとに、済み（遅れ日数つき）か未実施か。

## 3. 通知（Cron）

- Cron Triggers で15分ごとに起こす。日本時間のいまの時刻帯 `[HH:MM, HH:MM+15分)` を出す。
- 期限が**今日**の家事（遅れているものには送らない）を Family ごとに集める。すでに今日やってあれば送らない。
- 送る相手：担当者がいれば担当者、いなければ Family 全員。
- 送る時刻：家事の `notify_time` があればそれ、無ければ相手の `notify_time`。いまの時刻帯に入る人・家事だけ送る。
- 1人に同じ時刻帯で複数の家事があれば、1通にまとめる（「今日の家事：ゴミ出し・洗濯槽の掃除」）。
- 送ったら `notifications_sent` に入れる。
- 通知を押すとアプリのホームを開く。

## 4. 画面

タブは「今日・家事・家族・設定」。スマホでは画面の下に固定、PC ではヘッダーの右。Family が2つ以上なら上に切り替え。統計は「統計」のストーリーでタブを足す。

今日の画面は「当番表」。期限が来ている家事を「当番札」（左に紐の穴、黒い縁）で並べ、遅れは朱の判子「3日遅れ」、今日は藍の判子「今日」。「やった」を押すと札が裏返って「済」と取り消しを6秒見せ、そのあと並べ直す（動きを減らす設定では裏返さずに切り替える）。

| # | 画面 | 主に使う | 中身 |
|---|---|---|---|
| S1 | **今日**（ホーム） | スマホ | いちばん上に「期限が来ている」家事（遅れ日数の多い順、次に今日のもの）。大きな「やった」ボタンでワンタップ記録、押した直後に「取り消す」を出す。その下に「近いうち（7日以内）」、「そのほか」 |
| S2 | 家事の詳細 | 両方 | 次の期限・周期・担当。記録の履歴（カレンダー表示）、記録の取り消し、過去の日付で記録。この家事の統計（守れた率、平均の遅れ、実際の平均間隔と周期の差） |
| S3 | 家事の登録・編集 | PC | 名前、周期の種類（日数＋最初の期限 ／ カレンダーの規則）、担当者、通知の時刻、しまう・消す |
| S4 | 家事の一覧 | PC | 表で全部の家事。周期・次の期限・担当・最後にやった人で並べ替え |
| S5 | 統計 | 両方 | 期間の切り替え（今月・3か月・全期間）。分担、担当の偏り、守れた率と平均の遅れ、週・月ごとの回数の推移、よく遅れる家事のランキング |
| S6 | Family | 両方 | メンバーと役割。管理者は：招待の QR、外す、管理者にする・戻す、回復の札を出す、名前の変更、削除。だれでも：抜ける |
| S7 | Family の切り替え・作成 | 両方 | 入っている Family の一覧、新しく作る。Family が1つも無いときはここに来る |
| S8 | 設定（自分） | 両方 | 表示名、通知の時刻、この端末で通知を受ける（オン・オフ）、パスキーの一覧、ログイン中の端末の一覧、端末を追加（QR とリンク） |
| S9 | ログイン | 両方 | 「パスキーでログイン」ボタンだけ。新規登録の入口は無い |
| S10 | 招待を受ける（`#invite=…`） | スマホ | 初めての人：表示名 → パスキー作成 → 参加。アカウントがある人：ログイン → 参加 |
| S11 | 札で入る（`#login=…`） | 両方 | 引き換え → 続けて「この端末のパスキーを登録」 |
| S12 | ホーム画面に追加の案内 | スマホ | iPhone で、ホーム画面に追加していない状態で通知をオンにしようとしたときに出す |

「端末が入りました」の知らせは、QR を出している間、出した側の画面が札の状態を数秒ごとに問い合わせて出す（Workers で常時接続を持たないため）。

## 5. API（Hono、`/api` の下）

Cookie で来る要求には `X-Kaji-Client: 1` が要る。★ は step-up が要る。

**ログイン**
- `POST /auth/login/options`・`POST /auth/login/verify`：パスキーでログイン
- `POST /auth/ticket-info`：札が使えるかと種類（最初の1人なら名前を聞くため）
- `POST /auth/redeem`：札（`device` / `recovery` / `bootstrap`）を引き換える。`bootstrap` は表示名も受け取ってユーザーを作る
- `POST /auth/register/options`・`POST /auth/register/verify`：ログイン中のユーザーにパスキーを足す（★、ただしパスキーが0個なら不要）
- `POST /auth/step-up/options`・`POST /auth/step-up/verify`
- `POST /auth/logout`
- `GET /me`、`PATCH /me`（表示名・通知の時刻）
- `GET /me/passkeys`、`DELETE /me/passkeys/:id`★
- `GET /me/sessions`、`DELETE /me/sessions/:id`★
- `POST /me/device-tickets`★（QR とリンクの札を出す）、`GET /me/tickets/:id`（自分が出した札＝端末を追加・回復が使われたか）

**招待**
- `POST /families/:fid/invites`（管理者）、`GET /families/:fid/invites/:id`（使われたか・だれが入ったか）
- `POST /invites/info`（招待の中身。ログイン不要。招待の値は本文で渡す）
- `POST /invites/register/options`・`/invites/register/verify`（初めての人：名前とパスキーを確かめてから、招待を使い、ユーザー・パスキー・メンバーを作ってログインさせる。まだ作っていないユーザーの情報は challenge の行の data に置く）
- `POST /invites/accept`（ログイン済みの人が参加）

**Family**
- `GET /families`、`POST /families`
- `PATCH /families/:fid`（名前、管理者）、`DELETE /families/:fid`（管理者、名前の確認と★）
- `GET /families/:fid/members`、`PATCH /families/:fid/members/:uid`（役割、管理者）、`DELETE /families/:fid/members/:uid`（外す・抜ける）
- `POST /families/:fid/members/:uid/recovery-ticket`（管理者★）

**家事と記録**
- `GET /families/:fid/chores`（期限・状態・前回の記録つき。`?archived=1` でしまった家事も）、`POST /families/:fid/chores`
- `GET /chores/:id`（記録・回・家事ごとの統計つき）、`PATCH /chores/:id`（`archived` でしまう・戻す）、`DELETE /chores/:id`
- `POST /chores/:id/logs`（`doneOn` は省くと今日。先の日付は断る）、`DELETE /logs/:id`（取り消し。家族のだれでも）
- 周期の入力：`{type:"interval", intervalDays, firstDueOn}` か `{type:"calendar", rule}`。毎週・毎月は anchor を省くと登録した日（編集では前の基準日）。隔週・数か月ごとは anchor 必須で、規則に当たる日でなければ断る

**統計**
- `GET /families/:fid/groups`、`POST /families/:fid/groups`、`PATCH /groups/:id`（名前・並び順）、`DELETE /groups/:id`（家事はグループなしに）
- `POST /families/:fid/chores/bulk`（まとめて登録。1行でも不備があれば1件も入れず、`rows: [{index, message}]` を返す。100件まで）

- `GET /families/:fid/stats?from=&to=`

**通知**
- `GET /push/vapid-public-key`
- `POST /push/subscriptions`、`DELETE /push/subscriptions`

## 6. 最初の1人の作り方

```
npm run bootstrap-link -- --remote --origin https://kaji.tjstkm.net   # 本番の D1 に札を入れて URL を出す
npm run bootstrap-link                                               # ローカル（http://localhost:5173）
npm run bootstrap-link -- --origin https://dev-ae103b83.banto.tjstkm.net  # ローカルを banto の公開 URL で
```
スクリプトがランダムな札を作り、ハッシュを `wrangler d1 execute` で `login_tickets` に入れ、`https://kaji.tjstkm.net/#login=<札>` を表示する。API からはこの札を作れない。

## 7. ディレクトリ

```
src/
  worker/      Hono の API、Cron、認証
  client/      React の画面、Service Worker
  shared/      期限の計算など、両方で使うもの
migrations/    D1 のマイグレーション（Drizzle が出す SQL）
scripts/       bootstrap-link など
docs/
```
