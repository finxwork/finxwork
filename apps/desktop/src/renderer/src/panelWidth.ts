import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

// The width of a panel on the window's right (the browser's, the files'), dragged by its left
// edge or moved by the arrow keys there, and kept for next time. The conversation keeps `room`
// beside it at least.

const defaultMinWidth = 360;

function savedWidth(key: string, min: number): number | null {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n >= min ? n : null;
}

export type PanelWidth = {
  panel: RefObject<HTMLElement | null>;
  width: number | null;
  resizing: boolean;
  /** The panel's own style: its width, unless it takes the window. */
  style: (max: boolean) => CSSProperties | undefined;
  /** For the grip on the left edge. */
  grip: { onPointerDown: (e: ReactPointerEvent) => void; onKeyDown: (e: KeyboardEvent) => void; "aria-valuenow": number | undefined };
};

/**
 * The room the conversation keeps beside it. A width kept from a wider window (or from another
 * file's room, a document's being more) gives way to it, so the panel never takes the page whole
 * and the conversation's column never shrinks to nothing.
 */
const fit = (room: number): CSSProperties => ({ maxWidth: `calc(100% - ${room}px)` });

export function usePanelWidth(key: string, room: () => number, min = defaultMinWidth): PanelWidth {
  const panel = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(() => savedWidth(key, min));
  const [resizing, setResizing] = useState(false);

  /** The widest the panel may be: the conversation keeps its room. */
  const maxWidth = () => {
    const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
    const left = panel.current?.parentElement?.getBoundingClientRect().left ?? 0;
    return Math.max(min, right - left - room());
  };
  const clamp = (w: number, most: number) => Math.round(Math.min(most, Math.max(min, w)));
  const keep = (w: number) => {
    const next = clamp(w, maxWidth());
    setWidth(next);
    localStorage.setItem(key, String(next));
  };

  // The arrow keys on the edge: left widens, right narrows.
  const onKeyDown = (e: KeyboardEvent) => {
    const now = panel.current?.getBoundingClientRect().width ?? min;
    if (e.key === "ArrowLeft") keep(now + 24);
    else if (e.key === "ArrowRight") keep(now - 24);
    else return;
    e.preventDefault();
  };

  // Dragging the left edge; the width is kept once it is let go.
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
    const most = maxWidth();
    setResizing(true);
    const move = (ev: PointerEvent) => setWidth(clamp(right - ev.clientX, most));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setResizing(false);
      setWidth((w) => {
        if (w !== null) localStorage.setItem(key, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return {
    panel,
    width,
    resizing,
    style: (max) => {
      if (max) return undefined;
      return { ...fit(room()), ...(width !== null ? ({ "--brp-w": `${width}px` } as CSSProperties) : {}) };
    },
    grip: { onPointerDown, onKeyDown, "aria-valuenow": width ?? undefined },
  };
}
