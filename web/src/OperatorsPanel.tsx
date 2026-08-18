import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

interface Operator {
  did: string;
  handle: string;
  avatar?: string;
  addedAt: number;
  enrolledAt: number | null;
  passkeys: number;
}

export function OperatorsPanel() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDid, setConfirmDid] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .operators()
      .then((r) => setOperators(r.operators))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.operatorAdd(handle.trim());
      setHandle("");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (did: string) => {
    setBusy(true);
    setError(null);
    setConfirmDid(null);
    try {
      await api.operatorRemove(did);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Admins</h2>
      {error && <div className="error-text">{error}</div>}
      {operators.length === 0 && (
        <p className="mono-dim empty-state">
          no admins yet. add one by handle and have them sign in using the new admin button to
          create a passkey.
        </p>
      )}
      {operators.map((o) => (
        <div key={o.did} className="passkey-row">
          <span className="handle-cell">
            {o.avatar ? (
              <img className="avatar" src={o.avatar} alt="" loading="lazy" />
            ) : (
              <span className="avatar" aria-hidden="true" />
            )}
            @{o.handle}
            {o.enrolledAt == null && <span className="mono-dim">invited</span>}
          </span>
          <span className="mono-dim">
            {o.enrolledAt != null
              ? `enrolled ${new Date(o.enrolledAt).toLocaleDateString()}`
              : `added ${new Date(o.addedAt).toLocaleDateString()}`}
          </span>
          {confirmDid === o.did ? (
            <span className="invite-actions">
              <button className="danger" disabled={busy} onClick={() => remove(o.did)}>
                confirm remove
              </button>
              <button disabled={busy} onClick={() => setConfirmDid(null)}>
                cancel
              </button>
            </span>
          ) : (
            <button disabled={busy} onClick={() => setConfirmDid(o.did)}>
              remove
            </button>
          )}
        </div>
      ))}
      <div className="passkey-add">
        <input
          placeholder="handle (e.g. alice.bsky.social)"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <button disabled={busy || !handle.trim()} onClick={add}>
          add admin
        </button>
      </div>
      <p className="mono-dim panel-note">
        removing and re-adding an admin resets their enrollment (deletes their passkeys).
      </p>
    </div>
  );
}
