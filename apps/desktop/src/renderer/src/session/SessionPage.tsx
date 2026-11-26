import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { displayTitle, runningAgents, type ListSession } from "@finx/client";
import { SidebarToggle } from "../components";
import { GlassBar } from "../glass";
import { Icon } from "../icons";
import { DocContext } from "../docs/state";
import { layoutOf, setCard } from "../layout";
import { useStore } from "../store";
import { Background } from "./Background";
import { Chat } from "./Chat";
import { selectionMenu } from "./contentMenus";
import { SelectionBar } from "./SelectionBar";
import { Inspector } from "./Inspector";
import { ContentScope } from "./scope";
import { SidePanelButtons, SidePanelViews, useSidePanels } from "./SidePanels";
import { useSession } from "./useSession";
import { useYours, YoursButton } from "./Yours";

// A session: its conversation, the composer and the bar of a running task,
// with the info card over its right side, or in its place the background
// card once it has sub-agents; the browser as a column of its own.
export function SessionPage({ s }: { s: ListSession }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const [view, loadEarlier] = useSession(s.session_id);
  const agents = view?.agents.length ?? 0;
  const running = view ? runningAgents(view).length : 0;
  const background = st.background && agents > 0;
  const cwd = view?.info.cwd;
  const panels = useSidePanels(s.session_id, view, background);
  const { browser, files, max, dual } = panels;
  const layout = layoutOf(st);
  const info = layout.card !== "hidden" && !background && !browser && !files;
  const yours = useYours(s.session_id, view);
  // The background card keeps the conversation clear of it as the info card does, when there is room for one.
  const dock = (info && layout.card === "docked") || (background && layoutOf({ ...st, inspector: true, peek: null }).card === "docked");
  // What the conversation's content belongs to (content-actions-design §3.4): its paths are under the session's folder.
  const scope = useMemo(() => (cwd ? { session: s.session_id, cwd } : null), [s.session_id, cwd]);
  // `/context` answered: the card shows, its context section open.
  const asked = view?.asked?.at;
  useEffect(() => {
    if (asked === undefined) return;
    setCard(st, true);
    st.set({ contextOpen: true });
  }, [asked]);
  return (
    <DocContext.Provider value={panels.opener}>
    <div className={`spage ${browser || files ? "bgopen" : ""} ${dual ? "dual" : ""} ${max ? "brmax" : ""}`}>
      <div className="scol">
        <GlassBar className="ctool drag">
          <SidebarToggle />
          {/* The title moves the window like the rest of the bar; renaming lives in the sidebar. */}
          <div className="ctitle">
            <h2 title={displayTitle(s)}>{displayTitle(s)}</h2>
          </div>
          {/* A toolbar button as the sidebar's toggle is, highlighted while the info shows. */}
          <button
            className={`tb ${info ? "on" : ""}`}
            title={t("page.infoTip")}
            aria-label={t("page.info")}
            aria-pressed={info}
            onClick={() => setCard(st, !info)}
          >
            <Icon name="sessionInfo" />
          </button>
          {/* The background panel's button, with how many tasks run; only for a session that has some. */}
          {agents > 0 && (
            <button
              className={`tb ${background ? "on" : ""}`}
              title={t("background.title")}
              aria-label={t("background.title")}
              aria-pressed={background}
              onClick={() => st.set({ background: !background })}
            >
              <Icon name="layers" />
              {running > 0 && <span className="tb-badge">{running}</span>}
            </button>
          )}
          {/* The user's own browser, in the info card, or here while that does not show. */}
          {yours && !info && <YoursButton yours={yours} sessionId={s.session_id} />}
          <SidePanelButtons panels={panels} />
        </GlassBar>
          {/* The conversation keeps clear of the card beside it; a card over it (no room) leaves it be. */}
          <ContentScope value={scope}>
            {/* Right-click on selected text: Copy (anything with a menu of its own shows that instead). */}
            <div className={`dwrap ${dock ? "dock" : ""}`} onContextMenu={() => selectionMenu(st)}>
              <div className="dmain">{view ? <Chat s={s} view={view} loadEarlier={loadEarlier} /> : <div className="empty"><span className="mini-spin" /></div>}</div>
              {view && info && <Inspector s={s} view={view} yours={yours} />}
              {view && background && <Background s={s} view={view} />}
            </div>
            <SelectionBar />
          </ContentScope>
      </div>
      <SidePanelViews panels={panels} view={view} />
    </div>
    </DocContext.Provider>
  );
}
