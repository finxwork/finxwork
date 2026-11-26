import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { baseName, type RpcClient } from "@finx/client";
import type { Anchor, OutlineItem, Rect } from "@finx/protocol";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { maxComment } from "../../../shared/annotations";
import { loadPdf, pdfjs, viewerLib } from "./pdf";
import { PdfTranslationPane, type PdfTranslateMode } from "./PdfTranslationPane";
import { lockedOut, unlockDoc, type SessionFiles, type Tab } from "../files/state";
import { useScope } from "../session/scope";
import { quoteToComposer, setDocPassword, setPage, type DocTab, type Jump } from "./state";

// A PDF in the file panel (document-editor-design §7): the bar of its own tools — the page,
// zoom, search, outline and pages — over the PDF canvas, pdf.js's viewer. What people select
// is read by finx (doc/resolve), never taken from pdf.js's text (DE-11): the quote that goes to
// the conversation is the text the agent would read there.

type PdfViewer = InstanceType<Awaited<ReturnType<typeof viewerLib>>["PDFViewer"]>;
type EventBus = InstanceType<Awaited<ReturnType<typeof viewerLib>>["EventBus"]>;

/** A selection or a drawn region waiting in its card for a note and "Add"; a selection may go on over `more` pages. x, y: the end of it, in the view. */
type Pending = { page: number; quads: Rect[]; more: { page: number; quads: Rect[] }[]; rect?: Rect; text: string; x: number; y: number; image?: string };

/** The card's width, as the browser's add-to-chat card. */
const cardWidth = 296;

/** Lit-up rectangles on pages for a moment: a citation's source, or what was just quoted. */
type Flash = { parts: { page: number; rects: Rect[] }[]; seq: number };

/** A selection's rectangles, one per run of text, merged line by line into solid bands (as
 * Chrome draws a PDF selection): runs sharing most of their height are one line, and a line
 * takes the full height of its tallest run. PDF coordinates, y up. */
export function lineBands(rects: Rect[]): Rect[] {
  const lines: Rect[] = [];
  for (const r of [...rects].sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)) {
    const h = r.y1 - r.y0;
    const line = lines.find((l) => Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0) > 0.5 * Math.min(h, l.y1 - l.y0));
    if (line) Object.assign(line, { x0: Math.min(line.x0, r.x0), x1: Math.max(line.x1, r.x1), y0: Math.min(line.y0, r.y0), y1: Math.max(line.y1, r.y1) });
    else lines.push({ ...r });
  }
  return lines;
}

export function PdfView({ rpc, session, tab, jump }: { rpc: RpcClient; session: string; tab: DocTab; jump: Jump | null }) {
  const scope = useScope();
  const { t } = useTranslation("session");
  const st = useStore();
  const docId = tab.info.doc_id;
  const scroller = useRef<HTMLDivElement>(null);
  const pagesEl = useRef<HTMLDivElement>(null);
  const viewer = useRef<PdfViewer | null>(null);
  const bus = useRef<EventBus | null>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  // pdf.js asking for a password finx did not pass on (it may not keep one): asked for here, and given to pdf.js only.
  const [password, setPassword] = useState(tab.password);
  const [asking, setAsking] = useState<{ wrong: boolean } | null>(null);
  const [page, setPageNo] = useState(tab.page);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [translating, setTranslating] = useState(false);
  const [translateMode, setTranslateMode] = useState<PdfTranslateMode>("split");
  const [query, setQuery] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [side, setSide] = useState<"outline" | "pages" | null>(null);
  const [region, setRegion] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  // The text being selected, drawn as bands while the mouse drags (the browser's own highlight is hidden).
  const [live, setLive] = useState<Flash["parts"] | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const noteBox = useRef<HTMLTextAreaElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const ready = useRef<Promise<void> | null>(null);

  // The viewer: pdf.js lays out every page, renders those in sight, and keeps a text layer to
  // select and search in. Links go out only as http(s) (the window opens nothing else).
  useEffect(() => {
    let live = true;
    let doc: pdfjs.PDFDocumentProxy | null = null;
    let done: () => void = () => {};
    ready.current = new Promise((r) => (done = r));
    void (async () => {
      try {
        const lib = await viewerLib();
        const eventBus = new lib.EventBus();
        const linkService = new lib.PDFLinkService({ eventBus, externalLinkTarget: lib.LinkTarget.BLANK, externalLinkRel: "noopener noreferrer" });
        const findController = new lib.PDFFindController({ eventBus, linkService });
        const v = new lib.PDFViewer({
          container: scroller.current!,
          viewer: pagesEl.current!,
          eventBus,
          linkService,
          findController,
          textLayerMode: 1,
          annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
          removePageBorders: true,
        });
        linkService.setViewer(v);
        doc = await loadPdf(tab.token, password);
        if (!live) return void doc.destroy();
        eventBus.on("pagesinit", () => {
          v.currentScaleValue = "page-width";
          if (tab.page > 1) v.currentPageNumber = Math.min(tab.page, doc!.numPages);
          done();
        });
        eventBus.on("pagechanging", (e: { pageNumber: number }) => setPageNo(e.pageNumber));
        eventBus.on("scalechanging", (e: { scale: number }) => setScale(e.scale));
        eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount));
        eventBus.on("updatefindcontrolstate", (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount));
        v.setDocument(doc);
        linkService.setDocument(doc);
        viewer.current = v;
        bus.current = eventBus;
        setPdf(doc);
      } catch (e) {
        if (live && e instanceof Error && e.name === "PasswordException") setAsking({ wrong: password !== undefined });
        else if (live) setError(e instanceof Error ? e.message : String(e));
        done();
      }
    })();
    return () => {
      live = false;
      viewer.current?.setDocument(null as never);
      viewer.current = null;
      bus.current = null;
      void doc?.destroy();
    };
  }, [tab.token, password]);

  // The page goes back to finx (the session's view, for "this page") and stays for next time.
  useEffect(() => {
    if (!pdf) return;
    const timer = setTimeout(() => {
      setPage(session, docId, page);
      void rpc.request("doc/view", { session_id: session, doc_id: docId, page }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [page, pdf]);

  // Fit to width stays fit to width as the column's width changes.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const v = viewer.current;
      if (el.clientWidth && v && v.currentScaleValue === "page-width") v.currentScaleValue = "page-width";
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Chromium sends trackpad pinch as a control-modified wheel event. Keep the point
  // under the gesture in place as pdf.js relays out the pages at the new scale.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const pinch = (e: WheelEvent) => {
      const v = viewer.current;
      if (!e.ctrlKey || !v || !v.pdfDocument || !e.deltaY) return;
      e.preventDefault();
      const oldScale = v.currentScale;
      const next = Math.min(5, Math.max(0.1, oldScale * Math.exp(-e.deltaY * 0.01)));
      if (next === oldScale) return;
      const page = [...(pagesEl.current?.querySelectorAll<HTMLElement>(".page") ?? [])].find((p) => {
        const r = p.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      const before = page?.getBoundingClientRect();
      v.updateScale({ scaleFactor: next / oldScale, drawingDelay: 150 });
      if (page && before) {
        const after = page.getBoundingClientRect();
        const ratio = v.currentScale / oldScale;
        el.scrollLeft += after.left + (e.clientX - before.left) * ratio - e.clientX;
        el.scrollTop += after.top + (e.clientY - before.top) * ratio - e.clientY;
      }
    };
    el.addEventListener("wheel", pinch, { passive: false });
    return () => el.removeEventListener("wheel", pinch);
  }, []);

  /** The page's drawn area: where PDF coordinates map to the screen. */
  const pageBox = (n: number) => {
    const view = viewer.current?.getPageView(n - 1);
    const el = view?.div?.querySelector(".canvasWrapper") ?? view?.div;
    return view && el ? { view, rect: (el as HTMLElement).getBoundingClientRect() } : null;
  };
  const toPdf = (n: number, r: DOMRect | { left: number; top: number; right: number; bottom: number }): Rect | null => {
    const box = pageBox(n);
    if (!box) return null;
    const [ax, ay] = box.view.viewport.convertToPdfPoint(r.left - box.rect.left, r.top - box.rect.top);
    const [bx, by] = box.view.viewport.convertToPdfPoint(r.right - box.rect.left, r.bottom - box.rect.top);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  };
  /** The page under a point, by the pages' boxes: the point may be out of sight (a long selection). */
  const pageAt = (x: number, y: number): number | null => {
    for (const el of pagesEl.current?.querySelectorAll<HTMLElement>(".page") ?? []) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(el.dataset.pageNumber) || null;
    }
    return null;
  };
  const panelPoint = (x: number, y: number) => {
    const r = scroller.current!.parentElement!.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };

  // A citation, or a quote's source: go there and light it up.
  const go = async (anchor: Anchor) => {
    await ready.current;
    const v = viewer.current;
    if (!v || !("page" in anchor)) return;
    const rects = anchor.kind === "text" ? anchor.quads : anchor.kind === "region" ? [anchor.rect] : [];
    const top = rects.reduce((m, r) => Math.max(m, r.y1), -Infinity);
    v.scrollPageIntoView({ pageNumber: anchor.page, destArray: rects.length ? [null, { name: "XYZ" }, null, top + 36, null] : undefined, allowNegativeOffset: true });
    if (rects.length) setFlash({ parts: [{ page: anchor.page, rects }], seq: Date.now() });
  };
  useEffect(() => {
    if (jump && jump.anchor.kind !== "cells") void go(jump.anchor);
  }, [jump?.seq]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [flash?.seq]);

  // pdf.js's text layer stretches an empty element over the page while a selection is made; its
  // box, many lines tall, is not text and would light the whole page: boxes far taller than the
  // text around them are left out.
  const selectionRects = (sel: Selection) => {
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    const heights = rects.map((r) => r.height).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)] ?? 0;
    return rects.filter((r) => r.height <= Math.max(median * 2.5, 4) && !(r.width > 0 && rects.length === 1 && r.height > 200));
  };
  const rectsByPage = (rects: DOMRect[]) => {
    const byPage = new Map<number, Rect[]>();
    for (const r of rects) {
      const n = pageAt(r.left + r.width / 2, r.top + r.height / 2);
      const q = n ? toPdf(n, r) : null;
      if (n && q) byPage.set(n, [...(byPage.get(n) ?? []), q]);
    }
    return byPage;
  };
  // While text is being selected, its bands follow it.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount || !scroller.current?.contains(sel.anchorNode)) return setLive(null);
        const byPage = rectsByPage(selectionRects(sel));
        setLive(byPage.size ? [...byPage].map(([page, rects]) => ({ page, rects })) : null);
      });
    };
    document.addEventListener("selectionchange", update);
    return () => (document.removeEventListener("selectionchange", update), cancelAnimationFrame(frame));
  }, []);

  // Selected text: its rectangles, page by page, go to finx to be read.
  const onMouseUp = (e: React.MouseEvent) => {
    if (region) return;
    // The click that ends a selection's bar should not clear it first.
    if ((e.target as HTMLElement).closest(".dcp-card")) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !scroller.current?.contains(sel.anchorNode)) return setPending(null);
      const rects = selectionRects(sel);
      if (!rects.length) return setPending(null);
      const byPage = rectsByPage(rects);
      const pages = [...byPage.keys()].sort((a, b) => a - b);
      if (!pages.length) return setPending(null);
      const [first, ...rest] = pages;
      const more = rest.map((n) => ({ page: n, quads: byPage.get(n)! }));
      // The bar goes by the end of the selection, kept within sight.
      const last = rects[rects.length - 1];
      const view = scroller.current!.getBoundingClientRect();
      setPending({ page: first, quads: byPage.get(first)!, more, text: sel.getRangeAt(0).toString().replace(/\s+/g, " ").trim(), ...panelPoint(Math.min(last.right, view.right - 20), Math.min(Math.max(last.bottom, view.top), view.bottom - 60)) });
    });
  };

  // A region: drawn on a page while the region tool is on.
  const startBand = (e: React.PointerEvent) => {
    if (!region || e.button !== 0 || (e.target as HTMLElement).closest(".dcp-card")) return;
    const n = pageAt(e.clientX, e.clientY);
    if (!n) return;
    e.preventDefault();
    setPending(null);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => setBand({ x0: Math.min(x0, ev.clientX), y0: Math.min(y0, ev.clientY), x1: Math.max(x0, ev.clientX), y1: Math.max(y0, ev.clientY) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBand(null);
      const box = { left: Math.min(x0, ev.clientX), top: Math.min(y0, ev.clientY), right: Math.max(x0, ev.clientX), bottom: Math.max(y0, ev.clientY) };
      if (box.right - box.left < 6 || box.bottom - box.top < 6) return;
      const rect = toPdf(n, box);
      if (!rect) return;
      setPending({ page: n, quads: [], more: [], rect, text: "", image: crop(n, box), ...panelPoint(box.right, box.bottom) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** What the region shows, as PNG (base64), from the page's own canvas. */
  const crop = (n: number, box: { left: number; top: number; right: number; bottom: number }): string | undefined => {
    const canvas = viewer.current?.getPageView(n - 1)?.div?.querySelector("canvas");
    if (!canvas) return undefined;
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    const sx = Math.max(0, (box.left - r.left) * k);
    const sy = Math.max(0, (box.top - r.top) * k);
    const sw = Math.min(canvas.width - sx, (box.right - box.left) * k);
    const sh = Math.min(canvas.height - sy, (box.bottom - box.top) * k);
    if (sw < 2 || sh < 2) return undefined;
    const fit = Math.min(1, 1600 / Math.max(sw, sh));
    const out = document.createElement("canvas");
    out.width = Math.round(sw * fit);
    out.height = Math.round(sh * fit);
    out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  };

  // "Add", as in the browser's add-to-chat: finx reads what is there; the composer gets the quote,
  // the note said about it, and a region's picture. The annotate mode stays on for the next one.
  const add = async () => {
    const p = pending;
    if (!p || adding) return;
    setAdding(true);
    try {
      const r = await rpc.request("doc/resolve", { session_id: session, doc_id: docId, page: p.page, quads: p.quads, rect: p.rect, more: p.more });
      // A region names its block too, so the model can cite the passage, not only the page.
      const block = r.block ?? (r.anchor.kind === "text" ? (r.anchor.block ?? undefined) : undefined);
      const toPage = p.more.at(-1)?.page;
      const comment = note.trim() || undefined;
      quoteToComposer(session, { quote: { path: tab.info.path, doc_id: docId, page: p.page, text: r.text, block, anchor: r.anchor, region: p.rect ? true : undefined, to_page: toPage, comment }, image: p.image });
      // Over the window (a preview), the composer it went to is out of sight.
      scope?.leave?.();
      const parts = [{ page: p.page, rects: r.boxes.length ? r.boxes : p.rect ? [p.rect] : [] }, ...(r.more ?? []).map((m) => ({ page: "page" in m.anchor ? m.anchor.page : p.page, rects: m.boxes }))];
      setFlash({ parts, seq: Date.now() });
      setPending(null);
      window.getSelection()?.removeAllRanges();
      scroller.current?.focus({ preventScroll: true });
    } catch (e) {
      if (!(await lockedOut(session, docId, e))) st.show(errorText(e), undefined, true);
    } finally {
      setAdding(false);
    }
  };
  // A new selection or region starts a new card, its note empty and ready to type in.
  useEffect(() => {
    setNote("");
    if (pending) setTimeout(() => noteBox.current?.focus({ preventScroll: true }));
  }, [pending]);

  const find = (again: boolean, previous = false) => {
    if (!query) return;
    bus.current?.dispatch("find", { source: null, type: again ? "again" : "", query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  };
  const closeSearch = () => {
    setQuery(null);
    setMatches(null);
    bus.current?.dispatch("findbarclose", { source: null });
  };
  const zoom = (k: number | "fit") => {
    const v = viewer.current;
    if (!v) return;
    if (k === "fit") v.currentScaleValue = "page-width";
    else v.currentScale = Math.min(5, Math.max(0.25, v.currentScale * k));
  };
  const goPage = (n: number) => {
    if (viewer.current && pdf) viewer.current.currentPageNumber = Math.min(pdf.numPages, Math.max(1, n));
  };

  useEffect(() => {
    if (!region) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (pending) setPending(null);
      else setRegion(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [region, pending]);

  // Keys while the column has focus: ⌘F search, ⌘L quote, ⌘+ ⌘- ⌘0 zoom, Esc lets go.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "f") {
      e.preventDefault();
      setQuery((q) => q ?? "");
      setTimeout(() => searchBox.current?.select());
    } else if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoom(1.2);
    } else if (mod && e.key === "-") {
      e.preventDefault();
      zoom(1 / 1.2);
    } else if (mod && e.key === "0") {
      e.preventDefault();
      zoom("fit");
    } else if (e.key === "Escape") {
      if (pending) { e.preventDefault(); e.stopPropagation(); setPending(null); }
      else if (region) { e.preventDefault(); e.stopPropagation(); setRegion(false); }
      else if (query !== null) closeSearch();
    }
  };

  // The lit-up rectangles, laid over their page in its own coordinates: a flash for a moment,
  // or what the open card is about, for as long as it is open.
  const marking: Flash | null = pending
    ? { parts: [{ page: pending.page, rects: pending.rect ? [pending.rect] : lineBands(pending.quads) }, ...pending.more.map((m) => ({ page: m.page, rects: lineBands(m.quads) }))], seq: 0 }
    : live
      ? { parts: live.map((p) => ({ page: p.page, rects: lineBands(p.rects) })), seq: 0 }
      : null;
  useLayoutEffect(() => {
    if (!marking) return;
    const layers: HTMLElement[] = [];
    for (const part of marking.parts) {
      const view = viewer.current?.getPageView(part.page - 1);
      if (!view?.div) continue;
      const layer = document.createElement("div");
      layer.className = pending?.rect ? "dcp-flash dcp-mark" : "dcp-sel";
      for (const r of part.rects) {
        const [a, b, c, d] = view.viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
        const box = document.createElement("div");
        Object.assign(box.style, { left: `${Math.min(a, c)}px`, top: `${Math.min(b, d)}px`, width: `${Math.abs(c - a)}px`, height: `${Math.abs(d - b)}px` });
        layer.appendChild(box);
      }
      view.div.appendChild(layer);
      layers.push(layer);
    }
    return () => layers.forEach((l) => l.remove());
  }, [pending, live, scale]);
  useLayoutEffect(() => {
    if (!flash) return;
    const layers: HTMLElement[] = [];
    for (const part of flash.parts) {
      const view = viewer.current?.getPageView(part.page - 1);
      if (!view?.div) continue;
      const layer = document.createElement("div");
      layer.className = "dcp-flash";
      for (const r of part.rects) {
        const [a, b, c, d] = view.viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
        const box = document.createElement("div");
        Object.assign(box.style, { left: `${Math.min(a, c) - 2}px`, top: `${Math.min(b, d) - 2}px`, width: `${Math.abs(c - a) + 4}px`, height: `${Math.abs(d - b) + 4}px` });
        layer.appendChild(box);
      }
      view.div.appendChild(layer);
      layers.push(layer);
    }
    return () => layers.forEach((l) => l.remove());
  }, [flash?.seq, scale]);

  const info = tab.info;
  const pages = pdf?.numPages ?? info.pages ?? 0;
  return (
    <div className="dcp-in" onKeyDown={onKeyDown}>
      {/* Where you are on the left, how big in the middle, the tools on the right. */}
      <div className="dcp-bar">
        <div className="dcp-bar-start">
          <button className={`tb no-drag ${side ? "on" : ""}`} title={t("doc.sidebar")} aria-label={t("doc.sidebar")} aria-pressed={side !== null} onClick={() => setSide(side ? null : info.outline?.length ? "outline" : "pages")}>
            <Icon name="list" />
          </button>
          <button className={`brp-annotate no-drag ${region ? "on" : ""}`} title={t("doc.regionTool")} aria-label={t("doc.regionTool")} aria-pressed={region} disabled={!pdf} onClick={() => (setRegion(!region), setPending(null), scroller.current?.focus({ preventScroll: true }))}>
            <Icon name="edit" />
          </button>
          <button
            className={`brp-annotate brp-translate no-drag ${translating ? "on" : ""}`}
            title={t("browser.translate")}
            aria-label={t("browser.translate")}
            aria-pressed={translating}
            disabled={!pdf}
            onClick={() => {
              const next = !translating;
              setTranslating(next);
              if (next) {
                const w = scroller.current?.closest(".dcp-body")?.clientWidth ?? 900;
                setTranslateMode(w >= 820 ? "split" : "translated");
              }
            }}
          >
            <Icon name="translate" />
          </button>
          <span className="dcp-sep" />
          <form
            className="dcp-page no-drag"
            onSubmit={(e) => {
              e.preventDefault();
              if (pageDraft !== null) goPage(Number(pageDraft));
              setPageDraft(null);
            }}
          >
            <input aria-label={t("doc.page")} value={pageDraft ?? String(page)} onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ""))} onFocus={(e) => e.target.select()} onBlur={() => setPageDraft(null)} />
            <span>/ {pages}</span>
          </form>
        </div>
        <div className="dcp-zoom no-drag">
          <button title={t("doc.zoomOut")} aria-label={t("doc.zoomOut")} onClick={() => zoom(1 / 1.2)}>
            <Icon name="minus" />
          </button>
          <button className="dcp-scale" title={t("doc.fit")} onClick={() => zoom("fit")}>
            {Math.round(scale * 100)}%
          </button>
          <button title={t("doc.zoomIn")} aria-label={t("doc.zoomIn")} onClick={() => zoom(1.2)}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="dcp-bar-end">
          <button className={`tb no-drag ${query !== null ? "on" : ""}`} title={t("doc.search")} aria-label={t("doc.search")} onClick={() => (query === null ? (setQuery(""), setTimeout(() => searchBox.current?.focus())) : closeSearch())}>
            <Icon name="search" />
          </button>
        </div>
      </div>
      {query !== null && (
        <form
          className="dcp-find"
          onSubmit={(e) => {
            e.preventDefault();
            find(matches !== null, (e.nativeEvent as SubmitEvent & { shiftKey?: boolean }).shiftKey);
          }}
        >
          <Icon name="search" />
          <input
            ref={searchBox}
            value={query}
            placeholder={t("doc.searchPlaceholder")}
            onChange={(e) => (setQuery(e.target.value), setMatches(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matches === null) find(false);
                else find(true, e.shiftKey);
              } else if (e.key === "Escape") closeSearch();
            }}
          />
          {matches && <span className="dcp-count">{matches.total ? `${matches.current}/${matches.total}` : t("doc.noMatch")}</span>}
        </form>
      )}
      {info.scanned && <div className="dcp-note">{t("doc.scanned")}</div>}
      <div className="dcp-body">
        {side && pdf && <Side side={side} setSide={setSide} outline={info.outline ?? []} pdf={pdf} page={page} go={goPage} />}
        <div
          className={`dcp-view ${region ? "regioning" : ""}`}
          style={{ display: translating && translateMode === "translated" ? "none" : undefined }}
          onMouseUp={onMouseUp}
          onPointerDown={startBand}
        >
          <div className="dcp-scroll" ref={scroller} tabIndex={0}>
            <div className="pdfViewer" ref={pagesEl} />
          </div>
          {!pdf && !error && (
            <div className="dcp-wait">
              <span className="mini-spin" />
            </div>
          )}
          {error && <div className="dcp-error">{error}</div>}
          {asking && (
            <div className="dcp-wait">
              <PasswordForm
                name={baseName(tab.info.path)}
                wrong={asking.wrong}
                onSubmit={async (p) => {
                  setAsking(null);
                  setPassword(p);
                  setDocPassword(session, docId, p);
                }}
              />
            </div>
          )}
          {region && !band && !pending && <button type="button" className="dcp-hint" onClick={() => setRegion(false)}>{t("doc.regionHint")}</button>}
          {band && (
            <div
              className="dcp-band"
              style={(() => {
                const a = panelPoint(band.x0, band.y0);
                return { left: a.x, top: a.y, width: band.x1 - band.x0, height: band.y1 - band.y0 };
              })()}
            />
          )}
          {pending && (
            <form
              className="dcp-card no-drag"
              role="dialog"
              aria-label={t("annotate.title")}
              style={(() => {
                const view = scroller.current?.parentElement?.getBoundingClientRect();
                const w = view?.width ?? cardWidth + 24;
                const h = view?.height ?? 400;
                return { left: Math.max(12, Math.min(w - cardWidth - 12, pending.x - cardWidth / 2)), top: Math.max(12, Math.min(h - 170, pending.y + 10)) };
              })()}
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <div className="dcp-card-head">
                <span className="dcp-card-kind">{pending.rect ? t("doc.kindRegion") : t("doc.kindText")}</span>
                <span className="dcp-card-quote" title={pending.text}>
                  {pending.text || t("doc.regionOn", { page: pending.page })}
                </span>
                <button type="button" className="dcp-card-x" title={t("annotate.cancel")} aria-label={t("annotate.cancel")} onClick={() => setPending(null)}>
                  <Icon name="x" />
                </button>
              </div>
              <textarea
                ref={noteBox}
                value={note}
                rows={2}
                maxLength={maxComment}
                placeholder={t("annotate.placeholder")}
                aria-label={t("annotate.title")}
                disabled={adding}
                onChange={(e) => {
                  setNote(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  void add();
                }}
              />
              <div className="dcp-card-foot">
                <span>{adding ? t("annotate.adding") : t("annotate.shortcut")}</span>
                <button className="dcp-card-add" disabled={adding}>
                  {t("annotate.add")}
                </button>
              </div>
            </form>
          )}
        </div>
        {translating && pdf && translateMode !== "original" && (
          <PdfTranslationPane
            pdf={pdf}
            scopeId={`docpdf:${docId}`}
            title={baseName(tab.info.path)}
            currentPage={page}
            mode={translateMode}
            onMode={setTranslateMode}
            onFocusParagraph={(targetPage, rects) => {
              if (translateMode === "translated") setTranslateMode("split");
              goPage(targetPage);
              if (rects.length > 0) {
                const union: Rect = {
                  x0: Math.min(...rects.map((r) => r.x0)),
                  y0: Math.min(...rects.map((r) => r.y0)),
                  x1: Math.max(...rects.map((r) => r.x1)),
                  y1: Math.max(...rects.map((r) => r.y1)),
                };
                setFlash({ parts: [{ page: targetPage, rects: [union] }], seq: Date.now() });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

/** An encrypted document's password, asked for in its tab; it goes to finx and is kept nowhere else. */
export function Unlock({ s, tab }: { s: SessionFiles; tab: Tab }) {
  return (
    <div className="dcp-in">
      <PasswordForm name={tab.name} wrong={!!tab.opened?.locked?.wrong} onSubmit={(password) => unlockDoc(s, tab, password)} />
    </div>
  );
}

function PasswordForm({ name, wrong, onSubmit }: { name: string; wrong: boolean; onSubmit: (password: string) => Promise<void> }) {
  const { t } = useTranslation("session");
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  // Each refusal shakes the field again.
  const [tries, setTries] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    if (wrong) setTries((n) => n + 1);
  }, [wrong]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    await onSubmit(password);
    setBusy(false);
    setPassword("");
    input.current?.focus();
  };
  return (
    <form className="dcp-unlock" onSubmit={submit}>
      <span className="dcp-unlock-badge">
        <Icon name="lock" />
      </span>
      <b>{t("doc.lockedTitle")}</b>
      <p title={name}>{t("doc.locked", { name })}</p>
      <div key={tries} className={`dcp-unlock-field ${wrong ? "bad" : ""}`}>
        <input
          ref={input}
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={password}
          placeholder={t("doc.password")}
          aria-label={t("doc.password")}
          aria-invalid={wrong}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
        {password && (
          <button type="button" className="dcp-unlock-eye" title={t(shown ? "doc.hidePassword" : "doc.showPassword")} aria-label={t(shown ? "doc.hidePassword" : "doc.showPassword")} onClick={() => (setShown(!shown), input.current?.focus())}>
            <Icon name={shown ? "eyeOff" : "eye"} />
          </button>
        )}
        {(password || busy) && (
          <button className="dcp-unlock-go" title={t("doc.unlock")} aria-label={t("doc.unlock")} disabled={busy}>
            {busy ? <span className="mini-spin" /> : <Icon name="arrowRight" />}
          </button>
        )}
      </div>
      <span className="dcp-unlock-bad" role="alert">{wrong ? t("doc.wrongPassword") : ""}</span>
    </form>
  );
}

/** The outline and the pages, beside the canvas. */
function Side({ side, setSide, outline, pdf, page, go }: { side: "outline" | "pages"; setSide: (s: "outline" | "pages") => void; outline: OutlineItem[]; pdf: pdfjs.PDFDocumentProxy; page: number; go: (n: number) => void }) {
  const { t } = useTranslation("session");
  return (
    <div className="dcp-side">
      <div className="dcp-side-tabs">
        {outline.length > 0 && (
          <button className={side === "outline" ? "on" : ""} onClick={() => setSide("outline")}>
            {t("doc.outline")}
          </button>
        )}
        <button className={side === "pages" ? "on" : ""} onClick={() => setSide("pages")}>
          {t("doc.pages")}
        </button>
      </div>
      <div className="dcp-side-list">
        {side === "outline" ? <Outline items={outline} go={go} depth={0} /> : Array.from({ length: pdf.numPages }, (_, i) => <Thumb key={i} pdf={pdf} n={i + 1} on={page === i + 1} go={go} />)}
      </div>
    </div>
  );
}

function Outline({ items, go, depth }: { items: OutlineItem[]; go: (n: number) => void; depth: number }) {
  return (
    <>
      {items.map((item, i) => (
        <div key={i}>
          <button className="dcp-ol" style={{ paddingLeft: 10 + depth * 12 }} disabled={!item.page} onClick={() => item.page && go(item.page)}>
            <span>{item.title}</span>
            {item.page && <span className="dcp-ol-p">{item.page}</span>}
          </button>
          {item.children && item.children.length > 0 && <Outline items={item.children} go={go} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

/** A page's small picture, drawn once it scrolls into sight. */
function Thumb({ pdf, n, on, go }: { pdf: pdfjs.PDFDocumentProxy; n: number; on: boolean; go: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) holder.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let task: { cancel: () => void } | null = null;
    const observer = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || task) return;
      observer.disconnect();
      const p = await pdf.getPage(n);
      const vp = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: (110 / vp.width) * window.devicePixelRatio });
      const c = canvas.current;
      if (!c) return;
      c.width = viewport.width;
      c.height = viewport.height;
      const render = p.render({ canvas: c, viewport });
      task = render;
      await render.promise.catch(() => {});
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      task?.cancel();
    };
  }, [pdf, n]);
  return (
    <button ref={holder} className={`dcp-thumb ${on ? "on" : ""}`} onClick={() => go(n)}>
      <canvas ref={canvas} />
      <span>{n}</span>
    </button>
  );
}
