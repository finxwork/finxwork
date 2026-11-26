import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { handedTabBlock, handedTabsBlock, listView, mergeBots, mergeSessions, RpcError, RpcClient, sortBots, type ListSession, type ListView } from "@finx/client";
import { draftThinking } from "./format";
import type { BotSummary, Methods, ModelsListResult, Op, PermissionMode, ServerCapabilities, ThinkingLevel, UserContent } from "@finx/protocol";
import type { KernelStatusView } from "../../shared/bridge";
import { i18n, language } from "../../shared/i18n";
import { modelsIn } from "../../shared/model-names";
import { toInput, type Attachment } from "./composer/attachments";
import { docChanged } from "./docs/state";
import { connect } from "./kernel";
import type { Peek } from "./layout";

// What the window knows: the session list as finx pushes it (P1, no
// polling), the models, and the window's own state (selection, list view,
// open sheet, toast). A session's conversation is its page's
// (session/useSession.ts).

export type Selection = { kind: "new" } | { kind: "session"; id: string } | { kind: "customize" } | { kind: "bot"; id: string };

/** Which of the two ways the window is used: projects and their sessions, or bots (bot-mode-design §6.1). */
export type Mode = "sessions" | "bots";

/** The form that makes a bot or changes its name and avatar (bot-mode-design §6.3). */
export type BotSheet = { kind: "new" };

/**
 * Where the 自定义 page is (customize-design §10.1): skills or connectors, the person's own or
 * the catalog, and a card's own page when one is open. A card's id is a skill's path or a
 * server's name; with `catalog`, an entry of the catalog not added yet.
 */
export type CustomizeView = {
  tab: "skills" | "connectors";
  view: "mine" | "discover";
  detail: { kind: "skill" | "connector"; id: string; catalog?: boolean; tab: string } | null;
};

export type Sheet = { kind: "confirm"; title: string; message: string; button: string; cancel?: string; run: () => Promise<unknown>; done?: string };

export type Toast = { text: string; undo?: () => void; bad?: boolean; id: number };

/** What a new session starts with, chosen on the new session page. */
/**
 * `thinking` is the level chosen on the page, `null` until one is: then the model's own;
 * `levels` the level last chosen on the page for each model (model-catalog-design §18).
 */
/** A new session's settings; `noProject` starts it without a project, else `cwd` (unset: the latest project). */
export type Draft = { cwd: string | null; noProject?: boolean; model: string | null; thinking: ThinkingLevel | null; levels?: Record<string, ThinkingLevel>; permission: PermissionMode };

type UI = {
  selection: Selection;
  mode: Mode;
  /** What each mode showed last, to go back to it (bot-mode-design §6.1). */
  lastSession: Selection;
  lastBot: string | null;
  botSheet: BotSheet | null;
  /** A bot's settings beside its conversation (bot-mode-design §6.5.1). */
  botPanel: boolean;
  /** A bot's routines beside its conversation, and which of them is open (bot-mode-design §6.21); null when closed. */
  botRoutines: { routine?: string; run?: string } | null;
  /** For each bot, the conversation that was last given bots' default permission mode: what is picked in it afterwards stays. */
  botDefaulted: Record<string, string>;
  /** The owner closed the note about Full Access above the composer, or opened a bot's settings (bot-mode-design §6.13). */
  botAccessSeen: boolean;
  /** The default bot's model has been set the first time (bot-mode-design §6.4). */
  botSetupDone: boolean;
  inspector: boolean;
  /** The context card is open (closed, it shows only the share used). */
  contextOpen: boolean;
  /** The background panel is shown, in the info card's place. */
  background: boolean;
  /** The sub-agent open in the background panel. */
  agent: string | null;
  /** The embedded browser's panel is shown for a session with tabs, in the same place. */
  browser: boolean;
  /** The browser's panel takes all of the window but the sidebar, the conversation set aside. */
  browserMax: boolean;
  /** The file panel is shown, in the same place (file-panel-design §3.1). */
  files: boolean;
  /** The file panel takes all of the window but the sidebar. */
  filesMax: boolean;
  sidebar: boolean;
  /** What shows over the conversation for now, there being no room for it beside it (layout.ts). */
  peek: Peek;
  view: ListView;
  /** The list shows archived sessions. */
  archived: boolean;
  /** Collapsed groups, as "grouping:key" (each grouping keeps its own). */
  collapsed: string[];
  searching: boolean;
  /** The session whose title is being edited in the list. */
  renaming: string | null;
  sheet: Sheet | null;
  toast: Toast | null;
  draft: Draft;
  customize: CustomizeView;
  /** Text the new session's composer starts with, taken once (自定义 › 在对话中使用). */
  prefill: string | null;
  /** A tab the person offered from their browser, for the next message sent. */
  offered: { target_id: string; url: string; title: string } | null;
};

const noModels: ModelsListResult = { models: [], providers: [] };

/** The window's connection: first connecting, ready, reconnecting after it ended, or down (finx failed to run). */
export type KernelState = "connecting" | "ready" | "reconnecting" | "down";

export type Store = UI & {
  rpc: RpcClient | null;
  kernel: KernelState;
  /** The service as the main process sees it; null in a browser preview. */
  status: KernelStatusView | null;
  /** finx's name and version as it introduced itself. */
  server: string;
  /** What finx says it can do, for features that are turned off in its configuration. */
  capabilities: ServerCapabilities | null;
  /**
   * The lists as they are now, for an action at the moment it runs. What draws from them reads them
   * with `useLists`, so it renders again when they change and only then.
   */
  lists: () => Lists;
  /** The window's width, which lays it out (layout.ts). */
  width: number;
  /** Models, providers with their keys, and the defaults of a new session. */
  models: ModelsListResult;
  set: (patch: Partial<UI>) => void;
  select: (id: string) => void;
  selectBot: (id: string) => void;
  /** Switches mode, back to what that mode showed last. */
  setMode: (mode: Mode) => void;
  /** Runs a change against finx; failures become a toast. Resolves to whether it worked. */
  run: (action: () => Promise<unknown>, done?: string) => Promise<boolean>;
  show: (text: string, undo?: () => void, bad?: boolean) => void;
  call: <M extends keyof Methods & string>(method: M, params: Methods[M][0]) => Promise<Methods[M][1]>;
  op: (sessionId: string, op: Op) => Promise<boolean>;
  /** Asks finx for the models again (after a key was saved or removed). */
  refreshModels: () => Promise<void>;
  /** The tab the person offered goes to this session, and the message says so. */
  giveOffered: (sessionId: string, input: UserContent[]) => Promise<void>;
  /** Starts a session as a new session's draft says, and sends it its first message (folders attached become more of its roots). */
  start: (text: string, d: Draft, attachments: Attachment[]) => Promise<boolean>;
};

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside FinxProvider");
  return s;
}

/**
 * The session list and the bots as finx pushes them (P1, no polling). They change many times a
 * second while tasks run, so they are kept apart from the store: a change to them renders again
 * only what reads them, each reader only when what it picked out changed (`useLists`), not the
 * whole window. 1000+ sessions and bots stay cheap to keep up to date.
 */
export type Lists = {
  sessions: ListSession[];
  /** The session list arrived. */
  loaded: boolean;
  /** Bot mode's bots, in the list's order. */
  bots: BotSummary[];
  botsLoaded: boolean;
};

class ListStore {
  private value: Lists = { sessions: [], loaded: false, bots: [], botsLoaded: false };
  private readonly subs = new Set<() => void>();
  readonly get = (): Lists => this.value;
  readonly subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };
  update(patch: (l: Lists) => Partial<Lists>) {
    this.value = { ...this.value, ...patch(this.value) };
    this.subs.forEach((f) => f());
  }
}

const ListsCtx = createContext<ListStore | null>(null);

/**
 * What a component draws from the lists: it renders again when `pick` gives something else
 * (compared with Object.is). Pick a list itself, one of its rows, or a plain value; work out
 * anything new from them with useMemo, as a new array or object each time would never settle.
 */
export function useLists<T>(pick: (l: Lists) => T): T {
  const lists = useContext(ListsCtx);
  if (!lists) throw new Error("useLists outside FinxProvider");
  return useSyncExternalStore(lists.subscribe, () => pick(lists.get()));
}

/** An error from finx, for the person. */
export function errorText(e: unknown): string {
  if (e instanceof RpcError) {
    if (e.kind === "disconnected") return i18n.t("common:kernel.down");
    if (e.kind === "model_unavailable") return i18n.t("common:model.unavailable");
    if (e.kind === "no_model") return i18n.t("common:model.none");
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

type Saved = Pick<UI, "selection" | "mode" | "lastSession" | "lastBot" | "botDefaulted" | "botAccessSeen" | "botSetupDone" | "sidebar" | "inspector" | "contextOpen" | "view" | "archived" | "collapsed"> & { draft: Partial<Draft>; customize?: CustomizeView };

function saved(): Partial<Saved> {
  if (location.hash.startsWith("#settings")) return {};
  try {
    const v: Partial<Saved> = JSON.parse(localStorage.getItem("main-view") ?? "{}");
    return { ...v, view: listView(v.view), collapsed: Array.isArray(v.collapsed) ? v.collapsed : undefined };
  } catch {
    return {};
  }
}

export function FinxProvider({ children }: { children: ReactNode }) {
  const [rpc, setRpc] = useState<RpcClient | null>(null);
  const [kernel, setKernel] = useState<KernelState>("connecting");
  const [status, setStatus] = useState<KernelStatusView | null>(null);
  const [server, setServer] = useState("");
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [lists] = useState(() => new ListStore());
  const [listedModels, setModels] = useState<ModelsListResult>(noModels);
  const models = useMemo(() => modelsIn(listedModels, language()), [listedModels]);
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [ui, setUI] = useState<UI>(() => {
    const s = saved();
    return {
      selection: s.selection ?? { kind: "new" },
      mode: s.mode === "sessions" ? "sessions" : s.mode === "bots" ? "bots" : (window.finx?.defaultMode ?? "bots"),
      lastSession: s.lastSession ?? { kind: "new" },
      lastBot: s.lastBot ?? null,
      botSheet: null,
      botPanel: false,
      botRoutines: null,
      botDefaulted: s.botDefaulted ?? {},
      botAccessSeen: s.botAccessSeen ?? false,
      botSetupDone: s.botSetupDone ?? false,
      inspector: s.inspector ?? true,
      contextOpen: s.contextOpen ?? true,
      background: false,
      agent: null,
      browser: false,
      browserMax: false,
      files: false,
      filesMax: false,
      sidebar: s.sidebar ?? true,
      peek: null,
      view: s.view ?? listView(),
      archived: s.archived ?? false,
      collapsed: s.collapsed ?? [],
      searching: false,
      renaming: null,
      sheet: null,
      toast: null,
      draft: { cwd: null, model: null, thinking: null, permission: "manual", ...s.draft },
      customize: s.customize ?? { tab: "skills", view: "discover", detail: null },
      prefill: null,
      offered: null,
    };
  });

  // finx's service as the main process's supervisor sees it (in the app; a
  // page in a browser runs its own mock, always ready).
  useEffect(() => {
    if (!window.finx) return;
    void window.finx.kernelStatus().then(setStatus);
    return window.finx.onKernelState(setStatus);
  }, []);
  const serviceReady = !window.finx || window.finx.kernel === "mock" || status?.state === "ready";

  // The window's own connection: made once the service is ready, and made
  // again whenever it ends (desktop-kernel-integration §6.2). Pages that
  // follow `rpc` attach again with fresh snapshots; drafts stay where they are.
  const client = useRef<RpcClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!serviceReady || client.current) return;
    let stop = false;
    connect()
      .then(({ rpc: c, server, capabilities }) => {
        if (stop) return;
        client.current = c;
        c.onClose(() => {
          if (client.current !== c) return;
          client.current = null;
          setRpc(null);
          setKernel("reconnecting");
          // The supervisor may not have noticed yet; try again shortly either way.
          setTimeout(() => setAttempt((n) => n + 1), 400);
        });
        setServer(server);
        setCapabilities(capabilities);
        setRpc(c);
      })
      .catch(() => {
        if (stop) return;
        setKernel("reconnecting");
        setTimeout(() => setAttempt((n) => n + 1), 1000);
      });
    return () => {
      stop = true;
    };
  }, [serviceReady, attempt]);

  // On each connection: the list from then on as finx pushes it, and the models.
  useEffect(() => {
    if (!rpc) return;
    let stop = false;
    const offModels = rpc.on("models/changed", () => { void rpc.request("models/list", {}).then(m => { if (!stop) setModels(m); }).catch(() => {}); });
    const off = rpc.on("sessions/changed", (c) => lists.update((l) => ({ sessions: mergeSessions(l.sessions, c.sessions, c.deleted ?? []) })));
    // A workbook edited, undone or saved anywhere: the grids showing it read it again.
    const offDocs = rpc.on("doc/changed", (p) => docChanged(p.info));
    Promise.all([rpc.request("sessions/subscribe", {}), rpc.request("models/list", {})])
      .then(([list, m]) => {
        if (stop) return;
        lists.update(() => ({ sessions: list.sessions, loaded: true }));
        setModels(m);
        setKernel("ready");
      })
      .catch(() => {});
    // The bots as well, as finx pushes them (bot-design §4).
    const offBots = rpc.on("bots/changed", (c) => lists.update((l) => ({ bots: sortBots(mergeBots(l.bots, c.bots, c.deleted ?? [])) })));
    rpc
      .request("bots/subscribe", {})
      .then((r) => {
        if (stop) return;
        lists.update(() => ({ bots: sortBots(r.bots), botsLoaded: true }));
      })
      .catch(() => {});
    return () => {
      stop = true;
      off();
      offModels();
      offDocs();
      offBots();
    };
  }, [rpc, lists]);
  const kernelState: KernelState = status?.state === "failed" ? "down" : kernel;

  useEffect(() => {
    if (location.hash.startsWith("#settings")) return;
    const v: Saved = { selection: ui.selection, mode: ui.mode, lastSession: ui.lastSession, lastBot: ui.lastBot, botDefaulted: ui.botDefaulted, botAccessSeen: ui.botAccessSeen, botSetupDone: ui.botSetupDone, sidebar: ui.sidebar, inspector: ui.inspector, contextOpen: ui.contextOpen, view: ui.view, archived: ui.archived, collapsed: ui.collapsed, draft: ui.draft, customize: ui.customize };
    try {
      localStorage.setItem("main-view", JSON.stringify(v));
    } catch {
      // The window's layout is a convenience; without storage it just doesn't stick.
    }
  }, [ui.selection, ui.mode, ui.lastSession, ui.lastBot, ui.botDefaulted, ui.botAccessSeen, ui.botSetupDone, ui.sidebar, ui.inspector, ui.contextOpen, ui.view, ui.archived, ui.collapsed, ui.draft, ui.customize]);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const set = useCallback((patch: Partial<UI>) => setUI((u) => ({ ...u, ...patch })), []);
  const select = useCallback((id: string) => setUI((u) => ({ ...u, selection: { kind: "session", id } })), []);
  const selectBot = useCallback((id: string) => setUI((u) => ({ ...u, selection: { kind: "bot", id }, lastBot: id })), []);
  const setMode = useCallback(
    (mode: Mode) =>
      setUI((u) => {
        if (u.mode === mode) return u;
        if (mode === "bots") {
          const list = lists.get().bots;
          const bot = list.find((b) => b.id === u.lastBot) ?? list[0];
          const lastSession = u.selection.kind === "bot" ? u.lastSession : u.selection;
          return { ...u, mode, lastSession, selection: bot ? { kind: "bot", id: bot.id } : u.selection.kind === "customize" ? u.selection : { kind: "new" } };
        }
        const lastBot = u.selection.kind === "bot" ? u.selection.id : u.lastBot;
        return { ...u, mode, lastBot, selection: u.lastSession.kind === "bot" ? { kind: "new" } : u.lastSession };
      }),
    [lists],
  );
  const show = useCallback((text: string, undo?: () => void, bad?: boolean) => {
    clearTimeout(toastTimer.current);
    const id = Date.now();
    setUI((u) => ({ ...u, toast: { text, undo, bad, id } }));
    toastTimer.current = setTimeout(() => setUI((u) => (u.toast?.id === id ? { ...u, toast: null } : u)), 5200);
  }, []);
  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      try {
        await action();
        if (done) show(done);
        return true;
      } catch (e) {
        show(errorText(e), undefined, true);
        return false;
      }
    },
    [show],
  );
  const call = useCallback(
    <M extends keyof Methods & string>(method: M, params: Methods[M][0]) => (rpc ? rpc.request(method, params) : Promise.reject(new Error(i18n.t("common:kernel.connecting")))),
    [rpc],
  );
  const op = useCallback((sessionId: string, o: Op) => run(() => call("session/op", { session_id: sessionId, op: o })), [run, call]);
  const refreshModels = useCallback(async () => {
    if (rpc) setModels(await rpc.request("models/list", {}));
  }, [rpc]);
  const offered = ui.offered;
  const giveOffered = useCallback(
    async (sessionId: string, input: UserContent[]) => {
      if (!offered || input.length === 0) return;
      setUI((u) => ({ ...u, offered: null }));
      await call("browser/assign_tab", { target_id: offered.target_id, session_id: sessionId });
      input.push(handedTabBlock(offered.title, offered.url));
    },
    [offered, call],
  );
  const start = useCallback(
    (text: string, d: Draft, attachments: Attachment[]) =>
      run(async () => {
        const roots = attachments.flatMap((a) => (a.kind === "folder" ? [a.path] : []));
        const ref = d.model ?? models.defaults?.model;
        const thinking = draftThinking(models.models.find((m) => m.id === ref), d.thinking);
        const r = await call("session/new", { cwd: d.noProject ? undefined : (d.cwd ?? undefined), extra_roots: roots.length ? roots : undefined, model: d.model ?? undefined, thinking, permission_mode: d.permission });
        const browserTabs = await window.finx?.claimHomeBrowser(r.session_id) ?? [];
        setUI((u) => ({ ...u, draft: d, selection: { kind: "session", id: r.session_id } }));
        const input = toInput(text, attachments.filter((a) => a.kind !== "folder"));
        await giveOffered(r.session_id, input);
        if (browserTabs.length) input.push(handedTabsBlock(browserTabs.map(({ url, title, shown }) => ({ url, title, current: shown }))));
        await call("session/op", { session_id: r.session_id, op: { type: "prompt", input } });
      }),
    [run, call, models, giveOffered],
  );

  const store = useMemo<Store>(
    () => ({ ...ui, rpc, kernel: kernelState, status, server, capabilities, lists: lists.get, width, models, set, select, selectBot, setMode, run, show, call, op, refreshModels, giveOffered, start }),
    [ui, rpc, kernelState, status, server, capabilities, lists, width, models, set, select, selectBot, setMode, run, show, call, op, refreshModels, giveOffered, start],
  );
  return (
    <ListsCtx.Provider value={lists}>
      <Ctx.Provider value={store}>{children}</Ctx.Provider>
    </ListsCtx.Provider>
  );
}

/**
 * The current time, ticking every interval ms (for elapsed times). One clock
 * per interval for the whole window, so everything on the same interval
 * changes in the same frame. Ticks fall halfway between wall-clock
 * multiples of interval, so a clock counting whole seconds moves by exactly
 * one on each, however late a tick comes.
 */
export function useNow(interval = 1000): Date {
  const c = clock(interval);
  return useSyncExternalStore(c.subscribe, c.now);
}

const clocks = new Map<number, { subscribe: (f: () => void) => () => void; now: () => Date }>();

function clock(interval: number) {
  let c = clocks.get(interval);
  if (c) return c;
  const subs = new Set<() => void>();
  let now = new Date();
  let timer: ReturnType<typeof setTimeout> | undefined;
  c = {
    subscribe(f) {
      if (subs.size === 0) {
        now = new Date();
        const next = () => {
          timer = setTimeout(() => {
            now = new Date();
            subs.forEach((g) => g());
            next();
          }, interval - ((Date.now() + interval / 2) % interval));
        };
        next();
      }
      subs.add(f);
      return () => {
        subs.delete(f);
        if (subs.size === 0) clearTimeout(timer);
      };
    },
    now: () => now,
  };
  clocks.set(interval, c);
  return c;
}
