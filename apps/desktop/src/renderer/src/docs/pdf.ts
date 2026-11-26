import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

// pdf.js for the document column (document-editor-design §7.3): it only shows pages and lets
// people select and search. Scripts never run; the bytes come from finxdoc://, a range at a
// time, so a 500-page report opens without being read whole.

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// The viewer components read the library from here.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;

export { pdfjs };
export const viewerLib = () => import("pdfjs-dist/web/pdf_viewer.mjs");

/** pdf.js's data files beside the page (electron.vite.config.ts). */
const data = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

const chunk = 256 * 1024;

/** Fetches the ranges pdf.js asks for. */
class RangeTransport extends pdfjs.PDFDataRangeTransport {
  private url: string;

  constructor(url: string, length: number, initial: Uint8Array) {
    super(length, initial);
    this.url = url;
  }

  requestDataRange(begin: number, end: number) {
    void this.fetchRange(begin, end, 0);
  }

  /** pdf.js waits for every range it asks for: a failed one is asked for again, a few times, before giving up. */
  private async fetchRange(begin: number, end: number, tries: number): Promise<void> {
    try {
      const r = await fetch(this.url, { headers: { range: `bytes=${begin}-${end - 1}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.onDataRange(begin, new Uint8Array(await r.arrayBuffer()));
    } catch (e) {
      if (tries >= 3) return console.error(`pdf: cannot read bytes ${begin}-${end - 1}`, e);
      await new Promise((r) => setTimeout(r, 200 * 2 ** tries));
      return this.fetchRange(begin, end, tries + 1);
    }
  }
}

function pdfOptions(password?: string) {
  return {
    isEvalSupported: false,
    enableXfa: false,
    password,
    cMapUrl: data("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: data("standard_fonts"),
    wasmUrl: data("wasm"),
    rangeChunkSize: chunk,
  };
}

/** Opens the working copy a token stands for. */
export async function loadPdf(token: string, password?: string): Promise<pdfjs.PDFDocumentProxy> {
  const url = `finxdoc://${token}/current.pdf`;
  const first = await fetch(url, { headers: { range: `bytes=0-${chunk - 1}` } });
  if (!first.ok) throw new Error(`cannot read the document (HTTP ${first.status})`);
  const total = Number(/\/(\d+)$/.exec(first.headers.get("content-range") ?? "")?.[1] ?? first.headers.get("content-length"));
  const initial = new Uint8Array(await first.arrayBuffer());
  const common = pdfOptions(password);
  const src = initial.length >= total ? { ...common, data: initial } : { ...common, range: new RangeTransport(url, total, initial) };
  return pdfjs.getDocument(src).promise;
}

/** Opens a PDF directly from in-memory bytes (e.g. fetched from an embedded browser tab). */
export async function loadPdfBytes(bytes: Uint8Array, password?: string): Promise<pdfjs.PDFDocumentProxy> {
  // Pass a copy because pdf.js transfers the underlying ArrayBuffer to its worker.
  return pdfjs.getDocument({ ...pdfOptions(password), data: new Uint8Array(bytes) }).promise;
}
