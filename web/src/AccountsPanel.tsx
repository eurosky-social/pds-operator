import { useEffect, useState, useCallback, useRef } from "react";
import { api, formatBytes, type Account } from "./api.js";
import { AccountStatsModal } from "./AccountStatsModal.js";
import { useToast } from "./useToast.js";

const PAGE_SIZES = [25, 50, 100, 250];

export function AccountsPanel({
  appviewUrl,
  searchFor,
}: {
  appviewUrl: string;
  // search request from another panel (e.g. clicking a handle in stats)
  searchFor?: { q: string } | null;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [flaggedTotal, setFlaggedTotal] = useState(0);
  // DM notifications deep-link here with ?q=<handle> to pull up the flagged account
  const [query, setQuery] = useState(
    () => new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const [hideTakendown, setHideTakendown] = useState(true);
  const [sortStorage, setSortStorage] = useState(false);
  const [hideEmails, setHideEmails] = useState(
    () => localStorage.getItem("hideEmails") !== "0",
  );
  const [pageSize, setPageSize] = useState(() => {
    const saved = Number(localStorage.getItem("accountsPageSize"));
    return PAGE_SIZES.includes(saved) ? saved : 25;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!searchFor) return;
    setQuery(searchFor.q);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [searchFor]);
  const [busyDid, setBusyDid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    did: string;
    action: "status" | "reset" | "delete";
  } | null>(null);
  const [menuDid, setMenuDid] = useState<string | null>(null);
  const [passwordResult, setPasswordResult] = useState<{ handle: string; password: string } | null>(
    null,
  );
  const [statsDid, setStatsDid] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (!filtersOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setFiltersOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [filtersOpen]);
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
      setConfirm(null);
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
      .accounts({
        q: query.trim() || undefined,
        limit: pageSize,
        hideTakendown,
        sort: sortStorage ? "storage" : undefined,
      })
      .then((r) => {
        setAccounts(r.accounts);
        setTotal(r.total);
        setFlaggedTotal(r.flaggedTotal);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [query, hideTakendown, pageSize, sortStorage]);

  useEffect(() => {
    const id = setTimeout(refresh, query.trim() ? 300 : 0);
    return () => clearTimeout(id);
  }, [refresh, query]);

  // while any purge is running, poll so its progress ticks up in the table
  const anyPurging = accounts.some((a) => a.purge && a.purge.status !== "error");
  useEffect(() => {
    if (!anyPurging) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [anyPurging, refresh]);

  const loadMore = () => {
    setLoading(true);
    api
      .accounts({
        q: query.trim() || undefined,
        offset: accounts.length,
        limit: pageSize,
        hideTakendown,
        sort: sortStorage ? "storage" : undefined,
      })
      .then((r) => {
        setAccounts((prev) => [...prev, ...r.accounts]);
        setTotal(r.total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const runAction = async (
    did: string,
    action: "takedown" | "enable" | "resetPassword" | "purgeRecords",
  ) => {
    setBusyDid(did);
    setConfirm(null);
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
        <th>Handle</th>
        <th>DID</th>
        <th>Status</th>
        <th>Indexed</th>
        <th>
          <button
            type="button"
            className="th-sort"
            title="sort by storage"
            aria-pressed={sortStorage}
            onClick={() => setSortStorage((s) => !s)}
          >
            Storage{sortStorage ? " ↓" : ""}
          </button>
        </th>
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
          <button
            type="button"
            className="handle-link"
            title={`stats for ${a.handle}`}
            onClick={() => setStatsDid(a.did)}
          >
            {a.handle}
          </button>
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
        {a.purge && (
          <div className={`purge-tag ${a.purge.status === "error" ? "error" : ""}`}>
            {a.purge.status === "error"
              ? "purge failed"
              : `purging… ${a.purge.deleted.toLocaleString()} deleted`}
          </div>
        )}
      </td>
      <td className="mono-dim">{new Date(a.indexedAt).toLocaleDateString()}</td>
      <td className="mono-dim storage-cell">{formatBytes(a.storageBytes)}</td>
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
              setConfirm(null);
            }}
          >
            ⋯
          </button>
          {menuDid === a.did && (
            <div className="menu" role="menu">
              {confirm?.did === a.did ? (
                <>
                  <button
                    className="danger"
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      if (confirm.action === "reset") runAction(a.did, "resetPassword");
                      else if (confirm.action === "delete") runAction(a.did, "purgeRecords");
                      else runAction(a.did, a.status === "takendown" ? "enable" : "takedown");
                    }}
                  >
                    {confirm.action === "reset"
                      ? "confirm reset password"
                      : confirm.action === "delete"
                        ? "confirm delete forever"
                        : `confirm ${a.status === "takendown" ? "enable" : "takedown"}`}
                  </button>
                  <button role="menuitem" onClick={() => setConfirm(null)}>
                    cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      setStatsDid(a.did);
                    }}
                  >
                    view stats
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      window.open(`${appviewUrl}/profile/${a.did}`, "_blank", "noopener");
                    }}
                  >
                    visit profile
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuDid(null);
                      window.open(`https://pds.ls/at://${a.did}`, "_blank", "noopener");
                    }}
                  >
                    open in pdsls
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
                  <button
                    role="menuitem"
                    onClick={() => setConfirm({ did: a.did, action: "status" })}
                  >
                    {a.status === "takendown" ? "enable" : "takedown"}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => setConfirm({ did: a.did, action: "reset" })}
                  >
                    reset password
                  </button>
                  {a.status === "takendown" && !a.purge && (
                    <button
                      className="danger"
                      role="menuitem"
                      onClick={() => setConfirm({ did: a.did, action: "delete" })}
                    >
                      delete all records
                    </button>
                  )}
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
      <div className="panel" ref={panelRef}>
        <div className="panel-head">
          <h2>
            Accounts ({total - flaggedTotal}
            {query.trim() ? " matching" : ""}
            {flaggedTotal > 0 ? ` + ${flaggedTotal} flagged` : ""})
          </h2>
          <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button
              aria-haspopup="menu"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              filters
            </button>
            {filtersOpen && (
              <div className="menu filters-menu" role="menu">
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={hideTakendown}
                    onChange={(e) => setHideTakendown(e.target.checked)}
                  />
                  hide taken down
                </label>
                <label className="menu-check">
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
                <div className="menu-sep" />
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={sortStorage}
                    onChange={(e) => setSortStorage(e.target.checked)}
                  />
                  sort by storage
                </label>
              </div>
            )}
          </div>
        </div>
        <div className="accounts-toolbar">
          <span className="search-wrap">
            <input
              type="search"
              placeholder="search handle, email, did, or label…"
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
        {statsDid && (
          <AccountStatsModal
            did={statsDid}
            appviewUrl={appviewUrl}
            showEmail={!hideEmails}
            onClose={() => setStatsDid(null)}
          />
        )}
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
