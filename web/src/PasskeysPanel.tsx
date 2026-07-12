import { useCallback, useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "./api.js";

interface Passkey {
  id: string;
  name: string;
  createdAt: number;
}

export function PasskeysPanel() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .passkeys()
      .then((r) => setPasskeys(r.passkeys))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      await api.passkeyRegister(name.trim(), response);
      setName("");
      refresh();
    } catch (e) {
      const err = e as Error;
      if (err.name !== "NotAllowedError") setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.passkeyDelete(id);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Passkeys</h2>
      {error && <div className="error-text">{error}</div>}
      {passkeys.length === 0 && (
        <p className="mono-dim empty-state">no passkeys yet. password sign-in only.</p>
      )}
      {passkeys.map((p) => (
        <div key={p.id} className="passkey-row">
          <span>{p.name}</span>
          <span className="mono-dim">{new Date(p.createdAt).toLocaleDateString()}</span>
          <button disabled={busy} onClick={() => remove(p.id)}>
            remove
          </button>
        </div>
      ))}
      <div className="passkey-add">
        <input
          placeholder="name (e.g. macbook touch id)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={busy} onClick={add}>
          add passkey
        </button>
      </div>
    </div>
  );
}
