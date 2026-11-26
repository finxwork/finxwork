import { ipcRenderer } from "electron";
import {
  chunkBlocks,
  isAlreadyTargetLanguage,
  normalizeText,
  shouldSkipText,
  type TranslationBatchResult,
  type TranslationBlock,
  type TranslationState,
} from "../shared/translation";

const EXCLUDED_ANCESTOR =
  "script, style, noscript, template, code, pre, kbd, samp, svg, math, textarea, input, select, button, nav, footer, [hidden], [contenteditable='true'], [translate='no'], .notranslate, [role='button'], [role='navigation'], [role='menu'], [role='toolbar'], [data-finx-annotations], [data-finx-translation], [data-finx-translate-toast]";

const NON_TEXT_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "IFRAME", "OBJECT", "EMBED",
  "PRE", "TEXTAREA", "INPUT", "SELECT", "BUTTON",
]);

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY",
  "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

const LEAF_BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "FIGCAPTION", "TD", "TH", "DT", "DD", "SUMMARY",
  "DIV", "SECTION", "ARTICLE", "MAIN",
]);

const TRANSLATION_STYLE = `
  :host {
    display: block;
    margin-top: 0.32em;
    padding-left: 0.62em;
    border-left: 2px solid rgba(35, 136, 245, 0.38);
    color: inherit;
    font: inherit;
    font-size: 0.94em;
    line-height: 1.58;
    opacity: 0.86;
    word-break: break-word;
  }
  .text {
    display: block;
    white-space: pre-wrap;
  }
  .loading {
    display: inline-block;
    width: 3.5em;
    height: 0.72em;
    border-radius: 4px;
    background: currentColor;
    opacity: 0.16;
    animation: finx-pulse 1.2s ease-in-out infinite;
    vertical-align: middle;
  }
  @keyframes finx-pulse {
    0%, 100% { opacity: 0.14; }
    50% { opacity: 0.34; }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading { animation: none; }
  }
`;

const TOAST_STYLE = `
  :host {
    all: initial !important;
    position: fixed !important;
    left: 50% !important;
    bottom: 16px !important;
    transform: translateX(-50%) !important;
    z-index: 2147483647 !important;
    pointer-events: none !important;
    color-scheme: light dark !important;
    font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
  }
  .toast {
    max-width: min(420px, calc(100vw - 32px));
    background: #fff;
    color: #c83e3b;
    border: 0.5px solid #e5e8ed;
    border-radius: 8px;
    padding: 7px 13px;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.14);
  }
  @media (prefers-color-scheme: dark) {
    .toast {
      background: #25272d;
      color: #f07b78;
      border-color: #424650;
    }
  }
`;

type TrackedBlock = {
  host: HTMLSpanElement;
  body: HTMLSpanElement;
  text: string;
};

type InlineRunTarget = {
  kind: "run";
  key: Node;
  firstNode: Node;
  lastNode: Node;
  text: string;
};

type ElementTarget = {
  kind: "element";
  key: Element;
  el: Element;
};

type Target = ElementTarget | InlineRunTarget;

function isExcludedElement(el: Element): boolean {
  return !!el.closest(EXCLUDED_ANCESTOR);
}

function isHiddenElement(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getClientRects().length === 0) return true;
  const style = window.getComputedStyle(el);
  return style.display === "none" || style.visibility === "hidden";
}

/**
 * Extracts visible linguistic text from a DOM subtree while skipping `<script>`, `<style>`,
 * `<template>`, `<code>`, `<pre>`, hidden nodes, and our own translation/annotation hosts.
 */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof Element)) return "";
  if (NON_TEXT_TAGS.has(node.tagName)) return "";
  if (
    node.hasAttribute("hidden") ||
    node.hasAttribute("data-finx-translation") ||
    node.hasAttribute("data-finx-annotations") ||
    node.hasAttribute("data-finx-translate-toast")
  ) {
    return "";
  }
  let out = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    out += visibleText(child);
  }
  return out;
}

/** True when `node` is a `<br>` followed (ignoring whitespace-only text nodes) by another `<br>`. */
function isDoubleBreak(node: Node): ChildNode | null {
  if (!(node instanceof Element) || node.tagName !== "BR") return null;
  let next = node.nextSibling;
  while (next && next.nodeType === Node.TEXT_NODE && !(next.nodeValue ?? "").trim()) {
    next = next.nextSibling;
  }
  if (next instanceof Element && next.tagName === "BR") return next;
  return null;
}

function hasBlockChildOrDoubleBreak(el: Element): boolean {
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child instanceof Element) {
      if (BLOCK_TAGS.has(child.tagName)) return true;
      if (isDoubleBreak(child)) return true;
      if (hasBlockChildOrDoubleBreak(child)) return true;
    }
  }
  return false;
}

function isRunNearViewport(firstNode: Node, lastNode: Node, margin = 300): boolean {
  if (!firstNode.isConnected || !lastNode.isConnected) return false;
  try {
    const range = document.createRange();
    range.setStartBefore(firstNode);
    range.setEndAfter(lastNode);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
  } catch {
    return false;
  }
}

/**
 * Initializes the isolated-world immersive translation engine for the tab's main frame.
 * Translated nodes live inside closed Shadow DOMs with `aria-hidden="true"`, so neither
 * page scripts (`textContent`), FinxWork annotations, nor Agent AXTree snapshots are polluted.
 */
export function initBrowserTranslation(): void {
  let state: TranslationState = { url: "", enabled: false, targetLanguage: "zh-CN" };
  let generation = 0;
  let nextBlockId = 1;
  let flushTimer = 0;
  let scrollTimer = 0;
  let toastTimer = 0;
  let toastHost: HTMLDivElement | null = null;
  let intersection: IntersectionObserver | null = null;
  let mutation: MutationObserver | null = null;

  let observed = new WeakSet<Node>();
  const queued = new Map<Node, Target>();
  const pendingRuns = new Set<InlineRunTarget>();
  const rendered = new WeakMap<Node, TrackedBlock>();
  const toastBoxes = new WeakMap<HTMLDivElement, HTMLDivElement>();

  function copy() {
    const zh = state.targetLanguage.toLowerCase().startsWith("zh");
    return zh
      ? { noModel: "请先在设置中配置可用模型后再使用翻译", failed: "翻译失败，请稍后重试" }
      : { noModel: "Configure a model in Settings before translating.", failed: "Translation failed. Please retry." };
  }

  function showToast(message: string) {
    if (toastTimer) clearTimeout(toastTimer);
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.setAttribute("data-finx-translate-toast", "");
      toastHost.setAttribute("aria-hidden", "true");
      const root = toastHost.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = TOAST_STYLE;
      const box = document.createElement("div");
      box.className = "toast";
      box.setAttribute("role", "alert");
      root.append(style, box);
      (document.documentElement || document.body)?.append(toastHost);
      toastBoxes.set(toastHost, box);
    }
    const box = toastBoxes.get(toastHost);
    if (box) box.textContent = message;
    toastHost.style.display = "block";
    toastTimer = window.setTimeout(() => {
      if (toastHost) toastHost.style.display = "none";
      toastTimer = 0;
    }, 3600);
  }

  function isTranslatableText(text: string): boolean {
    return !shouldSkipText(text) && !isAlreadyTargetLanguage(text, state.targetLanguage);
  }

  function mountPlaceholder(target: Target, text: string): TrackedBlock {
    const host = document.createElement("span");
    host.setAttribute("data-finx-translation", "");
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = TRANSLATION_STYLE;
    const body = document.createElement("span");
    body.className = "loading";
    shadow.append(style, body);
    if (target.kind === "element") {
      target.el.append(host);
    } else {
      (target.lastNode as ChildNode).after(host);
    }
    const tracked: TrackedBlock = { host, body, text };
    rendered.set(target.key, tracked);
    return tracked;
  }

  /**
   * Walks a DOM subtree, registering either leaf block elements (via IntersectionObserver)
   * or `<br><br>` / block-delimited inline text runs (via viewport Range checks).
   */
  function collectTargets(root: Element) {
    if (!intersection || !root.isConnected || isExcludedElement(root) || isHiddenElement(root)) return;

    // 1. Leaf block element (no nested block children or `<br><br>` breaks).
    if (LEAF_BLOCK_TAGS.has(root.tagName) && !hasBlockChildOrDoubleBreak(root)) {
      if (observed.has(root) || rendered.has(root)) return;
      const text = normalizeText(visibleText(root));
      if (isTranslatableText(text)) {
        observed.add(root);
        intersection.observe(root);
      }
      return;
    }

    // 2. Mixed container (e.g. `<body>`, `<span class="style1">`, `<div>` with blocks or `<br><br>`):
    //    split direct childNodes into inline runs between block children / double `<br>` separators,
    //    and recurse into child elements that are blocks or wrappers around blocks.
    let runNodes: Node[] = [];
    const flushRun = () => {
      if (runNodes.length === 0) return;
      // Trim leading/trailing whitespace-only text nodes so the anchor is real content.
      while (runNodes.length > 0 && runNodes[0].nodeType === Node.TEXT_NODE && !(runNodes[0].nodeValue ?? "").trim()) {
        runNodes.shift();
      }
      while (
        runNodes.length > 0 &&
        runNodes[runNodes.length - 1].nodeType === Node.TEXT_NODE &&
        !(runNodes[runNodes.length - 1].nodeValue ?? "").trim()
      ) {
        runNodes.pop();
      }
      if (runNodes.length === 0) return;
      const text = normalizeText(runNodes.map((n) => visibleText(n)).join(""));
      const firstNode = runNodes[0];
      const lastNode = runNodes[runNodes.length - 1];
      runNodes = [];
      if (!isTranslatableText(text)) return;
      if (observed.has(lastNode) || rendered.has(lastNode)) return;
      observed.add(lastNode);
      const runTarget: InlineRunTarget = { kind: "run", key: lastNode, firstNode, lastNode, text };
      if (isRunNearViewport(firstNode, lastNode)) {
        queued.set(lastNode, runTarget);
        scheduleFlush();
      } else {
        pendingRuns.add(runTarget);
      }
    };

    for (let child: ChildNode | null = root.firstChild; child; child = child.nextSibling) {
      if (child instanceof Element) {
        if (child.hasAttribute("data-finx-translation") || child.hasAttribute("data-finx-annotations") || child.hasAttribute("data-finx-translate-toast")) {
          continue;
        }
        if (isExcludedElement(child)) {
          flushRun();
          continue;
        }
        const secondBr = isDoubleBreak(child);
        if (secondBr) {
          flushRun();
          child = secondBr;
          continue;
        }
        if (BLOCK_TAGS.has(child.tagName) || hasBlockChildOrDoubleBreak(child)) {
          flushRun();
          collectTargets(child);
          continue;
        }
        // Regular inline element (<a>, <em>, <strong>, <span> without blocks): part of current run.
        runNodes.push(child);
      } else if (child.nodeType === Node.TEXT_NODE) {
        runNodes.push(child);
      }
    }
    flushRun();
  }

  function checkPendingRuns() {
    if (!state.enabled || pendingRuns.size === 0) return;
    let added = false;
    for (const run of pendingRuns) {
      if (!run.firstNode.isConnected || !run.lastNode.isConnected) {
        pendingRuns.delete(run);
        continue;
      }
      if (isRunNearViewport(run.firstNode, run.lastNode)) {
        pendingRuns.delete(run);
        queued.set(run.key, run);
        added = true;
      }
    }
    if (added) scheduleFlush();
  }

  function onViewportChange() {
    if (!state.enabled || pendingRuns.size === 0 || scrollTimer) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = 0;
      checkPendingRuns();
    }, 100);
  }

  function scheduleFlush() {
    if (flushTimer || queued.size === 0) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = 0;
      void flushQueue();
    }, 80);
  }

  async function flushQueue() {
    if (!state.enabled || queued.size === 0) return;
    const gen = generation;
    const targets = [...queued.values()];
    queued.clear();

    const entries: Array<{ id: string; key: Node; text: string; tracked: TrackedBlock }> = [];
    for (const target of targets) {
      if (!target.key.isConnected || rendered.has(target.key)) continue;
      const text = target.kind === "element" ? normalizeText(visibleText(target.el)) : target.text;
      if (!isTranslatableText(text)) continue;
      const id = String(nextBlockId++);
      const tracked = mountPlaceholder(target, text);
      entries.push({ id, key: target.key, text, tracked });
    }
    if (entries.length === 0) return;

    const byId = new Map(entries.map((e) => [e.id, e]));
    const blocks: TranslationBlock[] = entries.map((e) => ({ id: e.id, text: e.text }));
    const batches = chunkBlocks(blocks);

    for (const batch of batches) {
      if (gen !== generation || !state.enabled) return;
      void sendBatch(gen, batch, byId);
    }
  }

  async function sendBatch(
    gen: number,
    batch: TranslationBlock[],
    byId: Map<string, { id: string; key: Node; text: string; tracked: TrackedBlock }>,
  ) {
    try {
      const result = (await ipcRenderer.invoke("browser-translate", {
        action: "batch",
        url: location.href,
        title: document.title || "",
        targetLanguage: state.targetLanguage,
        items: batch,
      })) as TranslationBatchResult;

      if (gen !== generation || !state.enabled || result.cancelled) {
        for (const item of batch) {
          const entry = byId.get(item.id);
          if (entry) {
            entry.tracked.host.remove();
            rendered.delete(entry.key);
          }
        }
        return;
      }
      for (const item of batch) {
        const entry = byId.get(item.id);
        if (!entry) continue;
        const translated = result.translations?.[item.id];
        if (translated) {
          entry.tracked.body.className = "text";
          entry.tracked.body.textContent = translated;
        } else {
          entry.tracked.host.remove();
          rendered.delete(entry.key);
        }
      }
    } catch (err) {
      if (gen !== generation || !state.enabled) return;
      for (const item of batch) {
        const entry = byId.get(item.id);
        if (entry) {
          entry.tracked.host.remove();
          rendered.delete(entry.key);
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/cancelled|Page changed|Translation is closed/i.test(message)) return;
      const fatal = /no_model|no_credentials|no model|credentials|auth/i.test(message);
      showToast(fatal ? copy().noModel : copy().failed);
      if (fatal) {
        stop();
        void ipcRenderer.invoke("browser-translate", { action: "disable", url: location.href }).catch(() => {});
      }
    }
  }

  function start() {
    stop();
    if (!/^https?:/.test(location.href)) return;
    const gen = generation;
    intersection = new IntersectionObserver(
      (entries) => {
        if (gen !== generation || !state.enabled) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          intersection?.unobserve(entry.target);
          queued.set(entry.target, { kind: "element", key: entry.target, el: entry.target });
        }
        scheduleFlush();
      },
      { rootMargin: "300px 0px" },
    );

    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);

    const target = document.body ?? document.documentElement;
    if (target) {
      collectTargets(target);
      mutation = new MutationObserver((records) => {
        if (gen !== generation || !state.enabled) return;
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (
              node.hasAttribute("data-finx-translation") ||
              node.hasAttribute("data-finx-annotations") ||
              node.hasAttribute("data-finx-translate-toast")
            ) {
              continue;
            }
            collectTargets(node);
          }
        }
      });
      mutation.observe(target, { childList: true, subtree: true });
    }
  }

  function stop() {
    generation++;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = 0;
    }
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    queued.clear();
    pendingRuns.clear();
    observed = new WeakSet<Node>();
    intersection?.disconnect();
    intersection = null;
    mutation?.disconnect();
    mutation = null;
    for (const node of document.querySelectorAll("[data-finx-translation]")) {
      const prev = node.previousSibling;
      const parent = node.parentElement;
      if (prev) rendered.delete(prev);
      if (parent) rendered.delete(parent);
      node.remove();
    }
  }

  function accept(next: TranslationState) {
    if (next.url !== location.href) return;
    const changed = state.enabled !== next.enabled || state.targetLanguage !== next.targetLanguage || state.url !== next.url;
    state = next;
    if (!changed) return;
    if (state.enabled) start();
    else stop();
  }

  ipcRenderer.on("browser-translation-state", (_event, next: TranslationState) => accept(next));
}
