import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionView } from "@finx/client";
import { cellTarget, docsOf, lockedPath, type DocOpener } from "../docs/state";
import { FilePanel } from "../files/FilePanel";
import { filesChanged, isPasswordError, lockedOut, setFilesConnection, showDoc, useDocEvents } from "../files/state";
import { Icon } from "../icons";
import { useStore } from "../store";
import { BrowserPanel, useBrowserTabs } from "./Browser";
import { bringBrowserBack, browserPutAway, putBrowserAway, sidePanelLayout } from "./browserPanel";
import { recheckFiles } from "./scope";

// The file panel, PDFs included, and the browser beside a conversation: what a session's page and
// a bot's page share. They can stay open side by side (e.g. a link opened from a Markdown file).

export type SidePanels = ReturnType<typeof useSidePanels>;

/** At least this wide, the window keeps the sidebar beside the conversation and the file panel. */
const roomForAll = 1600;
/** The sidebar was put away for the file panel, to come back with it; or the person brought it back while a file was open, and it stays from then on. */
let tucked = false;
let keptOut = false;

/**
 * A file opened beside the conversation puts the sidebar away, when the window has no room for all
 * three, and the last file closed brings it back; the person bringing it back meanwhile is final.
 */
function useSidebarForFiles(files: boolean) {
  const st = useStore();
  useEffect(() => {
    if (files && st.sidebar && !keptOut && st.width < roomForAll) {
      tucked = true;
      st.set({ sidebar: false });
    } else if (!files && tucked) {
      tucked = false;
      st.set({ sidebar: true });
    }
  }, [files]);
  useEffect(() => {
    if (files && tucked && st.sidebar) (tucked = false), (keptOut = true);
  }, [st.sidebar]);
}

/** `held`: another panel of the page (a session's background panel) has the place now. */
export function useSidePanels(session: string, view: SessionView | null, held = false) {
  const st = useStore();
  const tabs = useBrowserTabs().filter((t) => t.session === session);
  const cwd = view?.info.cwd;
  useDocEvents(st.rpc, session, cwd);
  // The file panel (file-panel-design §3.1), its PDFs too (document-editor-design §7.1), and the browser can stay open side by side.
  const { files, browser, filesMax, browserMax, max, dual } = sidePanelLayout({
    files: st.files,
    filesMax: st.filesMax,
    browser: st.browser,
    browserMax: st.browserMax,
    hasView: !!view,
    hasTabs: tabs.length > 0,
    held,
  });
  useSidebarForFiles(files);
  const rpc = st.rpc;
  const opener = useMemo<DocOpener | null>(() => {
    if (!rpc || !cwd) return null;
    const id = session;
    return {
      session: id,
      open: (what, anchor, target) =>
        void st.run(async () => {
          const cells = target ? cellTarget(target) : null;
          const shown = await showDoc(st, id, cwd, what, cells ?? anchor);
          // A citation's block or page, once its document is open in the session (not while it asks for its password).
          if (shown && target && !cells && "doc_id" in what) {
            try {
              const r = await rpc.request("doc/locate", { session_id: id, doc_id: what.doc_id, target });
              await showDoc(st, id, cwd, what, r.anchor);
            } catch (e) {
              // Its file changed and wants its password again: the tab asks for it, not a toast.
              if (!(await lockedOut(id, what.doc_id, e))) throw e;
            }
          }
        }),
      locate: async (docId, target) => {
        const known = docsOf(id).tabs.find((t) => t.info.doc_id === docId)?.info.path;
        try {
          // A hover must not bring the column out: finx opens the document, the column stays as it is.
          const path = known ?? (await rpc.request("doc/open", { session_id: id, doc_id: docId })).info.path;
          const cells = cellTarget(target);
          if (cells) {
            const got = await rpc.request("doc/cells", { session_id: id, doc_id: docId, sheet: cells.sheet, range: cells.range });
            const text = got.cells.slice(0, 6).map((c) => `${c.cell} = ${c.text || "(empty)"}`).join("\n");
            return { anchor: { ...cells, text }, path };
          }
          const r = await rpc.request("doc/locate", { session_id: id, doc_id: docId, target });
          return { anchor: r.anchor, path };
        } catch (e) {
          // Encrypted, its password not given yet (or changed): still there, a click asks for it.
          const path = lockedPath(e) ?? (isPasswordError(e) ? known : null);
          return path ? { locked: true, path } : null;
        }
      },
    };
  }, [rpc, session, cwd]);
  // The first page the conversation opens brings the browser panel out, unless the person put it away here.
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (!hasTabs) return;
    if (browserPutAway(session)) {
      if (st.browser) st.set({ browser: false, browserMax: false });
      return;
    }
    // Not over the panels the person opened.
    if (!st.files && !st.background) st.set({ browser: true });
  }, [hasTabs, session]);
  // What finx says changed on disk reaches the file panel's files, whichever session they are in.
  useEffect(() => {
    setFilesConnection(st.rpc);
    return st.rpc?.on("files/changed", (p) => filesChanged(p.session_id, p.paths));
  }, [st.rpc]);
  // A task that ended may have made or removed the files the replies point at.
  const ended = view?.entries.filter((e) => e.type === "task_end").length ?? 0;
  useEffect(() => recheckFiles(), [ended]);
  return { session, tabs, files, browser, filesMax, browserMax, max, dual, opener };
}

/** The buttons for them in the page's bar; while a panel is open its button sits at the panel's right end instead, where it puts the panel away. */
export function SidePanelButtons({ panels }: { panels: SidePanels }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const { session, tabs, files, browser } = panels;
  return (
    <>
      {/* A conversation with no pages yet gets a blank tab to start from. */}
      {window.finx && !browser && (
        <button
          className="tb"
          title={t("browser.builtIn")}
          aria-label={t("browser.builtIn")}
          aria-pressed={false}
          onClick={() => {
            bringBrowserBack(session);
            if (tabs.length > 0) st.set({ browser: true, browserMax: false, background: false, filesMax: false });
            else void st.run(async () => {
              await window.finx?.openBrowser(session);
              st.set({ browser: true, browserMax: false, background: false, filesMax: false });
            });
          }}
        >
          <Icon name="globe" />
        </button>
      )}
      {/* The conversation's folder and the files opened from it (file-panel-design §3.2). */}
      {!files && (
        <button
          className="tb"
          title={t("files.title")}
          aria-label={t("files.title")}
          aria-pressed={false}
          onClick={() => {
            st.set({ files: true, filesMax: false, browserMax: false, background: false });
          }}
        >
          <Icon name="folder" />
        </button>
      )}
    </>
  );
}

/** The panels that are open, beside the page's column. */
export function SidePanelViews({ panels, view }: { panels: SidePanels; view: SessionView | null }) {
  const st = useStore();
  const { session, tabs, files, browser, filesMax, browserMax, dual } = panels;
  return (
    <>
      {files && view && (
        <FilePanel
          session={session}
          cwd={view.info.cwd}
          max={filesMax}
          onMax={(m) => st.set({ filesMax: m, ...(m && { browserMax: false }) })}
          onClose={() => st.set({ files: false, filesMax: false })}
        />
      )}
      {browser && !filesMax && (
        <BrowserPanel
          session={session}
          tabs={tabs}
          max={browserMax}
          dual={dual}
          onMax={(m) => st.set({ browserMax: m, ...(m && { filesMax: false }) })}
          onClose={() => {
            putBrowserAway(session);
            st.set({ browser: false, browserMax: false });
          }}
        />
      )}
    </>
  );
}
