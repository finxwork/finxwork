import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Rect } from "@finx/protocol";
import type { pdfjs } from "./pdf";
import { extractPageParagraphs, type PdfParagraph, type PdfTextItem } from "./pdfBlocks";
import { chunkBlocks, isAlreadyTargetLanguage } from "../../../shared/translation";

export type PdfTranslateMode = "split" | "translated" | "original";

type PageState = {
  status: "loading" | "done" | "scanned" | "error";
  paragraphs: PdfParagraph[];
  translations: Record<string, string>;
  error?: string;
};

/**
 * Streaming bilingual translation pane shared by both local document-panel PDFs (`PdfView`)
 * and online PDFs opened in the embedded browser (`BrowserPdfView`).
 * Lazily extracts and translates the current page plus adjacent pages (±1).
 */
export function PdfTranslationPane({
  pdf,
  scopeId,
  title,
  currentPage,
  mode,
  onMode,
  onFocusParagraph,
}: {
  pdf: pdfjs.PDFDocumentProxy;
  scopeId: string;
  title: string;
  currentPage: number;
  mode: PdfTranslateMode;
  onMode: (mode: PdfTranslateMode) => void;
  onFocusParagraph: (page: number, rects: Rect[]) => void;
}) {
  const { t, i18n } = useTranslation("session");
  const targetLanguage = i18n.language || "zh-CN";
  const [pages, setPages] = useState<Record<number, PageState>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const startedRef = useRef(new Set<number>());
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    startedRef.current.clear();
    setPages({});
    return () => {
      aliveRef.current = false;
      window.finx?.cancelTranslation(scopeId);
    };
  }, [pdf, scopeId, targetLanguage, retryTick]);

  // Translate current page first, then prefetch next and previous pages.
  useEffect(() => {
    const finx = window.finx;
    if (!finx) return;
    const total = pdf.numPages;
    const targets = [currentPage, currentPage + 1, currentPage - 1].filter(
      (n) => n >= 1 && n <= total && !startedRef.current.has(n),
    );
    if (targets.length === 0) return;

    for (const pageNo of targets) {
      startedRef.current.add(pageNo);
      setPages((prev) => ({
        ...prev,
        [pageNo]: { status: "loading", paragraphs: [], translations: {} },
      }));

      void (async () => {
        try {
          const pdfPage = await pdf.getPage(pageNo);
          const viewport = pdfPage.getViewport({ scale: 1 });
          const content = await pdfPage.getTextContent();
          if (!aliveRef.current) return;

          const items: PdfTextItem[] = [];
          for (const x of content.items) {
            if ("str" in x && Array.isArray(x.transform)) items.push(x);
          }
          const paragraphs = extractPageParagraphs(items, pageNo, viewport.width, viewport.height);
          if (paragraphs.length === 0) {
            setPages((prev) => ({
              ...prev,
              [pageNo]: { status: "scanned", paragraphs: [], translations: {} },
            }));
            return;
          }

          const initialTranslations: Record<string, string> = {};
          const toTranslate: Array<{ id: string; text: string }> = [];
          for (const p of paragraphs) {
            if (isAlreadyTargetLanguage(p.text, targetLanguage)) {
              initialTranslations[p.id] = p.text;
            } else {
              toTranslate.push({ id: p.id, text: p.text });
            }
          }

          setPages((prev) => ({
            ...prev,
            [pageNo]: {
              status: toTranslate.length === 0 ? "done" : "loading",
              paragraphs,
              translations: initialTranslations,
            },
          }));

          if (toTranslate.length === 0) return;

          const batches = chunkBlocks(toTranslate, 10, 2400);
          for (const batch of batches) {
            if (!aliveRef.current) return;
            const res = await finx.translateBlocks(scopeId, {
              title,
              targetLanguage,
              items: batch,
            });
            if (!aliveRef.current || res.cancelled) return;
            setPages((prev) => {
              const cur = prev[pageNo];
              if (!cur) return prev;
              return {
                ...prev,
                [pageNo]: {
                  ...cur,
                  translations: { ...cur.translations, ...res.translations },
                },
              };
            });
          }

          if (!aliveRef.current) return;
          setPages((prev) => {
            const cur = prev[pageNo];
            if (!cur) return prev;
            return { ...prev, [pageNo]: { ...cur, status: "done" } };
          });
        } catch (err) {
          if (!aliveRef.current) return;
          const message = err instanceof Error ? err.message : String(err);
          if (/cancelled|aborted/i.test(message)) return;
          setPages((prev) => ({
            ...prev,
            [pageNo]: {
              status: "error",
              paragraphs: prev[pageNo]?.paragraphs ?? [],
              translations: prev[pageNo]?.translations ?? {},
              error: /no_model|no_credentials|no model|credentials|auth/i.test(message)
                ? t("pdfTranslate.noModel")
                : t("pdfTranslate.failed"),
            },
          }));
        }
      })();
    }
  }, [pdf, currentPage, scopeId, title, targetLanguage, retryTick, t]);

  // Smoothly keep the active page's translation in view as the user turns pages.
  useEffect(() => {
    const el = pageRefs.current.get(currentPage);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentPage]);

  const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1).filter(
    (n) => pages[n] || n === currentPage,
  );

  return (
    <div className="pdf-tr-pane" data-pdf-translate-pane="">
      <div className="pdf-tr-head">
        <span className="pdf-tr-title">{t("pdfTranslate.title")}</span>
        <div className="pdf-tr-modes" role="group" aria-label={t("pdfTranslate.viewMode")}>
          {(["split", "translated", "original"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`pdf-tr-mode ${mode === m ? "on" : ""}`}
              aria-pressed={mode === m}
              onClick={() => onMode(m)}
            >
              {t(`pdfTranslate.mode.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="pdf-tr-scroll">
        {pageNumbers.map((pageNo) => {
          const ps = pages[pageNo];
          return (
            <section
              key={pageNo}
              ref={(el) => {
                if (el) pageRefs.current.set(pageNo, el);
                else pageRefs.current.delete(pageNo);
              }}
              className={`pdf-tr-page ${pageNo === currentPage ? "current" : ""}`}
              data-pdf-tr-page={pageNo}
            >
              <div className="pdf-tr-page-label">
                <span>{t("pdfTranslate.page", { page: pageNo, total: pdf.numPages })}</span>
                {ps?.status === "loading" && <span className="mini-spin" aria-hidden="true" />}
              </div>
              {ps?.status === "scanned" && <div className="pdf-tr-note">{t("pdfTranslate.scanned")}</div>}
              {ps?.status === "error" && (
                <div className="pdf-tr-error">
                  <span>{ps.error}</span>
                  <button
                    type="button"
                    className="pdf-tr-retry"
                    onClick={() => {
                      startedRef.current.delete(pageNo);
                      setRetryTick((x) => x + 1);
                    }}
                  >
                    {t("pdfTranslate.retry")}
                  </button>
                </div>
              )}
              {ps?.paragraphs.map((p) => {
                const translated = ps.translations[p.id];
                return (
                  <div
                    key={p.id}
                    className={`pdf-tr-block ${p.kind === "heading" ? "heading" : ""} ${activeId === p.id ? "active" : ""}`}
                    data-pdf-tr-block={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setActiveId(p.id);
                      onFocusParagraph(p.page, p.rects);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveId(p.id);
                        onFocusParagraph(p.page, p.rects);
                      }
                    }}
                  >
                    {translated ? (
                      <div className="pdf-tr-text">{translated}</div>
                    ) : (
                      <div className="pdf-tr-skeleton" aria-hidden="true" />
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
