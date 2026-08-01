import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

type CrawlState =
  | { state: "idle" }
  | { state: "requesting" }
  | { state: "done"; relay?: string }
  | { state: "failed"; message: string };

export function RequestCrawl({
  className = "",
  onRequested,
}: {
  className?: string;
  onRequested?: () => void;
}) {
  const [crawl, setCrawl] = useState<CrawlState>({ state: "idle" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [relayInput, setRelayInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setMenuOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (showInput) inputRef.current?.focus();
  }, [showInput]);

  const handleRequestCrawl = async (relay?: string) => {
    setMenuOpen(false);
    setCrawl({ state: "requesting" });
    try {
      await api.requestCrawl(relay);
      setCrawl({ state: "done", relay });
      onRequested?.();
      setTimeout(() => setCrawl({ state: "idle" }), 8000);
    } catch (e) {
      setCrawl({ state: "failed", message: (e as Error).message });
    }
  };

  return (
    <div className={`crawl-row ${className}`}>
      <div className="menu-wrap crawl-split" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => handleRequestCrawl()}
          disabled={crawl.state === "requesting"}
        >
          {crawl.state === "requesting" ? "requesting…" : "request crawl"}
        </button>
        <button
          className="chevron"
          aria-label="request crawl from a specific relay"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={crawl.state === "requesting"}
          onClick={() => {
            setMenuOpen(!menuOpen);
            setShowInput(false);
            setRelayInput("");
          }}
        >
          {/* lucide chevron-down */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {menuOpen && (
          <div className="menu" role="menu">
            {showInput ? (
              <form
                className="relay-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const relay = relayInput.trim();
                  if (relay) handleRequestCrawl(relay);
                }}
              >
                <input
                  ref={inputRef}
                  value={relayInput}
                  onChange={(e) => setRelayInput(e.target.value)}
                  placeholder="relay.example.com"
                  aria-label="relay hostname"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <button type="submit" disabled={!relayInput.trim()}>
                  request
                </button>
              </form>
            ) : (
              <button role="menuitem" onClick={() => setShowInput(true)}>
                crawl from a specific relay…
              </button>
            )}
          </div>
        )}
      </div>
      {crawl.state === "done" && (
        <span className="value" style={{ fontSize: 12 }}>
          {crawl.relay ? `crawl requested from ${crawl.relay}.` : "crawl requested."} the relay
          status will refresh shortly.
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
