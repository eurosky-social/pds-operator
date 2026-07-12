import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { useToast } from "./useToast.js";

interface Invite {
  code: string;
  available: number;
  disabled: boolean;
  createdAt: string;
  uses: { usedBy: string; usedAt: string }[];
}

export function InvitesPanel() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [hideUsed, setHideUsed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const refresh = useCallback(() => {
    api
      .invites()
      .then((r) => setInvites(r.codes))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.inviteCreate(1);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.inviteDisable(code);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (code: string, e: React.MouseEvent) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    navigator.clipboard
      .writeText(code)
      .then(() => showToast("invite code copied", at))
      .catch(() => showToast("copy failed", at));
  };

  const isDead = (inv: Invite) => inv.disabled || inv.uses.length >= inv.available;
  const shown = hideUsed ? invites.filter((inv) => !isDead(inv)) : invites;

  return (
    <div className="panel">
      <h2 style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Invite Codes ({shown.length})
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            textTransform: "none",
            letterSpacing: "normal",
            fontWeight: 400,
            color: "var(--text)",
          }}
        >
          <input
            type="checkbox"
            checked={hideUsed}
            onChange={(e) => setHideUsed(e.target.checked)}
          />
          hide used
        </label>
      </h2>
      {error && <div className="error-text">{error}</div>}
      {shown.length === 0 && !error && (
        <p className="mono-dim empty-state">
          {hideUsed ? "no unused invite codes" : "no invite codes yet"}
        </p>
      )}
      {shown.length > 0 && (
        <table className="invites-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Uses</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((inv) => {
              const spent = inv.uses.length >= inv.available;
              return (
                <tr key={inv.code}>
                  <td className={inv.disabled || spent ? "mono-dim" : ""}>{inv.code}</td>
                  <td className="mono-dim">
                    {inv.uses.length}/{inv.available}
                  </td>
                  <td className="mono-dim">
                    {new Date(inv.createdAt).toLocaleDateString()}
                    {inv.disabled ? " (disabled)" : ""}
                  </td>
                  <td>
                    <div className="invite-actions">
                      <button disabled={busy} onClick={(e) => copy(inv.code, e)}>
                        copy
                      </button>
                      {!inv.disabled && !spent && (
                        <button disabled={busy} onClick={() => disable(inv.code)}>
                          disable
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button className="wide-mobile" disabled={busy} onClick={create} style={{ marginTop: 12 }}>
        create invite
      </button>
      {toast}
    </div>
  );
}
