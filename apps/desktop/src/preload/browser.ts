import { ipcRenderer } from "electron";
import { maxComment, type AnnotationAnchor, type AnnotationState } from "../shared/annotations";
import { initBrowserTranslation } from "./browser-translate";
import en from "../locales/en/session.json" with { type: "json" };
import zh from "../locales/zh-CN/session.json" with { type: "json" };

// Runs in the tab's isolated world, without exposing Electron to visited pages.
// "Add to chat": the person points at a part of the page, says something about it,
// and it goes to the conversation's composer. A closed shadow root keeps website CSS
// out of this UI; all page and comment text is inserted as textContent, never HTML.
if (process.isMainFrame) {
  type Spot = { anchor: AnnotationAnchor; element: Element | null };
  type Draft = Spot & { body: string };
  let state: AnnotationState = { url: "", enabled: false, language: "zh-CN" };
  let host: HTMLDivElement | undefined;
  let root: ShadowRoot;
  let highlight: HTMLDivElement;
  let highlightLabel: HTMLSpanElement;
  let markers: HTMLDivElement;
  let tray: HTMLDivElement;
  let card: HTMLFormElement | null = null;
  let input: HTMLTextAreaElement | null = null;
  let status: HTMLElement | null = null;
  let editing: Spot | null = null;
  let hover: Element | null = null;
  let pending = false, frame = 0;
  /** A failure to say, for a moment. */
  let notice: { text: string; timer: number } | null = null;
  /** What was added to the chat from this page, shown as numbered markers while the page lives. */
  let added: (Spot & { body: string })[] = [];
  /** Unsaved text, by element, kept while the page lives. */
  const drafts = new Map<string, Draft>();
  // The card's words are the app's (session.annotate), the same as the document column's card.
  const copy = {
    "zh-CN": { ...zh.annotate, failed: "未能添加，请重试", readError: "无法使用添加到对话，请重试", draft: "未添加的草稿", sent: "已添加", noMatch: "页面内容已变化",
      kinds: { a: "链接", button: "按钮", img: "图片", input: "输入框", textarea: "输入框", select: "选择框", heading: "标题", p: "段落", li: "列表项", table: "表格", video: "视频", other: "内容" } },
    en: { ...en.annotate, failed: "Could not add. Please retry.", readError: "Add to chat is unavailable. Please retry.", draft: "Draft not added", sent: "Added", noMatch: "The page has changed",
      kinds: { a: "Link", button: "Button", img: "Image", input: "Field", textarea: "Field", select: "Menu", heading: "Heading", p: "Paragraph", li: "List item", table: "Table", video: "Video", other: "Content" } },
  };
  const t = () => state.language === "zh-CN" ? copy["zh-CN"] : copy.en;
  /** What an element is, in words the person uses ("Link"), not its tag or classes. */
  function kind(tag: string) {
    const k = t().kinds;
    if (/^h[1-6]$/.test(tag)) return k.heading;
    return (k as Record<string, string>)[tag] ?? k.other;
  }
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const supported = () => /^https?:/.test(location.href);
  const draftKey = (anchor: AnnotationAnchor) => anchor.selector;
  const short = (s: string, n = 160) => s.length > n ? `${s.slice(0, n)}…` : s;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", content = ""): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag); el.className = className; el.textContent = content; return el;
  }
  function button(label: string, run: () => void, className = ""): HTMLButtonElement {
    const b = node("button", className, label); b.type = "button"; b.onclick = run; return b;
  }
  // The page's cursor says clicks now pick. An adopted sheet leaves the page's DOM untouched.
  let cursor: CSSStyleSheet | undefined;
  function setCursor(on: boolean) {
    try {
      if (!cursor) { cursor = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursor]; }
      cursor.replaceSync(on ? "*,*::before,*::after{cursor:crosshair!important}" : "");
    } catch { /* The page replaced its sheets: only the cursor is lost. */ }
  }
  function ensure() {
    if (host) return;
    host = node("div"); host.setAttribute("data-finx-annotations", "");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;color-scheme:light dark!important";
    root = host.attachShadow({ mode: "closed" });
    const style = node("style"); style.textContent = `
      :host{--bg:#fff;--fg:#20242c;--muted:#707782;--line:#e5e8ed;--wash:#f5f7fa;--blue:#2388f5;--blue-dark:#0967cb;--red:#d35c59;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg)}
      @media(prefers-color-scheme:dark){:host{--bg:#25272d;--fg:#f1f3f7;--muted:#a3a9b5;--line:#424650;--wash:#30333a;--red:#f07b78}}
      *{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer;color:inherit;border:0;background:transparent;border-radius:8px;padding:7px 10px}button:hover{background:var(--wash)}button:focus-visible,textarea:focus-visible{outline:2px solid var(--blue);outline-offset:2px}button:disabled{opacity:.45;cursor:default}button:disabled:hover{background:transparent}
      .highlight{position:fixed;border:2px solid var(--blue);background:#2388f512;border-radius:5px;pointer-events:none;display:none}
      .highlight span{position:absolute;left:-2px;bottom:100%;margin-bottom:4px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--blue);color:#fff;font:600 11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 6px;border-radius:4px}
      .highlight.low span{bottom:auto;top:100%;margin:4px 0 0}
      .pin,.draft-pin{position:fixed;pointer-events:auto;width:26px;height:26px;border-radius:13px 13px 13px 3px;border:2px solid #fff;background:var(--blue);color:#fff;font-size:11px;font-weight:650;padding:0;box-shadow:0 2px 8px #0003;transform:translate(-5px,-21px);transition:scale .1s}
      .pin{cursor:default}.pin:hover{background:var(--blue)}
      .draft-pin{background:var(--bg);color:var(--blue);border:2px dashed var(--blue);font-size:14px;line-height:1}.draft-pin:hover,.draft-pin.active{background:var(--blue-dark);color:#fff;scale:1.12}
      .toast{position:fixed;left:50%;bottom:16px;translate:-50% 0;max-width:calc(100vw - 32px);pointer-events:none;background:var(--bg);color:var(--red);border:.5px solid var(--line);border-radius:8px;padding:6px 12px;font-size:12px;box-shadow:0 4px 18px #0002;animation:appear .12s ease-out}
      .card{position:fixed;width:296px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;pointer-events:auto;background:var(--bg);color:var(--fg);border:.5px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 10px 32px #00000030,0 1px 3px #0000001a;animation:appear .12s ease-out}
      .head{display:flex;align-items:flex-start;gap:8px}
      .kind{flex:none;font-size:11px;font-weight:600;line-height:18px;padding:0 6px;border-radius:4px;color:var(--blue);background:#2388f51c}
      .quote{flex:1;min-width:0;font-size:12.5px;line-height:18px;color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.quote.lost{color:var(--red)}
      .close{flex:none;width:20px;height:20px;padding:0;margin:-1px -3px 0 0;border-radius:5px;font-size:15px;line-height:20px;color:var(--muted)}
      textarea{display:block;resize:none;min-height:56px;max-height:40vh;width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:var(--wash);color:var(--fg);margin:10px 0 8px;line-height:1.55;font-size:13px}textarea::placeholder{color:var(--muted)}textarea:focus{outline:0;border-color:var(--blue);background:var(--bg)}
      .footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.add{background:var(--blue);color:#fff;font-size:12.5px;font-weight:600;line-height:18px;padding:4px 12px;border-radius:7px}.add:hover{background:var(--blue-dark)}.add:disabled:hover{background:var(--blue)}
      .status{font-size:11px;color:var(--muted);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.error{color:var(--red)}.over{color:#d98a12}
      @keyframes appear{from{opacity:0;translate:0 3px}to{opacity:1;translate:0 0}}@media(prefers-reduced-motion:reduce){.card{animation:none}.pin,.draft-pin{transition:none}}
    `;
    highlight = node("div", "highlight"); highlightLabel = node("span"); highlight.append(highlightLabel);
    markers = node("div"); tray = node("div");
    // Keys typed in the editor stay out of the page's shortcuts (e.g. "/" to search).
    for (const name of ["keydown", "keyup", "keypress"] as const) root.addEventListener(name, (e) => e.stopPropagation());
    root.append(style, highlight, markers, tray); document.documentElement.append(host);
  }
  function selector(el: Element): string {
    const parts: string[] = [];
    for (let current: Element | null = el; current && current !== document.documentElement; current = current.parentElement) {
      if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
      const siblings: Element[] = Array.from(current.parentElement?.children ?? []).filter((s) => s.localName === current!.localName);
      parts.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return parts.join(" > ") || "html";
  }
  /** The outline's label: what the element is, and the start of its text. */
  function describe(el: Element) {
    const words = text(el) || (el.getAttribute("alt") ?? el.getAttribute("aria-label") ?? "").trim();
    return words ? `${kind(el.localName)} · ${short(words, 24)}` : kind(el.localName);
  }
  function point(el: Element, a: AnnotationAnchor) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * a.x, y: r.top + r.height * a.y, visible: r.width > 0 && r.height > 0 };
  }
  function place(pin: HTMLElement, spot: Spot | undefined) {
    const p = spot?.element?.isConnected ? point(spot.element, spot.anchor) : null;
    pin.hidden = !p || !p.visible || p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight;
    if (p) { pin.style.left = `${p.x}px`; pin.style.top = `${p.y}px`; }
  }
  function positionCard() {
    if (!card || !editing) return;
    const w = card.offsetWidth, h = card.offsetHeight;
    const p = editing.element?.isConnected ? point(editing.element, editing.anchor) : { x: innerWidth / 2 - w / 2 - 20, y: innerHeight / 3 };
    // Beside the spot, on whichever side has room, so the card never covers what it is about.
    let x = p.x + 20;
    if (x + w > innerWidth - 12 && p.x - w - 20 >= 12) x = p.x - w - 20;
    let y = p.y - 12;
    if (y + h > innerHeight - 12) y = innerHeight - h - 12;
    x = Math.max(12, Math.min(innerWidth - w - 12, x)); y = Math.max(12, y);
    card.style.left = `${x}px`; card.style.top = `${y}px`;
  }
  function refresh() {
    frame = 0;
    if (!host || !state.enabled) return;
    const r = hover?.isConnected ? hover.getBoundingClientRect() : null;
    highlight.style.display = r ? "block" : "none";
    if (r) {
      Object.assign(highlight.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      highlight.classList.toggle("low", r.top < 26);
    }
    for (const pin of Array.from(markers.children) as HTMLButtonElement[]) {
      if (pin.dataset.draft) {
        place(pin, drafts.get(pin.dataset.draft));
        pin.classList.toggle("active", !!editing && draftKey(editing.anchor) === pin.dataset.draft);
      } else place(pin, added[Number(pin.dataset.index)]);
    }
    positionCard();
  }
  function schedule() { if (state.enabled && !frame) frame = requestAnimationFrame(refresh); }
  function showNotice(text: string) {
    if (notice) clearTimeout(notice.timer);
    notice = { text, timer: window.setTimeout(() => { notice = null; render(); }, 4000) };
    render();
  }
  /** Keep what was typed: an unsent draft shows as a dashed marker the person can come back to. */
  function stash() {
    if (!editing || !input) return;
    if (input.value.trim()) drafts.set(draftKey(editing.anchor), { ...editing, body: input.value });
    else drafts.delete(draftKey(editing.anchor));
  }
  function dropCard() { card?.remove(); card = null; input = null; editing = null; status = null; }
  function closeEditor() {
    if (pending) return;
    stash(); dropCard(); render();
  }
  function openEditor(anchor: AnnotationAnchor, element: Element | null) {
    if (pending) return;
    if (card) { stash(); dropCard(); }
    editing = { anchor, element };
    card = node("form", "card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-label", t().title);
    const close = button("×", closeEditor, "close"); close.setAttribute("aria-label", t().cancel); close.title = t().cancel;
    // What was picked: its kind, and its text (two lines at most), so the person sees what the note is about.
    const quote = node("div", element ? "quote" : "quote lost", element ? anchor.text || kind(anchor.tag) : t().noMatch);
    quote.title = anchor.text;
    const head = node("div", "head"); head.append(node("span", "kind", kind(anchor.tag)), quote, close);
    input = node("textarea"); input.placeholder = t().placeholder; input.setAttribute("aria-label", t().title); input.maxLength = maxComment;
    input.value = drafts.get(draftKey(anchor))?.body ?? "";
    const footer = node("div", "footer");
    status = node("span", "status", t().shortcut); status.setAttribute("role", "status");
    const add = node("button", "add", t().add); add.type = "submit";
    footer.append(status, add);
    const sync = () => {
      const n = input!.value.length;
      // The textarea grows with the text, up to its maximum height.
      input!.style.height = "auto"; input!.style.height = `${input!.scrollHeight}px`;
      if (status && !pending && !status.classList.contains("error")) {
        status.textContent = n > maxComment * .8 ? `${n.toLocaleString()} / ${maxComment.toLocaleString()}` : t().shortcut;
        status.className = n >= maxComment ? "status over" : "status";
      }
      positionCard();
    };
    input.oninput = () => { status?.classList.remove("error"); sync(); };
    input.onkeydown = (event) => {
      if (event.isComposing || event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault(); void submit();
    };
    card.append(head, input, footer); card.onsubmit = (e) => { e.preventDefault(); void submit(); };
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const controls = Array.from(card!.querySelectorAll<HTMLElement>("button:not(:disabled),textarea:not(:disabled)"));
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    root.append(card); sync(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    render();
  }
  async function submit() {
    if (!editing || !input || pending) return;
    pending = true;
    const spot = editing, body = input.value;
    card?.querySelectorAll("button").forEach((b) => b.disabled = true);
    input.disabled = true; if (status) { status.textContent = t().adding; status.className = "status"; }
    try {
      // The picture taken of it shows the page, not this UI over it.
      const r = spot.element?.isConnected ? spot.element.getBoundingClientRect() : null;
      const box = r && { x: r.left, y: r.top, width: r.width, height: r.height };
      if (box) { host!.style.setProperty("visibility", "hidden", "important"); await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); }
      try { await ipcRenderer.invoke("browser-annotation", { action: "chat", url: state.url, anchor: spot.anchor, body, box }); }
      finally { host!.style.removeProperty("visibility"); }
      pending = false; dropCard(); drafts.delete(draftKey(spot.anchor));
      // The numbered marker and the card in the composer say it was added.
      added.push({ ...spot, body: body.trim() });
      render();
    } catch {
      pending = false;
      card?.querySelectorAll("button").forEach((b) => b.disabled = false);
      if (input) { input.disabled = false; input.focus(); }
      if (status) { status.textContent = t().failed; status.className = "status error"; }
    }
  }
  function render() {
    ensure(); host!.style.setProperty("display", state.enabled ? "block" : "none", "important");
    setCursor(state.enabled);
    if (!state.enabled) return;
    markers.replaceChildren();
    added.forEach((a, i) => {
      const pin = node("button", "pin", String(i + 1)); pin.type = "button"; pin.tabIndex = -1; pin.dataset.index = String(i);
      pin.title = a.body ? `${t().sent} · ${short(a.body)}` : t().sent; pin.setAttribute("aria-label", pin.title); markers.append(pin);
    });
    for (const [key, d] of drafts) {
      const pin = button("✎", () => openEditor(d.anchor, d.element?.isConnected ? d.element : null), "draft-pin");
      pin.dataset.draft = key; pin.setAttribute("aria-label", `${t().draft}: ${short(d.body)}`); pin.title = `${t().draft}\n${short(d.body)}`;
      markers.append(pin);
    }
    // Nothing stays at the bottom of the page: the toolbar's button and Esc leave; only a failure is said here.
    tray.replaceChildren();
    if (notice) {
      const toast = node("div", "toast", notice.text);
      toast.setAttribute("role", "alert");
      tray.append(toast);
    }
    schedule();
  }
  function accept(next: AnnotationState) {
    if (next.url !== location.href) return;
    if (state.url !== next.url) {
      pending = false; dropCard(); drafts.clear(); added = []; if (notice) clearTimeout(notice.timer); notice = null;
    }
    state = next; if (!state.enabled) { hover = null; closeEditor(); } render();
  }
  function exit() {
    if (pending) return;
    closeEditor();
    void ipcRenderer.invoke("browser-annotation", { action: "exit", url: state.url }).then(accept).catch(() => showNotice(t().readError));
  }
  const ownEvent = (e: Event) => !!host && e.composedPath().includes(host);
  const pickTarget = (raw: EventTarget | null): Element | null => {
    if (!(raw instanceof Element)) return null;
    return raw.hasAttribute("data-finx-translation") ? raw.parentElement : raw;
  };
  // On the window, in the capture phase, before anything the page registers: the preload runs first.
  window.addEventListener("pointermove", (e) => {
    if (!state.enabled) return;
    const next = ownEvent(e) ? null : pickTarget(e.target);
    if (next === hover) return;
    hover = next; if (hover) highlightLabel.textContent = describe(hover);
    schedule();
  }, true);
  // Leaving the window clears the outline rather than leaving it on the last element.
  window.addEventListener("mouseout", (e) => { if (!e.relatedTarget && hover) { hover = null; schedule(); } }, true);
  for (const name of ["pointerdown", "mousedown", "mouseup", "pointerup", "click", "dblclick", "auxclick"] as const) {
    window.addEventListener(name, (e: MouseEvent) => {
      if (!state.enabled || ownEvent(e) || e.button !== 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (name !== "click" || pending) return;
      const el = pickTarget(e.target);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const anchor = { selector: selector(el), text: text(el), tag: el.localName,
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))), y: Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1))) };
      // Coming back to an element with an unsent draft reopens that draft where it was left.
      openEditor(drafts.get(draftKey(anchor))?.anchor ?? anchor, el);
    }, true);
  }
  window.addEventListener("keydown", (e) => {
    if (!state.enabled || e.isComposing || e.key !== "Escape") return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (card) closeEditor(); else exit();
  }, true);
  window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
  ipcRenderer.on("browser-annotation-state", (_event, next: AnnotationState) => accept(next));
  window.addEventListener("DOMContentLoaded", () => {
    const observer = new MutationObserver((mutations) => {
      if (state.enabled && mutations.some((m) => m.target !== host && !host?.contains(m.target))) schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"], characterData: true });
    new ResizeObserver(schedule).observe(document.documentElement);
    if (supported()) void ipcRenderer.invoke("browser-annotation", { action: "read", url: location.href }).then(accept).catch(() => {});
  }, { once: true });
  initBrowserTranslation();
}
