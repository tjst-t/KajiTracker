import type { Me } from "../api";

/** S1 今日。家事の画面は「家事と記録・今日の画面」で作る */
export function Home({ me }: { me: Me }) {
  return (
    <main className="page">
      <h1>{me.user.displayName}さん、こんにちは</h1>
      <p>家事の一覧は、まだ作っていません。いまはログインと端末の管理だけ試せます。</p>
      {me.passkeyCount === 0 && (
        <p className="notice">
          あなたのアカウントには、まだパスキーがありません。「設定」でパスキーを作っておくと、次からすぐにログインできます。
        </p>
      )}
    </main>
  );
}
