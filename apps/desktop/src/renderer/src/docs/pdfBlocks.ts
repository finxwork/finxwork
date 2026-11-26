import type { Rect } from "@finx/protocol";
import { normalizeText, shouldSkipText } from "../../../shared/translation.ts";

/** Subset of pdf.js `TextItem` fields needed for pure geometric paragraph grouping. */
export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

export type PdfParagraph = {
  id: string;
  page: number;
  text: string;
  rects: Rect[];
  kind: "heading" | "body";
};

type SpanBox = {
  str: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fontSize: number;
};

type LineBox = {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fontSize: number;
};

const PAGE_NUM_RE = /^(?:page\s*)?\d+(?:\s*[/\-]\s*\d+)?$/i;
const DATE_HEADER_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}(?:,\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)?$/i;
const BULLET_START_RE = /^(?:[•●▪◦\-–—*]|\d+[.)]|\([a-z0-9]+\))\s+/i;

function toSpanBox(item: PdfTextItem): SpanBox | null {
  const str = item.str;
  if (!str || !str.trim()) return null;
  const t = item.transform;
  if (!Array.isArray(t) || t.length < 6) return null;
  // Skip rotated text (vertical margin watermarks, arXiv side stamps, Y-axis chart labels).
  if (Math.abs(t[1]) > 0.1 || Math.abs(t[2]) > 0.1) return null;
  const fontSize = Math.abs(t[0]) || Math.abs(t[3]) || Math.abs(item.height) || 10;
  const height = Math.abs(item.height) > 0.5 ? Math.abs(item.height) : fontSize;
  const width = Math.abs(item.width) > 0 ? Math.abs(item.width) : str.length * fontSize * 0.5;
  const x0 = t[4];
  const y0 = t[5];
  return { str, x0, x1: x0 + width, y0, y1: y0 + height, fontSize };
}

function isRunningHeaderOrFooter(line: LineBox, pageHeight: number): boolean {
  const topBand = line.y0 > pageHeight * 0.93;
  const bottomBand = line.y1 < pageHeight * 0.07;
  if (!topBand && !bottomBand) return false;
  const t = line.text.trim();
  if (PAGE_NUM_RE.test(t) || DATE_HEADER_RE.test(t)) return true;
  if (t.length <= 140 && (t.startsWith("http://") || t.startsWith("https://") || t.includes(".html") || t.includes(".pdf"))) {
    return true;
  }
  return t.length <= 36 && line.fontSize <= 10.5;
}

function mergeSpansIntoLines(spans: SpanBox[], maxHorizontalGapFactor?: number): LineBox[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0);
  const rows: SpanBox[][] = [];

  for (const span of sorted) {
    let target: SpanBox[] | undefined;
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 6); i--) {
      const ref = rows[i][0];
      const overlap = Math.min(ref.y1, span.y1) - Math.max(ref.y0, span.y0);
      const minH = Math.min(ref.y1 - ref.y0, span.y1 - span.y0);
      if (minH > 0 && overlap > minH * 0.45) {
        target = rows[i];
        break;
      }
    }
    if (target) target.push(span);
    else rows.push([span]);
  }

  const lines: LineBox[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    // Split a visual row into contiguous horizontal segments when a wide column gutter is present.
    const segments: SpanBox[][] = [];
    for (const s of row) {
      const cur = segments[segments.length - 1];
      if (!cur) {
        segments.push([s]);
        continue;
      }
      const prev = cur[cur.length - 1];
      const gap = s.x0 - prev.x1;
      const refSize = Math.max(prev.fontSize, s.fontSize, 8);
      if (maxHorizontalGapFactor !== undefined && gap > refSize * maxHorizontalGapFactor) {
        segments.push([s]);
      } else {
        cur.push(s);
      }
    }

    for (const group of segments) {
      let text = "";
      let prevEnd = group[0].x0;
      let x0 = group[0].x0;
      let x1 = group[0].x1;
      let y0 = group[0].y0;
      let y1 = group[0].y1;
      let weightedSize = 0;
      let totalChars = 0;

      for (let i = 0; i < group.length; i++) {
        const s = group[i];
        const gap = s.x0 - prevEnd;
        if (i > 0 && gap > s.fontSize * 0.18 && !text.endsWith(" ") && !s.str.startsWith(" ")) {
          text += " ";
        }
        text += s.str;
        prevEnd = Math.max(prevEnd, s.x1);
        x0 = Math.min(x0, s.x0);
        x1 = Math.max(x1, s.x1);
        y0 = Math.min(y0, s.y0);
        y1 = Math.max(y1, s.y1);
        weightedSize += s.fontSize * s.str.length;
        totalChars += s.str.length;
      }

      const normalized = normalizeText(text);
      if (normalized.length > 0) {
        lines.push({
          text: normalized,
          x0,
          x1,
          y0,
          y1,
          fontSize: totalChars > 0 ? weightedSize / totalChars : group[0].fontSize,
        });
      }
    }
  }

  return lines.sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0);
}

/**
 * Detects whether a page has a two-column academic layout using horizontally merged line segments
 * (never raw word/kerning spans, which would falsely split single-column lines down the middle).
 */
function partitionLineColumns(lines: LineBox[], pageWidth: number): LineBox[][] {
  if (lines.length < 8 || pageWidth <= 0) return [lines];
  const mid = pageWidth * 0.5;
  const gutterLeft = pageWidth * 0.45;
  const gutterRight = pageWidth * 0.55;

  const leftLines: LineBox[] = [];
  const rightLines: LineBox[] = [];
  const crossingLines: LineBox[] = [];

  for (const l of lines) {
    if (l.x1 <= gutterRight && l.x0 < mid) {
      leftLines.push(l);
    } else if (l.x0 >= gutterLeft && l.x1 > mid) {
      rightLines.push(l);
    } else {
      crossingLines.push(l);
    }
  }

  // Require substantial content on both sides and relatively few crossing lines (title/abstract).
  const isTwoColumn =
    leftLines.length >= 4 &&
    rightLines.length >= 4 &&
    crossingLines.length < (leftLines.length + rightLines.length) * 0.35;

  if (!isTwoColumn) return [lines];

  const colTop = Math.max(...leftLines.map((l) => l.y1), ...rightLines.map((l) => l.y1));
  const colBottom = Math.min(...leftLines.map((l) => l.y0), ...rightLines.map((l) => l.y0));
  const topSpanning = crossingLines.filter((l) => l.y0 >= colTop - 4);
  const bottomSpanning = crossingLines.filter((l) => l.y1 <= colBottom + 4);
  const middleCrossing = crossingLines.filter((l) => l.y0 < colTop - 4 && l.y1 > colBottom + 4);

  for (const l of middleCrossing) {
    if (l.x0 < mid) leftLines.push(l);
    else rightLines.push(l);
  }

  return [topSpanning, leftLines, rightLines, bottomSpanning]
    .filter((r) => r.length > 0)
    .map((r) => r.sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0));
}

function joinLinesText(lines: LineBox[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i].text;
    if (i === 0) {
      out = part;
      continue;
    }
    // Rejoin hyphenated English word wraps (`compu-` + `tation` -> `computation`).
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(part)) {
      out = out.slice(0, -1) + part;
    } else {
      out += " " + part;
    }
  }
  return normalizeText(out);
}

function median(values: number[]): number {
  if (values.length === 0) return 11;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function groupLinesIntoParagraphs(lines: LineBox[], pageNumber: number, bodyFontSize: number, startIdx: number): PdfParagraph[] {
  if (lines.length === 0) return [];
  const colRight = Math.max(...lines.map((l) => l.x1));
  const colLeft = Math.min(...lines.map((l) => l.x0));
  const colWidth = Math.max(colRight - colLeft, 1);

  const buckets: LineBox[][] = [];
  let current: LineBox[] = [];

  for (const line of lines) {
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const prev = current[current.length - 1];
    const lineH = Math.max(prev.y1 - prev.y0, line.y1 - line.y0, prev.fontSize, 8);
    const gap = prev.y0 - line.y1;
    const sizeRatio = line.fontSize / Math.max(prev.fontSize, 1);
    const sameSize = sizeRatio >= 0.85 && sizeRatio <= 1.18;
    const prevShort = colWidth > 120 && prev.x1 < colLeft + colWidth * 0.78;
    const indented = line.x0 - colLeft > line.fontSize * 1.1 && Math.abs(line.x0 - prev.x0) > line.fontSize * 0.8;
    const isBullet = BULLET_START_RE.test(line.text);

    // Start a new paragraph on large vertical gap, font size change, bullet, or clear paragraph end.
    const shouldSplit =
      gap > lineH * 0.75 ||
      gap < -lineH * 0.5 ||
      !sameSize ||
      isBullet ||
      indented ||
      (prevShort && /[.!?:;。！？]$/.test(prev.text));

    if (shouldSplit) {
      buckets.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) buckets.push(current);

  const paragraphs: PdfParagraph[] = [];
  let idx = startIdx;
  for (const group of buckets) {
    const text = joinLinesText(group);
    if (shouldSkipText(text)) continue;
    const avgSize = group.reduce((sum, l) => sum + l.fontSize, 0) / group.length;
    // Skip isolated micro-labels (tiny chart ticks, margin stamps, superscript fragments).
    if (group.length === 1 && avgSize < bodyFontSize * 0.65 && text.length <= 24) continue;
    const kind: "heading" | "body" =
      avgSize >= bodyFontSize * 1.16 && text.length <= 160 ? "heading" : "body";
    paragraphs.push({
      id: `p${pageNumber}-${idx++}`,
      page: pageNumber,
      text,
      rects: group.map((l) => ({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 })),
      kind,
    });
  }
  return paragraphs;
}

/**
 * Extracts ordered, column-aware natural paragraphs with exact PDF bounding rects from a page's
 * `pdf.js` text content. Pure and deterministic — safe to run in workers or Node unit tests.
 */
export function extractPageParagraphs(
  items: PdfTextItem[],
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
): PdfParagraph[] {
  const rawSpans = items.map(toSpanBox).filter((s): s is SpanBox => s !== null);
  if (rawSpans.length === 0) return [];

  // 1. Merge horizontally adjacent spans on the same baseline first (splitting only on wide gutters
  //    > 1.5 * fontSize) so word-fragmented single-column lines are never misclassified as two-column.
  const mergedLines = mergeSpansIntoLines(rawSpans, 1.5).filter(
    (line) => !isRunningHeaderOrFooter(line, pageHeight),
  );
  if (mergedLines.length === 0) return [];

  const regions = partitionLineColumns(mergedLines, pageWidth);
  const allFontSizes = mergedLines.map((l) => l.fontSize);
  const bodyFontSize = median(allFontSizes);

  const out: PdfParagraph[] = [];
  for (const lines of regions) {
    out.push(...groupLinesIntoParagraphs(lines, pageNumber, bodyFontSize, out.length));
  }
  return out;
}
