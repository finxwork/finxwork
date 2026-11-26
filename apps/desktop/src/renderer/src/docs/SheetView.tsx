import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { baseName, type RpcClient } from "@finx/client";
import type { CellData, DocApplyResult, FoundCell, Impact, SheetInfo, SheetOp, StructureKind } from "@finx/protocol";
import { Icon, type IconName } from "../icons";
import { isRpcKind } from "../rpcError";
import { errorText, useStore } from "../store";
import { openRef } from "../session/contentMenus";
import { addr, areaOf, colName, MAX_COLS, MAX_ROWS, onSheet, parseAddr, parseRange, rangeText, type Area, type Pos } from "./cellref";
import { useEditQueue } from "./sheet/editQueue";
import { useGeometry } from "./sheet/geometry";
import { CellMenu, item, sep, type MenuItem } from "./sheet/CellMenu";
import { ChartView } from "./sheet/ChartView";
import { ImpactBar } from "./sheet/ImpactBar";
import { areaCellCount, colSelected, copyGrid, decimalsOf, editTextOf, expandSpans, inAreas, inSpans, inputOp, isDisjoint, isHardcoded, lensAt, lensText, MAX_PASTE, mergeSpans, parseTsv, pasteOps, rangesText, readable, readLenses, readSizes, rowSelected, selectedAreas, selectionStats, sizeKey, sizesOf, spanCount, statText, toggleLine, toMarkdown, toMarkdownGrid, toTsvGrid, UNITS, wholeCols, wholeRows, withLens, writeLenses, writeSizes, type Lens, type Sel, type SelectionStats, type Sizes, type Unit } from "./sheet/model";
import { TraceBar, type Trace } from "./sheet/TraceBar";
import { useScope } from "../session/scope";
import { quoteToComposer, setDocInfo, setSheetViewing, type DocTab, type Jump } from "./state";

export { inputOp } from "./sheet/model";

// A workbook in the file panel (spreadsheet-design §8): a bar with the address and the formula,
// the grid, and the sheets underneath. Cells are read from finx by blocks of rows as they come
// into sight (doc/cells); edits go back as SheetOps (doc/apply) and come back with their impact,
// which the grid lights up. The agent's edits arrive as a new revision of the document.

const BLOCK = 100;
const HEAD_W = 44;
const HEAD_H = 22;
/**
 * The grid is drawn in layers (.sht-layer), bottom up: cells that scroll; frozen columns; frozen rows (a
 * merge in a frozen column scrolls up under them); the frozen corner; the freeze line; headers. The
 * frozen ones are sticky, so the browser keeps them in place in the same frame it scrolls: placed from
 * the scroll position after the fact, they would lag a frame behind and jump.
 */
type Pane = "s" | "c" | "r" | "x";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

type Cache = { key: string; cells: Map<string, CellData>; blocks: Set<number>; merges: Area[]; heights: Map<number, number> };

type Activity = { revision: number; title: string; impact?: Impact };

export function SheetView({ rpc, session, tab, jump, activeView = true }: { rpc: RpcClient; session: string; tab: DocTab; jump?: Jump | null; activeView?: boolean }) {
  const scope = useScope();
  const { t, i18n } = useTranslation("session");
  const st = useStore();
  const info = tab.info;
  const docId = info.doc_id;
  const sheets = (info.sheets ?? []).filter((s) => !s.hidden);
  const [sheetName, setSheetName] = useState(() => sheets.find((s) => !s.chart)?.name ?? sheets[0]?.name ?? "");
  const sheet: SheetInfo | undefined = (info.sheets ?? []).find((s) => s.name === sheetName);
  const [sel, setSel] = useState<Sel>({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
  const [editing, setEditing] = useState<{ text: string; inBar: boolean } | null>(null);
  // Cells lit up: what the agent changed (till dismissed), or what one of your edits changed downstream (till you move on). Your own edits are not marked, as in Excel.
  const [lit, setLit] = useState<{ cells: Set<string>; mine?: boolean } | null>(null);
  const [impact, setImpact] = useState<{ impact: Impact; byAgent: boolean } | null>(null);
  const [note, setNote] = useState<{ text: string; kind: "refused" | "conflict" } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [extent, setExtent] = useState({ rows: 100, cols: 26 });
  const [agentNotice, setAgentNotice] = useState<{ count: number; first?: string } | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [, redraw] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  /** The zoom buttons: about the view's top left. */
  const setZoomTo = (z: number) => {
    const el = scroller.current;
    const next = clampZoom(Math.round(z * 100) / 100);
    if (!el) return;
    const x = el.scrollLeft / zoomRef.current;
    const y = el.scrollTop / zoomRef.current;
    zoomRef.current = next;
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = x * next;
      el.scrollTop = y * next;
      // The browser keeps the scroll within the new size: read back where it is.
      measureView();
    });
  };
  const grid = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });
  /** What is in sight, in the grid's own pixels (zoom undone). */
  const measureView = () => {
    const el = scroller.current;
    const z = zoomRef.current;
    if (el) setView({ top: el.scrollTop / z, left: el.scrollLeft / z, w: el.clientWidth / z, h: el.clientHeight / z });
  };
  /** The sheet grows as far as the selection goes, with room beyond. */
  const reach = (r: number, c: number) => setExtent((x) => ({ rows: Math.max(x.rows, r + 20), cols: Math.max(x.cols, c + 5) }));
  const logActivity = (item: Activity) => setActivity((items) => [item, ...items].slice(0, 20));
  /** Rows or columns moved since the last read: the heights read before are where they were. */
  const reshaped = useRef(false);
  const cache = useRef<Cache>({ key: "", cells: new Map(), blocks: new Set(), merges: [], heights: new Map() });
  const { busy, enqueue, idle, made, revision, takeOwn } = useEditQueue(session, info);

  // ── the sheet's shape ──
  const used = parseRange(sheet?.used ?? "A1") ?? { r1: 1, c1: 1, r2: 1, c2: 1 };
  const nCols = Math.min(MAX_COLS, Math.max(used.c2 + 5, extent.cols, 26));
  const nRows = Math.min(MAX_ROWS, Math.max(used.r2 + 50, extent.rows, 100));
  // Widths and heights dragged here, by sheet: how the grid shows them, not written to the file.
  const [sized, setSized] = useState<Sizes>(() => readSizes(docId));
  const sizedDoc = useRef(docId);
  useEffect(() => {
    if (sizedDoc.current !== docId) {
      sizedDoc.current = docId;
      setSized(readSizes(docId));
      return;
    }
    writeSizes(docId, sized);
  }, [docId, sized]);
  const colSizes = useMemo(() => sizesOf(sized.cols, sheetName), [sized.cols, sheetName]);
  // A filter here (按所选单元格的值筛选) hides rows in the view only: never written to the file.
  const [filter, setFilter] = useState<{ sheet: string; col: number; value: string; hidden: Set<number> } | null>(null);
  const rowSizes = useMemo(() => {
    const m = sizesOf(sized.rows, sheetName);
    if (filter?.sheet === sheetName) for (const r of filter.hidden) m.set(r, 0);
    return m;
  }, [sized.rows, sheetName, filter]);
  const c0 = cache.current;
  const { widths, colLeft, rowY, rowAt, colAt } = useGeometry({ sheet, nCols, nRows, colSizes, rowSizes, heights: c0.heights, heightsStamp: `${c0.key}:${c0.heights.size}` });
  const frozen = { rows: Number(sheet?.frozen?.[0] ?? 0), cols: Number(sheet?.frozen?.[1] ?? 0) };
  const frozenH = rowY(frozen.rows + 1);
  const frozenW = colLeft[frozen.cols + 1];

  // ── reading cells ──
  const load = useCallback(
    async (block: number) => {
      const c = cache.current;
      const key = c.key;
      if (c.blocks.has(block) || !sheet || sheet.chart) return;
      c.blocks.add(block);
      const r1 = block * BLOCK + 1;
      try {
        const res = await rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: `A${r1}:${colName(nCols)}${r1 + BLOCK - 1}` });
        if (cache.current.key !== key) return;
        for (const cell of res.cells) c.cells.set(cell.cell, cell);
        for (const m of res.merges ?? []) {
          const g = parseRange(m);
          if (g && !c.merges.some((x) => x.r1 === g.r1 && x.c1 === g.c1)) c.merges.push(g);
        }
        for (const h of res.rows ?? []) c.heights.set(h.row, h.hidden ? 0 : h.height);
        redraw((n) => n + 1);
        setLoadError(null);
      } catch (error) {
        if (cache.current.key === key) setLoadError(errorText(error));
        c.blocks.delete(block);
      }
    },
    [rpc, session, docId, sheet, nCols],
  );

  /** Everything read is stale: read again what is in sight; with `diff`, cells that changed light up. */
  const reread = useCallback(
    (diff: boolean) => {
      const old = cache.current;
      const key = `${docId}:${sheetName}:${info.revision}`;
      const keep = old.key.startsWith(`${docId}:${sheetName}:`) && !reshaped.current;
      reshaped.current = false;
      cache.current = { key, cells: new Map(), blocks: new Set(), merges: [], heights: keep ? new Map(old.heights) : new Map() };
      const first = Math.floor(Math.max(0, rowAt(view.top) - 1) / BLOCK);
      const last = Math.floor(rowAt(view.top + view.h) / BLOCK);
      void Promise.all(Array.from({ length: last - first + 1 }, (_, i) => load(first + i))).then(() => {
        if (!diff || cache.current.key !== key) return;
        const changed = new Set<string>();
        for (const [k, v] of cache.current.cells) if (old.cells.has(k) && old.cells.get(k)!.text !== v.text) changed.add(k);
        for (const k of old.cells.keys()) if (!cache.current.cells.has(k) && old.cells.get(k)!.text) changed.add(k);
        if (changed.size) {
          setLit({ cells: changed });
          const first = changed.values().next().value as string | undefined;
          setAgentNotice({ count: changed.size, first });
          logActivity({ revision: info.revision, title: t("sheet.agentChanged", { count: changed.size }) });
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, sheetName, info.revision, load, view.top, view.h, t],
  );

  // A new sheet, or a new revision (an edit here, or the agent's): read again.
  useEffect(() => {
    const mine = takeOwn(info.revision);
    const byAgent = !mine && cache.current.key.startsWith(`${docId}:${sheetName}:`);
    reread(byAgent);
    if (byAgent) setImpact(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, sheetName, info.revision]);

  // The file changed on disk and finx was asked for it again (files/state refreshDoc): read it
  // again, as it may hold Excel's changes; a sheet that is gone gives way to the first one.
  const token = useRef(tab.token);
  useEffect(() => {
    if (token.current === tab.token) return;
    token.current = tab.token;
    if (!sheet && sheets.length) setSheetName(sheets.find((x) => !x.chart)?.name ?? sheets[0].name);
    else reread(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.token]);

  useEffect(() => {
    setAgentNotice(null);
    setImpact(null);
    setEditing(null);
    setMenuAt(null);
  }, [docId, sheetName]);

  // Blocks in sight.
  useEffect(() => {
    const first = Math.floor(Math.max(0, rowAt(view.top) - 1) / BLOCK);
    const last = Math.floor(rowAt(view.top + view.h) / BLOCK);
    for (let b = first; b <= last; b++) void load(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, load, cache.current.key]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measureView();
    const ro = new ResizeObserver(measureView);
    ro.observe(el);
    // Pinch on a trackpad (and ⌘ with the wheel): the grid zooms about the pointer, as in Excel.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const old = zoomRef.current;
      const next = clampZoom(old * Math.exp(-e.deltaY * 0.006));
      if (next === old) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const x = (el.scrollLeft + px) / old;
      const y = (el.scrollTop + py) / old;
      zoomRef.current = next;
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = x * next - px;
        el.scrollTop = y * next - py;
        measureView();
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, [sheetName]);

  // ── editing ──
  // The active cell is where the selection began, as in Excel; the focus is the end that moves.
  const maxRow = Math.max(used.r2, 1);
  const maxCol = Math.max(used.c2, 1);
  const active = sel.at ?? sel.anchor;
  const activeCell = cache.current.cells.get(addr(active));
  const selected = areaOf(sel.anchor, sel.focus);
  const areas = selectedAreas(sel);
  const disjoint = isDisjoint(sel);
  const selectedRange = rangeText(selected);
  const selectedRanges = rangesText(areas);
  const colSpans = mergeSpans(areas, "cols");
  const rowSpans = mergeSpans(areas, "rows");
  const wholeColSpans = wholeCols(areas, maxRow);
  const wholeRowSpans = wholeRows(areas, maxCol);
  const editable = !sheet?.protected && !!info.capabilities.includes("edit_values");
  const editText = editTextOf(activeCell);
  const shown = (p: Pos) => cache.current.cells.get(addr(p));

  // The status bar's figures for the selection, as in Excel; read from finx, so cells out of sight count too.
  const [stats, setStats] = useState<SelectionStats | null>(null);
  // The selection last read, and whether anything was in it (a single cell has no figures but may hold a value).
  const [statsOf, setStatsOf] = useState({ key: "", any: false });
  const statsKey = `${sheetName}!${selectedRanges}`;
  const inUseAreas = areas
    .map((a) => ({ r1: Math.max(a.r1, used.r1), c1: Math.max(a.c1, used.c1), r2: Math.min(a.r2, used.r2), c2: Math.min(a.c2, used.c2) }))
    .filter((a) => a.r1 <= a.r2 && a.c1 <= a.c2);
  const inUseSize = areaCellCount(inUseAreas);
  // Only a selection with something in it is offered to the agent; one too large to count is taken to have.
  const selectionFilled = inUseSize > STATS_MAX_CELLS || (inUseSize > 0 && statsOf.key === statsKey && statsOf.any);
  useEffect(() => {
    if (!sheet || sheet.chart || inUseSize === 0 || inUseSize > STATS_MAX_CELLS) return setStats(null);
    let gone = false;
    const timer = setTimeout(() => {
      Promise.all(inUseAreas.map((a) => rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: rangeText(a) })))
        .then((rs) => {
          if (gone) return;
          const all = rs.flatMap((r) => r.cells);
          setStats(selectionStats(all, areas));
          setStatsOf({ key: statsKey, any: all.some((c) => !!c.text || !!c.value) });
        })
        .catch(() => !gone && setStats(null));
    }, 80);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, sheetName, selectedRanges, sheet?.used, info.revision]);

  useEffect(() => {
    if (!activeView || !sheet || sheet.chart) return;
    setSheetViewing(session, { doc_id: docId, path: info.path, sheet: sheet.name, range: selectedRanges, text: activeCell?.text ?? "" });
    return () => setSheetViewing(session, null, docId);
  }, [activeView, session, docId, info.path, sheet, selectedRanges, activeCell?.text]);

  useEffect(() => {
    if (!jump || jump.doc_id !== docId || jump.anchor.kind !== "cells") return;
    const range = parseRange(jump.anchor.range);
    if (!range) return;
    setSheetName(jump.anchor.sheet);
    reach(range.r2, range.c2);
    setSel({ anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r2, c: range.c2 } });
    setLit({ cells: new Set([addr({ r: range.r1, c: range.c1 })]) });
  }, [jump?.seq, docId]);

  const apply = async (ops: SheetOp[]) => {
    if (!sheet || !editable) return;
    if (!info.capabilities.includes("edit_formulas") && ops.some((op) => op.op === "set_formula")) {
      setNote({ text: t("sheet.csvNoFormula"), kind: "refused" });
      return;
    }
    return edited(() => rpc.request("doc/apply", { session_id: session, doc_id: docId, ops, base_revision: revision() }));
  };

  /** An edit on its way, after the ones before it; what it changed lights up, a refusal says why. */
  const edited = (send: () => Promise<DocApplyResult>, title?: string) => {
    if (!sheet) return;
    return enqueue(async () => {
      try {
        const r = await send();
        made(r);
        setNote(null);
        setLit({ cells: new Set(onSheet(r.impact.affected ?? [], sheet.name)), mine: true });
        setImpact(r.impact.affected_count || r.impact.key_outputs?.length || r.impact.needs_excel?.length ? { impact: r.impact, byAgent: false } : null);
        logActivity({ revision: r.revision, title: title ?? t("sheet.youChanged", { count: r.impact.edited.length }), impact: r.impact });
        setAgentNotice(null);
      } catch (e) {
        if (isRpcKind(e, "doc_refused")) setNote({ text: e.message, kind: "refused" });
        else st.show(errorText(e), undefined, true);
      }
    });
  };

  /** Excel's ⌘D / ⌘R: the selection's first row (or column) across it; one cell takes the one above (or left). */
  const fill = (direction: "down" | "right") => {
    if (!sheet || !editable) return;
    if (disjoint) return void st.show(t("sheet.multiNotSupported"), undefined, true);
    const g = selected;
    const range = g.r1 === g.r2 && g.c1 === g.c2
      ? direction === "down" ? (g.r1 > 1 ? rangeText({ ...g, r1: g.r1 - 1 }) : null) : g.c1 > 1 ? rangeText({ ...g, c1: g.c1 - 1 }) : null
      : rangeText(g);
    if (!range) return;
    void edited(() => rpc.request("doc/fill", { session_id: session, doc_id: docId, sheet: sheet.name, range, direction, base_revision: revision() }));
  };

  /** The fill handle being dragged: the cells it would fill to, and what the farthest would show. */
  const [filling, setFilling] = useState<{ to: Area; tip: string | null } | null>(null);
  const fillSeq = useRef(0);

  /** Dragging Excel's fill handle: the drag adds rows or columns on the side it goes furthest past; inside the source, it takes them back. */
  const dragFill = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!sheet || !editable || e.button !== 0) return;
    const from = selected;
    const name = sheet.name;
    const anchor = sel.anchor;
    const same = (a: Area, b: Area) => a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
    const grows = (to: Area) => to.r1 < from.r1 || to.r2 > from.r2 || to.c1 < from.c1 || to.c2 > from.c2;
    const switched = (ev: MouseEvent) => ev.altKey || ev.ctrlKey;
    const targetOf = (q: Pos): Area => {
      const down = q.r - from.r2, up = from.r1 - q.r, right = q.c - from.c2, left = from.c1 - q.c;
      const v = Math.max(down, up), h = Math.max(right, left);
      if (v <= 0 && h <= 0) {
        if (q.r < from.r2 && from.r2 - q.r >= from.c2 - q.c) return { ...from, r2: q.r };
        if (q.c < from.c2) return { ...from, c2: q.c };
        return from;
      }
      if (v >= h) return down > 0 ? { ...from, r2: q.r } : { ...from, r1: q.r };
      return right > 0 ? { ...from, c2: q.c } : { ...from, c1: q.c };
    };
    // The cell whose value the tip shows: the farthest the drag reaches, in the source's first line.
    const farthest = (to: Area) =>
      to.r2 > from.r2 ? addr({ r: to.r2, c: from.c1 }) : to.r1 < from.r1 ? addr({ r: to.r1, c: from.c1 }) : to.c2 > from.c2 ? addr({ r: from.r1, c: to.c2 }) : addr({ r: from.r1, c: to.c1 });
    let to = from;
    let held = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const preview = () => {
      clearTimeout(timer);
      const mine = ++fillSeq.current;
      if (!grows(to)) return;
      const target = to;
      timer = setTimeout(() => {
        rpc.request("doc/autofill", { session_id: session, doc_id: docId, sheet: name, source: rangeText(from), target: rangeText(target), switch: held, preview: true })
          .then((r) => {
            if (mine !== fillSeq.current) return;
            const shown = r.impact.edited.find((x) => x.sheet === name && x.cell === farthest(target))?.after_text;
            setFilling((f) => f && { ...f, tip: shown || null });
          })
          .catch(() => {});
      }, 120);
    };
    const move = (ev: MouseEvent) => {
      const q = pick(ev as unknown as React.MouseEvent);
      if (!q) return;
      const next = targetOf(q);
      if (same(next, to) && switched(ev) === held) return;
      to = next;
      held = switched(ev);
      setFilling({ to, tip: null });
      preview();
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      clearTimeout(timer);
      fillSeq.current++;
      document.body.style.cursor = "";
      setFilling(null);
      if (same(to, from)) return;
      const target = to;
      const corner = { r: anchor.r === target.r1 ? target.r2 : target.r1, c: anchor.c === target.c1 ? target.c2 : target.c1 };
      setSel({ anchor, focus: corner });
      if (grows(target)) {
        void edited(() => rpc.request("doc/autofill", { session_id: session, doc_id: docId, sheet: name, source: rangeText(from), target: rangeText(target), switch: switched(ev), base_revision: revision() }));
      } else {
        // Taken back inside the source: the rows (or columns) given up are emptied.
        const gone = target.r2 < from.r2 ? { ...from, r1: target.r2 + 1 } : { ...from, c1: target.c2 + 1 };
        void apply([{ op: "clear", sheet: name, range: rangeText(gone) }]);
      }
      grid.current?.focus();
    };
    document.body.style.cursor = "crosshair";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** A paste: the clipboard's text, cell by cell from the selection's top-left, as one edit; values only, as typed. */
  const paste = (text: string) => {
    if (!sheet || !editable) return;
    const rows = parseTsv(text);
    const ops = pasteOps(sheet.name, { r: selected.r1, c: selected.c1 }, rows);
    if (!ops) return void (rows.length && st.show(t("sheet.pasteTooBig", { max: MAX_PASTE.toLocaleString() }), undefined, true));
    const width = Math.max(...rows.map((row) => row.length));
    setSel({ anchor: { r: selected.r1, c: selected.c1 }, focus: { r: selected.r1 + rows.length - 1, c: selected.c1 + width - 1 } });
    void apply(ops);
  };

  /** Excel's 插入 / 删除 of whole rows or columns: supports both contiguous and disjoint multi-selection (applied back-to-front so indices stay valid). */
  const restructure = (kind: StructureKind) => {
    if (!sheet || !editable) return;
    const rows = kind === "insert_rows" || kind === "delete_rows";
    const spans = rows ? rowSpans : colSpans;
    const count = spanCount(spans);
    reshaped.current = true;
    setFilter(null);
    const what = rows ? t("sheet.rowsN", { count }) : t("sheet.colsN", { count });
    if (disjoint) {
      const first = Math.max(1, spans[0][0]);
      setSel(rows ? { anchor: { r: first, c: 1 }, focus: { r: first, c: maxCol } } : { anchor: { r: 1, c: first }, focus: { r: maxRow, c: first } });
    }
    void edited(async () => {
      let last!: DocApplyResult;
      for (let i = spans.length - 1; i >= 0; i--) {
        const [at, end] = spans[i];
        last = await rpc.request("doc/structure", { session_id: session, doc_id: docId, sheet: sheet.name, kind, at, count: end - at + 1, base_revision: revision() });
        if (i > 0) made(last);
      }
      return last;
    }, t(`sheet.did_${kind}`, { what }));
  };

  /** Excel's 排序: by the active cell's column; one cell sorts the data around it, its first row a header. */
  const sortBy = (descending: boolean) => {
    if (!sheet || !editable) return;
    if (disjoint) return void st.show(t("sheet.multiNotSupported"), undefined, true);
    const multi = selected.r2 > selected.r1;
    const range = multi ? selectedRange : rangeText({ r1: used.r1, c1: used.c1, r2: used.r2, c2: used.c2 });
    void edited(() => rpc.request("doc/sort", { session_id: session, doc_id: docId, sheet: sheet.name, range, by: colName(active.c), descending, header: !multi, base_revision: revision() }), t(descending ? "sheet.sortedDown" : "sheet.sortedUp", { col: colName(active.c) }));
  };

  /** Excel's 按所选单元格的值筛选, in the view: rows under the data's first row whose cell in this column shows something else are hidden. */
  const filterByValue = async () => {
    if (!sheet) return;
    const col = active.c;
    const value = activeCell?.text ?? "";
    const hidden = new Set<number>();
    try {
      for (let r1 = used.r1 + 1; r1 <= used.r2; r1 += 10000) {
        const r2 = Math.min(used.r2, r1 + 9999);
        const res = await rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: `${colName(col)}${r1}:${colName(col)}${r2}` });
        const shownText = new Map(res.cells.map((c) => [c.cell, c.text]));
        for (let r = r1; r <= r2; r++) if ((shownText.get(addr({ r, c: col })) ?? "") !== value) hidden.add(r);
      }
    } catch (e) {
      return st.show(errorText(e), undefined, true);
    }
    setFilter({ sheet: sheet.name, col, value, hidden });
    st.show(t("sheet.filtered", { count: used.r2 - used.r1 - hidden.size, col: colName(col) }));
  };

  const copyAs = async (text: string, told: string) => {
    try {
      await navigator.clipboard.writeText(text);
      st.show(told);
    } catch (error) { st.show(errorText(error), undefined, true); }
  };

  // ── the right-click menu ──
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);

  // ── tracing (Excel's 追踪引用单元格 / 追踪从属单元格) ──
  const [trace, setTrace] = useState<Trace | null>(null);
  /** From the active cell, one step out; again from the same cell the same way, one step further. */
  const traceFrom = async (direction: "up" | "down", again?: Trace) => {
    if (!sheet) return;
    const cell = again?.cell ?? addr(active);
    const from = again?.sheet ?? sheet.name;
    const same = trace && trace.sheet === from && trace.cell === cell && trace.direction === direction;
    const depth = again ? again.depth : same ? Math.min(10, trace.depth + 1) : 1;
    try {
      const r = await rpc.request("doc/trace", { session_id: session, doc_id: docId, sheet: from, cell, direction, depth });
      setTrace({ sheet: from, cell, direction, depth, cells: r.cells, more: !!r.more });
    } catch (e) {
      st.show(errorText(e), undefined, true);
    }
  };
  // Formulas changed: the trace is worked out again, as far out as it went.
  useEffect(() => {
    if (trace) void traceFrom(trace.direction, trace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.revision]);

  // ── showing formulas (Excel's 显示公式, ⌃`) ──
  const [showFormulas, setShowFormulas] = useState(false);

  // ── display units (spreadsheet-design §8.8): how numbers show here, never written to the file ──
  const [lenses, setLenses] = useState<Record<string, Lens[]>>(() => readLenses(docId));
  const sheetLenses = lenses[sheetName];
  const setSheetLenses = (next: Lens[]) => {
    const all = { ...lenses, [sheetName]: next };
    setLenses(all);
    writeLenses(docId, all);
    if (next.length && !localStorage.getItem("finx.sheet.lensTold")) {
      localStorage.setItem("finx.sheet.lensTold", "1");
      st.show(t("sheet.lensFirst"));
    }
  };
  /** One cell selected stands for its whole column, as a unit is a column's. */
  const lensAreas = (): Area[] => (!disjoint && selected.r1 === selected.r2 && selected.c1 === selected.c2 ? [{ r1: 1, c1: selected.c1, r2: MAX_ROWS, c2: selected.c1 }] : areas);
  const applyLens = (change: { unit?: Unit; decimals?: (had: number | null) => number | null }) =>
    setSheetLenses(lensAreas().reduce((acc, a) => withLens(acc, a, change), sheetLenses ?? []));
  const activeLens = lensAt(sheetLenses, active.r, active.c);

  // ── finding (⌘F, as Excel's 查找) ──
  const [find, setFind] = useState<{ query: string; hits: FoundCell[] | null; at: number; more: boolean } | null>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const openFind = () => {
    setFind((f) => f ?? { query: "", hits: null, at: 0, more: false });
    setTimeout(() => (findBox.current?.focus(), findBox.current?.select()));
  };
  useEffect(() => {
    const onFind = () => root.current?.contains(document.activeElement) && openFind();
    window.addEventListener("finx:find", onFind);
    return () => window.removeEventListener("finx:find", onFind);
  }, []);
  const findNext = async (back: boolean) => {
    if (!find || !find.query.trim()) return;
    let { hits, at } = find;
    if (!hits) {
      try {
        const r = await rpc.request("doc/find", { session_id: session, doc_id: docId, query: find.query.trim(), limit: 500 });
        hits = r.cells;
        at = 0;
        setFind({ ...find, hits, at, more: !!r.more });
      } catch (e) {
        return st.show(errorText(e), undefined, true);
      }
    } else if (hits.length) {
      at = (at + (back ? hits.length - 1 : 1)) % hits.length;
      setFind({ ...find, at });
    }
    const hit = hits[at];
    if (hit) jumpCell(hit.sheet, hit.cell);
  };

  // One commit per edit: Enter commits, then the editor's blur would again.
  const committing = useRef(false);
  const commit = (text: string): Promise<void> => {
    if (committing.current) return Promise.resolve();
    committing.current = true;
    queueMicrotask(() => (committing.current = false));
    setEditing(null);
    const cell = addr(active);
    const before = editText;
    const done = text !== before && sheet ? apply([inputOp(sheet.name, cell, text)]) : Promise.resolve();
    grid.current?.focus();
    return done;
  };

  /** After an undo or redo, as in Excel: the cells it changed are selected, on their sheet, and brought into sight. */
  const selectChanged = (changed: { sheet: string; cell: string }[]) => {
    const on = changed.some((x) => x.sheet === sheetName) ? sheetName : changed[0]?.sheet;
    const at = changed.filter((x) => x.sheet === on).map((x) => parseAddr(x.cell)).filter((p): p is Pos => !!p);
    if (!on || !at.length) return;
    const top = { r: Math.min(...at.map((p) => p.r)), c: Math.min(...at.map((p) => p.c)) };
    const bottom = { r: Math.max(...at.map((p) => p.r)), c: Math.max(...at.map((p) => p.c)) };
    if (on !== sheetName) setSheetName(on);
    reach(bottom.r, bottom.c);
    setSel({ anchor: top, focus: bottom });
    requestAnimationFrame(() => reveal(top));
  };

  const history = (which: "doc/undo" | "doc/redo") =>
    enqueue(async () => {
      try {
        reshaped.current = true;
        const r = await rpc.request(which, { session_id: session, doc_id: docId });
        made(r);
        setImpact(null);
        setLit(null);
        selectChanged(r.impact.edited);
        logActivity({ revision: r.revision, title: t(which === "doc/undo" ? "sheet.undone" : "sheet.redone"), impact: r.impact });
      } catch (e) {
        st.show(errorText(e), undefined, true);
      }
    });

  /** Saves in place (over a change on disk with `force`), or to `path` (save as). */
  const save = async (force = false, path?: string) => {
    // What is typed and on its way is saved with the rest.
    await idle();
    try {
      const next = await rpc.request("doc/save", { session_id: session, doc_id: docId, force, ...(path ? { path } : {}) });
      setDocInfo(session, next);
      if (!path) setNote(null);
      st.show(path ? t("sheet.savedAs", { name: baseName(path) }) : t("sheet.saved"));
      return true;
    } catch (e) {
      if (!path && isRpcKind(e, "doc_conflict")) setNote({ text: t("sheet.conflict"), kind: "conflict" });
      else st.show(errorText(e), undefined, true);
      return false;
    }
  };

  const saveAs = async () => {
    const path = window.finx ? await window.finx.pickSaveFile(info.path) : window.prompt(t("sheet.saveAsPrompt"), info.path);
    if (path) await save(false, path);
  };

  // ⌘S / ⌘⇧S save the workbook in view wherever the focus is in the window, even mid-edit:
  // the cell being typed is committed first, so what is saved is what is shown.
  const saveKey = useRef<(e: KeyboardEvent) => void>(() => {});
  saveKey.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.metaKey && e.ctrlKey) || e.key.toLowerCase() !== "s") return;
    if (!activeView || !root.current?.checkVisibility()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    void (async () => {
      if (editing) await commit(editing.text);
      if (e.shiftKey) await saveAs();
      else if (info.dirty || editing) await save();
    })();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => saveKey.current(e);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const openExcel = async () => {
    if (info.dirty && !(await save())) return;
    void openRef(st, { path: info.path, rel: null, kind: "file" }, undefined, "system");
  };

  const cellsInAreas = async (list: readonly Area[]) => {
    if (!sheet) throw new Error(t("sheet.empty"));
    const rs = await Promise.all(list.map((a) => rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: rangeText(a) })));
    return rs.flatMap((r) => r.cells);
  };

  /** The selection's shown text, by address, as read from finx (cells out of sight included). */
  const selectionText = async () => {
    const cells = await cellsInAreas(areas);
    const values = new Map(cells.map((cell) => [cell.cell, cell.text]));
    return (cell: string) => values.get(cell);
  };

  const copySelection = async () => {
    const gridCopy = copyGrid(areas);
    if (!gridCopy) return void st.show(t("sheet.multiCopyRefused"), undefined, true);
    try {
      await navigator.clipboard.writeText(toTsvGrid(gridCopy.rowSpans, gridCopy.colSpans, await selectionText()));
      st.show(t("sheet.copied"));
    } catch (error) { st.show(errorText(error), undefined, true); }
  };

  const copyMarkdown = async () => {
    const gridCopy = copyGrid(areas);
    if (!gridCopy) return void st.show(t("sheet.multiCopyRefused"), undefined, true);
    try {
      await copyAs(toMarkdownGrid(gridCopy.rowSpans, gridCopy.colSpans, await selectionText()), t("sheet.copied"));
    } catch (error) { st.show(errorText(error), undefined, true); }
  };

  /** ⌘X: the selection copied, then cleared (values only, as the grid copies). */
  const cutSelection = async () => {
    if (!sheet || !editable) return;
    if (disjoint) return void st.show(t("sheet.multiNotSupported"), undefined, true);
    const range = selectedRange;
    try {
      await navigator.clipboard.writeText(toTsvGrid([[selected.r1, selected.r2]], [[selected.c1, selected.c2]], await selectionText()));
    } catch (error) { return st.show(errorText(error), undefined, true); }
    void apply([{ op: "clear", sheet: sheet.name, range }]);
  };

  const clearSelection = () => {
    if (!sheet || !editable) return;
    void apply(areas.map((a) => ({ op: "clear", sheet: sheet.name, range: rangeText(a) })));
  };

  /** Paste from the menu, where no paste event comes: the clipboard's text, read here. */
  const pasteClipboard = async () => {
    if (!editable) return;
    try {
      paste(await navigator.clipboard.readText());
    } catch {
      st.show(t("sheet.pasteKey"), undefined, true);
    }
  };

  /** The menu key or ⇧F10: the cell menu opened at the active cell, as a right-click there would. */
  const cellMenu = () => {
    if (!sheet || editing) return;
    const box = (grid.current?.querySelector(".sht-active") ?? grid.current?.querySelector(".sht-sel") ?? grid.current)?.getBoundingClientRect();
    if (box) setMenuAt({ x: box.left + Math.min(box.width, 40), y: box.top + Math.min(box.height, 20) });
  };

  const quoteSelection = async () => {
    if (!sheet) return;
    const count = areaCellCount(areas);
    let text = t("sheet.selectionSummary", { range: `${sheet.name}!${selectedRanges}`, count });
    if (count <= 200) {
      try {
        const values = await selectionText();
        const gridCopy = copyGrid(areas);
        const body = gridCopy
          ? toMarkdownGrid(gridCopy.rowSpans, gridCopy.colSpans, values)
          : areas.map((a) => `${rangeText(a)}\n\n${toMarkdown(a, values)}`).join("\n\n");
        text = `${sheet.name}!${selectedRanges}\n\n${body}`;
      } catch (error) {
        st.show(errorText(error), undefined, true);
        return;
      }
    }
    // What the person sees in a unit is said, so the agent does not take the values for what is shown (§8.8).
    const shownIn = lensAt(sheetLenses, active.r, active.c);
    if (shownIn && shownIn.unit !== 1) text += `\n\n${t("sheet.lensQuote", { unit: t(`sheet.unit${shownIn.unit}`) })}`;
    quoteToComposer(session, { quote: { path: info.path, doc_id: docId, sheet: sheet.name, range: selectedRanges, text } });
    st.show(t("sheet.quoted"));
    scope?.leave?.();
  };

  // ── moving ──
  const reveal = (p: Pos, axis: "both" | "x" | "y" = "both") => {
    const el = scroller.current;
    if (!el) return;
    const z = zoomRef.current;
    if (axis !== "x" && p.r > frozen.rows) {
      const top = rowY(p.r) + HEAD_H;
      const bottom = rowY(p.r + 1) + HEAD_H;
      const st = el.scrollTop / z;
      if (top - frozenH < st + HEAD_H) el.scrollTop = (top - HEAD_H - frozenH) * z;
      else if (bottom > st + el.clientHeight / z) el.scrollTop = (bottom - el.clientHeight / z) * z;
    }
    if (axis !== "y" && p.c > frozen.cols) {
      const left = colLeft[p.c] + HEAD_W;
      const right = colLeft[p.c + 1] + HEAD_W;
      const sl = el.scrollLeft / z;
      if (left - frozenW < sl + HEAD_W) el.scrollLeft = (left - HEAD_W - frozenW) * z;
      else if (right > sl + el.clientWidth / z) el.scrollLeft = (right - el.clientWidth / z) * z;
    }
  };
  const go = (p: Pos, extend: boolean) => {
    const q = { r: Math.min(MAX_ROWS, Math.max(1, p.r)), c: Math.min(MAX_COLS, Math.max(1, p.c)) };
    reach(q.r, q.c);
    setSel((s) => (extend ? { anchor: s.anchor, focus: q, ...(s.extra?.length ? { extra: s.extra } : {}) } : { anchor: q, focus: q }));
    requestAnimationFrame(() => reveal(q));
    // Moving on puts out what your last edit lit downstream; what the agent changed stays till dismissed.
    setLit((l) => (l?.mine ? null : l));
  };
  const jumpCell = (targetSheet: string, cell: string) => {
    const p = parseAddr(cell);
    if (!p) return;
    setSheetName(targetSheet);
    reach(p.r, p.c);
    setSel({ anchor: p, focus: p });
    setImpact(null);
    setAgentNotice(null);
    requestAnimationFrame(() => reveal(p));
  };
  /** Enter (down) or Tab (across), back with ⇧: in a range the active cell goes round inside it and the range stays, as in Excel; else on to the next cell. */
  const advance = (down: boolean, back: boolean) => {
    const g = areaOf(sel.anchor, sel.focus);
    const d = back ? -1 : 1;
    if (g.r1 === g.r2 && g.c1 === g.c2) return go(down ? { r: active.r + d, c: active.c } : { r: active.r, c: active.c + d }, false);
    let { r, c } = active;
    if (down) {
      r += d;
      if (r > g.r2) (r = g.r1), (c = c + 1 > g.c2 ? g.c1 : c + 1);
      else if (r < g.r1) (r = g.r2), (c = c - 1 < g.c1 ? g.c2 : c - 1);
    } else {
      c += d;
      if (c > g.c2) (c = g.c1), (r = r + 1 > g.r2 ? g.r1 : r + 1);
      else if (c < g.c1) (c = g.c2), (r = r - 1 < g.r1 ? g.r2 : r - 1);
    }
    setSel((s) => ({ ...s, at: { r, c } }));
    setLit((l) => (l?.mine ? null : l));
    requestAnimationFrame(() => reveal({ r, c }));
  };
  /** ⌘+arrow: to the edge of the data, as Excel goes. */
  const edge = (p: Pos, dr: number, dc: number): Pos => {
    const filled = (q: Pos) => !!shown(q)?.text;
    let q = { ...p };
    const next = (x: Pos) => ({ r: x.r + dr, c: x.c + dc });
    const inside = (x: Pos) => x.r >= 1 && x.c >= 1 && x.r <= Math.max(used.r2, 1) && x.c <= Math.max(used.c2, 1);
    const startFilled = filled(q) && inside(next(q)) && filled(next(q));
    if (startFilled) {
      while (inside(next(q)) && filled(next(q))) q = next(q);
    } else {
      q = next(q);
      while (inside(q) && !filled(q)) q = next(q);
      if (!inside(q)) q = { r: dr ? (dr > 0 ? used.r2 : 1) : p.r, c: dc ? (dc > 0 ? used.c2 : 1) : p.c };
    }
    return q;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (mod && e.altKey && e.key.toLowerCase() === "e") {
      void openExcel();
    } else if (arrows[e.key]) {
      const [dr, dc] = arrows[e.key];
      const from = e.shiftKey ? sel.focus : active;
      go(mod ? edge(from, dr, dc) : { r: from.r + dr, c: from.c + dc }, e.shiftKey);
    } else if (e.key === "Enter" || e.key === "Tab") {
      advance(e.key === "Enter", e.shiftKey);
    } else if (e.key === "F2") {
      editable && setEditing({ text: editText, inBar: false });
    } else if ((e.key === "Backspace" || e.key === "Delete") && sheet && editable) {
      clearSelection();
    } else if (mod && e.key.toLowerCase() === "z") {
      void history(e.shiftKey ? "doc/redo" : "doc/undo");
    } else if (mod && e.key.toLowerCase() === "x") {
      void cutSelection();
    } else if (mod && e.key.toLowerCase() === "c") {
      void copySelection();
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      cellMenu();
    } else if (mod && e.key.toLowerCase() === "l") {
      void quoteSelection();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
      fill("down");
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "r") {
      fill("right");
    } else if (mod && (e.key === "[" || e.code === "BracketLeft")) {
      void traceFrom("up");
    } else if (mod && (e.key === "]" || e.code === "BracketRight")) {
      void traceFrom("down");
    } else if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
      setShowFormulas((v) => !v);
    } else if (!mod && e.key.length === 1 && editable) {
      setEditing({ text: e.key, inBar: false });
    } else if (e.key === "Escape") {
      setLit(null);
      setTrace(null);
    } else return;
    e.preventDefault();
  };

  // ── drawing ──
  const firstRow = Math.max(frozen.rows + 1, rowAt(view.top + frozenH) - 2);
  const lastRow = Math.min(nRows, rowAt(view.top + view.h) + 2);
  const firstCol = Math.max(frozen.cols + 1, colAt(view.left + frozenW) - 1);
  const lastCol = Math.min(nCols, colAt(view.left + view.w) + 1);
  const rowsShown: number[] = [...Array.from({ length: frozen.rows }, (_, i) => i + 1), ...Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, i) => firstRow + i)];
  const colsShown: number[] = [...Array.from({ length: frozen.cols }, (_, i) => i + 1), ...Array.from({ length: Math.max(0, lastCol - firstCol + 1) }, (_, i) => firstCol + i)];
  const merges = cache.current.merges;
  const mergeAt = (r: number, c: number) => merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  const g = selected;

  /** The layer a cell is drawn in: the pane its top-left is in. */
  const paneOf = (r: number, c: number): Pane => (r <= frozen.rows ? (c <= frozen.cols ? "x" : "r") : c <= frozen.cols ? "c" : "s");
  /** Where a cell is drawn in its layer. */
  const place = (r: number, c: number, w: number, h: number) => ({ left: HEAD_W + colLeft[c], top: HEAD_H + rowY(r), width: w, height: h });
  /** Where that is on the canvas now, for what is drawn over every layer: frozen panes stay where the view starts. */
  const onCanvas = (r: number, c: number, b: { left: number; top: number }) => ({ left: b.left + (c <= frozen.cols ? view.left : 0), top: b.top + (r <= frozen.rows ? view.top : 0) });
  const panes: Record<Pane, React.ReactNode[]> = { s: [], c: [], r: [], x: [] };

  // Once per drawing, not per cell.
  const cellAt = (r: number, c: number) => cache.current.cells.get(addr({ r, c }));
  const traced = new Set(trace ? trace.cells.filter((x) => x.sheet === sheetName).map((x) => x.cell) : []);
  if (trace && trace.sheet === sheetName) traced.add(trace.cell);
  const found = new Set(find?.hits?.filter((x) => x.sheet === sheetName).map((x) => x.cell) ?? []);
  const unitName = (u: Unit) => t(`sheet.unit${u}`);
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  for (const r of rowsShown) {
    if (rowY(r + 1) === rowY(r)) continue;
    for (const c of colsShown) {
      if (!widths[c]) continue;
      const m = mergeAt(r, c);
      if (m && (m.r1 !== r || m.c1 !== c)) {
        // Covered by a merge whose top-left is out of sight: draw it here once.
        const firstShown = r === Math.max(m.r1, rowsShown[0]) && c === Math.max(m.c1, colsShown[0]);
        if (!(firstShown && (m.r1 < rowsShown[0] || m.c1 < colsShown[0]))) continue;
      }
      const a = m ? { r: m.r1, c: m.c1 } : { r, c };
      const key = addr(a);
      const d = cache.current.cells.get(key);
      const w = m ? colLeft[m.c2 + 1] - colLeft[m.c1] : widths[c];
      const h = m ? rowY(m.r2 + 1) - rowY(m.r1) : rowY(r + 1) - rowY(r);
      const asFormula = showFormulas && !!d?.formula;
      const lens = lensAt(sheetLenses, a.r, a.c);
      const lensed = asFormula ? null : lensText(d, lens, i18n.language);
      const text = asFormula ? d!.formula! : (lensed ?? d?.text);
      const num = d?.value?.type === "number" && !asFormula;
      const hard = isHardcoded(cellAt, a.r, a.c);
      const align = asFormula ? "left" : (d?.look?.align ?? (num ? "right" : d?.value?.type === "bool" || d?.value?.type === "error" ? "center" : "left"));
      // Text runs on over empty cells to its right, as in Excel; in a frozen column it stops at the
      // freeze line, else it would sit over whatever has scrolled under there.
      let span = w;
      if (!m && text && align === "left" && !num) {
        for (let k = c + 1; k <= Math.min(c <= frozen.cols ? frozen.cols : nCols, c + 12) && !cache.current.cells.get(addr({ r, c: k }))?.text && !mergeAt(r, k); k++) span += widths[k];
      }
      const style: CSSProperties = {
        ...place(a.r, a.c, w, h),
        color: readable(d?.look?.color, dark),
        background: d?.look?.fill ? `#${d.look?.fill}` : undefined,
        fontWeight: d?.look?.bold ? 600 : undefined,
        fontStyle: d?.look?.italic ? "italic" : undefined,
        justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
      };
      const cls = ["sht-c", text ? "has" : "", lit?.cells.has(key) ? "lit" : "", m ? "merged" : "", traced.has(key) ? "traced" : "", found.has(key) ? "found" : "", hard ? "hard" : "", lensed !== null ? "lensed" : "", asFormula ? "asformula" : ""].join(" ");
      const title = lensed !== null ? t("sheet.lensTip", { raw: d!.text, shown: lensed, unit: unitName(lens!.unit) }) : hard ? t("sheet.hardcoded") : (d?.formula ?? undefined);
      panes[paneOf(a.r, a.c)].push(
        <div key={`${r}:${c}`} data-cell={key} className={cls} style={style} title={title}>
          {text && <span style={span > w ? { maxWidth: Math.max(0, span - 8), background: d?.look?.fill || lit?.cells.has(key) || found.has(key) ? undefined : "var(--sht-bg)" } : { maxWidth: "100%" }}>{text}</span>}
        </div>,
      );
    }
  }

  // Charts the file draws on this sheet: shown over the cells where it anchors them, in the
  // scrolling layer; the clicks go through to the cells below.
  const colX = (c: number) => (c <= nCols + 1 ? colLeft[c] : colLeft[nCols + 1] + (c - nCols - 1) * (sheet?.default_width ?? 64));
  (sheet?.charts ?? []).forEach((ch, i) => {
    const x = colX(ch.from.col) + ch.from.dx;
    const y = rowY(ch.from.row) + ch.from.dy;
    const w = ch.to ? colX(ch.to.col) + ch.to.dx - x : ch.width;
    const h = ch.to ? rowY(ch.to.row) + ch.to.dy - y : ch.height;
    if (w < 20 || h < 20) return;
    panes.s.push(
      <div key={`chart${i}`} className="sht-chartbox" style={{ left: HEAD_W + x, top: HEAD_H + y, width: w, height: h }}>
        <ChartView chart={ch} width={w} height={h} />
      </div>,
    );
  });

  const isMac = window.finx?.platform === "mac" || (!window.finx && /Mac|iPhone|iPad/.test(navigator.platform));
  const isRight = (e: React.MouseEvent) => e.button === 2 || (e.button === 0 && e.ctrlKey && isMac);
  const isAdd = (e: React.MouseEvent) => (isMac ? e.metaKey : e.ctrlKey) && !isRight(e);
  const pickCol = (ev: { clientX: number }) => {
    const el = scroller.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const z = zoomRef.current;
    const x = (ev.clientX - rect.left) / z - HEAD_W;
    if (x < 0) return frozen.cols > 0 ? 1 : colAt(el.scrollLeft / z);
    return x < frozenW ? colAt(x) : colAt(x + el.scrollLeft / z);
  };
  const pickRow = (ev: { clientY: number }) => {
    const el = scroller.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const z = zoomRef.current;
    const y = (ev.clientY - rect.top) / z - HEAD_H;
    if (y < 0) return frozen.rows > 0 ? 1 : rowAt(el.scrollTop / z);
    return y < frozenH ? rowAt(y) : rowAt(y + el.scrollTop / z);
  };
  /** Column / row header selection: click, drag-sweep, ⇧-click range extend, and ⌘/Ctrl non-contiguous add/toggle. */
  const selectHeader = (axis: "cols" | "rows", n: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (editing) commit(editing.text);
    const cols = axis === "cols";
    const wholeSpans = cols ? wholeColSpans : wholeRowSpans;
    const lineSel = (a: number, b: number, extra?: Area[]): Sel =>
      cols
        ? { anchor: { r: 1, c: a }, focus: { r: maxRow, c: b }, ...(extra?.length ? { extra } : {}) }
        : { anchor: { r: a, c: 1 }, focus: { r: b, c: maxCol }, ...(extra?.length ? { extra } : {}) };
    if (isRight(e)) {
      if (!inSpans(wholeSpans, n)) setSel(lineSel(n, n));
      grid.current?.focus();
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const adding = isAdd(e);
    const togglePending = adding && inSpans(wholeSpans, n);
    let anchorLine = n;
    let keptExtra: Area[] | undefined;
    if (adding) {
      keptExtra = [...(sel.extra ?? []), selected];
      if (!togglePending) setSel(lineSel(n, n, keptExtra));
    } else if (e.shiftKey) {
      anchorLine = cols ? sel.anchor.c : sel.anchor.r;
      keptExtra = sel.extra;
      setSel(lineSel(anchorLine, n, keptExtra));
    } else {
      setSel(lineSel(n, n));
    }
    setLit((l) => (l?.mine ? null : l));
    grid.current?.focus();
    let last = n;
    let dragged = false;
    const move = (ev: MouseEvent) => {
      const q = cols ? pickCol(ev) : pickRow(ev);
      if (q === null || q === last) return;
      last = q;
      dragged = true;
      setSel(lineSel(anchorLine, q, keptExtra));
      reveal(cols ? { r: 1, c: q } : { r: q, c: 1 }, cols ? "x" : "y");
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (togglePending && !dragged) setSel((s) => toggleLine(s, axis, n, cols ? maxRow : maxCol));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** Headers: of columns that scroll, of rows that scroll, and frozen ones with the corner. */
  const heads: Record<"hc" | "hr" | "hx", React.ReactNode[]> = { hc: [], hr: [], hx: [] };
  /** A column shown in a unit other than the file's: its header says which (§8.8). */
  function unitOfCol(c: number): Unit | null {
    const l = sheetLenses?.findLast((x) => c >= x.area.c1 && c <= x.area.c2 && x.unit !== 1);
    return l?.unit ?? null;
  }
  for (const c of colsShown) {
    if (!widths[c]) continue;
    const fc = c <= frozen.cols;
    const on = colSelected(areas, c);
    heads[fc ? "hx" : "hc"].push(<div key={`h${c}`} className={`sht-h col ${on ? "on" : ""}`} style={{ left: HEAD_W + colLeft[c], top: 0, width: widths[c], height: HEAD_H }} onMouseDown={(e) => selectHeader("cols", c, e)} onContextMenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!inSpans(wholeColSpans, c)) setSel({ anchor: { r: 1, c }, focus: { r: maxRow, c } });
      grid.current?.focus();
      setMenuAt({ x: e.clientX, y: e.clientY });
    }}>{colName(c)}{unitOfCol(c) && <span className="sht-unit">{unitName(unitOfCol(c)!)}</span>}</div>);
  }
  /** Dragging a header's edge, as in Excel: applies to every selected whole column (or row) when dragging one of them. */
  const resize = (kind: "cols" | "rows", n: number, start: number, from: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const z = zoomRef.current;
    const whole = kind === "cols" ? wholeColSpans : wholeRowSpans;
    const targets = inSpans(whole, n) ? expandSpans(whole) : [n];
    const move = (ev: MouseEvent) => {
      const size = Math.max(kind === "cols" ? 8 : 6, Math.round(start + ((kind === "cols" ? ev.clientX : ev.clientY) - from) / z));
      setSized((x) => {
        const next = { cols: new Map(x.cols), rows: new Map(x.rows) };
        for (const k of targets) next[kind].set(sizeKey(sheetName, k), size);
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = kind === "cols" ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  /** Double-clicking a header's edge, as in Excel: fits each selected whole column (or this column alone) to its widest read text. */
  const autofit = (c: number) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const font = getComputedStyle(grid.current ?? document.body);
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono");
    const targets = inSpans(wholeColSpans, c) ? expandSpans(wholeColSpans) : [c];
    const targetSet = new Set(targets);
    const best = new Map<number, number>();
    for (const [key, d] of cache.current.cells) {
      const at = parseAddr(key);
      if (!at || !targetSet.has(at.c) || mergeAt(at.r, at.c)) continue;
      const asFormula = showFormulas && !!d.formula;
      const text = asFormula ? d.formula! : (lensText(d, lensAt(sheetLenses, at.r, at.c), i18n.language) ?? d.text);
      if (!text) continue;
      ctx.font = `${d.look?.italic ? "italic " : ""}${d.look?.bold ? 600 : 400} ${font.fontSize} ${asFormula ? mono : font.fontFamily}`;
      best.set(at.c, Math.max(best.get(at.c) ?? 0, ctx.measureText(text).width));
    }
    setSized((x) => {
      const next = { cols: new Map(x.cols), rows: new Map(x.rows) };
      for (const col of targets) {
        const w = best.get(col) ?? 0;
        next.cols.set(sizeKey(sheetName, col), w ? Math.min(800, Math.ceil(w) + 12) : (sheet?.default_width ?? 64));
      }
      return next;
    });
  };
  for (const c of colsShown) {
    if (!widths[c]) continue;
    const fc = c <= frozen.cols;
    heads[fc ? "hx" : "hc"].push(<div key={`hg${c}`} className="sht-grip col" style={{ left: HEAD_W + colLeft[c + 1] - 3, top: 0, height: HEAD_H }} onMouseDown={(e) => resize("cols", c, widths[c], e.clientX)(e)} onDoubleClick={(e) => { e.stopPropagation(); autofit(c); }} />);
  }
  for (const r of rowsShown) {
    const h = rowY(r + 1) - rowY(r);
    if (!h) continue;
    const frg = r <= frozen.rows;
    heads[frg ? "hx" : "hr"].push(<div key={`rg${r}`} className="sht-grip row" style={{ left: 0, top: HEAD_H + rowY(r + 1) - 3, width: HEAD_W }} onMouseDown={(e) => resize("rows", r, h, e.clientY)(e)} />);
  }
  for (const r of rowsShown) {
    const h = rowY(r + 1) - rowY(r);
    if (!h) continue;
    const fr = r <= frozen.rows;
    const on = rowSelected(areas, r);
    heads[fr ? "hx" : "hr"].push(<div key={`r${r}`} className={`sht-h row ${on ? "on" : ""}`} style={{ left: 0, top: HEAD_H + rowY(r), width: HEAD_W, height: h }} onMouseDown={(e) => selectHeader("rows", r, e)} onContextMenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!inSpans(wholeRowSpans, r)) setSel({ anchor: { r, c: 1 }, focus: { r, c: maxCol } });
      grid.current?.focus();
      setMenuAt({ x: e.clientX, y: e.clientY });
    }}><span className={filter?.sheet === sheetName && r > used.r1 ? "sht-filtered" : undefined}>{r}</span></div>);
  }

  const multi = g.r1 !== g.r2 || g.c1 !== g.c2;
  const selBox = (() => {
    const m = mergeAt(active.r, active.c);
    const box = m && g.r1 === g.r2 && g.c1 === g.c2 ? m : g;
    const w = colLeft[box.c2 + 1] - colLeft[box.c1];
    const h = rowY(box.r2 + 1) - rowY(box.r1);
    const p = place(box.r1, box.c1, w, h);
    if (!multi) return p;
    // Multi-cell range: leave the active cell untinted (like Excel) instead of drawing a second box over it.
    const x1 = colLeft[active.c] - colLeft[box.c1];
    const y1 = rowY(active.r) - rowY(box.r1);
    const x2 = x1 + widths[active.c];
    const y2 = y1 + rowY(active.r + 1) - rowY(active.r);
    const hole = `polygon(evenodd, 0 0, ${w}px 0, ${w}px ${h}px, 0 ${h}px, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`;
    return { ...p, "--sht-hole": hole } as CSSProperties;
  })();
  const selPane = (() => {
    const m = mergeAt(active.r, active.c);
    const box = m && !multi ? m : g;
    return paneOf(box.r1, box.c1);
  })();
  const selAt = onCanvas(g.r1 <= frozen.rows ? 1 : g.r1, g.c1 <= frozen.cols ? 1 : g.c1, { left: selBox.left as number, top: selBox.top as number });
  const activeBox = place(active.r, active.c, widths[active.c], rowY(active.r + 1) - rowY(active.r));

  // Trace arrows, as Excel draws them: from the cell read to the formula reading it, a dot at
  // its start; an end on another sheet is a dashed stub to a sheet mark.
  const centre = (cell: string) => {
    const p = parseAddr(cell);
    if (!p) return null;
    const b = place(p.r, p.c, widths[p.c] ?? 0, rowY(p.r + 1) - rowY(p.r));
    const at = onCanvas(p.r, p.c, b);
    return { x: at.left + b.width / 2, y: at.top + b.height / 2 };
  };
  const arrows: React.ReactNode[] = [];
  for (const x of trace?.cells ?? []) {
    if (!x.via || arrows.length >= 300) continue;
    const cut = x.via.lastIndexOf("!");
    const via = { sheet: x.via.slice(0, cut), cell: x.via.slice(cut + 1) };
    const [from, to] = trace!.direction === "up" ? [{ sheet: x.sheet, cell: x.cell }, via] : [via, { sheet: x.sheet, cell: x.cell }];
    const a = from.sheet === sheetName ? centre(from.cell) : null;
    const b = to.sheet === sheetName ? centre(to.cell) : null;
    const k = `${from.sheet}!${from.cell}>${to.sheet}!${to.cell}`;
    if (a && b) {
      arrows.push(<g key={k}><circle cx={a.x} cy={a.y} r={3} /><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#sht-arrow)" /></g>);
    } else if (a || b) {
      // The other end is on another sheet: a stub up and to the left of the cell here.
      const p = (a ?? b)!;
      const q = { x: p.x - 28, y: p.y - 22 };
      arrows.push(
        <g key={k} className="off">
          {a ? <line x1={a.x} y1={a.y} x2={q.x} y2={q.y} markerEnd="url(#sht-arrow)" /> : <line x1={q.x} y1={q.y} x2={b!.x} y2={b!.y} markerEnd="url(#sht-arrow)" />}
          <rect x={q.x - 7} y={q.y - 12} width={14} height={11} rx={1.5} />
          <path d={`M${q.x - 7} ${q.y - 8.5}h14M${q.x - 2.5} ${q.y - 12}v11`} />
        </g>,
      );
    }
  }

  /** A layer's cells, then the boxes drawn over the cells of that pane. */
  const pane = (p: Pane) => (
    <>
      {panes[p]}
      {(sel.extra ?? []).map((a, i) => paneOf(a.r1, a.c1) === p && (
        <div key={`ex${i}`} className="sht-sel extra" style={place(a.r1, a.c1, colLeft[a.c2 + 1] - colLeft[a.c1], rowY(a.r2 + 1) - rowY(a.r1))} />
      ))}
      {selPane === p && <div className={`sht-sel ${multi ? "multi" : ""}`} style={selBox} />}
      {!multi && paneOf(active.r, active.c) === p && <div className="sht-active" style={activeBox} />}
      {filling && paneOf(filling.to.r1, filling.to.c1) === p && <div className="sht-fill-to" style={place(filling.to.r1, filling.to.c1, colLeft[filling.to.c2 + 1] - colLeft[filling.to.c1], rowY(filling.to.r2 + 1) - rowY(filling.to.r1))} />}
      {selPane === p && editable && !editing && !filling && !disjoint && (
        <div className="sht-fill-handle" aria-label={t("sheet.fillHandle")} title={t("sheet.fillHandle")} onMouseDown={dragFill}
          style={{ left: (selBox.left as number) + (selBox.width as number) - 4, top: (selBox.top as number) + (selBox.height as number) - 4 }} />
      )}
      {editing && !editing.inBar && paneOf(active.r, active.c) === p && (
        <input
          autoFocus
          className="sht-edit"
          style={{ ...activeBox, minWidth: activeBox.width, zIndex: 6 }}
          value={editing.text}
          onChange={(e) => setEditing({ text: e.target.value, inBar: false })}
          onBlur={() => editing && commit(editing.text)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Tab") {
              commit(editing.text);
              advance(e.key === "Enter", e.shiftKey);
              e.preventDefault();
            } else if (e.key === "Escape") {
              setEditing(null);
              grid.current?.focus();
            }
          }}
        />
      )}
  </>
  );

  const pick = (e: React.MouseEvent) => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const z = zoomRef.current;
    const x = (e.clientX - rect.left) / z - HEAD_W;
    const y = (e.clientY - rect.top) / z - HEAD_H;
    if (x < 0 || y < 0) return null;
    const r = y < frozenH ? rowAt(y) : rowAt(y + el.scrollTop / z);
    const c = x < frozenW ? colAt(x) : colAt(x + el.scrollLeft / z);
    const m = mergeAt(r, c);
    return m ? { r: m.r1, c: m.c1 } : { r, c };
  };

  const nRowsSel = spanCount(rowSpans);
  const nColsSel = spanCount(colSpans);
  const formulas = !!info.capabilities.includes("edit_formulas");
  const menuItems: MenuItem[] = [
    item(t("sheet.cut"), () => void cutSelection(), { kbd: "⌘X", disabled: !editable || disjoint }),
    item(t("sheet.copy"), () => void copySelection(), { kbd: "⌘C" }),
    item(t("sheet.paste"), () => void pasteClipboard(), { kbd: "⌘V", disabled: !editable }),
    item(t("sheet.copyAs"), undefined, { items: [
      item(t("sheet.copyMarkdown"), () => void copyMarkdown()),
      item(t("sheet.copyAddress"), () => void copyAs(`${sheetName}!${selectedRanges}`, t("sheet.copiedAddress"))),
    ] }),
    sep,
    item(t("sheet.insert"), undefined, { disabled: !editable, items: [
      item(t("sheet.insertRows", { count: nRowsSel }), () => restructure("insert_rows")),
      item(t("sheet.insertCols", { count: nColsSel }), () => restructure("insert_columns")),
    ] }),
    item(t("sheet.delete"), undefined, { disabled: !editable, items: [
      item(t("sheet.deleteRows", { count: nRowsSel }), () => restructure("delete_rows"), { danger: true }),
      item(t("sheet.deleteCols", { count: nColsSel }), () => restructure("delete_columns"), { danger: true }),
    ] }),
    item(t("sheet.clear"), clearSelection, { kbd: "⌫", disabled: !editable }),
    sep,
    item(t("sheet.filter"), undefined, { items: [
      item(t("sheet.filterByValue"), () => void filterByValue()),
      item(t("sheet.filterClear"), () => setFilter(null), { disabled: filter?.sheet !== sheetName }),
    ] }),
    item(t("sheet.sort"), undefined, { disabled: !editable || disjoint, items: [
      item(t("sheet.sortUp"), () => sortBy(false)),
      item(t("sheet.sortDown"), () => sortBy(true)),
    ] }),
    item(t("sheet.fill"), undefined, { disabled: !editable || disjoint, items: [
      item(t("sheet.fillDown"), () => fill("down"), { kbd: "⌘D" }),
      item(t("sheet.fillRight"), () => fill("right"), { kbd: "⌘R" }),
    ] }),
    sep,
    item(t("sheet.askAgent"), () => void quoteSelection(), { kbd: "⌘L", icon: "chat" }),
    item(t("sheet.trace"), undefined, { disabled: !formulas, items: [
      item(t("sheet.traceUp"), () => void traceFrom("up"), { kbd: "⌘[" }),
      item(t("sheet.traceDown"), () => void traceFrom("down"), { kbd: "⌘]" }),
      ...(trace ? [item(t("sheet.traceClear"), () => setTrace(null))] : []),
    ] }),
    item(t("sheet.showFormulas"), () => setShowFormulas((v) => !v), { kbd: "⌃`", checked: showFormulas }),
    item(t("sheet.openExcel"), () => void openExcel(), { kbd: "⌥⌘E" }),
  ];

  const bar = editing?.text ?? editText;
  const dirty = info.dirty;

  if (!sheet) return <div className="fpn-empty">{t("sheet.empty")}</div>;
  return (
    <div
      ref={root}
      className="sht"
      onKeyDown={onKey}
      onPaste={(e) => {
        if (editing || (e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
        paste(e.clipboardData.getData("text/plain"));
      }}
    >
      <div className="sht-tools" role="toolbar" aria-label={t("sheet.tools")}>
        <div className="sht-group">
          <button className="tb" title={t("sheet.save")} aria-label={t("sheet.save")} disabled={!dirty} onClick={() => void save()}><Icon name="save" /></button>
          <button className="tb" title={t("sheet.undo")} aria-label={t("sheet.undo")} disabled={!editable || busy} onClick={() => void history("doc/undo")}><Icon name="undo" /></button>
          <button className="tb sht-redo" title={t("sheet.redo")} aria-label={t("sheet.redo")} disabled={!editable || busy} onClick={() => void history("doc/redo")}><Icon name="undo" /></button>
        </div>
        <span className="sht-sep" />
        <div className="sht-group">
          <Tool icon="tracePre" label={t("sheet.traceUp")} tip={t("sheet.traceUpTip")} on={trace?.direction === "up"} onClick={() => void traceFrom("up")} />
          <Tool icon="traceDep" label={t("sheet.traceDown")} tip={t("sheet.traceDownTip")} on={trace?.direction === "down"} onClick={() => void traceFrom("down")} />
          {trace && <Tool icon="traceOff" label={t("sheet.traceClear")} onClick={() => setTrace(null)} />}
          <Tool icon="fx" label={t("sheet.showFormulas")} tip={t("sheet.showFormulasTip")} on={showFormulas} onClick={() => setShowFormulas((v) => !v)} />
        </div>
        <span className="sht-sep" />
        <div className="sht-group sht-numfmt">
          <select className="sht-unitsel" aria-label={t("sheet.unit")} title={t("sheet.unitTip")} value={activeLens?.unit ?? 1} onChange={(e) => (e.target.value === "reset" ? setSheetLenses([]) : applyLens({ unit: Number(e.target.value) as Unit }))}>
            {UNITS.map((u) => <option key={u} value={u}>{unitName(u)}</option>)}
            {/* Everything on the sheet back as the file shows it. */}
            {!!sheetLenses?.length && <option value="reset">{t("sheet.lensClear")}</option>}
          </select>
          <button className="tb sht-dec" title={t("sheet.decimalsMore")} aria-label={t("sheet.decimalsMore")} onClick={() => applyLens({ decimals: (had) => Math.min(10, (had ?? decimalsOf(activeCell?.text ?? "")) + 1) })}>.00</button>
          <button className="tb sht-dec" title={t("sheet.decimalsLess")} aria-label={t("sheet.decimalsLess")} onClick={() => applyLens({ decimals: (had) => Math.max(0, (had ?? decimalsOf(activeCell?.text ?? "")) - 1) })}>.0</button>
        </div>
        <div className="sht-tools-end">
          {busy && <span className="mini-spin" />}
          <span className={`fpn-state ${dirty ? "dirty" : ""}`}>{dirty ? t("sheet.unsaved") : ""}</span>
          <button className={`tb ${find ? "on" : ""}`} title={t("sheet.find")} aria-label={t("sheet.find")} onClick={() => (find ? setFind(null) : openFind())}><Icon name="search" /></button>
          <button className={`tb ${showHistory ? "on" : ""}`} title={t("sheet.history")} aria-label={t("sheet.history")} onClick={() => setShowHistory((v) => !v)}><Icon name="clock" /></button>
          <button className="tb" title={t("sheet.openInExcel")} aria-label={t("sheet.openInExcel")} onClick={() => void openExcel()}><Icon name="ext" /></button>
        </div>
      </div>
      <div className="sht-bar">
        <input
          className="sht-name"
          aria-label={t("sheet.address")}
          defaultValue={addr(active)}
          key={addr(active)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key !== "Enter") return;
            const p = parseAddr((e.target as HTMLInputElement).value);
            if (p) go(p, false);
            grid.current?.focus();
          }}
        />
        <span className="sht-fx">fx</span>
        <input
          className="sht-formula"
          aria-label={t("sheet.formula")}
          value={bar}
          readOnly={!editable}
          onFocus={() => editable && !editing && setEditing({ text: bar, inBar: true })}
          onChange={(e) => setEditing({ text: e.target.value, inBar: true })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(editing?.text ?? bar);
            else if (e.key === "Escape") {
              setEditing(null);
              grid.current?.focus();
            }
          }}
        />
        {activeLens && activeCell?.value?.type === "number" && <span className="sht-raw" title={t("sheet.rawTip")}>{editing ? t("sheet.rawInput") : t("sheet.raw")}</span>}
      </div>
      {find && (
        <form className="dcp-find sht-find" onSubmit={(e) => e.preventDefault()}>
          <Icon name="search" />
          <input
            ref={findBox}
            value={find.query}
            placeholder={t("sheet.findPlaceholder")}
            onChange={(e) => setFind({ query: e.target.value, hits: null, at: 0, more: false })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.preventDefault(), void findNext(e.shiftKey));
              else if (e.key === "Escape") (setFind(null), grid.current?.focus());
            }}
          />
          {find.hits && <span className="dcp-count">{find.hits.length ? `${find.at + 1}/${find.hits.length}${find.more ? "+" : ""}` : t("sheet.findNone")}</span>}
          <button type="button" className="tb" aria-label={t("sheet.dismiss")} onClick={() => (setFind(null), grid.current?.focus())}><Icon name="x" /></button>
        </form>
      )}
      {trace && <TraceBar trace={trace} onJump={jumpCell} onMore={() => void traceFrom(trace.direction)} onClose={() => setTrace(null)} />}
      {showHistory && (
        <div className="sht-history" role="dialog" aria-label={t("sheet.history")}>
          <div className="sht-history-head"><b>{t("sheet.history")}</b><button className="tb" aria-label={t("sheet.dismiss")} onClick={() => setShowHistory(false)}><Icon name="x" /></button></div>
          {activity.length ? activity.map((item, i) => (
            <button key={`${item.revision}:${i}`} className="sht-history-row" onClick={() => item.impact && (setImpact({ impact: item.impact, byAgent: false }), setShowHistory(false))}>
              <span>{item.title}</span><small>r{item.revision}</small>
            </button>
          )) : <div className="sht-history-empty">{t("sheet.noHistory")}</div>}
        </div>
      )}
      {loadError && <div className="fpn-note" role="alert"><span>{t("sheet.loadFailed")} {loadError}</span><button className="btn sm" onClick={() => { setLoadError(null); reread(false); }}>{t("files.retry")}</button></div>}
      {!editable && !sheet.chart && <div className="fpn-note" role="status"><Icon name="lock" /><span>{t("sheet.readOnly")}</span><button className="btn sm" onClick={() => void openExcel()}>{t("sheet.openExcel")}</button></div>}
      {agentNotice && <div className="sht-agent" role="status"><Icon name="sparkle" /><span>{t("sheet.agentChanged", { count: agentNotice.count })}</span>{agentNotice.first && <button className="btn sm" onClick={() => jumpCell(sheet.name, agentNotice.first!)}>{agentNotice.first}</button>}<button className="tb" aria-label={t("sheet.dismiss")} onClick={() => setAgentNotice(null)}><Icon name="x" /></button></div>}
      {impact && <ImpactBar impact={impact.impact} onClose={() => (setImpact(null), setLit((l) => (l?.mine ? null : l)))} onJump={jumpCell} />}
      {sheet.chart ? (
        <div className="fpn-empty sht-chart"><Icon name="grid" /><span>{t("sheet.chart")}</span><button className="btn" onClick={() => void openExcel()}>{t("sheet.openExcel")}</button></div>
      ) : (
        <div
          ref={scroller}
          className="sht-scroll"
          onScroll={measureView}
        >
          <div
            ref={grid}
            className="sht-canvas"
            tabIndex={0}
            style={{ width: HEAD_W + colLeft[nCols + 1], height: HEAD_H + rowY(nRows + 1), zoom }}
            onMouseDown={(e) => {
              const p = pick(e);
              if (!p) return;
              if (editing) commit(editing.text);
              // A right-click (⌃-click on a Mac) keeps a selection it lands in, as Excel does, and drags nothing; the menu comes on contextmenu.
              if (isRight(e)) {
                if (!inAreas(areas, p.r, p.c)) go(p, false);
                grid.current?.focus();
                return;
              }
              if (e.button !== 0) return;
              if (isAdd(e)) {
                setSel({ anchor: p, focus: p, extra: [...(sel.extra ?? []), selected] });
                setLit((l) => (l?.mine ? null : l));
              } else {
                go(p, e.shiftKey);
              }
              grid.current?.focus();
              const move = (ev: MouseEvent) => {
                const q = pick(ev as unknown as React.MouseEvent);
                if (q) setSel((s) => ({ anchor: s.anchor, focus: q, ...(s.extra?.length ? { extra: s.extra } : {}) }));
              };
              const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
            }}
            onDoubleClick={() => editable && setEditing({ text: editText, inBar: false })}
            onContextMenu={(e) => {
              e.preventDefault();
              const p = pick(e);
              if (!p) return;
              if (editing) commit(editing.text);
              // A click outside the selection selects that cell first, as in Excel.
              if (!inAreas(areas, p.r, p.c)) setSel({ anchor: p, focus: p });
              grid.current?.focus();
              setMenuAt({ x: e.clientX, y: e.clientY });
            }}
          >
            <div className="sht-layer s">{pane("s")}</div>
            {frozen.cols > 0 && <div className="sht-layer c"><div className="sht-pane" style={{ left: HEAD_W, top: HEAD_H, width: frozenW, height: rowY(nRows + 1) }} />{pane("c")}</div>}
            {frozen.rows > 0 && <div className="sht-layer r"><div className="sht-pane" style={{ left: HEAD_W, top: HEAD_H, width: colLeft[nCols + 1], height: frozenH }} />{pane("r")}</div>}
            {frozen.rows > 0 && frozen.cols > 0 && <div className="sht-layer x"><div className="sht-pane" style={{ left: HEAD_W, top: HEAD_H, width: frozenW, height: frozenH }} />{pane("x")}</div>}
            {(frozen.rows > 0 || frozen.cols > 0) && (
              <div className="sht-layer line">
                {frozen.rows > 0 && <div className={`sht-freeze row ${view.top > 0 ? "lifted" : ""}`} style={{ left: HEAD_W, top: HEAD_H + frozenH - 1, width: Math.max(0, view.w - HEAD_W) }} />}
                {frozen.cols > 0 && <div className={`sht-freeze col ${view.left > 0 ? "lifted" : ""}`} style={{ left: HEAD_W + frozenW - 1, top: HEAD_H, height: Math.max(0, view.h - HEAD_H) }} />}
              </div>
            )}
            {arrows.length > 0 && (
              <svg className="sht-arrows" style={{ width: HEAD_W + colLeft[nCols + 1], height: HEAD_H + rowY(nRows + 1) }} aria-hidden="true">
                <defs><marker id="sht-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" /></marker></defs>
                {arrows}
              </svg>
            )}
            <div className="sht-layer hc">{heads.hc}</div>
            <div className="sht-layer hr">{heads.hr}</div>
            <div className="sht-layer hx">
              <div className="sht-corner" style={{ left: 0, top: 0, width: HEAD_W, height: HEAD_H }} onMouseDown={(e) => {
              e.stopPropagation();
              setSel({ anchor: { r: 1, c: 1 }, focus: { r: Math.max(used.r2, 1), c: Math.max(used.c2, 1) } });
              grid.current?.focus();
            }} />
              {heads.hx}
            </div>
            {filling && (() => {
              const to = filling.to;
              const box = place(to.r1, to.c1, colLeft[to.c2 + 1] - colLeft[to.c1], rowY(to.r2 + 1) - rowY(to.r1));
              const at = onCanvas(to.r1, to.c1, box);
              return (
                <>
                  {filling.tip && <div className="sht-fill-tip" style={{ left: Math.min(at.left + box.width + 6 / zoom, view.left + view.w - 80 / zoom), top: Math.min(at.top + box.height + 6 / zoom, view.top + view.h - 30 / zoom), transform: `scale(${1 / zoom})`, transformOrigin: "top left" }}>{filling.tip}</div>}
                </>
              );
            })()}
            {!editing && !filling && selectionFilled && (
              <div className="sht-selection-tools" onMouseDown={(e) => e.stopPropagation()} style={{
                left: Math.max(view.left + HEAD_W, Math.min(selAt.left + (selBox.width as number) + 8 / zoom, view.left + view.w - 96 / zoom)),
                top: Math.max(view.top + HEAD_H, Math.min(selAt.top + (selBox.height as number) + 8 / zoom, view.top + view.h - 40 / zoom)),
                transform: `scale(${1 / zoom})`, transformOrigin: "top left" }}>
                <button onClick={(e) => { e.stopPropagation(); void quoteSelection(); }}><Icon name="chat" />{t("sheet.askAgent")}</button>
              </div>
            )}
          </div>
        </div>
      )}
      {note && (
        <div className={`fpn-note ${note.kind === "conflict" ? "warn" : ""}`} role="alert">
          <Icon name={note.kind === "conflict" ? "warn" : "lock"} />
          <span>{note.kind === "refused" ? t("sheet.refused", { reason: note.text }) : note.text}</span>
          {note.kind === "conflict" ? (
            <button className="btn sm" onClick={() => void save(true)}>{t("sheet.overwrite")}</button>
          ) : (
            <button className="btn sm" onClick={() => void openExcel()}>{t("sheet.openExcel")}</button>
          )}
          <button className="btn sm" onClick={() => setNote(null)}>{t("sheet.dismiss")}</button>
        </div>
      )}
      {menuAt && <CellMenu at={menuAt} items={menuItems} onClose={closeMenu} />}
      {filter?.sheet === sheetName && (
        <div className="fpn-note" role="status"><Icon name="search" /><span>{t("sheet.filterOn", { col: colName(filter.col), value: filter.value || t("sheet.blank") })}</span><button className="btn sm" onClick={() => setFilter(null)}>{t("sheet.filterClear")}</button></div>
      )}
      <div className="sht-tabs">
        <div className="sht-tablist" role="tablist">
        {sheets.map((s) => (
          <button key={s.name} role="tab" aria-selected={s.name === sheetName} className={`sht-tab ${s.name === sheetName ? "on" : ""}`} onClick={() => {
            setSheetName(s.name);
            setSel({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
            setLit(null);
          }}>
            {s.chart && <Icon name="grid" />}
            {s.name}
          </button>
        ))}
        </div>
        {stats && (
          <div className="sht-stats" role="status" aria-label={t("sheet.stats")}>
            {stats.numbers > 0 && !stats.error && <Stat className="avg" label={t("sheet.average")} value={statText(stats.average!, i18n.language)} copy={String(stats.average)} />}
            <Stat label={t("sheet.count")} value={String(stats.count)} copy={String(stats.count)} />
            {stats.numbers > 0 && !stats.error && <Stat label={t("sheet.sum")} value={statText(stats.sum, i18n.language)} copy={String(stats.sum)} />}
          </div>
        )}
        <div className="sht-zoom">
          <button className="tb" aria-label={t("sheet.zoomOut")} onClick={() => setZoomTo(zoom / 1.1)}><Icon name="minus" /></button>
          <button className="sht-zoom-n" title={t("sheet.zoomReset")} onClick={() => setZoomTo(1)}>{Math.round(zoom * 100)}%</button>
          <button className="tb" aria-label={t("sheet.zoomIn")} onClick={() => setZoomTo(zoom * 1.1)}><Icon name="plus" /></button>
        </div>
      </div>
    </div>
  );
}

/** Above this many cells in use the status bar leaves the selection's figures out, as reading them all would lag. */
const STATS_MAX_CELLS = 500_000;

/** A status-bar figure; a click copies its full value, as in Excel. */
function Stat({ label, value, copy, className = "" }: { label: string; value: string; copy: string; className?: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  return (
    <button className={`sht-stat ${className}`} title={t("sheet.copyStat")} onClick={() => void navigator.clipboard.writeText(copy).then(() => st.show(t("sheet.copied")))}>
      {label}: <b>{value}</b>
    </button>
  );
}

/** A toolbar button with its name beside the icon, as Excel's ribbon has them; a narrow panel keeps the icon. */
function Tool({ icon, label, tip, on, onClick }: { icon: IconName; label: string; tip?: string; on?: boolean; onClick: () => void }) {
  return (
    <button className={`tb sht-btn ${on ? "on" : ""}`} title={tip ?? label} aria-label={label} aria-pressed={on} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}
