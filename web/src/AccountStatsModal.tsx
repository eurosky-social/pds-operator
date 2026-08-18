import { useEffect, useState } from "react";
import { api, formatBytes, type AccountStats } from "./api.js";
import { Bars, ChartHead, dayLabel, usePersisted } from "./StatsPanel.js";
import { useToast } from "./useToast.js";

interface AuditEntry {
  at: string;
  operator: string;
  action: string;
  target?: string;
}

export function AccountStatsModal({
  did,
  appviewUrl,
  showEmail,
  onClose,
}: {
  did: string;
  appviewUrl: string;
  showEmail: boolean;
  onClose: () => void;
}) {
  const [days, setDays] = usePersisted("accountStatsDays", [7, 30, 90], 30);
  const [data, setData] = useState<AccountStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // operator actions on this account, filtered client-side from the shared audit feed
  const [actions, setActions] = useState<AuditEntry[] | null>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    api
      .accountStats(did, days)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [did, days]);

  useEffect(() => {
    api
      .audit()
      .then((r) => setActions(r.entries.filter((e) => e.target === did)))
      .catch(() => setActions([]));
  }, [did]);

  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const act = data?.activity;
  const noActivity = act != null && act.allTimeWrites === 0;
  const tiles: { label: string; value: string | null | undefined }[] = [
    {
      label: "Joined",
      value: data && new Date(data.account.indexedAt).toLocaleDateString(),
    },
    {
      label: "Last Active",
      value: act && (act.lastActive ? new Date(act.lastActive).toLocaleDateString() : "never"),
    },
    { label: `Writes / ${days}d`, value: act?.windowWrites.toLocaleString() },
    { label: `Active Days / ${days}d`, value: act?.activeDaysInWindow.toLocaleString() },
    { label: "All-Time Writes", value: act?.allTimeWrites.toLocaleString() },
    {
      label: "Storage",
      value:
        data &&
        (data.account.repoBytes == null
          ? "—"
          : formatBytes(data.account.repoBytes + (data.account.blobBytes ?? 0))),
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal stats-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`stats for ${data?.account.handle ?? did}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="account-head">
          {data?.account.avatar ? (
            <img className="avatar" src={data.account.avatar} alt="" />
          ) : (
            <span className="avatar" aria-hidden="true" />
          )}
          <div className="account-head-text">
            <h3>
              <a
                className="handle-link"
                href={`${appviewUrl}/profile/${did}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {data?.account.handle ?? "…"}
              </a>{" "}
              <span className={`account-status ${data?.account.status ?? ""}`}>
                {data && data.account.status !== "active" ? data.account.status : ""}
              </span>
            </h3>
            <div className="mono-dim account-sub clip" title={did}>
              {did}
            </div>
            {showEmail && data?.account.email && (
              <div className="mono-dim account-sub clip" title={data.account.email}>
                {data.account.email}
              </div>
            )}
            {data?.account.invitedBy && (
              <div className="mono-dim account-sub">
                invite code <span className="no-break">{data.account.invitedBy.code}</span>
                {data.account.invitedBy.byHandle ? ` from @${data.account.invitedBy.byHandle}` : ""}
              </div>
            )}
          </div>
        </div>
        {error && <div className="error-text">{error}</div>}
        {data && act && (
          <>
            <div className="stats-strip">
              {tiles.map((t) => (
                <span className="pair kv" key={t.label}>
                  <span className="value">{t.value ?? "—"}</span>
                  <span className="label">{t.label}</span>
                </span>
              ))}
            </div>
            <div className="chart">
              <ChartHead
                title="Writes / Day"
                value={days}
                options={[7, 30, 90]}
                unit="days"
                onChange={setDays}
              />
              {noActivity ? (
                <div className="chart-empty">no activity recorded for this account yet</div>
              ) : (
                <Bars
                  onBar={showToast}
                  ariaLabel={`writes per day for ${data.account.handle}, last ${days} days`}
                  data={act.writesByDay.map((d) => ({
                    key: d.day,
                    n: d.n,
                    title: `${d.day}: ${d.n.toLocaleString()}`,
                  }))}
                  labels={act.writesByDay.map((d, i) =>
                    i % (days === 7 ? 1 : days === 30 ? 5 : 15) === 0 ? dayLabel(d.day) : "",
                  )}
                />
              )}
            </div>
            {data.labels.length > 0 && (
              <div className="inline-counts">
                <span className="chart-title">Labels</span>
                <div>
                  {data.labels.map((l) => (
                    <span className="inline-count" key={`${l.src} ${l.val}`}>
                      <span className="label">{l.val}</span>{" "}
                      <b>{new Date(l.cts).toLocaleDateString()}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(actions?.length ?? 0) > 0 && (
              <div className="inline-counts">
                <span className="chart-title">Operator Actions</span>
                <ul className="account-actions mono-dim">
                  {actions!.map((a, i) => (
                    <li key={i}>
                      {new Date(a.at).toLocaleString()} — {a.action} by {a.operator}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>close</button>
        </div>
        {toast}
      </div>
    </div>
  );
}
