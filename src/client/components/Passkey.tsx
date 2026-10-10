import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { fetchRegisterOptions, fetchStepUpOptions, registerPasskey, setStepUpOpener, stepUp, usePrepared } from "../auth";
import { errorText } from "../format";

const isStepUpRequired = (e: unknown) => e instanceof ApiError && e.code === "step_up_required";

/**
 * この端末のパスキーを作るボタン（札で入った直後・設定）。options は出したときに取っておく。
 * 先に step-up が要るときは、「パスキーで確認する」→「パスキーを作る」と2回押してもらう（1回の押下で WebAuthn は1回だけ）
 */
export function CreatePasskey({ name, onCreated }: { name?: string; onCreated: () => void }) {
  const [phase, setPhase] = useState<"register" | "step-up">("register");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reg = usePrepared(phase === "register", fetchRegisterOptions);
  const check = usePrepared(phase === "step-up", fetchStepUpOptions);

  useEffect(() => {
    if (isStepUpRequired(reg.failure)) setPhase("step-up");
  }, [reg.failure]);

  const prepared = phase === "register" ? reg : check;
  const prepError = prepared.failure && !isStepUpRequired(prepared.failure) ? errorText(prepared.failure) : null;

  // ceremony はこの関数の中で、await より前に始まる
  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {phase === "step-up" && <p>パスキーを作る前に、ほかの端末のパスキーでもう一度確認してください（入ってから時間がたったため）。</p>}
      {(error || prepError) && (
        <p className="error" role="alert">
          {error ?? prepError}
        </p>
      )}
      {prepError && (
        <button className="btn" onClick={prepared.reload}>
          もう一度用意する
        </button>
      )}
      {phase === "step-up" ? (
        <button
          className="btn btn--primary"
          disabled={busy || !check.ready}
          onClick={() => void act(() => check.start(stepUp), () => setPhase("register"))}
        >
          {busy ? "確認しています…" : check.ready ? "パスキーで確認する" : "用意しています…"}
        </button>
      ) : (
        <button
          className="btn btn--primary"
          disabled={busy || !reg.ready}
          onClick={() => void act(() => reg.start((o) => registerPasskey(o, name)), onCreated)}
        >
          {busy ? "作っています…" : reg.ready ? "パスキーを作る" : "用意しています…"}
        </button>
      )}
    </div>
  );
}

/**
 * 「パスキーでもう一度確認してください」の段。withStepUp が step_up_required を受けたときに開く。
 * 開いたときに options を取り、ボタンの click の中ですぐパスキーを出す。App に1つだけ置く
 */
export function StepUpDialog() {
  const [pending, setPending] = useState<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  useEffect(() => {
    setStepUpOpener(() => new Promise<void>((resolve, reject) => setPending({ resolve, reject })));
    return () => setStepUpOpener(null);
  }, []);

  if (!pending) return null;
  return (
    <StepUpBody
      onDone={() => {
        pending.resolve();
        setPending(null);
      }}
      onCancel={() => {
        pending.reject(new ApiError(0, "確認をやめました", "cancelled"));
        setPending(null);
      }}
    />
  );
}

function StepUpBody({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = usePrepared(true, fetchStepUpOptions);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await check.start(stepUp);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const prepError = check.failure ? errorText(check.failure) : null;

  return (
    <dialog ref={dialog} className="dialog" onClose={onCancel} aria-labelledby="step-up-title">
      <div className="stack">
        <h2 id="step-up-title">パスキーでもう一度確認してください</h2>
        <p>大事な操作なので、この端末の顔認証や指紋で、本人か確かめます。</p>
        {(error || prepError) && (
          <p className="error" role="alert">
            {error ?? prepError}
          </p>
        )}
        {prepError && (
          <button className="btn" onClick={check.reload}>
            もう一度用意する
          </button>
        )}
        <button className="btn btn--primary" disabled={busy || !check.ready} onClick={() => void confirm()}>
          {busy ? "確認しています…" : check.ready ? "パスキーで確認する" : "用意しています…"}
        </button>
        <button className="btn btn--quiet" onClick={() => dialog.current?.close()}>
          やめる
        </button>
      </div>
    </dialog>
  );
}
