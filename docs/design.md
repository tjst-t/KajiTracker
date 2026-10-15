# KajiTracker 設計メモ（データ・期限の計算・画面・API）

最終更新：2026-10-11
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
| howto | text NULL | やり方（Markdown、最大 10000 文字。空白だけなら NULL）。HTML もそのまま預かり、画面で HTML として出さない |
| howto_updated_at / howto_updated_by | timestamp NULL / text FK NULL | やり方を最後に直した日時と人（中身が変わったときだけ更新。人が消えたら NULL） |
| archived_at | timestamp NULL | 無効にした家事（今日の画面・一覧・通知から外す。記録と統計は残す。画面では「無効」） |
| created_by / created_at / updated_at | | |

`calendar_rule` の形：
```jsonc
// 毎週（every=2 で隔週）。weekdays は 0=日〜6=土
{ "kind": "weekly", "weekdays": [0], "every": 1, "anchor": "2026-10-04" }
// 毎月の「第n の w 曜日」のどれか（nths の -1 は最終）。例：第1・第3 の 土・日。every=3 で3か月ごと
{ "kind": "monthly_nth_weekday", "nths": [1, 3], "weekdays": [0, 6], "every": 1, "anchor": "2026-10-04" }
// 毎月○日（day=-1 で月末）。その月に無い日（31日など）は月末に寄せる
{ "kind": "monthly_day", "day": 1, "every": 1, "anchor": "2026-10-04" }
// 毎月の2つは、月を選ぶこともできる（months は 1〜12）。このとき every は 1 で見ない。例：1・4・7・10月の第1土曜
{ "kind": "monthly_nth_weekday", "nths": [1], "weekdays": [6], "every": 1, "anchor": "2026-10-04", "months": [1, 4, 7, 10] }
```
前の形（`monthly_nth_weekday` の `nth`・`weekday` が1つずつ）も `parseCalendarRule` で読み、新しい形に直す（保存は新しい形。D1 の書き換えはしない）。
`anchor` は予定日を数え始める日。anchor より前には予定日を作らない（登録したとたんに「遅れ」が出ないように）。
- 毎週・毎月（every=1）と月を選ぶ（months）は、登録した日を anchor にする。
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

### 買い物

**shopping_lists**（お店ごとのリスト）：id, family_id, name（1〜20文字）, sort_order, created_at。Family を作ると「スーパー・コストコ・IKEA」を入れる（`src/worker/shopping/defaults.ts`。前からある Family には 0004 のマイグレーションで入れた）。1つの Family に20個まで。

**shopping_sections**（売り場）：id, list_id, name（1〜20文字）, sort_order, created_at。リストを作ると最初の10の売り場を入れる。1つのリストに30個まで。

**shopping_items**（リストにある品物）
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | 画面で作ってよい（8〜64文字の英数字・`-`・`_`）。同じ id の追加は1件にする |
| list_id / family_id | text FK | family_id は認可の確かめ用 |
| name | text | 1〜40文字 |
| note | text NULL | 数量やメモ（40文字まで） |
| section_id | text FK NULL | 売り場。NULL なら売り場なし（売り場を消すと NULL） |
| status | text | `open`（未購入）/ `in_cart`（カゴに入れた） |
| added_by / cart_by | text FK NULL | 入れた人／カゴに入れた人 |
| created_at / updated_at | timestamp | |
1つのリストに300個まで。

**shopping_purchases**（買った記録）：id（品物の id をそのまま使い、二重に記録しない）, list_id, family_id, name, note, section_id（FK NULL）, section_name（売り場を消しても名前を残す）, user_id（カゴに入れた人。いなければ「買い物を終える」を押した人）, bought_at。
「よく買うもの」は、ここをリストと名前でまとめ、回数の多い順・最後に買った日時の新しい順に並べる。売り場は最後に買ったときのもの。

### TODO

**todos**（一回限りの TODO）
| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | |
| family_id | text FK | |
| title | text | 1〜60文字 |
| memo | text NULL | メモ（Markdown、最大 10000 文字。決まりは chores.howto と同じ） |
| due_on | date NULL | 期限（日本時間） |
| assignee_user_id | text FK NULL | 担当。抜けたら NULL に戻す |
| group_id | text FK NULL | chore_groups。グループを消すと NULL |
| notify_time | text NULL | 通知の時刻（15分きざみ）。NULL なら人の時刻 |
| created_by | text FK NULL | 作った人 |
| done_at / done_by | timestamp NULL / text FK NULL | 済ませた時刻と人。done_at が NULL なら未完了 |
| sort_order | integer | 並び順（足すと Family の最後に） |
| created_at / updated_at | timestamp | |

**todo_subtasks**（サブタスク、1段だけ）：id, todo_id（FK、TODO を消すと cascade）, title（1〜60文字）, done_at / done_by（NULL なら未完了）, sort_order, created_at。TODO 1つに50個まで。

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

**todo_notifications_sent**：TODO の分。(user_id, todo_id, due_on) を PK にする（考え方は notifications_sent と同じ）。期限を変えれば、新しい期限の日にまた送る。

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
- 1人に同じ時刻帯で複数の家事があれば、1通にまとめる（「今日の家事：ゴミ出し・洗濯槽の掃除」）。Family が複数ある人には Family 名をつける（「自宅：ゴミ出し／実家：草むしり」）。担当者がもう Family にいなければ、担当なしと同じに全員へ送る。
- **TODO**：期限（`due_on`）が今日で未完了のものを、家事と同じ相手・同じ時刻の決まり（TODO の `notify_time` → 相手の `notify_time`）で送る。遅れ・期限なし・済みは送らない。
- 同じ時刻帯に家事と TODO の両方があれば1通にまとめる。題名は「今日の家事」、本文は「今日の家事：ゴミ出し・洗濯／TODO：役所に電話」（Family が複数ある人は、それぞれの中を「自宅：ゴミ出し、実家：草むしり」のように「、」で区切る）。TODO だけなら題名「今日の TODO」、本文は家事と同じ形。
- 送ったら `notifications_sent`（TODO は `todo_notifications_sent`）に入れる。決めるのは `push/plan.ts`（純粋な関数）、読み出しと送信は `push/notify.ts`。
- 通知を押すとアプリのホームを開く。

## 4. 画面

タブは「今日・TODO・買い物・家事・その他」（統計・家族・設定は「その他」の中）。スマホでは画面の下に固定、PC ではヘッダーの右。Family が2つ以上なら上に切り替え。統計は「統計」のストーリーでタブを足す。

今日の画面は「当番表」。期限が来ている家事を「当番札」（左に紐の穴、黒い縁）で並べ、遅れは朱の判子「3日遅れ」、今日は藍の判子「今日」。「やった」を押すと札が裏返って「済」と取り消しを6秒見せ、そのあと並べ直す（動きを減らす設定では裏返さずに切り替える）。
期限が今日か過ぎている未完了の TODO も、家事と同じ並びの決まり（遅れの多い順→今日）で札にする。TODO の札は左上に「TODO」の印、メタにサブタスクの進み具合、ボタンは「済み」（サブタスクが残っていれば、まとめて済みにするか・TODO だけか・やめるかを聞く。取り消すと、いっしょに済みにしたサブタスクも戻す）。「近いうち（7日以内）」にも期限の近い TODO を出す（それより先の TODO は TODO の一覧で見る）。

**完了の演出（2026-10-15）**：1件済ませると、裏返った面の「済」の判子が押される（少し大きく傾いて現れ→ぽんと縮んで止まる、まわりに若竹のにじみが1回、札の枠が短く光る）。振動できる端末では 12ms。「やること」の見出しの横に「今日 3/5」と細い棒（総数＝残っている「やること」＋今日済ませたもの。今日の記録と今日済みにした TODO から数える）。TODO の一覧で済みにしたときは下の帯に小さな「済」、サブタスク・買い物のチェックは丸に「✓」が押される動きだけ。取り消しは静かに戻す。最後の1件を済ませた瞬間に「皆済」の画面（画面を少し暗く、朱の判子が上から押される、紙吹雪は藍・若竹・朱・生成り #F4EFE4 の紙片を canvas で約2秒、今日済ませた件数と人ごとの内訳、閉じるまで出す、振動 [20, 60, 30]）。Family ごとに1日1回（localStorage `kaji.kaisai`）。そのあと「やること」には小さな皆済の判子と一言を静かに出す。動きを減らす設定と、設定の「完了の演出」オフ（端末ごと、localStorage `kaji.celebrate`）では、動き・紙吹雪・振動なしで判子と文だけを出す。実装は `src/client/celebrate.ts`・`src/client/components/Kaisai.tsx`。

| # | 画面 | 主に使う | 中身 |
|---|---|---|---|
| S1 | **今日**（ホーム） | スマホ | いちばん上に「期限が来ている」家事（遅れ日数の多い順、次に今日のもの）。大きな「やった」ボタンでワンタップ記録、押した直後に「取り消す」を出す。その下に「近いうち（7日以内）」、「そのほか」 |
| S2 | 家事の詳細 | 両方 | やり方（Markdown）と最後に直した人・日時。次の期限・周期・担当。記録の履歴（カレンダー表示）、記録の取り消し、過去の日付で記録。この家事の統計（守れた率、平均の遅れ、実際の平均間隔と周期の差） |
| S3 | 家事の登録・編集 | PC | 名前、周期の種類（日数＋最初の期限 ／ カレンダーの規則）、担当者、通知の時刻、やり方（Markdown。PC 幅は入力とプレビューを左右に、スマホ幅は「書く／見る」）、無効にする・消す |
| S4 | 家事の一覧 | PC | 表で全部の家事。周期・次の期限・担当・最後にやった人で並べ替え |
| S5 | 統計 | 両方 | 期間の切り替え（今月・3か月・全期間）。分担、担当の偏り、守れた率と平均の遅れ、週・月ごとの回数の推移、よく遅れる家事のランキング |
| S6 | Family | 両方 | メンバーと役割。管理者は：招待の QR、外す、管理者にする・戻す、回復の札を出す、名前の変更、削除。だれでも：抜ける |
| S7 | Family の切り替え・作成 | 両方 | 入っている Family の一覧、新しく作る。Family が1つも無いときはここに来る |
| S8 | 設定（自分） | 両方 | 表示名、通知の時刻、この端末で通知を受ける（オン・オフ）、パスキーの一覧、ログイン中の端末の一覧、端末を追加（QR とリンク） |
| S9 | ログイン | 両方 | 「パスキーでログイン」ボタンだけ。新規登録の入口は無い |
| S10 | 招待を受ける（`#invite=…`） | スマホ | 初めての人：表示名 → パスキー作成 → 参加。アカウントがある人：ログイン → 参加 |
| S11 | 札で入る（`#login=…`） | 両方 | 引き換え → 続けて「この端末のパスキーを登録」 |
| S12 | ホーム画面に追加の案内 | スマホ | iPhone で、ホーム画面に追加していない状態で通知をオンにしようとしたときに出す |
| S13 | 買い物（`/shopping`） | スマホ | 上にお店のタブ（横に並び、入りきらなければ横にすべる。数は未購入＋カゴ）。「品物を足す」（名前・数量メモ・売り場。PC 幅は1行）と、その下に「よく買うもの」のチップ。品物は「買い物メモ」の紙に、売り場の見出しごとに並べ、押すとカゴへ（もう一度で戻る）。行の ✎ で数量・メモを直す。下に貼り付けた「買い物を終える（N点）」。いちばん下に「リストと売り場を編集」 |
| S14 | TODO の一覧（`/todos`） | スマホ | 「未完了」（期限の近い順、遅れが上・期限なしは下）と「済み」の切り替え、グループで絞る。上に「TODO を足す」の1行（題名だけで Enter）。行の左の丸いチェックで済み（サブタスクが残っていれば「まとめて済みにしますか」と聞く）、直後に下へ「取り消す」を6秒。行に題名・判子（遅れ・今日）・担当・グループ・サブタスクの進み具合（「2/5」と細い棒） |
| S15 | TODO の詳細（`/todos/:id`） | 両方 | 題名・期限・担当・グループ・通知の時刻・メモ（Markdown。家事のやり方と同じ書く欄）を直して「保存する」（保存していない変更があれば離れる前に聞く）。サブタスク：チェック・題名をその場で直す・上へ／下へ・消す、「サブタスクを足す」の1行（Enter で続けて足せる）。済みにする／未完了に戻す、消す |

買い物の画面は、書き込みを先に画面へ映してから送る（品物の id は画面で作る）。5秒ごと（`document.visibilityState` が visible のときだけ。見えるようになったときにもすぐ）に `GET /shopping-lists/:id` を読み直す。

### 買い物を電波の弱い店で使う（端末にデータを持つ）

コストコの売り場など電波が切れる場所でも、リストを見て・足して・カゴに入れて・買い物を終えられるように、買い物の画面だけは端末（IndexedDB）にデータを持つ（`src/client/shopping-store.ts`。自前の小さなラッパー）。家事・TODO などほかの画面は持たない（つながらなければ今まで通りのエラー）。`/api` は Service Worker でキャッシュしない決まりのまま（`public/sw.js`）。データを持つのは画面側だけ。

- **持つもの**：IndexedDB `kajitracker-shopping` に2つ。`views`（キー `ユーザー id:リスト id`）は、リストごとに最後にサーバから読めた中身（`GET /shopping-lists/:id` の返り値そのまま）。`queue`（キーは積んだ順の数）は、まだ送っていない変更（だれの変更か＝ユーザー id 付き）。ほかのお店のリストも、画面を開いたときに一度読んで入れておく（売り場で電波が切れても切り替えられるように）。IndexedDB が使えない端末では、開いている間だけメモリに持つ。
- **描き方**：開いたらまず端末の中身で描き、つながっていれば読み直して入れ替える。画面に出すのは「読めた中身」に「そのあと送れた変更」と「まだ送っていない変更」を順に重ねたもの（`applyOps`、`src/client/shopping.ts`）。重ねるときに無い品物への変更は捨てる（相手が消した・買い物を終えた品物にこちらがカゴの印を付けた、など）。読み直しは、あとから始めたものの結果だけ使う（遅れて返った古い結果で戻さない）。送れてから読み直しが返るまでの間に前の状態へ戻らないよう、読み始めたとき（送れた数 `sent`）よりあとに送れた変更も重ねる。
- **変更**（足す・カゴに入れる／戻す・数量メモを直す・消す・買い物を終える）は、まず `queue` に積んで画面に出し、すぐ送る。状態と数量メモは「切り替え」ではなく、なってほしい値で積む。どの API も同じ要求を2回送っても結果が同じなので、届いたか分からないときは送り直してよい。
- **送り方**：積んだ順に1つずつ。送れたら消す。同時には1本だけ（ほかのタブとも `navigator.locks` で順番に。ほかのタブが送って消した変更は、古い値で上書きしないよう送らずに外す）。
  - fetch そのものが落ちた・5xx・408・429・返事が JSON でない（お店の Wi-Fi のログイン画面など）：そこで止め、「電波がありません」にする。送り直すのは、`online` のイベント・画面が見えたとき・20秒ごと・読み直しが通ったとき。
  - 401：止めて、データは消さずに「ログインし直すと送ります」を出す。ログインし直したら送る（ログインの画面にも未送信の件数を出す）。
  - そのほかの 4xx：その変更を捨てて次へ。相手が消した品物への変更（404 `item_not_found`）は黙って捨てる。リストが消されていた、などは「送れなかった変更を取り消しました」と出す。品物を足すときに売り場が消されていたら、売り場なしで入れ直す。
  - 送り終えたら読み直し、サーバの中身に合わせる。2人の変更が重なったら、品物ごとに「最後に届いた方が勝ち」。
- **画面の上の知らせ**：電波が無いとき「電波がありません。この端末に保存して、つながったら送ります（未送信 N 件）」。ログインが切れたとき「ログインが切れています。ログインし直すと送ります（未送信 N 件）」と「ログインし直す」。送れたら消える。
- **開き直し**：電波が無いまま開き直しても出せるよう、最後に読めた自分と Family を localStorage（`kaji.offlineMe`）に持つ。`/me` が fetch ごと落ちたときだけこれで画面を出し、`online` で読み直す。401 やログアウトでは消す。画面の殻は Service Worker のキャッシュから（`/assets/*` は `Vary: Origin` で配られるので、キャッシュから引くときは Vary を見ない）。

やり方の Markdown は `components/Markdown.tsx`（react-markdown＋remark-gfm、`skipHtml`。rehype-raw は使わない）で React の要素にするだけで、HTML の文字列を作らない。HTML の直書きは捨て、`javascript:` などのリンクは react-markdown が消す。見出しは画面の見出しの下に入るよう `#` を h3 から。リンクは `target=_blank rel="noopener noreferrer"`、チェックリストの印は押せない飾り、画像は読み込まずリンクにする。重いので lazy で読む（`components/Howto.tsx`）。今日の札の「やり方」は札のメタの行の終わりに小さく置き、押すとダイアログで読む。表で編集の「やり方」のマス（あり／—）を押すと、書く欄とプレビューの小さな画面が開き、「決める」でマスに入れる（保存は表の保存ボタン）。

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
- `GET /families/:fid/chores`（期限・状態・前回の記録つき。`?archived=1` で無効の家事も）、`POST /families/:fid/chores`
- 家事の返り値（一覧・詳細・登録）には `howto`・`hasHowto`・`howtoUpdatedAt`・`howtoUpdatedByName` が付く。`POST`・`PATCH /chores/:id`・bulk の create と chores で `howto`（文字。空・null で消す）を受け付け、中身が変わったときだけ直した人と日時を更新する。10000 文字をこえたら 400
- `GET /chores/:id`（記録・回・家事ごとの統計つき）、`PATCH /chores/:id`（`archived` で無効にする・有効に戻す）、`DELETE /chores/:id`
- `POST /chores/:id/logs`（`doneOn` は省くと今日。先の日付は断る）、`DELETE /logs/:id`（取り消し。家族のだれでも）
- 周期の入力：`{type:"interval", intervalDays, firstDueOn}` か `{type:"calendar", rule}`。毎週・毎月は anchor を省くと登録した日（編集では前の基準日）。隔週・数か月ごとは anchor 必須で、規則に当たる日でなければ断る

- `GET /families/:fid/groups`、`POST /families/:fid/groups`、`PATCH /groups/:id`（名前・並び順）、`DELETE /groups/:id`（家事はグループなしに）
- `POST /families/:fid/chores/bulk`（まとめて登録。1行でも不備があれば1件も入れず、`rows: [{index, message}]` を返す。100件まで）
- `PATCH /families/:fid/chores/bulk`（表で編集。`{ create?: ChoreInput[], chores?: [{ id, name?, schedule?, groupId?, assigneeUserId?, notifyTime?, howto?, archived? }], deleteIds?: string[] }` で、足す・直す・消すを1つの batch で行う（どれか失敗したら全部戻る）。chores は来なかった項目は変えない。周期の基準日は `PATCH /chores/:id` と同じく引き継ぐ。消すと記録も cascade で消える。よその Family の家事・不備が1行でもあれば1件も変えず `bulk_invalid` の 400、`rows: [{ kind: "create"|"update"|"delete", index, message }]`（index はそれぞれの配列の中の位置）。同じ家事を直すのと消すの両方に入れると 400。3つとも空なら 400。返り値は `{ created, updated, deleted }`。合わせて200件まで）

**統計**
- `GET /families/:fid/stats?from=&to=`（日本時間の日付、両端を含む。省いた側は今月の初日・末日）。計算は `src/shared/stats.ts`
  - 取り消した記録は数えない。無効の家事は含める（期限の計算は、無効にした日で打ち切る）
  - 守り具合は、期間内に期限がある「回」（2 の統計用の「回」）で数える。家事の詳細の統計と同じ数え方。いま開いている回は数えない

```
{
  today, from, to,
  totalCount,                                   // 期間内の記録の数
  people: [{ userId, name, isMember, count, share }],  // 分担。メンバー（入った順）＋記録のある抜けた人。share は %（整数）
  byChore: [{ choreId, name, archived, count, byUser: [{ userId, count }] }],  // 担当の偏り。記録のある家事だけ、多い順
  punctuality: { judgedCount, onTimeCount, onTimeRate, averageDaysLate, missedCount },
      // onTimeRate は期限内の回 ÷（できた回＋missed）の %。averageDaysLate はできた回の平均（小数1桁）。回が無ければ null
  weekly: [{ weekStart, count }],               // 月曜始まり。weekStart は月曜の日付
  monthly: [{ month: "YYYY-MM", count }],
      // 推移は from と「いちばん古い記録・期限」の遅いほうから to まで、0 の週・月も並べる
  lateRanking: [{ choreId, name, archived, score, ...punctuality と同じ項目 }],
      // score ＝ 平均の遅れ日数 ＋ missed の回数。0 より大きいものを多い順に上位10
}
```

**買い物**（どれも Family のメンバーだけ。よその Family のものは 404）
- `GET /families/:fid/shopping-lists`（リストと、それぞれの `openCount`・`cartCount`）、`POST /families/:fid/shopping-lists`（`{name}`。最初の売り場も入れる）
- `GET /shopping-lists/:id` → `{ list, lists, sections, items, frequent: [{ name, count, lastBoughtAt, sectionId }] }`（画面はこれだけを読み直す。frequent はリストにある名前を除いて50個まで）
- `PATCH /shopping-lists/:id`（名前・並び順）、`DELETE /shopping-lists/:id`（売り場・品物・買った記録も消える）
- `POST /shopping-lists/:id/sections`、`PATCH /shopping-sections/:id`（名前・並び順）、`DELETE /shopping-sections/:id`（品物は売り場なしに）
- `POST /shopping-lists/:id/items`（`{ id?, name, note?, sectionId? }`）。同じ id がもうあれば何も変えず 200 で今の品物を返す（新しく入れたら 201）。よそのリストの id なら 409。`sectionId` を送らなければ前に買ったときの売り場、`null` なら売り場なし
- `PATCH /shopping-items/:id`（`{ status?: "open"|"in_cart", name?, note?, sectionId? }`）。状態は切り替えではなく、なってほしい状態を送る。最後に書いた方が勝ち。無ければ 404
- `DELETE /shopping-items/:id`：もう無くても 200（`deleted: false`）
- `POST /shopping-lists/:id/checkout`（`{ itemIds? }`）：カゴの品物（itemIds があれば、そのうちカゴにあるもの）を買った記録に移してリストから外す。返り値は `{ purchased, names }`。送り直しても二重にならない
- `GET /shopping-lists/:id/purchases?limit=`（買った記録、新しい順。`{ name, note, sectionName, listName, userName, boughtAt }`）

**TODO**（どれも Family のメンバーだけ。よその Family のものは 404）。実装は `src/worker/todos/routes.ts`
- `GET /families/:fid/todos?status=open|done&due=today-or-overdue` → `{ today, todos: Todo[] }`
  - `status=open`（既定）：未完了。期限の近い順、期限なしは後ろ（同じなら sort_order・作った順）
  - `status=done`：済み。済ませた新しい順に `limit`（既定 100、500 まで）件
  - `due=today-or-overdue`：未完了で期限が今日か過ぎているものだけ（今日の画面用。`status=open` のときだけ）
  - `Todo` は `{ id, familyId, title, memo, hasMemo, dueOn, dueStatus: "overdue"|"today"|"upcoming"|null, daysLate, assigneeUserId, assigneeName, groupId, groupName, notifyTime, createdByName, done, doneAt, doneByName, sortOrder, createdAt, updatedAt, subtasks: [{ id, todoId, title, done, doneAt, doneByName, sortOrder }], progress: { done, total } }`。dueStatus は済み・期限なしなら null
- `POST /families/:fid/todos`（`{ title, memo?, dueOn?, assigneeUserId?, groupId?, notifyTime?, subtasks?: string[] }`）→ 201 で Todo
- `GET /todos/:id`、`PATCH /todos/:id`（`title・memo・dueOn・assigneeUserId・groupId・notifyTime・sortOrder・done`。来なかった項目は変えない。`done: true` で済ませた人と時刻を記録（もう済んでいれば変えない）、`false` で取り消し。サブタスクは変えない）→ Todo、`DELETE /todos/:id`（サブタスクも消える）
- `POST /todos/:id/subtasks`（`{ title }`。最後に足す）、`PATCH /subtasks/:id`（`title・done・sortOrder`。全部済んでも親は済みにしない）、`DELETE /subtasks/:id`。サブタスクの下に足す口は無い

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
  client/      React の画面、Service Worker、買い物を端末に持つ仕組み（shopping-store.ts）
  shared/      期限の計算など、両方で使うもの
migrations/    D1 のマイグレーション（Drizzle が出す SQL）
scripts/       bootstrap-link など
docs/
```
