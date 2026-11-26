#!/usr/bin/env node
// The file panel (docs/desktop/file-panel-design.md), in the real app: a reply's files open
// beside the conversation at their lines; text is edited and saved on its own or with ⌘S;
// changes from elsewhere are taken, or (with edits not saved) offered as a choice; Markdown
// shows rendered, images show, GBK text is read-only, other files say why they are not
// shown; the tree opens folders; the panel takes the browser's place and gives it back.
//
// A project folder with such files, and a model server on this Mac that reads one file and
// then answers with links to them. The files on disk are checked after each save. What would
// open outside the app is written down instead (FINXWORK_E2E_OPENED), and native menus are
// answered from a file (FINXWORK_E2E_MENU).
//
//   node apps/desktop/e2e/file-panel.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/file-panel.mjs   also screenshots
//   FINXWORK_E2E_APP=dist/FinxWork.app node apps/desktop/e2e/file-panel.mjs   the packaged app
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const packaged = process.env.FINXWORK_E2E_APP ? path.resolve(process.env.FINXWORK_E2E_APP) : null;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxf-")));
const home = path.join(work, "finx");
// A private HOME: the app registers the extension's host in the browsers under it.
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
const opened = path.join(work, "opened.jsonl");
const menus = path.join(work, "menus");
fs.mkdirSync(menus, { recursive: true });

// ── the project ──
const proj = path.join(work, "proj");
const put = (rel, body) => {
  const p = path.join(proj, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const appLines = Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
put("src/app.ts", appLines.join("\n") + "\n");
put("docs/notes.md", "# 标题\n\n正文，见 [入口](../src/app.ts)。\n");
put("crlf.txt", "first\r\nsecond\r\n");
// "报告,1" in GBK.
put("data/gbk.txt", Buffer.from([0xb1, 0xa8, 0xb8, 0xe6, 0x2c, 0x31, 0x0a]));
put("data/values.csv", "名称,金额\r\n收入,100\r\n");
fs.copyFileSync(path.join(root, "crates/finx-sheet/tests/fixtures/legacy.xls"), path.join(proj, "legacy.xls"));
put("bin/blob.bin", Buffer.from([0, 1, 2, 3, 0, 5]));
// Not a zip: the workbook will not open, and the error names its long path.
put("bin/a_workbook_with_a_rather_long_name_that_will_not_open.xlsx", "not a workbook");
put("assets/logo.png", Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c636000020000050001e9fadcd80000000049454e44ae426082", "hex"));
fs.copyFileSync(path.join(root, "crates/finx-sheet/tests/fixtures/gen/dcf_model.xlsx"), path.join(proj, "model.xlsx"));
const disk = (rel) => fs.readFileSync(path.join(proj, rel), "utf8");

// ── the model: reads a file, then answers with links ──
const reply = [
  "改好了：[入口](src/app.ts:3)，说明在 [说明](docs/notes.md)。",
  "",
  "其他：`crlf.txt`、[图](assets/logo.png)、[数据](data/gbk.txt)、[二进制](bin/blob.bin)、[模型](model.xlsx)、[CSV](data/values.csv)、[旧表](legacy.xls)、[坏表](bin/a_workbook_with_a_rather_long_name_that_will_not_open.xlsx)、`src/`。",
].join("\n");
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const messages = JSON.parse(body).messages;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!messages.some((m) => m.role === "tool")) {
      const call = { index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/app.ts", offset: 5, limit: 2 }) } };
      return res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
    }
    res.end(sse({ role: "assistant", content: reply }, "stop"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

function finxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(1, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) send(2, method, params);
        if (msg.id === 2) {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
    // A kernel told to shut down may go before it answers.
    s.on("close", () => reject(new Error("the kernel closed the connection")));
  });
}

// ── the app, driven over the DevTools protocol ──
let app = null;
let port = 0;
async function launch() {
  port = cdpPort();
  const program = packaged ? path.join(packaged, "Contents/MacOS/FinxWork") : electron;
  app = spawn(program, [...(packaged ? [] : [desktop]), `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, ...(!packaged && { FINXWORK_FINX: finx }), FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_OPENED: opened, FINXWORK_E2E_MENU: menus },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(120);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 860, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, close: page.close };
}

async function devtools(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const waiting = new Map();
  let next = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  return { call, close: () => ws.close() };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
  // The launcher is gone; the app it started may not be.
  try {
    execFileSync("pkill", ["-f", `remote-debugging-port=${port}`]);
  } catch {}
}


const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const pick = (id) => fs.writeFileSync(path.join(menus, "pick"), id);
async function until(what, test, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const strings = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8"))]));
const either = (pick) => JSON.stringify(Object.values(strings).map(pick));

const chip = (name) => `[...document.querySelectorAll(".am .fref")].find((c) => c.querySelector(".fref-n").textContent === ${JSON.stringify(name)})`;
const editorText = `(document.querySelector(".fpn .cm-content")?.innerText ?? "")`;
/** A result opens over the window (content-actions-design DD-161); its button takes it to the panel, which is what these steps are about. */
const toPanel = async (page, name) => {
  await page.run(`${chip(name)}.click()`);
  await page.until(`${name} over the window`, `!!document.querySelector(".fpv-panel")`);
  await page.run(`document.querySelector(".fpv-panel").click()`);
  await page.until(`${name} out of the preview`, `!document.querySelector(".fpv")`);
};
const activeTab = `(document.querySelector(".fpn-tab.on .brp-tab-t")?.textContent ?? null)`;
const status = `(document.querySelector(".fpn-state")?.textContent ?? "")`;
const note = `(document.querySelector(".fpn-note")?.className ?? "")`;

let failed = false;
let activePage = null;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD && !packaged) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  activePage = page;
  await page.cdp("Page.bringToFront");
  // A common window: the panel has room for the tree beside the code (narrower, the tree starts closed).
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false });
  const key = async (k, code, vk, modifiers = 0) => {
    const ev = { key: k, code, windowsVirtualKeyCode: vk, modifiers };
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  };
  const META = 4;
  /** Puts the cursor at the end of the open file and types. */
  const typeAtEnd = async (text) => {
    await page.run(`document.querySelector(".fpn .cm-content").focus()`);
    await key("ArrowDown", "ArrowDown", 40, META);
    await page.cdp("Input.insertText", { text });
  };
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  await page.run(`localStorage.setItem("main-view", JSON.stringify({ ...JSON.parse(localStorage.getItem("main-view") ?? "{}"), draft: { cwd: ${JSON.stringify(proj)}, model: null, thinking: null, permission: "manual" } }))`);
  await page.run(`location.reload()`);
  await page.until("the new session page again", `!!document.querySelector(".cmp-in")`);

  step("a task reads a file and answers with links to files");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "看看项目" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the reply", `document.querySelectorAll(".am .fref").length >= 5`, 30000);
  await page.until("the task ended", `!document.querySelector(".working")`, 20000);

  step("a file tag opens the file in the panel, at its line, the tree closed; opened, it shows where the file is");
  await page.run(`${chip("入口")}.click()`);
  await page.until("the panel with app.ts", `${activeTab} === "app.ts" && (${editorText}).includes("line12")`);
  const target = await page.until("the marked line", `document.querySelector(".fpn .cm-line.cm-target")?.textContent ?? null`);
  check(target === appLines[2], `the marked line is ${JSON.stringify(target)}`);
  check(!(await page.run(`!!document.querySelector(".fpt")`)), "the tree opened with a file from the conversation");
  await page.run(`[...document.querySelectorAll(".fpn button")].find((b) => ${either((s) => s.files.toggleTree)}.includes(b.getAttribute("aria-label"))).click()`);
  await page.until("the tree, src open with app.ts marked", `document.querySelector(".fpt-row.on .fpt-name")?.textContent === "app.ts"`);
  const tree = await page.run(`[...document.querySelectorAll(".fpt-row .fpt-name")].map((n) => n.textContent)`);
  check(JSON.stringify(tree.slice(0, 4)) === JSON.stringify(["assets", "bin", "data", "docs"]) && tree.includes("crlf.txt") && tree.includes("app.ts"), `the tree: ${JSON.stringify(tree)}`);
  check(!(await page.run(`!!document.querySelector(".insp")`)), "the info card is still over the conversation");
  const sides = await page.run(`(() => { const f = document.querySelector(".fpn-main").getBoundingClientRect(), t = document.querySelector(".fpt").getBoundingClientRect(); return { file: f.left, tree: t.left, treeEnd: t.right, panelEnd: document.querySelector(".fpn").getBoundingClientRect().right }; })()`);
  check(sides.file < sides.tree && Math.abs(sides.treeEnd - sides.panelEnd) < 2, `the file is not on the left with the tree on the right: ${JSON.stringify(sides)}`);
  await page.shot("1-opened");

  step("an Excel workbook shows as a grid, edits a cell, saves, and quotes the selection");
  await toPanel(page, "模型");
  await page.until("the workbook grid", `${activeTab} === "model.xlsx" && !!document.querySelector(".dcp-viewer:not([hidden]) .sht-canvas") && [...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-tab")].some((x) => x.textContent.includes("假设"))`);
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-name").select()`);
  await page.cdp("Input.insertText", { text: "B6" });
  await key("Enter", "Enter", 13);
  await page.until("WACC selected", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="B6"]')?.textContent === "8.5%"`).catch(async (e) => {
    fail(`${e.message}: address ${await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-name")?.value`)}, B6 ${JSON.stringify(await page.run(`document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="B6"]')?.textContent ?? null`))}, cells ${JSON.stringify(await page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-c[data-cell]")].slice(0,8).map((x) => [x.dataset.cell,x.textContent])`))}, note ${JSON.stringify(await page.run(`document.querySelector(".fpn-note")?.textContent ?? null`))}`);
  });
  await page.run(`(() => { const x = document.querySelector(".dcp-viewer:not([hidden]) .sht-formula"); x.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(x, "9%"); x.dispatchEvent(new Event("input", { bubbles: true })); x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await page.until("WACC changed", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="B6"]')?.textContent === "9.0%" && !!document.querySelector(".fpn-tab.on.dirty")`, 10000);
  await page.until("ask agent offered for a cell with a value", `!!document.querySelector(".dcp-viewer:not([hidden]) .sht-selection-tools button")`);
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-selection-tools button").click()`);
  await page.until("the cell quote in the composer", `!!document.querySelector(".tile.quote")`);
  // ⌘S saves the workbook in view even with the focus in the composer.
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await key("s", "KeyS", 83, META);
  await page.until("the workbook saved", `!document.querySelector(".fpn-tab.on.dirty")`, 10000).catch(async (e) => {
    fail(`${e.message}: note ${JSON.stringify(await page.run(`document.querySelector(".fpn-note")?.textContent ?? null`))}, toast ${JSON.stringify(await page.run(`document.querySelector(".toast")?.textContent ?? null`))}, save disabled ${await page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-tools .tb")].find((b) => ${either((s) => s.sheet.save)}.includes(b.getAttribute("aria-label")))?.disabled`)}`);
  });
  step("selection tools keep their size while zooming");
  await page.until("selection tools", `!!document.querySelector(".dcp-viewer:not([hidden]) .sht-selection-tools")`);
  const toolsWidth = await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-selection-tools").getBoundingClientRect().width`);
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-zoom button:last-child").click()`);
  await page.until("zoomed in", `document.querySelector(".dcp-viewer:not([hidden]) .sht-zoom-n").textContent !== "100%"`);
  await page.until("selection tools after zoom", `!!document.querySelector(".dcp-viewer:not([hidden]) .sht-selection-tools")`);
  check(await page.run(`Math.abs(document.querySelector(".dcp-viewer:not([hidden]) .sht-selection-tools").getBoundingClientRect().width - ${toolsWidth}) < 1`), "selection tools grew with zoom");
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-zoom-n").click()`);
  step("dragged column widths survive closing and reopening the workbook");
  const oldWidth = await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-h.col").getBoundingClientRect().width`);
  await page.run(`(() => { const g = document.querySelector(".dcp-viewer:not([hidden]) .sht-grip.col"), r = g.getBoundingClientRect(); g.dispatchEvent(new MouseEvent("mousedown", { bubbles:true, clientX:r.x, clientY:r.y+5 })); window.dispatchEvent(new MouseEvent("mousemove", { clientX:r.x+40, clientY:r.y+5 })); window.dispatchEvent(new MouseEvent("mouseup")); })()`);
  await page.until("the resized column", `Math.abs(document.querySelector(".dcp-viewer:not([hidden]) .sht-h.col").getBoundingClientRect().width - ${oldWidth + 40}) < 1`);
  const oldHeight = await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-h.row").getBoundingClientRect().height`);
  await page.run(`(() => { const g = document.querySelector(".dcp-viewer:not([hidden]) .sht-grip.row"), r = g.getBoundingClientRect(); g.dispatchEvent(new MouseEvent("mousedown", { bubbles:true, clientX:r.x+5, clientY:r.y })); window.dispatchEvent(new MouseEvent("mousemove", { clientX:r.x+5, clientY:r.y+12 })); window.dispatchEvent(new MouseEvent("mouseup")); })()`);
  await page.until("the resized row", `Math.abs(document.querySelector(".dcp-viewer:not([hidden]) .sht-h.row").getBoundingClientRect().height - ${oldHeight + 12}) < 1`);
  await page.run(`document.querySelector(".fpn-tab.on .brp-tab-x").click()`);
  await toPanel(page, "模型");
  await page.until("the saved column width", `!!document.querySelector(".dcp-viewer:not([hidden]) .sht-h.col") && Math.abs(document.querySelector(".dcp-viewer:not([hidden]) .sht-h.col").getBoundingClientRect().width - ${oldWidth + 40}) < 1`);
  check(await page.run(`Math.abs(document.querySelector(".dcp-viewer:not([hidden]) .sht-h.row").getBoundingClientRect().height - ${oldHeight + 12}) < 1`), "row height was not restored");
  step("an edit from another session refreshes the grid; switching sheets clears its notice");
  await page.until("the baseline cells after reopening", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="B6"]')?.textContent === "9.0%"`);
  const other = (await finxCall("session/new", { cwd: proj })).result.session_id;
  const remoteDoc = (await finxCall("doc/open", { session_id: other, path: path.join(proj, "model.xlsx") })).result.info.doc_id;
  const remoteEdit = await finxCall("doc/apply", { session_id: other, doc_id: remoteDoc, ops: [{ op: "set_value", sheet: "假设", cell: "B6", value: 0.095 }] });
  check(!remoteEdit.error, `remote edit: ${JSON.stringify(remoteEdit.error)}`);
  await page.until("the remote change", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="B6"]')?.textContent === "9.5%" && !!document.querySelector(".dcp-viewer:not([hidden]) .sht-agent")`);
  await page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-tab")].find((x) => x.textContent === "利润表").click()`);
  await page.until("no stale notice on the other sheet", `!document.querySelector(".dcp-viewer:not([hidden]) .sht-agent")`);
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-canvas").focus()`);
  await key("s", "KeyS", 83, META);
  await page.until("remote change saved", `!document.querySelector(".fpn-tab.on.dirty")`);
  // Saving writes the file, which finx then reports changed: the grid stays on its sheet.
  await new Promise((r) => setTimeout(r, 600));
  check(await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-tab.on")?.textContent`) === "利润表", "saving sent the grid back to its first sheet");
  step("the right-click menu inserts a row above the cell; undo takes them back");
  await page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-tab")].find((x) => x.textContent === "利润表").click()`);
  await page.until("the income statement", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A3"]')?.textContent === "营业收入"`);
  const menuItem = (pick) => `[...document.querySelectorAll(".sht-menu .mi")].find((b) => ${either(pick)}.includes(b.querySelector("span")?.textContent))`;
  await page.run(`(() => { const c = document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A3"]'), r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })); })()`);
  await page.until("the cell menu", `!!document.querySelector(".sht-menu") && !!${menuItem((s) => s.sheet.insert)}`);
  await page.run(`${menuItem((s) => s.sheet.insert)}.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))`);
  await page.until("the insert submenu", `document.querySelectorAll(".sht-menu").length === 2`);
  await page.run(`document.querySelectorAll(".sht-menu")[1].querySelector(".mi").click()`);
  await page.until("a row inserted above A3", `!document.querySelector(".sht-menu") && document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A4"]')?.textContent === "营业收入" && !document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A3"]')?.textContent`, 10000).catch(async (e) => {
    fail(`${e.message}: note ${JSON.stringify(await page.run(`document.querySelector(".fpn-note")?.textContent ?? null`))}, toast ${JSON.stringify(await page.run(`document.querySelector(".toast")?.textContent ?? null`))}`);
  });
  await page.shot("1-menu-inserted");
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-canvas").focus()`);
  await key("z", "KeyZ", 90, META);
  await page.until("the insert undone", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A3"]')?.textContent === "营业收入"`, 10000);
  step("a range draws one border and leaves its active cell untinted");
  await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-name").select()`);
  await page.cdp("Input.insertText", { text: "A2" });
  await key("Enter", "Enter", 13);
  for (const [k, vk] of [["ArrowRight", 39], ["ArrowDown", 40], ["ArrowDown", 40]]) await key(k, k, vk, 8);
  await page.until("the range", `!!document.querySelector(".dcp-viewer:not([hidden]) .sht-sel.multi")`);
  check(await page.run(`!document.querySelector(".dcp-viewer:not([hidden]) .sht-active")`), "a range drew a second box around its active cell");
  check(await page.run(`getComputedStyle(document.querySelector(".dcp-viewer:not([hidden]) .sht-sel.multi"), "::before").clipPath.startsWith("polygon(evenodd")`), "the range tint covers its active cell");
  // The status bar sums the range as Excel's does: six cells, the numbers among them summed.
  const stats = await page.until("the selection figures", `document.querySelector(".dcp-viewer:not([hidden]) .sht-stats")?.textContent ?? null`).catch(async (e) => {
    fail(`${e.message}: bottom ${JSON.stringify(await page.run(`document.querySelector(".dcp-viewer:not([hidden]) .sht-tabs")?.textContent ?? null`))}`);
  });
  check(/6/.test(stats) && /3,368/.test(stats), `the selection figures: ${JSON.stringify(stats)}`);
  await page.shot("1-workbook");
  // Enter and Tab go round inside the range, which stays, as in Excel: A2 → A3 → A4 → B2; ⇧Enter back to A4; Tab across to B4.
  const nameIs = (at) => page.until(`the active cell at ${at}`, `document.querySelector(".dcp-viewer:not([hidden]) .sht-name").value === "${at}" && !!document.querySelector(".dcp-viewer:not([hidden]) .sht-sel.multi")`, 3000);
  for (const at of ["A3", "A4", "B2"]) await key("Enter", "Enter", 13), await nameIs(at);
  await key("Enter", "Enter", 13, 8);
  await nameIs("A4");
  await key("Tab", "Tab", 9);
  await nameIs("B4");

  // The workbook's tools (spreadsheet-design §8.7, §8.8), as one who uses Excel reaches for them.
  const V = ".dcp-viewer:not([hidden])";
  const tool = (pick) => `[...document.querySelectorAll("${V} .sht-tools button")].find((b) => ${either(pick)}.includes(b.getAttribute("aria-label")))`;
  const shownText = (at) => `(document.querySelector('${V} .sht-c[data-cell="${at}"]')?.textContent ?? null)`;
  const goCell = async (at) => {
    await page.run(`document.querySelector("${V} .sht-name").select()`);
    await page.cdp("Input.insertText", { text: at });
    await key("Enter", "Enter", 13);
    await page.until(`${at} selected`, `document.querySelector("${V} .sht-name").value === "${at}"`);
    await page.run(`document.querySelector("${V} .sht-canvas").focus()`);
  };
  step("trace precedents draws arrows to the cell and lists what it reads; again goes a level further");
  await goCell("B4");
  await page.run(`${tool((s) => s.sheet.traceUp)}.click()`);
  await page.until("the trace list", `!!document.querySelector("${V} .sht-trace .sht-trace-row")`);
  check(await page.run(`[...document.querySelectorAll("${V} .sht-trace-at")].some((x) => x.textContent === "B3")`), "B4's precedents leave out B3");
  await page.until("an arrow on the grid", `document.querySelectorAll("${V} .sht-arrows line").length > 0`);
  check(await page.run(`!!document.querySelector('${V} .sht-c[data-cell="B3"].traced')`), "the precedent is not marked");
  await key("[", "BracketLeft", 219, META);
  await page.until("a second level", `/2/.test(document.querySelector("${V} .sht-trace-head b").textContent)`);
  await page.shot("1-trace");
  await key("Escape", "Escape", 27);
  await page.until("arrows removed", `!document.querySelector("${V} .sht-trace") && !document.querySelector("${V} .sht-arrows")`);
  step("show formulas puts the formulas in the cells, and back");
  await page.run(`${tool((s) => s.sheet.showFormulas)}.click()`);
  await page.until("B4 as its formula", `(${shownText("B4")} ?? "").startsWith("=")`);
  await page.run(`${tool((s) => s.sheet.showFormulas)}.click()`);
  await page.until("B4 as its value", `!(${shownText("B4")} ?? "=").startsWith("=")`);
  step("a display unit shows a column in 万, says so, and keeps the file's value in the formula bar");
  await goCell("B3");
  await page.run(`(() => { const x = document.querySelector("${V} .sht-unitsel"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(x, "10000"); x.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.until("B3 in 万", `${shownText("B3")} === "0.13"`);
  check(await page.run(`!!document.querySelector("${V} .sht-h.col .sht-unit") && !!document.querySelector("${V} .sht-raw")`), "the unit is not said on the column and the formula bar");
  const bar = await page.run(`document.querySelector("${V} .sht-formula").value`);
  check(bar === "1344" || bar.startsWith("="), `the formula bar shows ${JSON.stringify(bar)}, not the file's value`);
  check(!(await page.run(`!!document.querySelector(".fpn-tab.on.dirty")`)), "a display unit made the workbook unsaved");
  await page.run(`${tool((s) => s.sheet.decimalsMore)}.click()`);
  await page.until("one more decimal", `${shownText("B3")} === "0.134"`);
  await page.run(`(() => { const x = document.querySelector("${V} .sht-unitsel"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(x, "reset"); x.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.until("B3 as in the file", `${shownText("B3")} === "1,344.00"`);
  step("⌘F finds a cell and goes to it");
  await page.run(`${tool((s) => s.sheet.find)}.click()`);
  await page.until("the find box", `document.activeElement === document.querySelector("${V} .sht-find input")`);
  await page.cdp("Input.insertText", { text: "净利润" });
  await key("Enter", "Enter", 13);
  await page.until("净利润 found", `document.querySelector("${V} .sht-name").value === "A9" && (document.querySelector("${V} .sht-find .dcp-count")?.textContent ?? "").startsWith("1/")`);
  await key("Escape", "Escape", 27);
  await page.until("the find box closed", `!document.querySelector("${V} .sht-find")`);
  step("a paste fills cells from the clipboard; ⌘D fills down; a number typed among formulas is marked");
  await goCell("H2");
  await page.run(`(() => { const d = new DataTransfer(); d.setData("text/plain", "1\\t2\\n3\\t4\\n"); document.querySelector("${V} .sht-canvas").dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); })()`);
  const valuesAt = async (range) => Object.fromEntries((await finxCall("doc/cells", { session_id: other, doc_id: remoteDoc, sheet: "利润表", range })).result.cells.map((c) => [c.cell, c.value?.value]));
  await until("the pasted cells", async () => { const v = await valuesAt("H2:I3"); return v.H2 === 1 && v.I2 === 2 && v.H3 === 3 && v.I3 === 4; }, 5000);
  check(await page.run(`document.querySelector("${V} .sht-name").value`) === "H2" && await page.run(`!!document.querySelector("${V} .sht-sel.multi")`), "the paste is not selected from its top-left");
  await page.run(`document.querySelector("${V} .sht-name").select()`);
  await page.cdp("Input.insertText", { text: "H2" });
  await key("Enter", "Enter", 13);
  await page.run(`document.querySelector("${V} .sht-canvas").focus()`);
  for (let i = 0; i < 3; i++) await key("ArrowDown", "ArrowDown", 40, 8);
  await key("d", "KeyD", 68, META);
  await until("filled down", async () => { const v = await valuesAt("H2:H5"); return v.H4 === 1 && v.H5 === 1; }, 5000);
  step("a right-click in the selection keeps it and opens Excel's cell menu; Clear Contents clears it");
  const rightClick = async (at) => {
    const p = await page.run(`(() => { const r = document.querySelector('${V} .sht-c[data-cell="${at}"]')?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    check(p, `${at} is not drawn: the grid draws only the cells in sight, and a right-click needs one`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "right", buttons: 2, clickCount: 1 });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "right", clickCount: 1 });
  };
  const shownMenus = path.join(menus, "shown.jsonl");
  const menusBefore = lines(shownMenus).length;
  pick("clear");
  await rightClick("H3");
  await until("the cell menu", () => lines(shownMenus).length > menusBefore, 5000);
  const cellMenu = lines(shownMenus).at(-1);
  const ids = cellMenu.filter((x) => x !== "-").map((x) => x.id);
  for (const id of ["cut", "copy", "paste", "clear", "fillDown", "fillRight", "traceUp", "traceDown", "formulas", "quote"]) check(ids.includes(id), `the cell menu has no ${id}: ${JSON.stringify(ids)}`);
  check(cellMenu.find((x) => x.id === "copy")?.accel === "CmdOrCtrl+C", "the cell menu shows no ⌘C");
  await until("H2:H5 cleared", async () => { const v = await valuesAt("H2:H5"); return Object.values(v).every((x) => x === undefined || x === null); }, 5000);
  check((await page.run(`document.querySelector("${V} .sht-name").value`)) === "H2" && (await page.run(`!!document.querySelector("${V} .sht-sel.multi")`)), "the right-click moved off the selection");
  step("a right-click outside the selection selects the cell it lands on");
  await rightClick("H12");
  await page.until("H12 selected", `document.querySelector("${V} .sht-name").value === "H12" && !document.querySelector("${V} .sht-sel.multi")`, 3000);
  // The fill handle: 1…4 dragged down four rows carries on to 8, the tip showing 8 on the way.
  await goCell("J2");
  await page.run(`(() => { const d = new DataTransfer(); d.setData("text/plain", "1\\n2\\n3\\n4\\n"); document.querySelector("${V} .sht-canvas").dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); })()`);
  await until("1…4 pasted", async () => (await valuesAt("J5")).J5 === 4, 5000);
  await page.until("the fill handle", `!!document.querySelector("${V} .sht-fill-handle")`);
  const centre = (sel) => page.run(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  // Measured once going to the cell has stopped scrolling the grid.
  await page.until("the grid at rest", `!document.querySelector("${V} .sht-scroll.scrolling")`, 5000);
  const handle = await centre(`${V} .sht-fill-handle`);
  const j9 = await centre(`${V} .sht-c[data-cell="J9"]`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...handle });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...handle, button: "left", clickCount: 1 });
  for (let i = 1; i <= 4; i++) await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x, y: handle.y + ((j9.y - handle.y) * i) / 4, button: "left", buttons: 1 });
  await page.until("the drag's tip", `/^8(\\.0+)?$/.test(document.querySelector("${V} .sht-fill-tip")?.textContent ?? "")`, 5000);
  check(await page.run(`!!document.querySelector("${V} .sht-fill-to")`), "the drag draws no box");
  await page.shot("1-fill-drag");
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...j9, button: "left", clickCount: 1 });
  await until("filled on to 8", async () => { const v = await valuesAt("J6:J9"); return v.J6 === 5 && v.J9 === 8; }, 5000);
  await page.until("the filled cells selected, 1…8 summed", `/8/.test(document.querySelector("${V} .sht-stats")?.textContent ?? "") && /36/.test(document.querySelector("${V} .sht-stats")?.textContent ?? "")`, 5000);
  await page.until("J9 shown", `/^8(\\.0+)?$/.test(document.querySelector('${V} .sht-c[data-cell="J9"]')?.textContent ?? "")`);
  // As in Excel: the active cell stays where the selection began, and the cells filled carry no box of their own.
  check((await page.run(`document.querySelector("${V} .sht-name").value`)) === "J2", "the active cell moved off J2 with the fill");
  check(await page.run(`["J6", "J7", "J8", "J9"].every((c) => getComputedStyle(document.querySelector('${V} .sht-c[data-cell="' + c + '"]')).boxShadow === "none")`), "the filled cells are boxed on their own");
  await page.shot("1-fill-done");
  await goCell("C4");
  await page.run(`(() => { const x = document.querySelector("${V} .sht-formula"); x.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(x, "5"); x.dispatchEvent(new Event("input", { bubbles: true })); x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await page.until("C4 marked as typed among formulas", `!!document.querySelector('${V} .sht-c[data-cell="C4"].hard')`);
  check(!(await page.run(`!!document.querySelector("${V} .sht-agent")`)), "a person's own edits were taken for the agent's");
  await page.shot("1-tools");
  await page.run(`document.querySelector("${V} .sht-canvas").focus()`);
  await key("ArrowDown", "ArrowDown", 40);
  // An undo selects what it changed back, as Excel's does.
  await key("z", "KeyZ", 90, META);
  await page.until("the undone cell selected", `document.querySelector("${V} .sht-name").value === "C4"`, 5000);
  for (let i = 0; i < 5; i++) await key("z", "KeyZ", 90, META);
  await page.until("the edits undone", `!document.querySelector(".fpn-tab.on.dirty")`, 10000);
  await page.run(`[...document.querySelectorAll(".fpn-tab")].find((x) => x.textContent.includes("app.ts")).click()`);
  await page.until("app.ts back in front", `${activeTab} === "app.ts"`);

  step("typing saves after a pause; ⌘S saves at once");
  await typeAtEnd("// one\n");
  await page.until("unsaved", `${either((s) => s.files.unsaved)}.includes(${status})`, 3000);
  await until("the edit on disk", () => disk("src/app.ts").includes("// one"), 5000);
  await page.until("saved", `${either((s) => s.files.saved)}.includes(${status})`);
  await typeAtEnd("// two\n");
  const pressed = Date.now();
  await key("s", "KeyS", 83, META);
  await until("the ⌘S save on disk", () => disk("src/app.ts").includes("// two"), 3000);
  check(Date.now() - pressed < 900, `⌘S took ${Date.now() - pressed} ms`);

  step("a change from elsewhere comes in when nothing is edited");
  fs.writeFileSync(path.join(proj, "src/app.ts"), appLines.join("\n") + "\n// from elsewhere\n");
  await page.until("the editor shows it", `(${editorText}).includes("// from elsewhere") && !(${editorText}).includes("// two")`, 10000);

  step("with edits not saved, a change from elsewhere is a choice: load the disk's version");
  await typeAtEnd("// mine\n");
  fs.writeFileSync(path.join(proj, "src/app.ts"), appLines.join("\n") + "\n// theirs\n");
  await page.until("the conflict note", `${note}.includes("warn")`, 10000);
  check(disk("src/app.ts").includes("// theirs") && !disk("src/app.ts").includes("// mine"), "an edit overwrote the change from elsewhere");
  await page.shot("2-conflict");
  await page.run(`document.querySelectorAll(".fpn-note .btn")[0].click()`);
  await page.until("the disk's version taken", `!document.querySelector(".fpn-note") && (${editorText}).includes("// theirs") && !(${editorText}).includes("// mine")`);

  step("…or save anyway");
  await typeAtEnd("// keep me\n");
  fs.writeFileSync(path.join(proj, "src/app.ts"), "elsewhere again\n");
  await page.until("the conflict note again", `${note}.includes("warn")`, 10000);
  await page.run(`document.querySelectorAll(".fpn-note .btn")[1].click()`);
  await until("this side's text on disk", () => disk("src/app.ts").includes("// keep me") && !disk("src/app.ts").includes("elsewhere again"), 5000);
  await page.until("no note", `!document.querySelector(".fpn-note")`);

  step("Markdown shows rendered, its source a click away");
  await toPanel(page, "说明");
  await page.until("notes.md rendered", `${activeTab} === "notes.md" && document.querySelector(".fpn-md h1")?.textContent === "标题"`);
  await page.shot("3-markdown");
  await page.run(`document.querySelector('.fpn-tools .tb[aria-pressed]').click()`);
  await page.until("its source in the editor", `(${editorText}).includes("# 标题")`);

  step("\\r\\n line ends stay as they were");
  await page.run(`${chip("crlf.txt")}.click()`);
  await page.until("crlf.txt open", `${activeTab} === "crlf.txt" && (${editorText}).includes("second")`);
  await typeAtEnd("third");
  await key("s", "KeyS", 83, META);
  await until("saved with \\r\\n", () => disk("crlf.txt") === "first\r\nsecond\r\nthird", 4000);

  step("an image shows; GBK text is read-only; a binary file says why and opens elsewhere");
  await toPanel(page, "图");
  await page.until("the image", `!!document.querySelector(".fpn-img img")?.src.startsWith("data:image/png;base64,")`);
  // A pinch (Chromium's control-modified wheel) zooms it; a double click takes it back to fitted.
  const imgWidth = `document.querySelector(".fpn-img img").getBoundingClientRect().width`;
  await page.until("the image laid out", `${imgWidth} > 0`);
  const fitted = await page.run(imgWidth);
  await page.run(`(() => { const r = document.querySelector(".fpn-img img").getBoundingClientRect(); document.querySelector(".fpn-img").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: r.left, clientY: r.top, bubbles: true, cancelable: true })); })()`);
  await page.until("pinched larger", `${imgWidth} > ${fitted} * 2 && document.querySelector(".fpn-img").classList.contains("zoomed")`);
  await page.run(`document.querySelector(".fpn-img").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 1, clientY: 1 }))`);
  await page.until("back to fitted", `Math.abs(${imgWidth} - ${fitted}) < 0.01`);
  await page.run(`${chip("数据")}.click()`);
  await page.until("GBK read-only", `${activeTab} === "gbk.txt" && (${editorText}).includes("报告,1") && ${either((s) => s.files.readOnlyEncoding.replace("{{encoding}}", "GBK"))}.includes(${status})`);
  await typeAtEnd("x");
  await sleep(300);
  check(!(await page.run(`(${editorText}).includes("x")`)), "a read-only file took typing");
  step("CSV opens in the grid, rejects formulas and saves values; XLS stays read-only");
  await toPanel(page, "CSV");
  await page.until("CSV grid", `${activeTab} === "values.csv" && document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A1"]')?.textContent === "名称"`);
  const enterFormula = async (text) => page.run(`(() => { const x = document.querySelector(".dcp-viewer:not([hidden]) .sht-formula"); x.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(x, ${JSON.stringify(text)}); x.dispatchEvent(new Event("input", { bubbles: true })); x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await enterFormula("=1+1");
  await page.until("CSV formula refusal", `${either((s) => s.sheet.csvNoFormula)}.some((s) => document.querySelector(".fpn-note")?.textContent.includes(s))`);
  check(disk("data/values.csv").startsWith("名称,金额"), "CSV formula changed the file");
  await enterFormula("项目");
  await page.until("CSV value edited", `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="A1"]')?.textContent === "项目"`);
  await page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-tools .tb")].find((b) => ${either((s) => s.sheet.save)}.includes(b.getAttribute("aria-label"))).click()`);
  await until("CSV saved", () => disk("data/values.csv") === "项目,金额\r\n收入,100\r\n", 5000);
  // Typed one after another, each Enter before the last edit is back: none is dropped.
  await page.run(`(() => { const x = document.querySelector(".dcp-viewer:not([hidden]) .sht-name"); x.select(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(x, "C1"); x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  for (const [k, code, vk] of [["7", "Digit7", 55], ["8", "Digit8", 56], ["9", "Digit9", 57]]) {
    await key(k, code, vk);
    await key("Enter", "Enter", 13);
  }
  const cellText = (c) => `document.querySelector('.dcp-viewer:not([hidden]) .sht-c[data-cell="${c}"]')?.textContent`;
  await page.until("every quick entry kept", `${cellText("C1")} === "7" && ${cellText("C2")} === "8" && ${cellText("C3")} === "9"`, 10000).catch(async (e) => {
    fail(`${e.message}: C1-C3 ${JSON.stringify(await page.run(`[${cellText("C1")}, ${cellText("C2")}, ${cellText("C3")}]`))}, toast ${JSON.stringify(await page.run(`document.querySelector(".toast")?.textContent ?? null`))}`);
  });
  check(await page.run(`!document.querySelector(".dcp-viewer:not([hidden]) .sht-agent")`), "the grid took its own quick edits for the agent's");
  step("columns multi-select by drag, Shift-click, and ⌘-click; right-click preserves multi-selection for batch delete and resize");
  const colHead = (label) => `[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col")].find((el) => el.textContent === ${JSON.stringify(label)})`;
  const selectedCols = () => page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((el) => el.textContent)`);
  // Drag across A → C selects A, B, C.
  await page.run(`(() => { const a = ${colHead("A")}.getBoundingClientRect(), c = ${colHead("C")}.getBoundingClientRect(); ${colHead("A")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: a.x + a.width / 2, clientY: a.y + a.height / 2 })); window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: c.x + c.width / 2, clientY: c.y + c.height / 2 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
  await page.until("drag-selected columns A..C", `JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A","B","C"]'`);
  // ⌘-clicking B toggles B out of A..C, leaving disjoint A and C.
  await page.run(`(() => { const b = ${colHead("B")}.getBoundingClientRect(); ${colHead("B")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
  await page.until("⌘-toggled disjoint A and C", `JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A","C"]' && !!document.querySelector(".dcp-viewer:not([hidden]) .sht-sel.extra")`);
  // Status bar aggregates across disjoint columns A (2 texts) and C (7, 8, 9 → sum 24, count 5).
  await page.until("disjoint status figures", `/5/.test(document.querySelector(".dcp-viewer:not([hidden]) .sht-stats")?.textContent ?? "") && /24/.test(document.querySelector(".dcp-viewer:not([hidden]) .sht-stats")?.textContent ?? "")`, 5000);
  // Shift-clicking B from A selects contiguous A..B; dragging A's grip resizes both selected columns together.
  await page.run(`(() => { const a = ${colHead("A")}.getBoundingClientRect(); ${colHead("A")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: a.x + a.width / 2, clientY: a.y + a.height / 2 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
  await page.until("single A before Shift", `JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A"]'`);
  await page.run(`(() => { const b = ${colHead("B")}.getBoundingClientRect(); ${colHead("B")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
  await page.until("Shift-selected A..B", `JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A","B"]'`);
  const csvW = await page.run(`${colHead("A")}.getBoundingClientRect().width`);
  await page.run(`(() => { const g = document.querySelector(".dcp-viewer:not([hidden]) .sht-grip.col"), r = g.getBoundingClientRect(); g.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.x, clientY: r.y + 5 })); window.dispatchEvent(new MouseEvent("mousemove", { clientX: r.x + 30, clientY: r.y + 5 })); window.dispatchEvent(new MouseEvent("mouseup")); })()`);
  await page.until("both selected columns resized", `Math.abs(${colHead("A")}.getBoundingClientRect().width - ${csvW + 30}) < 1 && Math.abs(${colHead("B")}.getBoundingClientRect().width - ${csvW + 30}) < 1`);
  // ⌘-select disjoint A and C, right-click C keeps both selected and deletes both columns cleanly.
  await page.run(`(() => { const a = ${colHead("A")}.getBoundingClientRect(); ${colHead("A")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: a.x + a.width / 2, clientY: a.y + a.height / 2 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
  await page.until("single A before ⌘-click", `JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A"]'`);
  await page.run(`(() => { const c = ${colHead("C")}.getBoundingClientRect(); ${colHead("C")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true, clientX: c.x + c.width / 2, clientY: c.y + c.height / 2 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
  await page.until("disjoint A and C before right-click", `JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A","C"]'`);
  await page.run(`(() => { const c = ${colHead("C")}.getBoundingClientRect(); ${colHead("C")}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, clientX: c.x + c.width / 2, clientY: c.y + c.height / 2 })); ${colHead("C")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: c.x + c.width / 2, clientY: c.y + c.height / 2 })); })()`);
  await page.until("menu opened preserving disjoint columns", `!!document.querySelector(".sht-menu") && JSON.stringify([...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-h.col.on")].map((e) => e.textContent)) === '["A","C"]'`);
  await page.run(`${menuItem((s) => s.sheet.delete)}.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))`);
  await page.until("delete submenu with 2 columns", `document.querySelectorAll(".sht-menu").length === 2 && /2/.test(document.querySelectorAll(".sht-menu")[1].querySelectorAll(".mi")[1]?.textContent ?? "")`);
  await page.run(`document.querySelectorAll(".sht-menu")[1].querySelectorAll(".mi")[1].click()`);
  await page.until("disjoint A and C deleted leaving B as A", `${cellText("A1")} === "金额" && ${cellText("A2")} === "100" && !${cellText("B1")}`, 10000);
  check((await selectedCols()).length >= 1, "selection cleared after delete");
  const tabIcon = (name) => `[...document.querySelectorAll(".fpn-tab")].find((x) => x.querySelector(".brp-tab-t")?.textContent === ${JSON.stringify(name)})?.querySelector(".brp-tab-ic svg rect")`;
  check(await page.run(`!!${tabIcon("values.csv")} && !!${tabIcon("model.xlsx")}`), "a workbook tab does not show the grid icon");
  await toPanel(page, "旧表");
  await page.until("XLS read only", `${activeTab} === "legacy.xls" && document.querySelector(".dcp-viewer:not([hidden]) .sht-formula")?.readOnly && !!document.querySelector(".dcp-viewer:not([hidden]) .sht-canvas")`);
  check(await page.run(`[...document.querySelectorAll(".dcp-viewer:not([hidden]) .sht-tools button")].filter((b) => [${either((s) => s.sheet.undo)} , ${either((s) => s.sheet.redo)}].flat().includes(b.getAttribute("aria-label"))).every((b) => b.disabled)`), "XLS undo/redo enabled");
  check(await page.run(`!!${tabIcon("legacy.xls")}`), "the .xls tab does not show the grid icon");
  await page.shot("4-csv-xls");
  await page.run(`${chip("二进制")}.click()`);
  await page.until("the card", `!!document.querySelector(".fpn-card") && ${activeTab} === "blob.bin"`);
  const before = lines(opened).length;
  await page.run(`document.querySelector(".fpn-card .btn").click()`);
  await until("opened in its app", () => lines(opened).length > before, 4000);
  check(JSON.stringify(lines(opened).at(-1)) === JSON.stringify({ kind: "open", path: path.join(proj, "bin/blob.bin") }), `opened: ${JSON.stringify(lines(opened).at(-1))}`);

  await toPanel(page, "坏表");
  await page.until("the broken workbook's card", `${activeTab}?.startsWith("a_workbook") && !!document.querySelector(".fpn-main > .fpn-card")`);
  check(await page.run(`(() => { const c = document.querySelector(".fpn-main > .fpn-card").getBoundingClientRect(), m = document.querySelector(".fpn-main").getBoundingClientRect(); return c.left >= m.left && c.right <= m.right; })()`), "the card spills out of the file's column");
  await page.shot("5-broken");

  step("the tree: a folder closes and opens, a file opens from it; a tab closes");
  const docsRow = `[...document.querySelectorAll(".fpt-row")].find((r) => r.querySelector(".fpt-name").textContent === "docs")`;
  const notesShown = `[...document.querySelectorAll(".fpt-row .fpt-name")].some((n) => n.textContent === "notes.md")`;
  // Opening notes.md opened docs on the way.
  check(await page.run(`(${docsRow}).getAttribute("aria-expanded") === "true" && ${notesShown}`), "the tree did not open the way to notes.md");
  await page.run(`(${docsRow}).click()`);
  await page.until("docs closed", `!${notesShown}`);
  await page.run(`(${docsRow}).click()`);
  await page.until("docs open", notesShown);
  await page.run(`[...document.querySelectorAll(".fpt-row")].find((r) => r.querySelector(".fpt-name").textContent === "notes.md").click()`);
  await page.until("notes.md in front", `${activeTab} === "notes.md"`);
  const tabs = () => page.run(`[...document.querySelectorAll(".fpn-tab .brp-tab-t")].map((n) => n.textContent)`);
  const count = (await tabs()).length;
  await page.run(`document.querySelector(".fpn-tab.on .brp-tab-x").click()`);
  await page.until("the tab closed", `document.querySelectorAll(".fpn-tab").length === ${count - 1}`);

  step("⌘F in the editor finds in the file");
  await page.run(`[...document.querySelectorAll(".fpn-tab")].find((x) => x.textContent.includes("app.ts")).click()`);
  await page.until("app.ts in front", `${activeTab} === "app.ts"`);
  await page.run(`document.querySelector(".fpn .cm-content").focus(); window.dispatchEvent(new Event("finx:find"))`);
  await page.until("the editor's search", `!!document.querySelector(".fpn .cm-search")`);

  step("the Files button sits at the panel's right end while it is open, and puts it away");
  const browserButton = `[...document.querySelectorAll('.spage .ctool button')].find((b) => ${either((s) => s.browser.builtIn)}.includes(b.getAttribute('aria-label')))`;
  const filesButton = `[...document.querySelectorAll('.spage .ctool button')].find((b) => ${either((s) => s.files.title)}.includes(b.getAttribute('aria-label')))`;
  const stripEnd = `[...document.querySelectorAll(".fpn .brp-strip > button")].at(-1)`;
  check(!(await page.run(`!!(${filesButton})`)), "the bar's Files button stayed while the panel is open");
  check(await page.run(`${either((s) => s.files.hide)}.includes((${stripEnd}).getAttribute("aria-label")) && (${stripEnd}).getAttribute("aria-pressed") === "true"`), "the panel's last button is not Files");
  check(await page.run(`${either((s) => s.browser.maximize)}.includes([...document.querySelectorAll(".fpn .brp-strip > button")].at(-2).getAttribute("aria-label"))`), "Expand is not just left of Files");
  check(await page.run(`innerWidth - (${stripEnd}).getBoundingClientRect().right < 16`), "the Files button is not at the window's right end");
  const kept = (await tabs()).length;
  await page.run(`(${stripEnd}).click()`);
  await page.until("the panel away, the bar's button back", `!document.querySelector(".fpn") && !!(${filesButton})`);

  step("the bar reads Session info, Browser, Files from left to right, each with a tip that shows soon");
  const labels = await page.run(`[...document.querySelectorAll('.spage .ctool button.tb')].map((b) => b.getAttribute('aria-label')).slice(-3)`);
  check(either((s) => s.page.info).includes(labels[0]) && either((s) => s.browser.builtIn).includes(labels[1]) && either((s) => s.files.title).includes(labels[2]), `the bar's buttons are ${labels.join(", ")}`);
  const point = async (expr) => {
    const { x, y } = await page.run(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  };
  const infoButton = `[...document.querySelectorAll('.spage .ctool button')].find((b) => ${either((s) => s.page.info)}.includes(b.getAttribute('aria-label')))`;
  let since = Date.now();
  await point(infoButton);
  await page.until("the info button's tip", `${either((s) => s.page.info)}.some((w) => document.querySelector(".tip")?.textContent.startsWith(w))`, 1500);
  check(Date.now() - since < 1000, `the first tip took ${Date.now() - since} ms`);
  check(await page.run(`!(${infoButton}).hasAttribute("title")`), "the system's own tip can still show over ours");
  since = Date.now();
  await point(browserButton);
  await page.until("the browser button's tip", `${either((s) => s.browser.builtIn)}.includes(document.querySelector(".tip")?.textContent)`, 1000);
  check(Date.now() - since < 250, `moving along the bar, the next tip took ${Date.now() - since} ms`);
  await page.shot("0-tip");
  await point(`document.querySelector(".dmain")`);
  await page.until("the tip gone, the title back", `!document.querySelector(".tip") && (${browserButton}).hasAttribute("title")`, 1000);

  await page.run(`(${filesButton}).click()`);
  await page.until("the panel back with its tabs", `!!document.querySelector(".fpn") && document.querySelectorAll(".fpn-tab").length === ${kept} && !(${filesButton})`);

  step("the browser takes the panel's place, and gives it back with the tabs");
  await page.run(`(${browserButton}).click()`);
  await page.until("the browser instead", `!!document.querySelector(".brp:not(.fpn)") && !document.querySelector(".fpn")`);
  await page.run(`(${filesButton}).click()`);
  await page.until("the files again", `!!document.querySelector(".fpn") && document.querySelectorAll(".fpn-tab").length === ${count - 1}`);

  step("a step's file opens in the panel at the line it read from");
  await page.run(`[...document.querySelectorAll(".fpn-tab")].find((x) => x.textContent.includes("crlf.txt")).click()`);
  await page.run(`[...document.querySelectorAll(".tgroup .tg-h, .tool .th")].forEach((b) => b.getAttribute("aria-expanded") === "false" && b.closest(".tgroup") && b.click())`);
  const readStep = `[...document.querySelectorAll(".tool")].find((t) => t.querySelector(".sm2")?.textContent.includes("src/app.ts"))`;
  await page.until("the read step", `!!(${readStep})`);
  pick("open");
  await page.run(`(${readStep}).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await page.until("app.ts at line 5", `${activeTab} === "app.ts" && (document.querySelector(".fpn .cm-line.cm-target")?.textContent ?? "").startsWith("export const line5")`, 8000).catch(async (e) => {
    fail(`${e.message}: marked ${await page.run(`document.querySelector(".fpn .cm-line.cm-target")?.textContent ?? null`)}`);
  });
  await page.shot("4-step");
  if (shots) {
    await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await sleep(300);
    await page.shot("5-light");
    await page.cdp("Emulation.setEmulatedMedia", { features: [] });
  }

  page.close();
  console.log("\n✔ files open beside the conversation at their lines, save on their own and with ⌘S, take changes from elsewhere or offer the choice, and show what they are");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
  if (activePage) {
    await activePage.shot("failure").catch(() => {});
    console.error(await activePage.run(`({ active: document.querySelector(".fpn-tab.on")?.textContent, panel: document.querySelector(".fpn")?.innerText.slice(-1200), toast: document.querySelector(".toast")?.textContent })`).catch(() => null));
  }
} finally {
  await quit();
  await finxCall("server/shutdown", {}).catch(() => {});
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work} (finx's log is in finx/logs)`);
}
process.exit(failed ? 1 : 0);
