export function SyncFooter({ lastFullSync }: { lastFullSync: string | null }) {
  if (!lastFullSync) return null;
  const mins = (Date.now() - new Date(lastFullSync).getTime()) / 60_000;
  return (
    <footer className="sync-footer">
      {mins > 40 ? "⚠ " : ""}
      db synced {formatAgo(mins)}
    </footer>
  );
}

function formatAgo(mins: number): string {
  const m = Math.floor(mins);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
