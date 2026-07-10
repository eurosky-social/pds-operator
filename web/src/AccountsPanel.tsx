import { useEffect, useState, useCallback } from "react";
import { api, type Account } from "./api.js";
import { useToast } from "./useToast.js";

const PAGE_SIZES = [25, 50, 100, 250];

export function AccountsPanel({ appviewUrl }: { appviewUrl: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [flaggedTotal, setFlaggedTotal] = useState(0);
  // DM notifications deep-link here with ?q=<handle> to pull up the flagged account
  const [query, setQuery] = useState(
    () => new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const [hideTakendown, setHideTakendown] = useState(true);
  const [hideEmails, setHideEmails] = useState(
    () => localStorage.getItem("hideEmails") !== "0",
  );
  const [pageSize, setPageSize] = useState(() => {
    const saved = Number(localStorage.getItem("accountsPageSize"));
    return PAGE_SIZES.includes(saved) ? saved : 25;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyDid, setBusyDid] = useState<string | null>(null);
  const [confirmDid, setConfirmDid] = useState<string | null>(null);
  const [menuDid, setMenuDid] = useState<string | null>(null);
  const [passwordResult, setPasswordResult] = useState<{ handle: string; password: string } | null>(
    null,
  );
  const [toast, showToast] = useToast();

  const copy = (text: string, what: string, e: React.MouseEvent) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    setMenuDid(null);
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(`${what} copied`, at))
      .catch(() => showToast("copy failed", at));
  };

  useEffect(() => {
    if (!menuDid) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setMenuDid(null);
      setConfirmDid(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuDid]);

  useEffect(() => {
    if (!passwordResult) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPasswordResult(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [passwordResult]);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .accounts({ q: query.trim() || undefined, limit: pageSize, hideTakendown })
      .then((r) => {
        setAccounts(r.accounts);
        setTotal(r.total);
        setFlaggedTotal(r.flaggedTotal);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [query, hideTakendown, pageSize]);

  useEffect(() => {
    const id = setTimeout(refresh, query.trim() ? 300 : 0);
    return () => clearTimeout(id);
  }, [refresh, query]);

  const loadMore = () => {
    setLoading(true);
    api
      .accounts({
        q: query.trim() || undefined,
        offset: accounts.length,
        limit: pageSize,
        hideTakendown,
      })
      .then((r) => {
        setAccounts((prev) => [...prev, ...r.accounts]);
        setTotal(r.total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const runAction = async (did: string, action: "takedown" | "enable" | "resetPassword") => {
    setBusyDid(did);
    setConfirmDid(null);
    try {
      if (action === "resetPassword") {
        const { password } = await api.resetPassword(did);
        const handle = accounts.find((a) => a.did === did)?.handle ?? did;
        setPasswordResult({ handle, password });
      } else {
        await api[action](did);
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyDid(null);
    }
  };

  const tableHead = (
    <thead>
      <tr>
        <th>handle</th>
        <th>did</th>
        <th>status</th>
        <th>indexed</th>
        <th></th>
      </tr>
    </thead>
  );

  const renderRow = (a: Account) => (
    <tr key={a.did}>
      <td>
        <span className="handle-cell">
          {a.avatar ? (
            <img className="avatar" src={a.avatar} alt="" loading="lazy" />
          ) : (
            <span className="avatar" aria-hidden="true" />
          )}
          <a
            className="handle-link"
            href={`${appviewUrl}/profile/${a.did}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {a.handle}
          </a>
        </span>
        {(a.labels?.length ?? 0) > 0 && <div className="labels">{a.labels!.join(", ")}</div>}
      </td>
      <td className="mono-dim did-cell">
        <div>{a.did}</div>
        {a.email && !hideEmails && <div className="email">{a.email}</div>}
      </td>
      <td
        className={`status-cell ${
          a.status === "takendown" ? "error" : a.status === "deactivated" ? "warn" : "ok"
        }`}
      >
        {a.status ?? "active"}
      </td>
      <td className="mono-dim">{new Date(a.indexedAt).toLocaleDateString()}</td>
      <td>
        <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            className="kebab"
            aria-label={`actions for ${a.handle}`}
            aria-haspopup="menu"
            aria-expanded={menuDid === a.did}
            disabled={busyDid === a.did}
            onClick={() => {
              setMenuDid(menuDid === a.did ? null : a.did);
              setConfirmDid(null);
            }}
          >
            ⋯
          </button>
          {menuDid === a.did && (
            <div className="menu" role="menu">
              {confirmDid === a.did ? (
                <>
                  <button
                    className="danger"
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      runAction(a.did, a.status === "takendown" ? "enable" : "takedown");
                    }}
                  >
                    confirm {a.status === "takendown" ? "enable" : "takedown"}
                  </button>
                  <button role="menuitem" onClick={() => setConfirmDid(null)}>
                    cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      window.open(`${appviewUrl}/profile/${a.did}`, "_blank", "noopener");
                    }}
                  >
                    visit profile
                  </button>
                  <button role="menuitem" onClick={(e) => copy(a.handle, "username", e)}>
                    copy username
                  </button>
                  <button role="menuitem" onClick={(e) => copy(a.did, "did", e)}>
                    copy did
                  </button>
                  {a.email && (
                    <button role="menuitem" onClick={(e) => copy(a.email ?? "", "email", e)}>
                      copy email
                    </button>
                  )}
                  <div className="menu-sep" />
                  <button role="menuitem" onClick={() => setConfirmDid(a.did)}>
                    {a.status === "takendown" ? "enable" : "takedown"}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      runAction(a.did, "resetPassword");
                    }}
                  >
                    reset password
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <>
      <div className="panel">
        <h2>
          accounts ({total - flaggedTotal}
          {query.trim() ? " matching" : ""}
          {flaggedTotal > 0 ? ` + ${flaggedTotal} flagged` : ""})
        </h2>
        <div className="accounts-toolbar">
          <span className="search-wrap">
            <input
              type="search"
              placeholder="search handle, email, or did…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="clear-search"
                aria-label="clear search"
                onClick={() => setQuery("")}
              >
                ✕
              </button>
            )}
          </span>
          <label>
            <input
              type="checkbox"
              checked={hideTakendown}
              onChange={(e) => setHideTakendown(e.target.checked)}
            />
            hide taken down
          </label>
          <label>
            <input
              type="checkbox"
              checked={hideEmails}
              onChange={(e) => {
                setHideEmails(e.target.checked);
                localStorage.setItem("hideEmails", e.target.checked ? "1" : "0");
              }}
            />
            hide emails
          </label>
        </div>
        {error && <div className="error-text">{error}</div>}
        {!loading && accounts.length === 0 && !error && (
          <p className="mono-dim empty-state">
            {query.trim() ? `no accounts match “${query.trim()}”` : "no accounts to show"}
          </p>
        )}
        <table className="accounts-table">
          {tableHead}
          <tbody>{accounts.map(renderRow)}</tbody>
        </table>
        <div className="accounts-footer">
          {total > accounts.length ? (
            <button onClick={loadMore} disabled={loading}>
              load more ({total - accounts.length} more)
            </button>
          ) : (
            <span />
          )}
          <label className="page-size">
            per page
            <select
              value={pageSize}
              onChange={(e) => {
                const size = Number(e.target.value);
                setPageSize(size);
                localStorage.setItem("accountsPageSize", String(size));
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {toast}
        {passwordResult && (
          <div className="modal-backdrop" onClick={() => setPasswordResult(null)}>
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label={`new password for ${passwordResult.handle}`}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>password reset for @{passwordResult.handle}</h3>
              <div className="password-box">{passwordResult.password}</div>
              <p className="modal-warn">
                this password won&rsquo;t be shown again — copy it now.
              </p>
              <div className="modal-actions">
                <button onClick={(e) => copy(passwordResult.password, "password", e)}>copy</button>
                <button onClick={() => setPasswordResult(null)}>close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
