import { useEffect, useState, useCallback } from "react";
import { api, type CursorStatus } from "./api.js";
import { RequestCrawl } from "./RequestCrawl.js";

export function StatusPanel({
  onLastSync,
}: {
  onLastSync?: (iso: string | null) => void;
}) {
  const [status, setStatus] = useState<CursorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .cursorStatus()
      .then((s) => {
        setStatus(s);
        onLastSync?.(s.lastFullSync);
      })
      .catch((e) => setError(e.message));
  }, [onLastSync]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const gap = status?.gap;
  const gapClass = gap == null ? "warn" : gap < 500 ? "ok" : gap < 5000 ? "warn" : "error";
  const statusClass =
    status == null
      ? ""
      : status.relayStatus === "active" || status.relayStatus === "idle"
        ? "ok"
        : status.relayStatus === "throttled"
          ? "warn"
          : "error";

  // pulsing skeleton while the first fetch is in flight; static dash once it has failed
  const placeholder = error ? (
    <span className="value mono-dim">—</span>
  ) : (
    <span className="value skeleton" aria-hidden="true" />
  );

  return (
    <div className="status-panel">
      {error && (
        <div className="error-text" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div className="status-grid">
        <div className="stat kv">
          <span className="label">Relay Seq</span>
          {status ? (
            <span className="value">{status.relaySeq.toLocaleString()}</span>
          ) : (
            placeholder
          )}
        </div>
        <div className="stat kv">
          <span className="label">PDS Head</span>
          {status ? (
            <span className="value">{status.pdsHeadSeqApprox?.toLocaleString() ?? "—"}</span>
          ) : (
            placeholder
          )}
        </div>
        <div className="stat kv">
          <span className="label">Gap</span>
          {status ? (
            <span className={`value ${gapClass}`}>
              {gap != null ? gap.toLocaleString() : "unknown"}
            </span>
          ) : (
            placeholder
          )}
        </div>
        <div className="stat kv">
          <span className="label">Relay Status</span>
          {status ? <span className={`value ${statusClass}`}>{status.relayStatus}</span> : placeholder}
        </div>
        <div className="stat kv">
          <span className="label">Relay Accounts</span>
          {status ? <span className="value">{status.accountCount.toLocaleString()}</span> : placeholder}
        </div>
      </div>
      <RequestCrawl className="panel-crawl" onRequested={() => setTimeout(refresh, 2000)} />
    </div>
  );
}
