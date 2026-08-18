import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "./api.js";

export function Enroll({
  token,
  pdsHostname,
  onEnrolled,
}: {
  /** one-time token, minted by the CLI or by the admin OAuth callback */
  token: string;
  pdsHostname: string;
  onEnrolled: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enroll = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.passkeyRegisterOptions(token);
      const response = await startRegistration({ optionsJSON: options });
      await api.passkeyRegister(name.trim(), response, token);
      window.history.replaceState(null, "", "/");
      onEnrolled();
    } catch (e) {
      const err = e as Error;
      if (err.name !== "NotAllowedError") setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-form">
        <span className="mono-dim">{pdsHostname ? `${pdsHostname} — ` : ""}enroll a passkey</span>
        <input
          placeholder="name (e.g. macbook touch id)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {error && <span className="error-text">{error}</span>}
        <button disabled={busy} onClick={enroll}>
          {busy ? "enrolling…" : "create passkey"}
        </button>
      </div>
    </div>
  );
}
