#!/usr/bin/env node
// End-to-end verification for online PDF immersive translation in the embedded browser:
// - Serves a valid 2-page English PDF over HTTP with `Content-Type: application/pdf`
// - Verifies `tab.isPdf === true` and Chromium native PDF view stays untouched before toggle
// - Toggles translate ON -> BrowserPdfView mounts with pdf.js + PdfTranslationPane
// - Verifies page 1 & page 2 paragraphs are extracted and translated via models/complete
// - Verifies clicking a translated paragraph switches/flashes the original PDF canvas
// - Verifies view mode switching (split / translated / original)
// - Toggles translate OFF -> BrowserPdfView unmounts cleanly
// - Toggles translate ON again -> LRU cache hit (0 new LLM requests)
// - Navigates to an HTML page -> isPdf & translating reset cleanly
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = createRequire(import.meta.url)("electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

/** Builds a minimal, spec-compliant 2-page PDF with real selectable Helvetica text. */
function makeSamplePdf() {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const pageStream = (lines) => {
    const cmds = [];
    for (const { text, x, y, size } of lines) {
      cmds.push(`BT /F1 ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`);
    }
    return cmds.join("\n");
  };

  const s1 = pageStream([
    { text: "The Bitter Lesson", x: 50, y: 720, size: 18 },
    { text: "General methods that leverage computation are ultimately the most effective.", x: 50, y: 680, size: 11 },
    { text: "In computer chess, massive deep search defeated the world champion.", x: 50, y: 640, size: 11 },
  ]);
  const s2 = pageStream([
    { text: "Second page discusses computer Go and self-play reinforcement learning.", x: 50, y: 700, size: 11 },
  ]);

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(s1)} >>\nstream\n${s1}\nendstream\nendobj\n`,
    `6 0 obj\n<< /Length ${Buffer.byteLength(s2)} >>\nstream\n${s2}\nendstream\nendobj\n`,
    "7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out));
    out += obj;
  }
  const xrefOffset = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "utf8");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxp-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

const llmRequests = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const request = JSON.parse(body);
    const userMsg = (request.messages ?? []).find((m) => m.role === "user");
    const content = typeof userMsg?.content === "string" ? userMsg.content : "";
    const items = {};
    const out = [];
    for (const m of content.matchAll(/<t id="([^"]+)">([\s\S]*?)<\/t>/g)) {
      items[m[1]] = m[2];
      out.push(`<t id="${m[1]}">[PDF-ZH] ${m[2]}</t>`);
    }
    llmRequests.push({ items });
    const delta = { role: "assistant", content: out.join("\n") };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      `data: [DONE]\n\n`,
    );
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 4096\n`,
);
fs.writeFileSync(
  path.join(home, "config.toml"),
  `model = "mock/mock-1"\npermission_mode = "bypass-permissions"\n[models]\nnetwork = false\n[browser]\nenabled = true\n`,
);

const pdfBytes = makeSamplePdf();
const site = http.createServer((req, res) => {
  if (req.url === "/sample.pdf") {
    res.writeHead(200, { "content-type": "application/pdf", "content-length": String(pdfBytes.length) });
    return res.end(pdfBytes);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><head><title>Plain HTML</title></head><body><p>Hello HTML</p></body></html>");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));

let app = null;
async function launch() {
  const port = cdpPort();
  app = spawn(
    electron,
    [desktop, ...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`],
    {
      env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && /^(app:|file:)/.test(t.url) && !t.url.includes("#settings"));
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
      await sleep(150);
    }
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 820, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, port, close: page.close };
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
}

let failed = false;
try {
  const page = await launch();
  await page.until("kernel ready", `(async () => (await window.finx?.kernelStatus())?.state === "ready")()`, 60000);
  await sleep(800);
  await page.until("app loaded", `!!document.querySelector("button")`);
  await page.until(
    "onboarding left",
    `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".ctool button[aria-pressed]"); })()`,
  );
  await page.run(`document.querySelector('.ctool button[aria-pressed]').click()`);
  await page.until("browser ready", `!!document.querySelector('.brp-url')`);

  const pdfUrl = `http://127.0.0.1:${site.address().port}/sample.pdf`;
  const htmlUrl = `http://127.0.0.1:${site.address().port}/plain`;

  await page.run(
    `(async () => { const tabs = await window.finx.browserTabs(); window.finx.browserTabCommand(tabs[0].targetId, { command: 'go', url: ${JSON.stringify(pdfUrl)} }); })()`,
  );
  await page.until(
    "PDF tab detected",
    `(async () => { const tabs = await window.finx.browserTabs(); return tabs.some(t => t.url === ${JSON.stringify(pdfUrl)} && t.isPdf && t.domReady); })()`,
  );
  check(!(await page.run(`!!document.querySelector('[data-browser-pdf-view]')`)), "BrowserPdfView should not mount before translation is toggled");

  // 1. Toggle translate ON -> BrowserPdfView + PdfTranslationPane mount and translate pages 1 & 2
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("BrowserPdfView mounted", `!!document.querySelector('[data-browser-pdf-view]')`);
  await page.until(
    "page 1 translated",
    `document.querySelector('[data-pdf-translate-pane]')?.textContent?.includes('[PDF-ZH] The Bitter Lesson')`,
  );
  await page.until(
    "page 1 body & page 2 prefetched",
    `(() => { const t = document.querySelector('[data-pdf-translate-pane]')?.textContent ?? ''; return t.includes('[PDF-ZH] General methods that leverage computation') && t.includes('[PDF-ZH] Second page discusses computer Go'); })()`,
  );

  // 2. Click a translated paragraph -> switches/keeps split view and flashes highlight on left PDF canvas
  await page.run(`document.querySelector('[data-pdf-tr-block]')?.click()`);
  await page.until("split view active after click", `document.querySelector('[data-browser-pdf-view]')?.classList.contains('mode-split')`);

  // 3. Toggle translate OFF -> BrowserPdfView unmounts cleanly
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("BrowserPdfView unmounted", `!document.querySelector('[data-browser-pdf-view]')`);

  // 4. Toggle translate ON again -> LRU cache hit (0 new LLM requests)
  const callsBefore = llmRequests.length;
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until(
    "cached PDF translation rendered",
    `document.querySelector('[data-pdf-translate-pane]')?.textContent?.includes('[PDF-ZH] The Bitter Lesson')`,
  );
  check(llmRequests.length === callsBefore, `expected 0 new LLM calls on LRU hit, got ${llmRequests.length - callsBefore}`);

  // 5. Navigate to plain HTML page -> isPdf and translating both reset
  await page.run(
    `(async () => { const tabs = await window.finx.browserTabs(); window.finx.browserTabCommand(tabs[0].targetId, { command: 'go', url: ${JSON.stringify(htmlUrl)} }); })()`,
  );
  await page.until(
    "navigated to HTML & reset",
    `(async () => { const tabs = await window.finx.browserTabs(); return tabs.some(t => t.url === ${JSON.stringify(htmlUrl)} && !t.isPdf && !t.translating); })()`,
  );
  check(!(await page.run(`!!document.querySelector('[data-browser-pdf-view]')`)), "BrowserPdfView should unmount after leaving PDF");

  page.close();
  console.log("✓ browser PDF translate: detection, pdf.js bilingual view, page 1+2 prefetch, paragraph focus, lossless toggle off, LRU cache, and navigation reset");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await quit();
  site.closeAllConnections();
  site.close();
  provider.closeAllConnections();
  provider.close();
  try { execFileSync("pkill", ["-f", `${home}/run/finx.sock`]); } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
