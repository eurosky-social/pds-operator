import { useState, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  x: number;
  y: number;
  leaving: boolean;
}

let nextId = 0;

const VISIBLE_MS = 1200;
const LEAVE_MS = 450;
const STACK_GAP = 36;
const EDGE = 8;

/**
 * Transient notices anchored to the click point, clamped to the viewport.
 * Each toast holds, then slides up and fades; concurrent toasts stack upward.
 */
export function useToast(): [
  ReactNode,
  (message: string, at?: { clientX: number; clientY: number }) => void,
] {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = (message: string, at?: { clientX: number; clientY: number }) => {
    const id = nextId++;
    setToasts((prev) => {
      // rough monospace width estimate, good enough to keep it on-screen
      const halfWidth = Math.min(
        (message.length * 8.4 + 28) / 2,
        (window.innerWidth - EDGE * 2) / 2,
      );
      const baseX = at?.clientX ?? window.innerWidth / 2;
      const baseY = (at?.clientY ?? window.innerHeight - 20) - 44;
      const x = Math.min(Math.max(baseX, halfWidth + EDGE), window.innerWidth - halfWidth - EDGE);
      const y = Math.max(baseY, EDGE);
      // newest sits at the click point; everything already showing shifts up a slot
      const shifted = prev.map((t) => ({ ...t, y: Math.max(t.y - STACK_GAP, EDGE) }));
      return [...shifted, { id, message, x, y, leaving: false }];
    });
    window.setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    }, VISIBLE_MS);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, VISIBLE_MS + LEAVE_MS);
  };

  const node =
    toasts.length > 0 ? (
      <>
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast${t.leaving ? " leaving" : ""}`}
            style={{ left: t.x, top: t.y }}
          >
            {t.message}
          </div>
        ))}
      </>
    ) : null;

  return [node, show];
}
