import type { Family, Me } from "../api";

/** S1 今日。家事の画面は「家事と記録・今日の画面」で作る */
export function Home({ me, family }: { me: Me; family: Family }) {
  return (
    <main className="page">
      <h1>{family.name}</h1>
      <p>家事の一覧は、まだ作っていません。いまはログイン・端末の管理・家族の招待を試せます。</p>
      {me.passkeyCount === 0 && (
        <p className="notice">
          あなたのアカウントには、まだパスキーがありません。「設定」でパスキーを作っておくと、次からすぐにログインできます。
        </p>
      )}
    </main>
  );
}
