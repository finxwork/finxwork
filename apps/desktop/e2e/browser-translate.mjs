#!/usr/bin/env node
// Comprehensive E2E verification for embedded browser immersive translation:
// - Standard blocks, leaf <div>, nested wrappers (no double translation), inline <code> in prose
// - BitterLesson-style bare text runs with <br><br>, inline links/em, single <br> soft breaks
// - Skipping: target language, <pre><code>, <div><script>, <style>, <template>, <svg>,
//   hidden elements, contenteditable, translate="no", .notranslate, nav/footer/button
// - Unescaped quotes in translations (<t> wire format resilience)
// - Closed Shadow DOM, light DOM textContent, and Agent AXTree zero-pollution
// - Viewport lazy-loading on scroll & MutationObserver dynamic DOM updates
// - In-page hash navigation keeps translation ON; full navigation resets to OFF
// - Rapid toggle OFF during slow in-flight LLM call cancels cleanly with zero stderr errors
// - Lossless revert & LRU cache hit on re-enable
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxt-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

const llmRequests = [];
let responseDelayMs = 0;
let stderrLog = "";

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const request = JSON.parse(body);
    const userMsg = (request.messages ?? []).find((m) => m.role === "user");
    const content = typeof userMsg?.content === "string" ? userMsg.content : "";
    const items = {};
    const out = [];
    for (const m of content.matchAll(/<t id="([^"]+)">([\s\S]*?)<\/t>/g)) {
      items[m[1]] = m[2];
      // Intentionally include unescaped double quotes to verify wire format immunity.
      out.push(`<t id="${m[1]}">[ZH] "${m[2]}"</t>`);
    }
    llmRequests.push({ items });
    if (responseDelayMs > 0) await sleep(responseDelayMs);
    if (res.destroyed) return;
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

let app = null;
async function launch() {
  const port = cdpPort();
  app = spawn(
    electron,
    [desktop, ...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`],
    {
      env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  app.stderr.on("data", (chunk) => {
    const s = chunk.toString();
    stderrLog += s;
  });
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

const page1Html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Translate Test</title>
<style>
  body { font: 16px/1.5 system-ui; padding: 24px; margin: 0; }
  #spacer { height: 2400px; }
</style>
</head>
<body>
  <nav><a href="#top">Navigation links must be skipped</a></nav>
  <h1 id="title">Immersive Translation Heading</h1>
  <p id="en-top">This is an English paragraph with "quotes" visible in the initial viewport.</p>
  <p id="en-inline-code">Call <code>fetchData()</code> to load the remote resource.</p>
  <article id="nested-wrap"><div class="inner"><p id="nested-p">Nested paragraph should only translate once.</p></div></article>
  <ul id="list-wrap"><li><p id="li-p">List item wrapping a paragraph.</p></li></ul>
  <span class="style1">
    Bare text paragraph one with <a href="#ref">an inline link</a> and <em>emphasis</em>.<br>
    <br>
    Soft break line one.<br>Soft break line two stays in the same paragraph.<br>
    <br>
  </span>
  <div id="en-div">Leaf div paragraph without a p tag.</div>

  <!-- Elements that must NEVER be translated -->
  <div id="script-wrapper"><script>window.__uspapi = function() { return "inline script must never be translated"; };</script></div>
  <div id="style-wrapper"><style>.never-translate-css { color: red; }</style></div>
  <template><p>Template content must never be translated.</p></template>
  <svg width="100" height="20"><text x="0" y="15">SVG chart text must never be translated</text></svg>
  <div id="hidden-div" style="display:none">Hidden display none must never be translated.</div>
  <div id="vis-hidden" style="visibility:hidden">Visibility hidden must never be translated.</div>
  <p id="attr-hidden" hidden>Hidden attribute must never be translated.</p>
  <p contenteditable="true">Contenteditable text must never be translated.</p>
  <p translate="no">Translate no attribute must never be translated.</p>
  <p class="notranslate">Notranslate class must never be translated.</p>
  <button type="button">Subscribe button must never be translated</button>
  <p id="zh-top">这是一段已经是中文的正文内容，不应该被重复翻译。</p>
  <pre id="code-block"><code>const greeting = "This code block must never be translated";</code></pre>
  <footer>Footer legal notice must never be translated.</footer>

  <div id="dynamic-slot"></div>
  <div id="spacer"></div>
  <p id="en-bottom">This paragraph sits far below the initial fold and should lazy load.</p>
</body>
</html>`;

const page2Html = `<!doctype html><html><head><meta charset="utf-8"><title>Second Page</title></head><body><p id="p2">Second page English sentence for cancel test.</p></body></html>`;

const site = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/page2" ? page2Html : page1Html);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));

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

  const url1 = `http://127.0.0.1:${site.address().port}/`;
  const url2 = `http://127.0.0.1:${site.address().port}/page2`;
  await page.run(
    `(async () => { const tabs = await window.finx.browserTabs(); window.finx.browserTabCommand(tabs[0].targetId, { command: 'go', url: ${JSON.stringify(url1)} }); })()`,
  );
  await page.until(
    "site loaded",
    `document.querySelector('.brp-tab-t')?.textContent === 'Translate Test' && !document.querySelector('.brp-translate').disabled`,
  );

  const targets = await fetch(`http://127.0.0.1:${page.port}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.url === url1);
  check(target, "browser target missing");
  const browser = await devtools(target.webSocketDebuggerUrl);
  const run = async (expression) => {
    const r = await browser.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(r.exceptionDetails.text);
    return r.result.value;
  };

  await browser.call("DOM.enable");
  await browser.call("Accessibility.enable");

  const shadowTexts = async () => {
    const { root } = await browser.call("DOM.getDocument", { depth: -1, pierce: true });
    const texts = [];
    const collect = (node, inTranslation) => {
      const attrs = node.attributes ?? [];
      const isHost = attrs.includes("data-finx-translation");
      if (inTranslation && node.nodeType === 3 && node.nodeValue?.trim()) texts.push(node.nodeValue.trim());
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        collect(child, inTranslation || isHost);
      }
    };
    collect(root, false);
    return texts;
  };

  // 1. Toggle translation ON
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("translate on", `document.querySelector('.brp-translate').getAttribute('aria-pressed') === 'true'`);

  let texts = [];
  for (let i = 0; i < 60; i++) {
    texts = await shadowTexts();
    if (texts.some((t) => t.includes("Leaf div paragraph without a p tag."))) break;
    await sleep(150);
  }

  // Verify every translatable structure rendered cleanly (including quotes, inline code, bare text runs, soft breaks)
  check(texts.some((t) => t.includes('Immersive Translation Heading')), `heading missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes('English paragraph with "quotes"')), `quoted paragraph missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes("Call fetchData() to load the remote resource.")), `inline code prose missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes("Nested paragraph should only translate once.")), `nested paragraph missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes("List item wrapping a paragraph.")), `li>p missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes("Bare text paragraph one with an inline link and emphasis.")), `bare text run with inline tags missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes("Soft break line one.Soft break line two stays in the same paragraph.")), `soft break run missing: ${JSON.stringify(texts)}`);
  check(texts.some((t) => t.includes("Leaf div paragraph without a p tag.")), `leaf div missing: ${JSON.stringify(texts)}`);

  // Verify NO double-translation on nested containers (<article><div><p> and <li><p>)
  check(
    (await run(`document.querySelectorAll('#nested-wrap [data-finx-translation]').length`)) === 1,
    "nested wrapper produced duplicate translation nodes",
  );
  check(
    (await run(`document.querySelectorAll('#list-wrap [data-finx-translation]').length`)) === 1,
    "li > p produced duplicate translation nodes",
  );

  // Verify ALL excluded elements were skipped and NEVER sent to the LLM
  const sentTexts = llmRequests.flatMap((r) => Object.values(r.items ?? {}));
  for (const forbidden of [
    "Navigation links",
    "__uspapi",
    "never-translate-css",
    "Template content",
    "SVG chart text",
    "Hidden display none",
    "Visibility hidden",
    "Hidden attribute",
    "Contenteditable text",
    "Translate no attribute",
    "Notranslate class",
    "Subscribe button",
    "已经是中文",
    "const greeting",
    "Footer legal notice",
    "far below the initial fold",
  ]) {
    check(!sentTexts.some((t) => t.includes(forbidden)), `forbidden content was sent to LLM (${forbidden}): ${JSON.stringify(sentTexts)}`);
  }

  // 2. Verify light DOM, security isolation, and Agent AXTree zero-pollution
  check(
    await run(`document.querySelector('#en-top').textContent === 'This is an English paragraph with "quotes" visible in the initial viewport.'`),
    "light DOM textContent was polluted",
  );
  check(
    await run(`window.finx === undefined && document.querySelector('[data-finx-translation]').shadowRoot === null`),
    "exposed shadowRoot or window.finx",
  );
  const ax = await browser.call("Accessibility.getFullAXTree");
  const visibleAxText = (ax.nodes ?? [])
    .filter((n) => !n.ignored)
    .map((n) => n.name?.value ?? "")
    .join("\n");
  check(!visibleAxText.includes("[ZH]"), `Agent AXTree polluted: ${visibleAxText}`);

  // 3. In-page hash navigation keeps translation ON
  await run(`location.hash = '#section-2'`);
  await sleep(250);
  check(
    (await page.run(`document.querySelector('.brp-translate').getAttribute('aria-pressed')`)) === "true",
    "hash navigation should keep translation enabled",
  );

  // 4. Scroll down -> lazy load below-the-fold paragraph
  await run(`document.querySelector('#en-bottom').scrollIntoView()`);
  for (let i = 0; i < 60; i++) {
    texts = await shadowTexts();
    if (texts.some((t) => t.includes("This paragraph sits far below"))) break;
    await sleep(150);
  }
  check(texts.some((t) => t.includes("This paragraph sits far below")), "below-fold paragraph did not lazy-translate");

  // 5. Dynamic DOM mutation -> MutationObserver translates newly appended paragraph
  await run(`(() => { const p = document.createElement('p'); p.id = 'en-dyn'; p.textContent = 'Dynamically appended English content.'; document.querySelector('#dynamic-slot').append(p); p.scrollIntoView(); })()`);
  for (let i = 0; i < 60; i++) {
    texts = await shadowTexts();
    if (texts.some((t) => t.includes("Dynamically appended English content."))) break;
    await sleep(150);
  }
  check(texts.some((t) => t.includes("Dynamically appended English content.")), "dynamic paragraph was not translated");

  // 6. Toggle OFF -> 100% lossless revert
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("translate off", `document.querySelector('.brp-translate').getAttribute('aria-pressed') === 'false'`);
  for (let i = 0; i < 40; i++) {
    if ((await run(`document.querySelectorAll('[data-finx-translation]').length`)) === 0) break;
    await sleep(100);
  }
  check((await run(`document.querySelectorAll('[data-finx-translation]').length`)) === 0, "translation nodes remained after toggle off");

  // 7. Toggle ON again -> LRU cache hit (0 new LLM calls)
  const callsBeforeReEnable = llmRequests.length;
  await run(`window.scrollTo(0, 0)`);
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("translate re-enabled", `document.querySelector('.brp-translate').getAttribute('aria-pressed') === 'true'`);
  for (let i = 0; i < 40; i++) {
    texts = await shadowTexts();
    if (texts.some((t) => t.includes('English paragraph with "quotes"'))) break;
    await sleep(100);
  }
  check(llmRequests.length === callsBeforeReEnable, `expected 0 new LLM calls on LRU hit, got ${llmRequests.length - callsBeforeReEnable}`);

  // 8. Full navigation resets translation to OFF; rapid toggle ON->OFF during slow LLM cancels cleanly with zero IPC error spam
  await page.run(
    `(async () => { const tabs = await window.finx.browserTabs(); window.finx.browserTabCommand(tabs[0].targetId, { command: 'go', url: ${JSON.stringify(url2)} }); })()`,
  );
  await page.until("navigated to page 2", `document.querySelector('.brp-tab-t')?.textContent === 'Second Page'`);
  check(
    (await page.run(`document.querySelector('.brp-translate').getAttribute('aria-pressed')`)) === "false",
    "full navigation did not reset translation to off",
  );

  responseDelayMs = 800;
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("page 2 translate on", `document.querySelector('.brp-translate').getAttribute('aria-pressed') === 'true'`);
  await sleep(180);
  await page.run(`document.querySelector('.brp-translate').click()`);
  await page.until("page 2 translate off", `document.querySelector('.brp-translate').getAttribute('aria-pressed') === 'false'`);
  await sleep(400);
  check(
    !stderrLog.includes("Error occurred in handler for 'browser-translate'"),
    `unexpected IPC error spam in stderr:\n${stderrLog}`,
  );

  browser.close();
  page.close();
  console.log("✓ browser translate: all DOM structures, skip rules, isolation, lazy-load, mutation, hash/full navigation, LRU cache, and clean cancel");
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
