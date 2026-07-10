import { useState } from "react";
import { api } from "./api.js";

type CrawlState =
  | { state: "idle" }
  | { state: "requesting" }
  | { state: "done" }
  | { state: "failed"; message: string };

export function RequestCrawl({
  className = "",
  onRequested,
}: {
  className?: string;
  onRequested?: () => void;
}) {
  const [crawl, setCrawl] = useState<CrawlState>({ state: "idle" });

  const handleRequestCrawl = async () => {
    setCrawl({ state: "requesting" });
    try {
      await api.requestCrawl();
      setCrawl({ state: "done" });
      onRequested?.();
      setTimeout(() => setCrawl({ state: "idle" }), 8000);
    } catch (e) {
      setCrawl({ state: "failed", message: (e as Error).message });
    }
  };

  return (
    <div className={`crawl-row ${className}`}>
      <button onClick={handleRequestCrawl} disabled={crawl.state === "requesting"}>
        {crawl.state === "requesting" ? "requesting…" : "request crawl"}
      </button>
      {crawl.state === "done" && (
        <span className="value" style={{ fontSize: 12 }}>
          crawl requested. the relay status will refresh shortly.
        </span>
      )}
      {crawl.state === "failed" && (
        <span className="error-text" style={{ fontSize: 12 }}>
          crawl request failed: {crawl.message}
        </span>
      )}
    </div>
  );
}
