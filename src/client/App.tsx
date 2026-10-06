import { useCallback, useEffect, useState } from "react";
import { ApiError, type Family, type Me, api } from "./api";
import { takeFragmentFromUrl } from "./auth";
import { errorText } from "./format";
import { FamilyCreate } from "./screens/FamilyCreate";
import { FamilyScreen } from "./screens/FamilyScreen";
import { Home } from "./screens/Home";
import { InviteScreen } from "./screens/Invite";
import { Login } from "./screens/Login";
import { Settings } from "./screens/Settings";
import { TicketScreen } from "./screens/Ticket";

// 札・招待はページを開いた瞬間に URL から抜いておく（描画より前に）
const initialFragment = takeFragmentFromUrl();

type Route = "home" | "family" | "settings";
const PATHS: Record<Route, string> = { home: "/", family: "/family", settings: "/settings" };
const routeOf = (path: string): Route => (path.startsWith("/settings") ? "settings" : path.startsWith("/family") ? "family" : "home");

const FAMILY_KEY = "kaji.currentFamily";

export function App() {
  const [ticket, setTicket] = useState(initialFragment?.kind === "login" ? initialFragment.token : null);
  const [invite, setInvite] = useState(initialFragment?.kind === "invite" ? initialFragment.token : null);
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = 確認中
  const [families, setFamilies] = useState<Family[] | undefined>(undefined);
  const [currentId, setCurrentId] = useState<string | null>(localStorage.getItem(FAMILY_KEY));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(routeOf(location.pathname));

  const selectFamily = (id: string | null) => {
    setCurrentId(id);
    if (id) localStorage.setItem(FAMILY_KEY, id);
    else localStorage.removeItem(FAMILY_KEY);
  };

  const loadFamilies = useCallback(async (select?: string) => {
    const list = await api<Family[]>("GET", "/families");
    setFamilies(list);
    setCurrentId((cur) => {
      const want = select ?? cur;
      const next = list.find((f) => f.id === want)?.id ?? list[0]?.id ?? null;
      if (next) localStorage.setItem(FAMILY_KEY, next);
      else localStorage.removeItem(FAMILY_KEY);
      return next;
    });
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const m = await api<Me>("GET", "/me");
      setMe(m);
      await loadFamilies();
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setFamilies(undefined);
      } else setLoadError(errorText(e));
    }
  }, [loadFamilies]);

  useEffect(() => {
    if (!ticket) void refreshMe();
  }, [ticket, refreshMe]);

  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = (r: Route) => {
    history.pushState(null, "", PATHS[r]);
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

  if (invite)
    return (
      <InviteScreen
        token={invite}
        me={me}
        onJoined={async (familyId) => {
          setInvite(null);
          selectFamily(familyId);
          await refreshMe();
          await loadFamilies(familyId);
          go("home");
        }}
        onCancel={() => setInvite(null)}
      />
    );

  if (me === null) return <Login onLoggedIn={refreshMe} />;
  if (families === undefined) return <main className="page" aria-busy="true" />;

  const family = families.find((f) => f.id === currentId) ?? families[0];

  if (!family && route !== "settings")
    return <FamilyCreate displayName={me.user.displayName} onCreated={(f) => void loadFamilies(f.id)} />;

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
        {family && families.length > 1 && (
          <label className="family-switch">
            <span className="visually-hidden">Family を切り替える</span>
            <select value={family.id} onChange={(e) => selectFamily(e.target.value)}>
              {families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav className="topnav" aria-label="画面">
          {(
            [
              ["home", "今日"],
              ["family", "家族"],
              ["settings", "設定"],
            ] as const
          ).map(([r, label]) => (
            <button key={r} className={route === r ? "is-current" : ""} aria-current={route === r ? "page" : undefined} onClick={() => go(r)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      {route === "settings" || !family ? (
        <Settings me={me} onChanged={refreshMe} onLoggedOut={() => setMe(null)} />
      ) : route === "family" ? (
        <FamilyScreen me={me} family={family} onFamiliesChanged={loadFamilies} />
      ) : (
        <Home me={me} family={family} />
      )}
    </div>
  );
}
