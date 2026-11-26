import assert from "node:assert/strict";
import { test } from "node:test";
import { areaCellCount, colSelected, copyGrid, editTextOf, expandSpans, inAreas, inSpans, inputOp, isDisjoint, isHardcoded, lensAt, lensText, mergeSpans, parseTsv, pasteOps, rangesText, readable, rowSelected, selectedAreas, selectionStats, sizeKey, sizesOf, spanCount, statText, toggleLine, toMarkdown, toMarkdownGrid, toTsv, toTsvGrid, wholeCols, wholeRows, withLens, type Lens, type Sel } from "./model.ts";

test("what is typed reads as Excel reads it", () => {
  const v = (raw: string) => inputOp("S", "A1", raw);
  assert.deepEqual(v(""), { op: "clear", sheet: "S", range: "A1" });
  assert.deepEqual(v("  "), { op: "clear", sheet: "S", range: "A1" });
  assert.deepEqual(v("=SUM(B1:B3)"), { op: "set_formula", sheet: "S", cell: "A1", formula: "=SUM(B1:B3)" });
  assert.deepEqual(v("="), { op: "set_value", sheet: "S", cell: "A1", value: "=" });
  assert.deepEqual(v("'0012"), { op: "set_value", sheet: "S", cell: "A1", value: "0012" });
  assert.deepEqual(v("1,234.5"), { op: "set_value", sheet: "S", cell: "A1", value: 1234.5 });
  assert.deepEqual(v("12%"), { op: "set_value", sheet: "S", cell: "A1", value: 0.12 });
  assert.deepEqual(v("-1e3"), { op: "set_value", sheet: "S", cell: "A1", value: -1000 });
  assert.deepEqual(v("true"), { op: "set_value", sheet: "S", cell: "A1", value: true });
  for (const text of ["1,2", "-", "12 apples", "1.2.3"]) assert.deepEqual(v(text), { op: "set_value", sheet: "S", cell: "A1", value: text }, text);
});

test("editing starts from the formula, then the value, then the text", () => {
  assert.equal(editTextOf({ cell: "A1", text: "3", formula: "=1+2", value: { type: "number", value: 3 }, look: {} } as never), "=1+2");
  assert.equal(editTextOf({ cell: "A1", text: "12%", value: { type: "number", value: 0.12 }, look: {} } as never), "0.12");
  assert.equal(editTextOf({ cell: "A1", text: "#DIV/0!", value: { type: "error", value: "#DIV/0!" }, look: {} } as never), "#DIV/0!");
  assert.equal(editTextOf(undefined), "");
});

test("dark text is lightened only on a dark background", () => {
  assert.equal(readable("000000", false), "#000000");
  assert.equal(readable("000000", true), "rgb(140,140,140)");
  assert.equal(readable("FFFF00", true), "#FFFF00");
  assert.equal(readable(null, true), undefined);
});

test("a selection copies as TSV and quotes as a Markdown table", () => {
  const cells = new Map([["A1", "a"], ["B1", "x|y"], ["A2", "two\nlines"]]);
  const area = { r1: 1, c1: 1, r2: 2, c2: 2 };
  assert.equal(toTsv(area, (c) => cells.get(c)), "a\tx|y\ntwo\nlines\t");
  assert.equal(toMarkdown(area, (c) => cells.get(c)), "| | A | B |\n|---|---|---|\n| 1 | a | x\\|y |\n| 2 | two lines |  |");
});

test("dragged sizes are kept by sheet", () => {
  const m = new Map([[sizeKey("S", 3), 80], [sizeKey("T", 3), 40], [sizeKey("S", 7), 20]]);
  assert.deepEqual([...sizesOf(m, "S")], [[3, 80], [7, 20]]);
});

test("the status bar counts what Excel counts", () => {
  const n = (cell: string, value: number) => ({ cell, text: String(value), value: { type: "number", value } }) as never;
  const area = { r1: 1, c1: 1, r2: 5, c2: 1 };
  const cells = [n("A1", 22.5), n("A2", 72), { cell: "A3", text: "label", value: { type: "text", value: "label" } } as never, { cell: "A4", text: "TRUE", value: { type: "bool", value: true } } as never];
  assert.deepEqual(selectionStats(cells, area), { count: 4, numbers: 2, sum: 94.5, average: 47.25, error: false });
  // Text only: a count, no sum.
  assert.deepEqual(selectionStats([cells[2]], area), { count: 1, numbers: 0, sum: 0, average: null, error: false });
  // An error value: the sum is not told.
  assert.equal(selectionStats([...cells, { cell: "A5", text: "#REF!", value: { type: "error", value: "#REF!" } } as never], area)!.error, true);
  // One cell, or nothing in the selection: no figures.
  assert.equal(selectionStats([n("A1", 1)], { r1: 1, c1: 1, r2: 1, c2: 1 }), null);
  assert.equal(selectionStats([], area), null);
});

test("status figures read without float noise", () => {
  assert.equal(statText(0.1 + 0.2, "en"), "0.3");
  assert.equal(statText(1234567.891, "en"), "1,234,567.89");
  assert.equal(statText(1122.6666666667, "en"), "1,122.67");
  assert.equal(statText(22.222222222, "en"), "22.2222");
  assert.equal(statText(0.085, "en"), "0.085");
});

test("a paste reads as Excel writes the clipboard", () => {
  assert.deepEqual(parseTsv("a\tb\n1\t2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseTsv("a\r\nb"), [["a"], ["b"]]);
  assert.deepEqual(parseTsv('"x\ty"\t"say ""hi"""\n"two\nlines"'), [["x\ty", 'say "hi"'], ["two\nlines"]]);
  assert.deepEqual(parseTsv('5" disk\t1'), [['5" disk', "1"]]);
  assert.deepEqual(parseTsv("a\t\tc"), [["a", "", "c"]]);
  const ops = pasteOps("S", { r: 2, c: 2 }, [["1,234", "=B1"], ["", "x"]]);
  assert.deepEqual(ops, [
    { op: "set_value", sheet: "S", cell: "B2", value: 1234 },
    { op: "set_formula", sheet: "S", cell: "C2", formula: "=B1" },
    { op: "clear", sheet: "S", range: "B3" },
    { op: "set_value", sheet: "S", cell: "C3", value: "x" },
  ]);
  assert.equal(pasteOps("S", { r: 1, c: 1 }, []), null);
});

test("a lens shows amounts in a unit and leaves the rest as the file shows it", () => {
  const n = (text: string, value: number, formula?: string) => ({ cell: "A1", text, value: { type: "number", value }, formula }) as never;
  const wan: Lens = { area: { r1: 1, c1: 1, r2: 9, c2: 1 }, unit: 1e4, decimals: 2 };
  assert.equal(lensText(n("1,234,567.89", 1234567.89), wan, "en"), "123.46");
  assert.equal(lensText(n("(12,000)", -12000), wan, "en"), "(1.20)");
  assert.equal(lensText(n("-12000", -12000), wan, "en"), "-1.20");
  // Percentages, dates and scientific notation stay.
  for (const text of ["8.5%", "2024/1/1", "1.2E+06", "12:30"]) assert.equal(lensText(n(text, 1), wan, "en"), null, text);
  // Text stays; the file's own decimals when the lens keeps them.
  assert.equal(lensText({ cell: "A1", text: "x", value: { type: "text", value: "x" } } as never, wan, "en"), null);
  assert.equal(lensText(n("1,344.00", 1344), { ...wan, unit: 1e3, decimals: null }, "en"), "1.34");
  assert.equal(lensText(n("1,344.00", 1344), { ...wan, unit: 1, decimals: 0 }, "en"), "1,344");
  // The last lens over a cell wins; one wholly under a new one goes.
  const a = withLens([], { r1: 1, c1: 1, r2: 9, c2: 3 }, { unit: 1e4 });
  const b = withLens(a, { r1: 2, c1: 2, r2: 2, c2: 2 }, { decimals: (d) => (d ?? 2) + 1 });
  assert.equal(lensAt(b, 2, 2)!.decimals, 3);
  assert.equal(lensAt(b, 2, 2)!.unit, 1e4);
  assert.equal(lensAt(b, 3, 3)!.decimals, null);
  assert.deepEqual(withLens(b, { r1: 1, c1: 1, r2: 9, c2: 3 }, { unit: 1, decimals: () => null }), []);
});

test("a number typed among formulas is marked", () => {
  const grid: Record<string, unknown> = {
    "1:1": { formula: "=X", value: { type: "number", value: 1 } },
    "1:2": { value: { type: "number", value: 2 } },
    "1:3": { formula: "=Y", value: { type: "number", value: 3 } },
    "2:2": { value: { type: "number", value: 4 } },
  };
  const at = (r: number, c: number) => grid[`${r}:${c}`] as never;
  assert.equal(isHardcoded(at, 1, 2), true);
  assert.equal(isHardcoded(at, 1, 1), false);
  assert.equal(isHardcoded(at, 2, 2), false);
});

test("multi-area selection helpers merge spans, identify whole lines, and count unique cells", () => {
  const sel: Sel = {
    extra: [{ r1: 1, c1: 1, r2: 10, c2: 1 }, { r1: 1, c1: 3, r2: 10, c2: 4 }],
    anchor: { r: 1, c: 4 },
    focus: { r: 10, c: 5 },
  };
  const areas = selectedAreas(sel);
  assert.equal(isDisjoint(sel), true);
  assert.equal(rangesText(areas), "A1:A10,C1:D10,D1:E10");
  assert.equal(colSelected(areas, 1), true);
  assert.equal(colSelected(areas, 2), false);
  assert.equal(colSelected(areas, 5), true);
  assert.equal(rowSelected(areas, 5), true);
  assert.equal(inAreas(areas, 3, 2), false);
  assert.equal(inAreas(areas, 3, 4), true);

  const cols = mergeSpans(areas, "cols");
  assert.deepEqual(cols, [[1, 1], [3, 5]]);
  assert.equal(spanCount(cols), 4);
  assert.deepEqual(expandSpans(cols), [1, 3, 4, 5]);
  assert.equal(inSpans(cols, 4), true);
  assert.equal(inSpans(cols, 2), false);

  assert.deepEqual(wholeCols(areas, 10), [[1, 1], [3, 5]]);
  assert.deepEqual(wholeCols(areas, 12), []);
  assert.deepEqual(wholeRows([{ r1: 2, c1: 1, r2: 2, c2: 4 }, { r1: 5, c1: 1, r2: 6, c2: 4 }], 4), [[2, 2], [5, 6]]);

  // Overlapping column D is counted once: 4 unique columns × 10 rows = 40.
  assert.equal(areaCellCount(areas), 40);
  // Two disjoint single cells count as 2.
  assert.equal(areaCellCount([{ r1: 1, c1: 1, r2: 1, c2: 1 }, { r1: 1, c1: 3, r2: 1, c2: 3 }]), 2);
});

test("⌘/Ctrl toggling removes a selected column or row and splits contiguous ranges without ever emptying", () => {
  // Single column cannot be toggled off.
  const one: Sel = { anchor: { r: 1, c: 1 }, focus: { r: 10, c: 1 } };
  assert.deepEqual(toggleLine(one, "cols", 1, 10), one);

  // Removing the middle of A..C splits into A and C.
  const three: Sel = { anchor: { r: 1, c: 1 }, focus: { r: 10, c: 3 } };
  const split = toggleLine(three, "cols", 2, 10);
  assert.deepEqual(selectedAreas(split), [
    { r1: 1, c1: 1, r2: 10, c2: 1 },
    { r1: 1, c1: 3, r2: 10, c2: 3 },
  ]);

  // Removing C leaves only A (no extra).
  const back = toggleLine(split, "cols", 3, 10);
  assert.equal(isDisjoint(back), false);
  assert.deepEqual(selectedAreas(back), [{ r1: 1, c1: 1, r2: 10, c2: 1 }]);

  // Symmetric row toggling.
  const rows: Sel = { extra: [{ r1: 2, c1: 1, r2: 2, c2: 5 }], anchor: { r: 4, c: 1 }, focus: { r: 5, c: 5 } };
  assert.deepEqual(selectedAreas(toggleLine(rows, "rows", 4, 5)), [
    { r1: 2, c1: 1, r2: 2, c2: 5 },
    { r1: 5, c1: 1, r2: 5, c2: 5 },
  ]);
});

test("multi-area copy follows Excel's R × C alignment rule and deduplicates overlapping areas", () => {
  const cells = new Map([
    ["A1", "t"], ["B1", "skip"], ["C1", "api"],
    ["A2", "00:00"], ["B2", "9"], ["C2", "0"],
    ["A3", "01:00"], ["B3", "8"], ["C3", "1"],
  ]);
  // Disjoint whole columns A and C align on rows 1..3.
  const colGrid = copyGrid([{ r1: 1, c1: 3, r2: 3, c2: 3 }, { r1: 1, c1: 1, r2: 3, c2: 1 }]);
  assert.deepEqual(colGrid, { rowSpans: [[1, 3]], colSpans: [[1, 1], [3, 3]] });
  assert.equal(toTsvGrid(colGrid!.rowSpans, colGrid!.colSpans, (c) => cells.get(c)), "t\tapi\n00:00\t0\n01:00\t1");
  assert.equal(
    toMarkdownGrid(colGrid!.rowSpans, colGrid!.colSpans, (c) => cells.get(c)),
    "| | A | C |\n|---|---|---|\n| 1 | t | api |\n| 2 | 00:00 | 0 |\n| 3 | 01:00 | 1 |",
  );

  // Disjoint rows 1 and 3 align on columns A..C.
  const rowGrid = copyGrid([{ r1: 1, c1: 1, r2: 1, c2: 3 }, { r1: 3, c1: 1, r2: 3, c2: 3 }]);
  assert.deepEqual(rowGrid, { rowSpans: [[1, 1], [3, 3]], colSpans: [[1, 3]] });

  // Symmetric four-corner grid (A1, C1, A3, C3) aligns.
  const corners = copyGrid([
    { r1: 1, c1: 1, r2: 1, c2: 1 },
    { r1: 1, c1: 3, r2: 1, c2: 3 },
    { r1: 3, c1: 1, r2: 3, c2: 1 },
    { r1: 3, c1: 3, r2: 3, c2: 3 },
  ]);
  assert.deepEqual(corners, { rowSpans: [[1, 1], [3, 3]], colSpans: [[1, 1], [3, 3]] });

  // Misaligned areas (A1:A2 and C2:C3) are refused, as in Excel.
  assert.equal(copyGrid([{ r1: 1, c1: 1, r2: 2, c2: 1 }, { r1: 2, c1: 3, r2: 3, c2: 3 }]), null);
});

test("status bar figures aggregate across disjoint areas and deduplicate overlaps", () => {
  const n = (cell: string, value: number) => ({ cell, text: String(value), value: { type: "number", value } }) as never;
  const areas = [{ r1: 1, c1: 1, r2: 2, c2: 1 }, { r1: 1, c1: 3, r2: 2, c2: 3 }];
  assert.deepEqual(selectionStats([n("A1", 10), n("C1", 20), n("C1", 20), n("C2", 30)], areas), {
    count: 3,
    numbers: 3,
    sum: 60,
    average: 20,
    error: false,
  });
  // Two disjoint single cells produce figures (unlike one single cell).
  assert.deepEqual(
    selectionStats([n("A1", 4), n("C1", 6)], [{ r1: 1, c1: 1, r2: 1, c2: 1 }, { r1: 1, c1: 3, r2: 1, c2: 3 }]),
    { count: 2, numbers: 2, sum: 10, average: 5, error: false },
  );
});
