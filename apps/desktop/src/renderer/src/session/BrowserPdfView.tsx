import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Rect } from "@finx/protocol";
import { Icon } from "../icons";
import { loadPdfBytes, pdfjs, viewerLib } from "../docs/pdf";
import { PdfTranslationPane, type PdfTranslateMode } from "../docs/PdfTranslationPane";

type PdfViewer = InstanceType<Awaited<ReturnType<typeof viewerLib>>["PDFViewer"]>;
type EventBus = InstanceType<Awaited<ReturnType<typeof viewerLib>>["EventBus"]>;
type Flash = { page: number; rects: Rect[]; seq: number };

const SPLIT_MIN_WIDTH = 820;

/**
 * Unified `pdf.js` bilingual reader mounted in place of Chromium's PDFium plugin
 * whenever the user toggles immersive translation on an online PDF tab in the embedded browser.
 */
export function BrowserPdfView({
  targetId,
  url,
  title,
}: {
  targetId: string;
  url: string;
  title: string;
}) {
  const { t } = useTranslation("session");
  const wrapRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pagesEl = useRef<HTMLDivElement>(null);
  const viewer = useRef<PdfViewer | null>(null);
  const bus = useRef<EventBus | null>(null);

  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<PdfTranslateMode>("split");
  const [userPickedMode, setUserPickedMode] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // Adaptive default layout: split on wide panels, translated-only stream on narrow panels.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => {
      if (userPickedMode) return;
      setMode(el.clientWidth >= SPLIT_MIN_WIDTH ? "split" : "translated");
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [userPickedMode]);

  // Fetch PDF bytes using the embedded browser tab's session (cookies & proxy) and open in pdf.js.
  useEffect(() => {
    let alive = true;
    let doc: pdfjs.PDFDocumentProxy | null = null;
    setPdf(null);
    setError(null);
    setPage(1);

    void (async () => {
      try {
        const finx = window.finx;
        if (!finx) throw new Error("Bridge unavailable");
        const bytes = await finx.fetchBrowserPdf(targetId);
        if (!alive) return;
        doc = await loadPdfBytes(bytes);
        if (!alive) {
          void doc.destroy();
          return;
        }
        setPdf(doc);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      alive = false;
      void doc?.destroy();
    };
  }, [targetId, url]);

  // Mount pdf.js PDFViewer into the left pane.
  useEffect(() => {
    if (!pdf || !scroller.current || !pagesEl.current) return;
    let alive = true;
    void viewerLib().then(({ EventBus, PDFLinkService, PDFViewer }) => {
      if (!alive || !scroller.current || !pagesEl.current) return;
      const b = new EventBus();
      const linkService = new PDFLinkService({ eventBus: b });
      const v = new PDFViewer({
        container: scroller.current,
        viewer: pagesEl.current,
        eventBus: b,
        linkService,
        textLayerMode: 2,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
      });
      linkService.setViewer(v);
      linkService.setDocument(pdf);
      v.setDocument(pdf);
      b.on("pagesinit", () => {
        v.currentScaleValue = "page-width";
        setScale(v.currentScale);
      });
      b.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => setPage(pageNumber));
      b.on("scalechanging", ({ scale: s }: { scale: number }) => setScale(s));
      viewer.current = v;
      bus.current = b;
    });
    return () => {
      alive = false;
      viewer.current = null;
      bus.current = null;
      if (pagesEl.current) pagesEl.current.replaceChildren();
    };
  }, [pdf]);

  // Re-fit PDF canvas when toggling between split and original modes.
  useEffect(() => {
    if (!viewer.current || mode === "translated") return;
    const id = requestAnimationFrame(() => {
      if (viewer.current) {
        viewer.current.currentScaleValue = "page-width";
        setScale(viewer.current.currentScale);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  // Draw a single clean bounding highlight on the left PDF canvas when a translated paragraph is clicked.
  useLayoutEffect(() => {
    if (!flash || !viewer.current || flash.rects.length === 0) return;
    const view = viewer.current.getPageView(flash.page - 1);
    if (!view?.div) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of flash.rects) {
      const [a, b, c, d] = view.viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
      minX = Math.min(minX, a, c);
      minY = Math.min(minY, b, d);
      maxX = Math.max(maxX, a, c);
      maxY = Math.max(maxY, b, d);
    }
    const padX = 6;
    const padY = 4;
    const layer = document.createElement("div");
    layer.className = "pdf-tr-focus";
    const box = document.createElement("div");
    Object.assign(box.style, {
      left: `${Math.max(0, minX - padX)}px`,
      top: `${Math.max(0, minY - padY)}px`,
      width: `${maxX - minX + padX * 2}px`,
      height: `${maxY - minY + padY * 2}px`,
    });
    layer.appendChild(box);
    view.div.appendChild(layer);
    const timer = window.setTimeout(() => layer.remove(), 2200);
    return () => {
      clearTimeout(timer);
      layer.remove();
    };
  }, [flash?.seq, scale]);

  const focusParagraph = (targetPage: number, rects: Rect[]) => {
    if (mode === "translated") {
      setUserPickedMode(true);
      setMode("split");
    }
    if (viewer.current) {
      viewer.current.currentPageNumber = targetPage;
      setPage(targetPage);
    }
    setFlash({ page: targetPage, rects, seq: Date.now() });
  };

  const pickMode = (next: PdfTranslateMode) => {
    setUserPickedMode(true);
    setMode(next);
  };

  const totalPages = pdf?.numPages ?? 0;

  return (
    <div ref={wrapRef} className={`bpdf-root mode-${mode}`} data-browser-pdf-view="">
      <div className="bpdf-bar">
        <span className="bpdf-pages">
          {totalPages > 0 ? t("pdfTranslate.page", { page, total: totalPages }) : t("pdfTranslate.loading")}
        </span>
        {mode !== "translated" && pdf && (
          <div className="dcp-zoom">
            <button
              type="button"
              title={t("doc.zoomOut")}
              aria-label={t("doc.zoomOut")}
              onClick={() => {
                if (viewer.current) viewer.current.currentScale = Math.max(0.4, viewer.current.currentScale / 1.2);
              }}
            >
              <Icon name="minus" />
            </button>
            <button
              type="button"
              className="dcp-scale"
              title={t("doc.fit")}
              onClick={() => {
                if (viewer.current) viewer.current.currentScaleValue = "page-width";
              }}
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              title={t("doc.zoomIn")}
              aria-label={t("doc.zoomIn")}
              onClick={() => {
                if (viewer.current) viewer.current.currentScale = Math.min(3, viewer.current.currentScale * 1.2);
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
        )}
        {mode === "original" && (
          <div className="pdf-tr-modes">
            {(["split", "translated", "original"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`pdf-tr-mode ${mode === m ? "on" : ""}`}
                aria-pressed={mode === m}
                onClick={() => pickMode(m)}
              >
                {t(`pdfTranslate.mode.${m}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bpdf-body">
        <div className="dcp-view bpdf-original" style={{ display: mode === "translated" ? "none" : undefined }}>
          <div className="dcp-scroll" ref={scroller} tabIndex={0}>
            <div className="pdfViewer" ref={pagesEl} />
          </div>
          {!pdf && !error && (
            <div className="dcp-wait">
              <span className="mini-spin" />
            </div>
          )}
          {error && <div className="dcp-error">{error}</div>}
        </div>
        {pdf && mode !== "original" && (
          <PdfTranslationPane
            pdf={pdf}
            scopeId={`bpdf:${targetId}`}
            title={title || url}
            currentPage={page}
            mode={mode}
            onMode={pickMode}
            onFocusParagraph={focusParagraph}
          />
        )}
      </div>
    </div>
  );
}
