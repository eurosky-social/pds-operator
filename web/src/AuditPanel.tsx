import { useEffect, useState } from "react";
import { api } from "./api.js";

interface AuditEntry {
  at: string;
  operator: string;
  action: string;
  target?: string;
}

const INITIAL = 7;
const STEP = 25;

export function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [visible, setVisible] = useState(INITIAL);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .audit()
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="panel">
      <h2>Audit Log</h2>
      {error && <div className="error-text">{error}</div>}
      {entries.length === 0 && !error && (
        <p className="mono-dim empty-state">no actions recorded yet</p>
      )}
      {entries.length > 0 && (
        <table className="audit-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Target</th>
              <th>Operator</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, visible).map((e, i) => (
              <tr key={i}>
                <td className="mono-dim">{new Date(e.at).toLocaleString()}</td>
                <td>{e.action}</td>
                <td className="mono-dim">{e.target ?? "—"}</td>
                <td className="mono-dim">{e.operator}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {entries.length > visible && (
        <button
          className="wide-mobile"
          onClick={() => setVisible((v) => v + STEP)}
          style={{ marginTop: 12 }}
        >
          load more ({entries.length - visible} more)
        </button>
      )}
    </div>
  );
}
