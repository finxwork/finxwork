/** Tabs opened from the new-session page, before a conversation exists. */
export const homeBrowserSession = "finxwork:home-browser";

import type { AlertTarget } from "@finx/client";
import type { Language, LanguageChoice } from "./i18n";
import type { UpdateInfo } from "./update";
import type { BrowserComment } from "./annotations";
import type { TranslationBatchResult, TranslationBlock } from "./translation";
import type { SearchEngine } from "./search";

// What the preload script gives the page (window.finx). Everything about
// sessions comes from finx itself, over the port connectKernel hands out.

export type PlatformId = "mac" | "win" | "linux";

/** A native menu's item: `icon` a PNG data URL drawn before the label, `submenu` items it opens to (its own id unused). */
/** A native menu item; `accel` is the shortcut it shows on its right (an Electron accelerator, shown only: the page handles the keys). */
export type MenuItem = { id: string; label: string; enabled?: boolean; checked?: boolean; icon?: string; accel?: string; submenu?: MenuItem[] } | { separator: true };

/** A path a reply wrote, looked up under its session's folder: absolute, relative when it is under the folder, and what it is (null: nothing there). */
export type PathInfo = { path: string; rel: string | null; kind: "file" | "folder" | null };

/** How a file a reply pointed at was opened, or why it was not. "revealed": shown in the file manager, as opening it would run it. */
export type OpenFileResult = { ok: true; how: "editor" | "app" | "folder" | "revealed" } | { ok: false; reason: "missing" | "failed" };

/** An editor installed here, for the "Open with" menu: its bundle id, name and icon, and whether it opens folders. */
export type EditorInfo = { id: string; name: string; icon: string | null; folders: boolean };

/** Commands from the app menu, handled by the main window's page. */
export type Command =
  | "newSession" | "openProject" | "attachFiles" | "attachFolder" | "search" | "nextAttention" | "nextActive"
  | "toggleInspector" | "toggleSidebar"
  | "approve" | "interrupt" | "rename" | "archive" | "unarchive" | "copySessionId" | "revealSessionFile"
  | "undo";

/** What the page shows, so the app menu's items enable and check right. */
export type MenuState = {
  main: boolean;
  session: null | {
    interruptible: boolean;
    approvable: boolean;
    archivable: boolean;
    archived: boolean;
    inspector: boolean;
  };
  /** The bot on screen waits for an approval: it has no `session` entry (its session has no such menu). */
  botApprovable: boolean;
  sidebar: boolean;
  /** The toast offers Undo (⌘Z undoes it rather than typing). */
  undo: boolean;
};

/**
 * A file the person picked to attach: an image comes with its bytes (base64,
 * as the protocol's image content takes them); any other file by its path.
 */
export type PickedFile = { path: string; name: string } & ({ kind: "file" } | { kind: "image"; mime_type: string; data: string });
/** What a paste attaches: files as picked, or a folder. */
export type PastedItem = PickedFile | { kind: "folder"; path: string; name: string };

/** Follow the system (soft gray when dark), or choose a fixed palette. */
export type Appearance = "system" | "light" | "gray" | "black";

export type Preferences = {
  appearance: Appearance;
  /** A change takes effect when the app next starts. */
  language: LanguageChoice;
  /** "Don't ask again" when the app offered to move to the Applications folder. */
  moveDeclined?: boolean;
  /** The embedded browser's cookies and site data: kept until the app quits, or (unset) always. */
  browserCookies?: "untilQuit";
  /** The id of the engine the embedded browser's address field searches with, for text that is not an address. */
  searchEngine: string;
  /** The search engines the person added, beside the built-in ones. */
  searchEngines: SearchEngine[];
  notifications: NotificationSettings;
  /** False: routines do not make the app start at login (routine-design §7.4). */
  routinesAtLogin?: boolean;
  /** Keep the Mac from idle sleep while a routine is enabled and it is on power (routine-design §7.5). */
  routinesKeepAwake?: boolean;
};

/** The app's system notifications on this device (notification-design §5.5). Muting a bot is the bot's own. */
export type NotificationSettings = {
  /** Off: no notifications and no number on the app's icon. */
  enabled: boolean;
  sound: boolean;
  /** Also when a session's task ends; waiting and failing always say so. */
  sessionEnded: boolean;
};

/** A window's browser panel (browser-design §8.3.4): the session it shows, and where, in window coordinates; none while hidden. */
export type BrowserPanel = {
  session: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  /** The tab steps aside for now (a dialog is over the window): the page gets a picture of it to show meanwhile. */
  hold?: boolean;
  /** The person is typing in the panel's address field: the agent's tabs do not take the panel from them. */
  editing?: boolean;
};

/** Where an HTML file's preview shows, in window coordinates. */
export type PagePreviewRect = { x: number; y: number; width: number; height: number };

/** What the page in a preview asks of the app: to close (Esc, with the keys in the page), or to go to a web address. */
export type PagePreviewEvent = { kind: "close" } | { kind: "link"; url: string };

/** A picture of a session's shown tab, taken as it stepped aside; `width` in CSS pixels. */
export type BrowserStill = { session: string; image: string; width: number };

/** A tab of the embedded browser. */
export type BrowserTab = {
  targetId: string;
  session: string | null;
  url: string;
  title: string;
  shown: boolean;
  loading: boolean;
  /** The page's document is parsed, so it can be annotated while images and the like still load. */
  domReady?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  annotating?: boolean;
  translating?: boolean;
  /** The tab's main document is a PDF (`application/pdf`). */
  isPdf?: boolean;
  /** A blank tab the person opened: the panel's address field waits for them. The agent's blank tabs do not take the keyboard. */
  asksAddress?: boolean;
};

/** The size a tab lays out at: the panel's, or a phone's or a tablet's. */
export type BrowserViewport = "responsive" | "mobile" | "tablet";

/** What the browser panel's ⋯ menu shows: the system's browser by name (when known), whether the tab has a web page, and the choices in effect. */
export type BrowserMenuState = { browser: string | null; web: boolean; viewport: BrowserViewport; cookies: "always" | "untilQuit" };

export type BrowserMenuAction =
  | { action: "open" | "copy" | "screenshot" | "clear" }
  | { action: "viewport"; viewport: BrowserViewport }
  | { action: "cookies"; cookies: "always" | "untilQuit" };

/** A web server running on this machine, for the new tab to offer; `framework` when its page shows it. */
export type DevServer = { port: number; url: string; title: string; framework?: string; process: string; pid: number };

/** What the person does to a tab in the panel. "new" opens a tab beside it, for its session. */
export type BrowserTabCommand =
  | { command: "back" | "forward" | "reload" | "stop" | "close" | "new" | "annotate" | "translate" }
  /** `engine`: the person picked a search engine by its keyword, so this is a search with it. */
  | { command: "go"; url: string; engine?: string };

/** Where the window's sessions come from: finx, or the demo's mock server (FINXWORK_KERNEL=mock). */
export type KernelKind = "mock" | "finx";

/** How finx's service is, as the main process's supervisor sees it (desktop-kernel-integration §6.1). */
/** A browser on this machine that can run the FinxWork extension (browser-design §8.4). */
export type SystemBrowserId = "chrome" | "edge" | "brave" | "chromium";
export type SystemBrowser = {
  id: SystemBrowserId;
  name: string;
  /** finx is registered as the extension's host for it, by this home. */
  registered: boolean;
  /** What its host manifest points at: this home's host, one that is gone, or another home's. */
  manifest: "missing" | "ours" | "dead" | "other";
  /** It is running now. */
  running: boolean;
};

/** Each link from the browser to finx's service, as this machine has it. */
export type SystemBrowserDiagnosis = {
  app: string;
  service: string | null;
  launcher: string;
  program: string | null;
  programExists: boolean;
  extensionFolder: string;
  extensionBuild: string | null;
  browsers: { name: string; running: boolean; manifest: SystemBrowser["manifest"] }[];
};

/** Desktop control (finx's desktop tools, through agent-desktop): the program and the app's own permissions. */
export type DesktopPermission = "granted" | "denied" | "not-determined" | "unsupported";
export type DesktopControlStatus = {
  /** The program finx would run, its version, and whether it is the one inside FinxWork; null when there is none. */
  program: { path: string; version: string | null; bundled: boolean } | null;
  /** Reading and operating other apps' windows; required. */
  accessibility: DesktopPermission;
  /** Screenshots of windows. */
  screen: DesktopPermission;
};

/** A desktop app as `[desktop.apps]` names it, with its name in the system's language and its icon (a data URL) when installed. */
export type DesktopApp = { key: string; name: string; icon: string | null };

export type KernelStatusView = {
  state: "starting" | "ready" | "reconnecting" | "failed";
  /** The running service's version. */
  version?: string;
  /** An older or different build, replaced once no task runs. */
  replacing?: boolean;
  /** Started from the app's own finx. */
  ours?: boolean;
  attempt?: number;
  /** Failed: why, and what finx printed. */
  reason?: string;
  output?: string;
  endpoint: string;
  binary: string | null;
  env?: "login" | "fallback";
  /** finx's output when the app starts it. */
  log: string;
  home: string;
};

export type Bridge = {
  /** The embedded browser: where this window's panel is, the tabs there are, and picking one. */
  setBrowserPanel(panel: BrowserPanel): void;
  /** Shows the home page's browser, or the given conversation's, opening a blank tab when it has none. */
  openBrowser(session?: string): Promise<void>;
  claimHomeBrowser(session: string): Promise<BrowserTab[]>;
  browserTabs(): Promise<BrowserTab[]>;
  /** A part of a page the person added to a conversation from the browser panel. */
  onBrowserComment(cb: (c: BrowserComment) => void): () => void;
  onBrowserTabs(cb: (tabs: BrowserTab[]) => void): () => void;
  showBrowserTab(targetId: string): void;
  onBrowserStill(cb: (still: BrowserStill) => void): () => void;
  browserTabCommand(targetId: string, command: BrowserTabCommand): void;
  /** Fetches the bytes of an embedded browser PDF tab using its session (cookies & proxy). */
  fetchBrowserPdf(targetId: string): Promise<Uint8Array>;
  /** Translates a batch of text blocks through the active kernel with LRU caching & concurrency control. */
  translateBlocks(
    scopeId: string,
    req: { title: string; targetLanguage: string; items: TranslationBlock[] },
  ): Promise<TranslationBatchResult>;
  /** Cancels in-flight and queued translations for a scope (e.g. a PDF document or browser tab). */
  cancelTranslation(scopeId: string): void;
  /** The panel's ⋯ menu: what it shows for a tab, and doing what the person picked there. */
  browserMenuState(targetId: string | null): Promise<BrowserMenuState>;
  browserMenuAction(targetId: string | null, action: BrowserMenuAction): void;
  /** System Settings' Full Disk Access, where the person lets the app read another browser's data. */
  openPrivacySettings(): void;
  /** The web servers running on this machine now, for a new tab. */
  localServers(): Promise<DevServer[]>;
  /** Stops the one on `port`, if `pid` still listens there: "gone" when it no longer does, "denied" when it isn't ours to stop. */
  stopLocalServer(port: number, pid: number): Promise<"stopped" | "gone" | "denied">;
  openSourceApp(adapter?: "qwenwork" | "qoder" | "workbuddy"): Promise<void>;
  /** The local application's own icon, as the system draws it (a data URL), or null when it isn't installed. */
  sourceAppIcon(adapter?: "qwenwork" | "qoder" | "workbuddy"): Promise<string | null>;
  platform: PlatformId;
  userName: string;
  home: string;
  version: string;
  /** The app's language for this run, chosen by the main process. */
  language: Language;
  kernel: KernelKind;
  /**
   * Asks for a connection to finx: a MessagePort, posted to the window as a
   * "finx-kernel" message. Its messages are NDJSON text both ways.
   */
  connectKernel(): void;
  /** The kernel's state now, and as it changes. */
  kernelStatus(): Promise<KernelStatusView>;
  onKernelState(cb: (s: KernelStatusView) => void): () => void;
  /** After a failure: start over. */
  retryKernel(): void;
  /** Starts finx again with a fresh login environment: now (running tasks are interrupted), or once no task runs. */
  restartKernel(now: boolean): void;
  /**
   * Gives back memory this page no longer uses (Electron's webFrame.clearCache: the renderer is told memory is short, so
   * it drops caches and returns pages its allocators keep). After leaving a heavy page for a light one, or while hidden.
   */
  releaseMemory(): void;
  /** The settings window, on a page ("general", "models", "browser"). */
  openSettings(page?: string): void;
  /** The user's own browser: the ones here, setting finx up as the extension's host, opening one, the extension's folder. */
  systemBrowsers(): Promise<SystemBrowser[]>;
  setUpSystemBrowser(): Promise<{ ok: true } | { ok: false; message: string }>;
  openSystemBrowser(id: SystemBrowserId, page?: "extensions"): Promise<boolean>;
  /** A task waits for the user's own browser: starts it behind what the user is doing. */
  openSystemBrowserQuietly(): Promise<void>;
  /** A host was refused: the files follow the service's program again. */
  repairSystemBrowser(): Promise<void>;
  diagnoseSystemBrowser(): Promise<SystemBrowserDiagnosis>;
  /** What a clicked system notification opens, once; the page asks when it starts and when told. */
  takeOpenTarget(): Promise<AlertTarget | null>;
  onOpenTarget(cb: () => void): () => void;
  testNotification(): void;
  openNotificationSettings(): void;
  /** A window can keep the focus behind a locked screen: nobody is looking then. */
  screenLocked(): Promise<boolean>;
  onScreenUnlocked(cb: () => void): () => void;
  /** Brings the main window to the front. */
  showMainWindow(): void;
  revealBrowserExtension(): void;
  systemBrowserIcon(id: SystemBrowserId): Promise<string | null>;
  /** Desktop control's program and the app's permissions for it; `configured` is `desktop.executable`. */
  desktopControlStatus(configured?: string): Promise<DesktopControlStatus>;
  /** Asks for a permission: the system's prompt where there is one, and its page in System Settings. */
  requestDesktopPermission(kind: "accessibility" | "screen"): void;
  /** A desktop app's name and icon by its bundle id; the key itself as the name when it is not found. */
  desktopApp(key: string): Promise<DesktopApp>;
  /** An app chosen in the system's dialog (macOS), for Settings › Desktop control; null when cancelled or it has no bundle id. */
  pickDesktopApp(): Promise<DesktopApp | null>;
  /** In the settings window: another page was asked for while it is open. */
  onSettingsPage(cb: (page: string) => void): () => void;
  /** In the main window: whether the settings window is open now, and as that changes (the window dims behind it). */
  settingsOpen(): Promise<boolean>;
  onSettingsOpen(cb: (open: boolean) => void): () => void;
  /** A native menu at the pointer; resolves to the chosen item's id. */
  popupMenu(items: MenuItem[]): Promise<string | null>;
  /** A menu the page drew itself has opened: end-to-end tests write its items down and may answer with an item's id (null otherwise). */
  menuShown?(items: MenuItem[]): Promise<string | null>;
  onCommand(cb: (c: Command) => void): () => void;
  setMenuState(state: MenuState): void;
  pickDirectory(): Promise<string | null>;
  /** A destination chosen for Save As. */
  pickSaveFile(defaultPath: string): Promise<string | null>;
  /** A skill to upload, from the system's dialog: a folder, or a .zip, .skill or .md file. */
  pickSkillSource(): Promise<string | null>;
  /** The path of a file or folder dropped on the page. */
  pathForFile(file: File): string;
  /** Tests of session mode (FINXWORK_DEFAULT_MODE): a new profile starts there instead of in Bot mode. */
  defaultMode?: "sessions";
  /** The 自定义 page's catalog skills: in the app's resources, or the repository's in development. */
  catalogDir: string;
  /** Files to attach, from the system's dialog; images read (up to 10 MB each), others by path. */
  pickFiles(): Promise<PickedFile[]>;
  /** A bot's avatar from the system's dialog (bot-mode-design §6.3): a PNG, JPEG or HEIC of up to 10 MB, cropped to a square and scaled to 256 px, as a PNG (base64). */
  pickAvatar(): Promise<{ png: string } | { error: "too_large" | "unreadable" } | null>;
  /** The files and folders on the clipboard, else its picture (a screenshot); none when it holds neither. */
  pasteFiles(): Promise<PastedItem[]>;
  /** Dropped files and folders, by their paths (pathForFile), as attachments. */
  attachPaths(paths: string[]): Promise<PastedItem[]>;
  /** Shows a file or folder in Finder (Explorer, the file manager). */
  revealPath(path: string): void;
  /** A 3D model's bytes (.stl, .obj, .ply, .glb) for the spatial view; null when it cannot be read. */
  readModel(path: string): Promise<Uint8Array | null>;
  /** Paths a reply wrote, looked up under `base` (its session's folder): what each is, never what is in it. */
  pathInfo(base: string, paths: string[]): Promise<PathInfo[]>;
  /** Opens a file or folder a reply pointed at outside the app: in `app` (an editor's id), else its default app; at `line` where an editor takes one. */
  openFile(path: string, options?: { line?: number; app?: string }): Promise<OpenFileResult>;
  /** The editors installed here. */
  editors(): Promise<EditorInfo[]>;
  /** A web page in a conversation's embedded browser: the tab already at the address, else a new one. */
  openURL(session: string, url: string): Promise<void>;
  /** An HTML file in the session's browser, as it is now; false when it is not there. */
  openPageFile(session: string, path: string): Promise<boolean>;
  /** An HTML file over the given rectangle, nobody's tab; false when it is not there. It stays until closed. */
  openPagePreview(path: string, rect: PagePreviewRect): Promise<boolean>;
  placePagePreview(rect: PagePreviewRect): void;
  closePagePreview(): void;
  onPagePreview(cb: (event: PagePreviewEvent) => void): () => void;
  /** Opens a folder itself in Finder (Explorer, the file manager). */
  openFolder(path: string): void;
  /** A new terminal window, its shell in this folder. */
  openTerminal(path: string): void;
  /** The git branch checked out where this folder lies (a detached HEAD's short id), or null outside a repository. */
  gitBranch(path: string): Promise<string | null>;
  openExternal(url: string): void;
  showAbout(): void;
  getPreferences(): Promise<Preferences>;
  setPreferences(p: Partial<Preferences>): Promise<Preferences>;
  onPreferences(cb: (p: Preferences) => void): () => void;
  /** Quits and opens the app again (a new language takes effect). */
  relaunch(): void;
  /** Where the app is with its next version, and as that changes. */
  updates(): Promise<UpdateInfo>;
  onUpdate(cb: (u: UpdateInfo) => void): () => void;
  checkForUpdates(): void;
  downloadUpdate(): void;
  /** Quits, installs the downloaded version and opens it; tasks go on in finx. */
  installUpdate(): void;
  /** "Later": no reminder of this version in the sidebar for a day. */
  snoozeUpdate(): void;
  setAutoDownload(on: boolean): Promise<UpdateInfo>;
};

declare global {
  interface Window {
    finx?: Bridge;
  }
}
