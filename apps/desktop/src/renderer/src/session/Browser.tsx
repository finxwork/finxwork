import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserStill, BrowserTab, BrowserTabCommand } from "../../../shared/bridge";
import { SidebarToggle } from "../components";
import { Icon } from "../icons";
import { useCovered } from "../overlays";
import { usePanelWidth } from "../panelWidth";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { allEngines, type SearchEngine } from "../../../shared/search";
import { EngineIcon } from "../settings/BuiltInBrowser";
import { BrowserMenu } from "./BrowserMenu";
import { BrowserPdfView } from "./BrowserPdfView";
import { NewTabPage } from "./NewTabPage";

// The embedded browser's panel (browser-design §8.3.4), drawn as a browser: the session's
// tabs and a new-tab button on top, then back, forward, reload and the address, and below
// them the room where the main process lays the tab's own view. The page itself never draws
// a website: it only says where the room is. What the person does here takes the tab over
// from the agent, whose next call finds the page changed.

/** The embedded browser's tabs, as the main process has them. */
export function useBrowserTabs(): BrowserTab[] {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  useEffect(() => {
    // The web build has no main process, and so no embedded browser.
    const finx = window.finx;
    if (!finx) return;
    let live = true;
    void finx.browserTabs().then((t) => live && setTabs(t));
    const off = finx.onBrowserTabs(setTabs);
    return () => {
      live = false;
      off();
    };
  }, []);
  return tabs;
}

/** A blank page: the address field shows empty, the tab "New tab". */
const blank = (url: string) => url === "" || url === "about:blank";

const command = (t: BrowserTab | undefined, c: BrowserTabCommand) => t && window.finx?.browserTabCommand(t.targetId, c);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** What the conversation keeps beside the panel at least: a strip, as the person may want the page most of the window. */
const conversationRoom = () => 160;

/**
 * `max`: the panel takes the window but the sidebar, the conversation set aside; its strip
 * then starts with the sidebar's toggle when the sidebar is hidden, as the conversation's bar
 * does.
 */
export function BrowserPanel({ session, tabs, max, dual = false, onMax, onClose }: { session: string; tabs: BrowserTab[]; max: boolean; dual?: boolean; onMax: (max: boolean) => void; onClose: () => void }) {
  const { t } = useTranslation("session");
  const room = useRef<HTMLDivElement>(null);
  const { panel, width, resizing, style, grip } = usePanelWidth("finxwork.browserPanelWidth", () => conversationRoom() + (dual ? 280 : 0));
  const current = tabs.find((x) => x.shown) ?? tabs[tabs.length - 1];
  /** What the person is typing in the address field; null shows the tab's address. */
  const [draft, setDraft] = useState<string | null>(null);
  const address = useRef<HTMLInputElement>(null);
  /** The engine picked by its keyword (keyword, then Tab or Space): what is typed is searched with it. */
  const [keyword, setKeyword] = useState<SearchEngine | null>(null);
  const [engines, setEngines] = useState<SearchEngine[]>(() => allEngines());
  // The engine a keyword being typed would pick: shown as a hint, taken with Tab.
  const typed = draft?.trim().toLowerCase() ?? "";
  const hinted = !keyword && typed.length >= 2 && !/\s/.test(typed) ? engines.find((e) => e.keyword.toLowerCase().startsWith(typed)) : undefined;
  // A blank tab the person opened waits for an address. One the agent opened leaves the keyboard alone.
  const currentId = current?.targetId;
  const currentBlank = current ? blank(current.url) : false;
  useEffect(() => {
    setDraft(null);
    if (currentBlank && current?.asksAddress) address.current?.focus();
  }, [currentId]);
  /** The person is in the address field: main keeps the agent's new tabs from taking the panel. */
  const [editing, setEditing] = useState(false);
  // A dialog, the search palette or the settings' dim is over the window: the tab steps aside,
  // a picture of it in its place.
  const covered = useCovered();
  const [still, setStill] = useState<BrowserStill | null>(null);
  useEffect(() => window.finx?.onBrowserStill((s) => s.session === session && setStill(s)), [session]);

  // Where the tab's view goes, in window coordinates; reported again as it moves or resizes.
  const pdfBilingual = !!(current?.isPdf && current?.translating);
  useLayoutEffect(() => {
    const el = room.current;
    const finx = window.finx;
    if (!el || !finx) return;
    if (covered || pdfBilingual) {
      finx.setBrowserPanel({ session, rect: null, hold: covered });
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      finx.setBrowserPanel({ session, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, editing });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [session, covered, pdfBilingual, editing, dual]);
  // Gone (another session, or the panel closed): no room for a tab here.
  useEffect(() => () => window.finx?.setBrowserPanel({ session: null, rect: null }), [session]);

  return (
    <aside
      ref={panel}
      className={`bgp brp ${max ? "max" : width !== null ? "sized" : ""} ${resizing ? "resizing" : ""}`}
      style={style(max)}
      aria-label={t("browser.title")}
    >
      <div className="brp-strip drag">
        {max && <SidebarToggle />}
        <div className="brp-tabs" role="tablist">
          {tabs.map((x) => {
            const on = x.targetId === current?.targetId;
            // A page without a title of its own shows its URL as one: name it by its host.
            const untitled = !x.title || x.title === x.url || blank(x.title);
            const name = blank(x.url) ? t("browser.newTab") : untitled ? hostOf(x.url) || x.url : x.title;
            return (
              <div key={x.targetId} role="tab" aria-selected={on} className={`brp-tab no-drag ${on ? "on" : ""}`} title={x.url || name} onClick={() => window.finx?.showBrowserTab(x.targetId)}>
                {/* Loading, the spinner; then the site's icon (browser-design §10.2), as a browser's tab shows. */}
                {x.loading ? (
                  <span className="mini-spin" aria-hidden="true" />
                ) : (
                  !blank(x.url) && <SiteIcon origin={siteOrigin(x.url)} className="brp-tab-ic" fallback={<Icon name="globe" />} />
                )}
                <span className="brp-tab-t">{name}</span>
                <button
                  className="brp-tab-x"
                  aria-label={t("browser.closeTab", { name })}
                  title={t("browser.closeTab", { name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    command(x, { command: "close" });
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>
            );
          })}
        </div>
        <button className="tb no-drag" aria-label={t("browser.newTab")} title={t("browser.newTab")} onClick={() => command(current, { command: "new" })}>
          <Icon name="plus" />
        </button>
        <BrowserMenu targetId={current?.targetId ?? null} />
        <button className="tb" aria-label={max ? t("browser.restore") : t("browser.maximize")} title={max ? t("browser.restore") : t("browser.maximize")} onClick={() => onMax(!max)}>
          <Icon name={max ? "shrink" : "expand"} />
        </button>
        {/* The page bar's Browser button, moved here while the panel is open: it puts the panel away, its tabs kept. */}
        <button className="tb on" aria-label={t("browser.hide")} title={t("browser.hide")} aria-pressed onClick={onClose}>
          <Icon name="globe" />
        </button>
      </div>
      <div className="brp-bar">
        <button className="tb" aria-label={t("browser.back")} title={t("browser.back")} disabled={!current?.canGoBack} onClick={() => command(current, { command: "back" })}>
          <Icon name="arrowLeft" />
        </button>
        <button className="tb" aria-label={t("browser.forward")} title={t("browser.forward")} disabled={!current?.canGoForward} onClick={() => command(current, { command: "forward" })}>
          <Icon name="arrowRight" />
        </button>
        {current?.loading ? (
          <button className="tb" aria-label={t("browser.stop")} title={t("browser.stop")} onClick={() => command(current, { command: "stop" })}>
            <Icon name="x" />
          </button>
        ) : (
          <button className="tb" aria-label={t("browser.reload")} title={t("browser.reload")} disabled={!current} onClick={() => command(current, { command: "reload" })}>
            <Icon name="retry" />
          </button>
        )}
        <button className={`brp-annotate ${current?.annotating ? "on" : ""}`} aria-pressed={!!current?.annotating}
          disabled={!current?.domReady || !/^https?:/.test(current.url)}
          title={t("browser.annotate")} aria-label={t("browser.annotate")} onClick={() => command(current, { command: "annotate" })}>
          <Icon name="edit" />
        </button>
        <button className={`brp-annotate brp-translate ${current?.translating ? "on" : ""}`} aria-pressed={!!current?.translating}
          disabled={!current?.domReady || !/^https?:/.test(current.url)}
          title={t("browser.translate")} aria-label={t("browser.translate")} onClick={() => command(current, { command: "translate" })}>
          <Icon name="translate" />
        </button>
        <form
          className="brp-addr"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft !== null && draft.trim()) command(current, { command: "go", url: draft, ...(keyword && { engine: keyword.id }) });
            setDraft(null);
            setKeyword(null);
            address.current?.blur();
          }}
        >
          {keyword && (
            <span className="brp-keyword">
              <EngineIcon engine={keyword} />
              {t("browser.searchWith", { name: keyword.name })}
            </span>
          )}
          <input
            ref={address}
            className="brp-url"
            aria-label={t("browser.address")}
            placeholder={keyword ? "" : t("browser.typeUrl")}
            spellCheck={false}
            value={draft ?? (keyword ? "" : current && !blank(current.url) ? current.url : "")}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              e.currentTarget.select();
              setEditing(true);
              // The person's engines may have changed in the settings meanwhile.
              void window.finx?.getPreferences().then((p) => setEngines(allEngines(p.searchEngines)));
            }}
            onBlur={() => {
              setEditing(false);
              setDraft(null);
              setKeyword(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(null);
                setKeyword(null);
                e.currentTarget.blur();
                return;
              }
              // Tab takes the hinted engine; Space after a whole keyword does too, as in Chrome.
              const whole = !keyword && engines.find((x) => x.keyword.toLowerCase() === typed);
              const pick = e.key === "Tab" && !e.shiftKey ? hinted : e.key === " " ? whole : undefined;
              if (pick && e.currentTarget.selectionStart === e.currentTarget.value.length) {
                e.preventDefault();
                setKeyword(pick);
                setDraft("");
                return;
              }
              // Backspace at the start leaves keyword mode, with the keyword back as text.
              if (keyword && e.key === "Backspace" && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
                e.preventDefault();
                setDraft(keyword.keyword + (draft ?? ""));
                setKeyword(null);
              }
            }}
          />
          {hinted && (
            <span className="brp-hint" aria-live="polite">
              {t("browser.tabToSearch", { name: hinted.name })}
            </span>
          )}
        </form>
      </div>
      <div className="brp-view" ref={room}>
        {/* Keyed by tab: each new tab looks again. */}
        {current && currentBlank && !current.loading && <NewTabPage key={current.targetId} open={(url) => command(current, { command: "go", url })} />}
        {current && pdfBilingual && !covered && (
          <BrowserPdfView key={`${current.targetId}:${current.url}`} targetId={current.targetId} url={current.url} title={current.title} />
        )}
        {covered && still && !currentBlank && <img className="brp-still" src={still.image} style={{ width: still.width }} alt="" />}
      </div>
      {/* Last: the window's drag areas are laid in page order, and the edge must win over the tab strip's. */}
      {!max && <div className="brp-grip no-drag" role="separator" aria-orientation="vertical" aria-label={t("browser.resize")} tabIndex={0} {...grip} />}
    </aside>
  );
}
