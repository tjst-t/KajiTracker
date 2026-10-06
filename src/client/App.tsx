import { useEffect, useState } from "react";

// 雛形の確認用。画面は「家事と記録・今日の画面」で作る
export function App() {
  const [health, setHealth] = useState<string>("確認中…");

  useEffect(() => {
    fetch("/api/health", { headers: { "X-Kaji-Client": "1" } })
      .then((r) => r.json() as Promise<{ ok: boolean; tables: number }>)
      .then((b) => setHealth(b.ok ? `API OK（テーブル ${b.tables} 個）` : "API NG"))
      .catch((e) => setHealth(`API に届かない：${String(e)}`));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>KajiTracker</h1>
      <p>{health}</p>
    </main>
  );
}
