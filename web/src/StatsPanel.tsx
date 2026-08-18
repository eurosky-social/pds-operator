import { useEffect, useState } from "react";
import { api, type Stats } from "./api.js";
import { useToast } from "./useToast.js";

const monthLabel = (m: string) =>
  new Date(`${m}-15T00:00:00Z`)
    .toLocaleString(undefined, { month: "short", timeZone: "UTC" })
    .toLowerCase();

// "2026-07-05" -> "7/5"
export const dayLabel = (day: string) => {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
};

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

export function usePersisted(key: string, allowed: number[], fallback: number) {
  const [value, setValue] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return allowed.includes(saved) ? saved : fallback;
  });
  const set = (v: number) => {
    setValue(v);
    localStorage.setItem(key, String(v));
  };
  return [value, set] as const;
}

export function ChartHead({
  title,
  value,
  options,
  unit,
  onChange,
}: {
  title: string;
  value: number;
  options: number[];
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="chart-head">
      <span className="chart-title">{title}</span>
      <select
        value={value}
        aria-label={`${title} time period`}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n} {unit}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Bars({
  data,
  labels,
  ariaLabel,
  max: maxOverride,
  onBar,
}: {
  data: { key: string; n: number; title: string }[];
  labels?: string[];
  ariaLabel: string;
  // shared scale when one dataset renders as multiple charts
  max?: number;
  onBar?: (title: string, at: { clientX: number; clientY: number }) => void;
}) {
  const max = maxOverride ?? Math.max(...data.map((d) => d.n), 1);
  // pre-thinned labels (blanks between marks) opt out of the nth-child hiding
  const sparse = labels?.some((l) => !l) ?? false;
  return (
    <>
      <div className={`chart-bars${data.length > 40 ? " dense" : ""}`} role="img" aria-label={ariaLabel}>
        {data.map((d) => (
          <div
            key={d.key}
            className={`chart-bar${d.n === 0 ? " zero" : ""}`}
            style={{ height: `${Math.max((d.n / max) * 100, 3)}%` }}
            title={d.title}
            onClick={(e) => onBar?.(d.title, e)}
          />
        ))}
      </div>
      {labels && (
        <div
          className={`chart-months${!sparse && labels.length > 12 ? " dense" : ""}${sparse ? " sparse" : ""}`}
          aria-hidden="true"
        >
          {labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </>
  );
}

export function StatsPanel({ onSearchAccount }: { onSearchAccount?: (handle: string) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writeDays, setWriteDays] = usePersisted("statsWriteDays", [7, 30, 90], 30);
  const [signupMonths, setSignupMonths] = usePersisted("statsSignupMonths", [6, 12, 24], 12);
  const [activeDays, setActiveDays] = usePersisted("statsActiveDays", [7, 30, 90], 30);
  const isMobile = useIsMobile();
  const [toast, showToast] = useToast();
  useEffect(() => {
    const refresh = () =>
      api
        .stats(writeDays, signupMonths, activeDays)
        .then(setStats)
        .catch((e) => setError(e.message));
    refresh();
    // same cadence as the relay stats at the top of the page
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [writeDays, signupMonths, activeDays]);

  const placeholder = error ? (
    <span className="value mono-dim">—</span>
  ) : (
    <span className="value skeleton" aria-hidden="true" />
  );

  const act = stats?.activity;
  const noActivityYet = act != null && act.writesByDay.every((d) => d.n === 0);

  const tiles: { label: string; value: string | null | undefined }[] = [
    { label: "Active", value: act?.active.toLocaleString() },
    { label: "Dormant", value: act?.dormant.toLocaleString() },
    {
      label: "Avg Daily Active",
      value: act?.avgDailyActive.toLocaleString(undefined, { maximumFractionDigits: 1 }),
    },
    { label: "Signups", value: act?.newAccounts.toLocaleString() },
    { label: "Writes", value: act?.writes.toLocaleString() },
  ];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Stats</h2>
        <select
          value={activeDays}
          aria-label="activity time period"
          onChange={(e) => setActiveDays(Number(e.target.value))}
        >
          {[7, 30, 90].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
      {error && (
        <div className="error-text" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div className="stats-strip">
        {tiles.map((t) => (
          <span className="pair kv" key={t.label}>
            {stats ? <span className="value">{t.value ?? "—"}</span> : placeholder}
            <span className="label">{t.label}</span>
          </span>
        ))}
      </div>
      {stats && act && (
        <>
          {act.topAccounts.length > 0 && (
            <div className="inline-counts">
              <span className="chart-title">Most Active</span>
              <div>
                {act.topAccounts.map((t) => (
                  <button
                    className="inline-count with-avatar"
                    key={t.did}
                    title={`search accounts for ${t.handle}`}
                    onClick={() => onSearchAccount?.(t.did)}
                  >
                    {t.avatar ? (
                      <img className="avatar" src={t.avatar} alt="" loading="lazy" />
                    ) : (
                      <span className="avatar" aria-hidden="true" />
                    )}
                    {t.handle} <b>{t.n.toLocaleString()}</b>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="charts-row">
          <div className="chart">
            <ChartHead
              title="Signups / Month"
              value={signupMonths}
              options={[6, 12, 24]}
              unit="months"
              onChange={setSignupMonths}
            />
            {(() => {
              const data = stats.signups.map((s) => ({
                key: s.month,
                n: s.n,
                title: `${s.month}: ${s.n.toLocaleString()}`,
              }));
              const monthLabels = stats.signups.map((s) => monthLabel(s.month));
              // 24 bars don't fit a phone screen; split into two stacked years
              if (isMobile && signupMonths === 24) {
                const shared = Math.max(...stats.signups.map((s) => s.n), 1);
                return [0, 12].map((from) => (
                  <div key={from} className={from > 0 ? "chart-half" : undefined}>
                    <Bars
                  onBar={showToast}
                      ariaLabel={`signups per month, months ${from + 1}-${from + 12} of the last 24`}
                      data={data.slice(from, from + 12)}
                      labels={monthLabels.slice(from, from + 12)}
                      max={shared}
                    />
                  </div>
                ));
              }
              return (
                <Bars
                  onBar={showToast}
                  ariaLabel={`signups per month, last ${signupMonths} months`}
                  data={data}
                  labels={monthLabels}
                />
              );
            })()}
          </div>
          <div className="chart">
            <ChartHead
              title="Writes / Day"
              value={writeDays}
              options={[7, 30, 90]}
              unit="days"
              onChange={setWriteDays}
            />
            {noActivityYet ? (
              <div className="chart-empty">no activity recorded yet, counting starts now</div>
            ) : (
              <Bars
                  onBar={showToast}
                ariaLabel={`writes per day, last ${writeDays} days`}
                data={act.writesByDay.map((d) => ({
                  key: d.day,
                  n: d.n,
                  title: `${d.day}: ${d.n.toLocaleString()}`,
                }))}
                labels={act.writesByDay.map((d, i) =>
                  i % (writeDays === 7 ? 1 : writeDays === 30 ? 5 : 15) === 0
                    ? dayLabel(d.day)
                    : "",
                )}
              />
            )}
          </div>
          </div>
          {stats.labels.length > 0 && (
            <div className="inline-counts">
              <span className="chart-title">Flags By Label</span>
              <div>
                {stats.labels.map((l) => (
                  <button
                    className="inline-count"
                    key={l.name}
                    title={`search accounts flagged ${l.name}`}
                    onClick={() => onSearchAccount?.(l.name)}
                  >
                    <span className="label">{l.name}</span> <b className="value">{l.n.toLocaleString()}</b>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {toast}
    </section>
  );
}
