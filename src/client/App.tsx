import { useCallback, useEffect, useState } from "react";
import { ApiError, type Me, api } from "./api";
import { takeTicketFromUrl } from "./auth";
import { errorText } from "./format";
import { Home } from "./screens/Home";
import { Login } from "./screens/Login";
import { Settings } from "./screens/Settings";
import { TicketScreen } from "./screens/Ticket";

// 札はページを開いた瞬間に URL から抜いておく（描画より前に）
const initialTicket = takeTicketFromUrl();

type Route = "home" | "settings";
const routeOf = (path: string): Route => (path.startsWith("/settings") ? "settings" : "home");

export function App() {
  const [ticket, setTicket] = useState(initialTicket);
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = 確認中
  const [loadError, setLoadError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(routeOf(location.pathname));

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/me"));
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!ticket) void refreshMe();
  }, [ticket, refreshMe]);

  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = (r: Route) => {
    history.pushState(null, "", r === "home" ? "/" : "/settings");
    setRoute(r);
  };

  if (ticket) return <TicketScreen token={ticket} onDone={() => setTicket(null)} />;
  if (loadError)
    return (
      <main className="page">
        <p className="error" role="alert">
          サーバに届きませんでした：{loadError}
        </p>
        <button className="btn" onClick={() => void refreshMe()}>
          もう一度読み込む
        </button>
      </main>
    );
  if (me === undefined) return <main className="page" aria-busy="true" />;
  if (me === null) return <Login onLoggedIn={refreshMe} />;

  return (
    <div className="shell">
      <header className="topbar">
        <a
          className="wordmark wordmark--small"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go("home");
          }}
        >
          KajiTracker
        </a>
        <nav className="topnav" aria-label="画面">
          <button className={route === "home" ? "is-current" : ""} aria-current={route === "home" ? "page" : undefined} onClick={() => go("home")}>
            今日
          </button>
          <button className={route === "settings" ? "is-current" : ""} aria-current={route === "settings" ? "page" : undefined} onClick={() => go("settings")}>
            設定
          </button>
        </nav>
      </header>
      {route === "home" ? <Home me={me} /> : <Settings me={me} onChanged={refreshMe} onLoggedOut={() => setMe(null)} />}
    </div>
  );
}
