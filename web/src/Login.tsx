import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api.js";

export function Login({
  pdsHostname,
  passwordLogin,
  onLoggedIn,
}: {
  pdsHostname: string;
  passwordLogin: boolean;
  onLoggedIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passkeySignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.passkeyLogin(response);
      onLoggedIn();
    } catch (e) {
      const err = e as Error;
      // user dismissing the browser's passkey prompt isn't an error worth showing
      if (err.name !== "NotAllowedError") setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-form" onSubmit={submit}>
        <span className="mono-dim">{pdsHostname ? `${pdsHostname} — operator` : "pds operator"}</span>
        <button type="button" disabled={busy} onClick={passkeySignIn} autoFocus>
          sign in with passkey
        </button>
        {passwordLogin &&
          (showPassword ? (
            <>
              <input
                type="password"
                placeholder="operator password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <button type="submit" disabled={busy}>
                {busy ? "checking…" : "sign in"}
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setShowPassword(true)}>
              use password
            </button>
          ))}
        {error && <span className="error-text">{error}</span>}
      </form>
    </div>
  );
}
