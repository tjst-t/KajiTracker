import { useState } from "react";
import { type Family, api } from "../api";
import { errorText } from "../format";

/** Family を作るフォーム。Family が1つも無いときは画面全体（S7）、ある時は Family の画面の中で使う */
export function FamilyCreateForm({ onCreated, compact = false }: { onCreated: (f: Family) => void; compact?: boolean }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className={compact ? "row-form" : "stack"}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          onCreated(await api<Family>("POST", "/families", { name: name.trim() }));
          setName("");
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>{compact ? "新しい Family の名前" : "Family の名前"}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required placeholder="例：辻下家、実家" />
      </label>
      <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
        Family を作る
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function FamilyCreate({ displayName, onCreated }: { displayName: string; onCreated: (f: Family) => void }) {
  return (
    <main className="page page--narrow">
      <h1>{displayName}さん、まず Family を作りましょう</h1>
      <p>家事は Family ごとに管理します。作ったあと、家族を QR で招待できます。</p>
      <p className="muted">家族から招待の QR を受け取っているなら、ここでは作らずに、その QR を読み取ってください。</p>
      <FamilyCreateForm onCreated={onCreated} />
    </main>
  );
}
