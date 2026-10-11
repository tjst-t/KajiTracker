import { type Nav, type Route, pathOf } from "../router";

const ITEMS: { route: Route; title: string; note: string }[] = [
  { route: { name: "stats" }, title: "統計", note: "分担や期限の守り具合、回数の推移を見る" },
  { route: { name: "family" }, title: "家族", note: "メンバーと役割、家族を招待、Family の名前" },
  { route: { name: "settings" }, title: "設定", note: "名前・通知の時刻・パスキー・ログイン中の端末" },
];

/** その他：統計・家族・設定への入口 */
export function MoreScreen({ nav }: { nav: Nav }) {
  return (
    <main className="page">
      <h1>その他</h1>
      <ul className="more-list">
        {ITEMS.map(({ route, title, note }) => (
          <li key={route.name}>
            <a
              href={pathOf(route)}
              onClick={(e) => {
                e.preventDefault();
                nav.go(route);
              }}
            >
              <span className="more-list__title">{title}</span>
              <span className="more-list__note">{note}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** 統計・家族・設定の上に出す「その他」へ戻るリンク */
export function MoreCrumb({ nav }: { nav: Nav }) {
  return (
    <p className="crumb">
      <a
        href="/more"
        onClick={(e) => {
          e.preventDefault();
          nav.go({ name: "more" });
        }}
      >
        その他
      </a>
    </p>
  );
}
