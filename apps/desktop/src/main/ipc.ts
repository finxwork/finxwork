import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PagePreviewRect, BrowserMenuAction, BrowserPanel, BrowserTabCommand, Command, DesktopApp, DesktopControlStatus, DesktopPermission, EditorInfo, MenuItem, MenuState, PastedItem, PickedFile, Preferences } from "../shared/bridge";
import { i18n } from "../shared/i18n";
import { cancelScopeTranslation, claimHomeBrowser, currentTabs, fetchTabPdf, openBrowser, openURL, setPanel, showTab, tabCommand, translateScopeBlocks } from "./browser/pages";
import type { TranslationBlock } from "../shared/translation";
import { closePagePreview, openPagePreview, placePagePreview } from "./browser/pagePreview";
import { devServers, stopDevServer } from "./browser/devservers";
import { diagnoseSystemBrowser, openSystemBrowser, openSystemBrowserQuietly, refreshSystemBrowser, revealExtension, setUpSystemBrowser, systemBrowserIcon, systemBrowsers } from "./browser/system";
import { notifier, openNotificationSettings, screenLocked, takeOpenTarget, testNotification } from "./notify";
import { tabMenuAction, tabMenuState } from "./browser/menu";
import { bundleIdOf, desktopProgramVersion, findApp, locateDesktopProgram } from "./desktop";
import { editors, opensFolders } from "./editors";
import { openExternal, openFile, openFolder, openTerminal, pageOfFile, pathInfo, reveal } from "./files";
import { gitBranch } from "./git";
import { connectKernel, kernelBinary, kernelStatus, restartKernel, retryKernel } from "./kernel";
import { clipboardContent } from "./clipboard";
import { platform } from "./platform";
import { preferences, setPreferences } from "./preferences";
import { applyRoutinePreferences } from "./routines";
import { check, download, install, setAutoDownload, snooze, updateInfo } from "./updater";
import { mainWindow, ours, settingsVisible, showMain, showSettings } from "./windows";

// The page's requests to the main process (shared/bridge.ts). Each handler
// checks the request comes from one of our own pages.
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!e.senderFrame && ours(e.senderFrame.url);
}

const noMenuState: MenuState = { main: false, session: null, botApprovable: false, sidebar: true, undo: false };
let menuState = noMenuState;
export const currentMenuState = () => menuState;
export const menuStateListeners = new Set<() => void>();
const reporting = new WeakSet<WebContents>();
let pending: Command | undefined;

/** Hands a command to the main window's page, opening the window first if needed; a page still loading gets it once it reports its state. */
export function command(c: Command) {
  const win = showMain();
  if (menuState.main) win.webContents.send("command", c);
  else pending = c;
}

/** A tab command as the page sends it. */
function tabCommandOk(c: unknown): c is BrowserTabCommand {
  if (typeof c !== "object" || c === null) return false;
  const { command, url } = c as Record<string, unknown>;
  if (command === "go") {
    const { engine } = c as Record<string, unknown>;
    return typeof url === "string" && url.length <= 8192 && (engine === undefined || (typeof engine === "string" && engine.length <= 80));
  }
  return ["back", "forward", "reload", "stop", "close", "new", "annotate", "translate"].includes(command as string);
}

/** A menu pick as the page sends it. */
function menuActionOk(a: unknown): a is BrowserMenuAction {
  if (typeof a !== "object" || a === null) return false;
  const { action, viewport, cookies } = a as Record<string, unknown>;
  if (action === "viewport") return viewport === "responsive" || viewport === "mobile" || viewport === "tablet";
  if (action === "cookies") return cookies === "always" || cookies === "untilQuit";
  return ["open", "copy", "screenshot", "clear"].includes(action as string);
}

/** A panel as the page reports it: a session id or null, a rectangle of finite numbers or null. */
function browserPanel(p: unknown): p is BrowserPanel {
  if (typeof p !== "object" || p === null) return false;
  const { session, rect, hold, editing } = p as Record<string, unknown>;
  if (session !== null && typeof session !== "string") return false;
  if (hold !== undefined && typeof hold !== "boolean") return false;
  if (editing !== undefined && typeof editing !== "boolean") return false;
  return rect === null || finiteRect(rect);
}

/** A rectangle as the page reports it: four finite numbers. */
function finiteRect(rect: unknown): rect is PagePreviewRect {
  if (typeof rect !== "object" || rect === null) return false;
  const r = rect as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}

/** The images an attachment sends as image content; any other file goes by its path. */
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** What an image may be as sent: its size, and its long side (larger ones are scaled down, as providers would anyway). */
const maxImageBytes = 5 * 1024 * 1024;
const maxImageSide = 2048;

/** Pictures pasted with no file of their own, counted for their names. */
let pasted = 0;

/** The local application FinxWork can connect (finx-connections' QwenWork adapter looks for it here too). */
const sourceApps: Record<string, string> = { qwenwork: "/Applications/QwenWorkCN.app", qoder: "/Applications/Qoder.app", workbuddy: "/Applications/WorkBuddy.app" };
function sourceApplication(adapter: unknown): string {
  if (typeof adapter !== "string" || !Object.hasOwn(sourceApps, adapter)) throw new Error("Unknown source application");
  return sourceApps[adapter];
}

/**
 * An image as the model gets it: as it is when small enough, else scaled
 * to fit maxImageSide and sent as JPEG. Null when it can't be read as one
 * (it then goes by its path, like any file).
 */
async function readImage(p: string, mime: string, bytes: number): Promise<{ mime_type: string; data: string } | null> {
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return bytes <= maxImageBytes ? { mime_type: mime, data: (await fs.promises.readFile(p)).toString("base64") } : null;
  const { width, height } = img.getSize();
  if (bytes <= maxImageBytes && Math.max(width, height) <= maxImageSide) return { mime_type: mime, data: (await fs.promises.readFile(p)).toString("base64") };
  return fitImage(img);
}

/** A picture with no file (a screenshot, a copied image): as PNG when small enough, else scaled as readImage does. */
function imageOf(img: Electron.NativeImage): { mime_type: string; data: string } {
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= maxImageSide) {
    const png = img.toPNG();
    if (png.length <= maxImageBytes) return { mime_type: "image/png", data: png.toString("base64") };
  }
  return fitImage(img);
}

function fitImage(img: Electron.NativeImage): { mime_type: string; data: string } {
  const { width, height } = img.getSize();
  const fit = Math.max(width, height) > maxImageSide ? img.resize(width >= height ? { width: maxImageSide, quality: "best" } : { height: maxImageSide, quality: "best" }) : img;
  return { mime_type: "image/jpeg", data: fit.toJPEG(88).toString("base64") };
}

/** Files and folders as attachments, those that are there: an image is read (to go as image content), any other file goes by its path. */
async function attachPaths(paths: string[]): Promise<PastedItem[]> {
  const kinds = await Promise.all(paths.map((p) => fs.promises.stat(p).then((s) => (s.isDirectory() ? "folder" : s.isFile() ? "file" : null), () => null)));
  const folders = paths.flatMap((p, i): PastedItem[] => (kinds[i] === "folder" ? [{ kind: "folder", path: p, name: path.basename(p) }] : []));
  return [...(await attachFiles(paths.filter((_, i) => kinds[i] === "file"))), ...folders];
}

/** Files as attachments: an image is read (to go as image content), any other file goes by its path. */
function attachFiles(paths: string[]): Promise<PickedFile[]> {
  return Promise.all(
    paths.map(async (p): Promise<PickedFile> => {
      const name = path.basename(p);
      const mime = imageTypes[path.extname(p).toLowerCase()];
      const image = mime ? await readImage(p, mime, (await fs.promises.stat(p)).size).catch(() => null) : null;
      return image ? { kind: "image", path: p, name, ...image } : { kind: "file", path: p, name };
    }),
  );
}

/** A path the page may reveal: the person's own files, never the app's. */
function revealable(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p.replace(/^~(?=$|\/)/, os.homedir()));
}

/** An http or https address, the only ones a page's link may open. */
function web(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 8192) return false;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Editors' icons, drawn once each: Quick Look draws the app's own, at twice a menu's size. */
const editorIcons = new Map<string, Promise<string | null>>();
function editorIcon(app: string): Promise<string | null> {
  let icon = editorIcons.get(app);
  if (!icon) {
    icon = nativeImage.createThumbnailFromPath(app, { width: 32, height: 32 }).then((i) => (i.isEmpty() ? null : i.toDataURL()), () => null);
    editorIcons.set(app, icon);
  }
  return icon;
}

/** A menu item's icon: a PNG data URL, at the size a menu draws it. */
function menuIcon(icon: unknown) {
  if (typeof icon !== "string" || !icon.startsWith("data:image/png;base64,") || icon.length > 256 * 1024) return undefined;
  const image = nativeImage.createFromDataURL(icon);
  return image.isEmpty() ? undefined : image.resize({ width: 16, height: 16 });
}

/**
 * End-to-end tests (FINXWORK_E2E_MENU=<folder>): a native menu cannot be driven from the
 * page's DevTools, so its items are written to `shown.jsonl` there instead, and the id in
 * `pick`, when there is one, is taken as the person's choice (and `pick` removed).
 */
const menuTests = process.env.FINXWORK_E2E_MENU;
function testMenu(items: MenuItem[]): string | null {
  const dir = menuTests!;
  const plain = (list: MenuItem[]): unknown[] => list.map((it) => ("separator" in it ? "-" : { id: it.id, label: it.label, ...(it.enabled === false && { enabled: false }), ...(it.checked !== undefined && { checked: it.checked }), ...(it.icon && { icon: true }), ...(it.accel && { accel: it.accel }), ...(it.submenu && { submenu: plain(it.submenu) }) }));
  fs.appendFileSync(path.join(dir, "shown.jsonl"), JSON.stringify(plain(items)) + "\n");
  const pick = path.join(dir, "pick");
  if (!fs.existsSync(pick)) return null;
  const id = fs.readFileSync(pick, "utf8").trim();
  fs.rmSync(pick);
  return id || null;
}

/** A folder the page may open, in the file manager or a terminal: an existing one, by its absolute path. */
function folder(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Desktop control's state. The permissions are the app's own: macOS counts what it starts
 * (finx, and agent-desktop under it) as FinxWork. Windows and Linux ask for none.
 */
async function desktopControlStatus(configured: unknown): Promise<DesktopControlStatus> {
  // FinxWork carries its own copy beside finx: in Contents/MacOS (scripts/build-app.mjs), and
  // beside the repository's debug build in development (scripts/dev-agent-desktop.mjs).
  const finx = kernelBinary();
  const beside = finx ? path.dirname(finx) : null;
  const found = locateDesktopProgram(typeof configured === "string" && configured ? configured : undefined, undefined, undefined, beside);
  const program = found ? { path: found, version: await desktopProgramVersion(found), bundled: !!beside && path.dirname(found) === beside } : null;
  if (process.platform !== "darwin") return { program, accessibility: "unsupported", screen: "unsupported" };
  const screen = systemPreferences.getMediaAccessStatus("screen");
  return {
    program,
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    screen: (screen === "granted" || screen === "not-determined" ? screen : "denied") as DesktopPermission,
  };
}

const PRIVACY_PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

async function requestDesktopPermission(kind: unknown) {
  if (process.platform !== "darwin" || (kind !== "accessibility" && kind !== "screen")) return;
  // Asking puts FinxWork in the list, so the person only has to switch it on. macOS lists an
  // app under Screen Recording only once it has tried to capture: one tiny capture does that.
  if (kind === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
  else if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
  }
  void shell.openExternal(PRIVACY_PANES[kind]);
}

/** The desktop apps asked about, by key, for the session: a name and an icon don't change while it runs. */
const desktopApps = new Map<string, Promise<DesktopApp>>();

/** A desktop app's name and icon by its key in `[desktop.apps]` (a bundle id, or a name). */
function desktopApp(key: unknown): Promise<DesktopApp> | null {
  if (typeof key !== "string" || !key || key.length > 255) return null;
  let found = desktopApps.get(key);
  if (!found) {
    found = findApp(key).then(async (installed) => {
      if (!installed) return { key, name: key, icon: null };
      // Quick Look draws the app's own icon; the file icon of a .app is often the generic one.
      const drawn = await nativeImage.createThumbnailFromPath(installed.path, { width: 64, height: 64 }).catch(() => null);
      const icon = drawn && !drawn.isEmpty() ? drawn.toDataURL() : await app.getFileIcon(installed.path, { size: "normal" }).then((i) => i.toDataURL(), () => null);
      return { key, name: installed.name, icon };
    });
    desktopApps.set(key, found);
  }
  return found;
}

export function registerIPC() {
  ipcMain.handle("open-source-app", async (e, adapter: unknown = "qwenwork") => {
    if (!trusted(e)) return;
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("/usr/bin/open", ["-a", sourceApplication(adapter)], err => err ? reject(new Error("Cannot open source application")) : resolve()));
  });
  // Its icon from the installed app (Quick Look draws it, whatever the bundle keeps it in): no copy of it ships with FinxWork.
  ipcMain.handle("source-app-icon", async (e, adapter: unknown = "qwenwork") => {
    if (!trusted(e)) return null;
    const sourceApp = sourceApplication(adapter);
    if (!fs.existsSync(sourceApp)) return null;
    try {
      const icon = await nativeImage.createThumbnailFromPath(sourceApp, { width: 128, height: 128 });
      return icon.isEmpty() ? null : icon.toDataURL();
    } catch {
      return null;
    }
  });
  ipcMain.on("connect-kernel", (e) => trusted(e) && connectKernel(e.sender));
  ipcMain.on("browser-panel", (e, panel: unknown) => trusted(e) && browserPanel(panel) && setPanel(e.sender, panel));
  ipcMain.handle("browser-open", (e, session: unknown) => {
    if (!trusted(e)) return;
    if (session !== undefined && (typeof session !== "string" || !session)) throw new Error("Invalid browser session");
    openBrowser(session as string | undefined);
  });
  // A link in a reply, in its conversation's browser (content-actions-design §5.2).
  ipcMain.handle("browser-open-url", (e, session: unknown, url: unknown) => {
    if (!trusted(e)) return;
    if (typeof session !== "string" || !session || session === "finxwork:home-browser" || !web(url)) throw new Error("Invalid page to open");
    openURL(session, url);
  });
  // An HTML file from a conversation, as the page it is (content-actions-design DD-157): false when it is not there.
  ipcMain.handle("browser-open-file", async (e, session: unknown, file: unknown) => {
    if (!trusted(e) || !revealable(file)) return false;
    if (typeof session !== "string" || !session || session === "finxwork:home-browser") throw new Error("Invalid page to open");
    const url = await pageOfFile(file.replace(/^~(?=$|\/)/, os.homedir()));
    if (url) openURL(session, url, true);
    return !!url;
  });
  // An HTML file in the preview over the window (bot-mode-design DD-159): false when it is not there.
  ipcMain.handle("page-preview-open", (e, file: unknown, rect: unknown) => {
    if (!trusted(e) || !revealable(file) || !finiteRect(rect)) return false;
    return openPagePreview(e.sender, file.replace(/^~(?=$|\/)/, os.homedir()), rect);
  });
  ipcMain.on("page-preview-place", (e, rect: unknown) => trusted(e) && finiteRect(rect) && placePagePreview(e.sender, rect));
  ipcMain.on("page-preview-close", (e) => trusted(e) && closePagePreview(e.sender));
  ipcMain.handle("browser-claim-home", (e, session: unknown) => {
    if (!trusted(e) || typeof session !== "string" || !session || session === "finxwork:home-browser") throw new Error("Invalid browser session");
    return claimHomeBrowser(session);
  });
  ipcMain.handle("browser-tabs", (e) => (trusted(e) ? currentTabs() : []));
  ipcMain.on("browser-show", (e, targetId: unknown) => trusted(e) && typeof targetId === "string" && showTab(targetId));
  ipcMain.on("browser-command", (e, targetId: unknown, c: unknown) => trusted(e) && typeof targetId === "string" && tabCommandOk(c) && tabCommand(targetId, c));
  ipcMain.handle("browser-fetch-pdf", (e, targetId: unknown) => {
    if (!trusted(e) || typeof targetId !== "string" || !targetId) throw new Error("Invalid browser tab");
    return fetchTabPdf(targetId);
  });
  ipcMain.handle("translate-blocks", (e, scopeId: unknown, req: unknown) => {
    if (!trusted(e) || typeof scopeId !== "string" || !scopeId || !req || typeof req !== "object") {
      throw new Error("Invalid translation request");
    }
    const r = req as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    const targetLanguage = typeof r.targetLanguage === "string" ? r.targetLanguage : "";
    const rawItems = Array.isArray(r.items) ? r.items : [];
    const items: TranslationBlock[] = rawItems.filter(
      (x): x is TranslationBlock =>
        !!x && typeof x === "object" && typeof (x as TranslationBlock).id === "string" && typeof (x as TranslationBlock).text === "string",
    );
    return translateScopeBlocks(scopeId, title, targetLanguage, items);
  });
  ipcMain.on("translate-cancel", (e, scopeId: unknown) => trusted(e) && typeof scopeId === "string" && scopeId && cancelScopeTranslation(scopeId));
  // The app's own processes (its helpers, finx) are not servers to offer.
  ipcMain.handle("browser-menu-state", (e, targetId: unknown) => {
    if (!trusted(e) || (targetId !== null && typeof targetId !== "string")) throw new Error("Invalid browser tab");
    return tabMenuState(targetId);
  });
  ipcMain.on("browser-menu-action", (e, targetId: unknown, a: unknown) =>
    trusted(e) && (targetId === null || typeof targetId === "string") && menuActionOk(a) && tabMenuAction(e.sender, targetId, a));
  ipcMain.handle("browser-local-servers", (e) => (trusted(e) ? devServers(new Set(app.getAppMetrics().map((m) => m.pid))) : []));
  ipcMain.handle("browser-stop-local-server", (e, port: unknown, pid: unknown) => {
    if (!trusted(e) || !Number.isInteger(port) || !Number.isInteger(pid)) throw new Error("Invalid server");
    return stopDevServer(port as number, pid as number, new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]));
  });
  ipcMain.handle("kernel-status", (e) => (trusted(e) ? kernelStatus() : null));
  ipcMain.handle("system-browsers", (e) => (trusted(e) ? systemBrowsers() : []));
  ipcMain.handle("system-browser-set-up", (e) => (trusted(e) ? setUpSystemBrowser() : null));
  ipcMain.handle("system-browser-open", (e, id: unknown, page: unknown) => (trusted(e) ? openSystemBrowser(id, page === "extensions" ? "extensions" : undefined) : false));
  ipcMain.handle("desktop-control-status", (e, configured: unknown) => (trusted(e) ? desktopControlStatus(configured) : null));
  ipcMain.on("desktop-permission", (e, kind: unknown) => trusted(e) && void requestDesktopPermission(kind));
  ipcMain.handle("desktop-app", (e, key: unknown) => (trusted(e) ? desktopApp(key) : null));
  // An app to set access for (Settings › Desktop control › Add app): chosen in the system's dialog, by its bundle id.
  ipcMain.handle("pick-desktop-app", async (e): Promise<DesktopApp | null> => {
    if (!trusted(e) || process.platform !== "darwin") return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = {
      defaultPath: "/Applications",
      properties: ["openFile"] as "openFile"[],
      filters: [{ name: i18n.t("main:dialog.application"), extensions: ["app"] }],
    };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    const picked = r.canceled ? undefined : r.filePaths[0];
    const key = picked ? await bundleIdOf(picked) : null;
    return key ? desktopApp(key) : null;
  });
  ipcMain.handle("system-browser-icon", (e, id: unknown) => (trusted(e) ? systemBrowserIcon(id) : null));
  ipcMain.handle("system-browser-open-quietly", (e) => (trusted(e) ? openSystemBrowserQuietly() : undefined));
  ipcMain.handle("system-browser-repair", (e) => (trusted(e) ? refreshSystemBrowser() : undefined));
  ipcMain.handle("system-browser-diagnose", (e) => (trusted(e) ? diagnoseSystemBrowser() : null));
  ipcMain.handle("take-open-target", (e) => (trusted(e) ? takeOpenTarget() : null));
  ipcMain.handle("screen-locked", (e) => (trusted(e) ? screenLocked() : false));
  ipcMain.on("test-notification", (e) => trusted(e) && testNotification());
  ipcMain.on("open-notification-settings", (e) => trusted(e) && openNotificationSettings());
  ipcMain.on("show-main-window", (e) => trusted(e) && void showMain());
  ipcMain.on("system-browser-reveal-extension", (e) => trusted(e) && revealExtension());
  ipcMain.on("retry-kernel", (e) => trusted(e) && retryKernel());
  ipcMain.on("restart-kernel", (e, now: unknown) => trusted(e) && restartKernel(now === true));
  ipcMain.on("open-settings", (e, page?: string) => trusted(e) && showSettings(typeof page === "string" ? page : undefined));
  ipcMain.handle("settings-open", (e) => trusted(e) && settingsVisible());
  ipcMain.on("relaunch", (e) => {
    if (!trusted(e)) return;
    app.relaunch();
    app.quit();
  });
  ipcMain.on("open-external", (e, url: unknown) => {
    // http and https only: a link in a reply may be a server on this machine or the network (content-actions-design §5.4).
    if (!trusted(e) || !web(url)) return;
    // Tests play the browser themselves.
    if (process.env.FINXWORK_NO_BROWSER) return;
    openExternal(url);
  });
  ipcMain.on("reveal-path", (e, p: unknown) => {
    if (trusted(e) && revealable(p)) reveal(p.replace(/^~(?=$|\/)/, os.homedir()));
  });
  ipcMain.on("open-folder", (e, p: unknown) => {
    if (trusted(e) && folder(p)) openFolder(p);
  });
  ipcMain.on("open-terminal", (e, p: unknown) => trusted(e) && folder(p) && openTerminal(p));
  // A 3D model's bytes for the spatial view (spatial-design §7): only a model file, by its absolute path, and not past 512 MB.
  ipcMain.handle("read-model", async (e, p: unknown) => {
    if (!trusted(e) || typeof p !== "string" || !path.isAbsolute(p) || !/\.(stl|obj|ply|glb)$/i.test(p)) return null;
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > 512 * 1024 * 1024) return null;
      return new Uint8Array(await fs.promises.readFile(p));
    } catch {
      return null;
    }
  });
  // A reply's files (content-actions-design §4): looked up under the session's folder, opened the person's way.
  ipcMain.handle("path-info", (e, base: unknown, paths: unknown) => {
    if (!trusted(e) || typeof base !== "string" || !path.isAbsolute(base) || !Array.isArray(paths)) return [];
    return pathInfo(base, paths.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096).slice(0, 200));
  });
  ipcMain.handle("open-file", (e, p: unknown, options: unknown) => {
    if (!trusted(e) || !revealable(p)) return { ok: false, reason: "failed" };
    const o = typeof options === "object" && options !== null ? (options as { line?: unknown; app?: unknown }) : {};
    const line = typeof o.line === "number" && Number.isInteger(o.line) && o.line > 0 ? o.line : undefined;
    return openFile(p.replace(/^~(?=$|\/)/, os.homedir()), { line, app: typeof o.app === "string" ? o.app : undefined });
  });
  ipcMain.handle("editors", async (e) => {
    if (!trusted(e)) return [];
    return Promise.all((await editors(os.homedir())).map(async (ed): Promise<EditorInfo> => ({ id: ed.id, name: ed.name, icon: await editorIcon(ed.path), folders: opensFolders(ed) })));
  });
  ipcMain.handle("git-branch", (e, p: unknown) => (trusted(e) && typeof p === "string" && path.isAbsolute(p) ? gitBranch(p) : null));
  ipcMain.on("show-about", (e) => trusted(e) && app.showAboutPanel());
  ipcMain.on("menu-state", (e, s: MenuState) => {
    if (!trusted(e) || BrowserWindow.fromWebContents(e.sender) !== mainWindow()) return;
    // A closed window's page shows nothing any more.
    if (!reporting.has(e.sender)) {
      reporting.add(e.sender);
      e.sender.once("destroyed", () => {
        menuState = noMenuState;
        menuStateListeners.forEach((f) => f());
      });
    }
    menuState = s;
    if (s.main && pending) {
      e.sender.send("command", pending);
      pending = undefined;
    }
    menuStateListeners.forEach((f) => f());
  });
  ipcMain.handle("pick-directory", async (e) => {
    if (!trusted(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = { properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // End-to-end tests (FINXWORK_E2E_SAVE_TO=<path>): a native save panel cannot be driven from the
  // page, so it answers with that path at once.
  ipcMain.handle("pick-save-file", async (e, defaultPath: unknown) => {
    if (!trusted(e) || typeof defaultPath !== "string") return null;
    if (process.env.FINXWORK_E2E_SAVE_TO) return process.env.FINXWORK_E2E_SAVE_TO;
    const win = BrowserWindow.fromWebContents(e.sender);
    const ext = path.extname(defaultPath).toLowerCase();
    const options = {
      defaultPath,
      filters: [{ name: ext === ".csv" || ext === ".tsv" ? "Delimited text" : ext === ".pdf" ? "PDF" : ext === ".docx" ? "Word" : "Spreadsheet", extensions: [ext.slice(1) || "xlsx"] }],
    };
    const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
    return r.canceled ? null : (r.filePath ?? null);
  });
  // A skill to upload (自定义 › 上传技能): its folder, or an archive or a SKILL.md; finx reads it.
  ipcMain.handle("pick-skill-source", async (e) => {
    if (!trusted(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = {
      properties: ["openFile", "openDirectory"] as ("openFile" | "openDirectory")[],
      filters: [{ name: i18n.t("main:dialog.skillSource"), extensions: ["zip", "skill", "md"] }],
    };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // Files to attach, chosen in the system's dialog: only what the person picked there is read.
  ipcMain.handle("pick-files", async (e): Promise<PickedFile[]> => {
    if (!trusted(e)) return [];
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = { properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    if (r.canceled) return [];
    return attachFiles(r.filePaths);
  });
  // A bot's avatar (bot-mode-design §6.3): the system reads the picture, HEIC too; the page gets
  // a square 256 px PNG, which is all finx keeps.
  ipcMain.handle("pick-avatar", async (e) => {
    if (!trusted(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = {
      properties: ["openFile"] as "openFile"[],
      filters: [{ name: i18n.t("main:dialog.images"), extensions: ["png", "jpg", "jpeg", "heic"] }],
    };
    // End-to-end tests: the system's dialog cannot be driven, so a file stands for what was picked.
    const r = menuTests ? { canceled: false, filePaths: [path.join(menuTests, "avatar.png")] } : await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    const size = await fs.promises.stat(file).then((s) => s.size, () => 0);
    if (size > 10 * 1024 * 1024) return { error: "too_large" };
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return { error: "unreadable" };
    const { width, height } = img.getSize();
    const side = Math.min(width, height);
    const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    return { png: square.resize({ width: 256, height: 256, quality: "best" }).toPNG().toString("base64") };
  });
  // What is pasted into the composer: the files and folders copied (in Finder, Explorer), else
  // a picture with no file (a screenshot). Read only when the person pastes.
  ipcMain.handle("paste-files", async (e): Promise<PastedItem[]> => {
    if (!trusted(e)) return [];
    const { paths, image } = await clipboardContent();
    if (paths.length) return attachPaths(paths);
    const img = image ? nativeImage.createFromBuffer(image) : null;
    if (!img || img.isEmpty()) return [];
    pasted += 1;
    const name = i18n.t("main:pastedImage", { n: pasted });
    return [{ kind: "image", path: `pasted:${Date.now()}:${pasted}`, name, ...imageOf(img) }];
  });
  // Files and folders dropped on the composer, by the paths the window got for them.
  ipcMain.handle("attach-paths", (e, paths: unknown): Promise<PastedItem[]> | [] => {
    if (!trusted(e) || !Array.isArray(paths) || !paths.every((p) => typeof p === "string" && path.isAbsolute(p))) return [];
    return attachPaths(paths);
  });
  ipcMain.handle("popup-menu", (e, items: MenuItem[]) => {
    if (!trusted(e) || !Array.isArray(items)) return null;
    if (menuTests) return testMenu(items);
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null;
      const build = (list: MenuItem[]): MenuItemConstructorOptions[] =>
        list.map((it) => {
          if ("separator" in it) return { type: "separator" as const };
          const icon = menuIcon(it.icon);
          const common = { label: String(it.label), enabled: it.enabled !== false, ...(icon && { icon }), ...(typeof it.accel === "string" && { accelerator: it.accel, registerAccelerator: false }) };
          if (Array.isArray(it.submenu)) return { ...common, submenu: build(it.submenu) };
          return { ...common, type: it.checked === undefined ? ("normal" as const) : ("checkbox" as const), checked: it.checked, click: () => (chosen = it.id) };
        });
      const menu = Menu.buildFromTemplate(build(items));
      menu.popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined, callback: () => setTimeout(() => resolve(chosen)) });
    });
  });
  // A menu the page draws itself (pageMenu.tsx): nothing to do here but in tests, which read and answer it as a native one.
  ipcMain.handle("menu-shown", (e, items: MenuItem[]) => (trusted(e) && menuTests && Array.isArray(items) ? testMenu(items) : null));
  ipcMain.handle("preferences", (e) => (trusted(e) ? preferences() : null));
  ipcMain.handle("set-preferences", (e, p: Partial<Preferences>) => {
    if (!trusted(e) || typeof p !== "object" || p === null) return null;
    const next = setPreferences(p);
    for (const win of BrowserWindow.getAllWindows()) {
      if (ours(win.webContents.getURL())) win.webContents.send("preferences-changed", next);
    }
    notifier.refresh();
    applyRoutinePreferences();
    return next;
  });
  ipcMain.handle("update-info", (e) => (trusted(e) ? updateInfo() : null));
  ipcMain.on("check-updates", (e) => trusted(e) && void check());
  ipcMain.on("download-update", (e) => trusted(e) && download());
  ipcMain.on("install-update", (e) => trusted(e) && install());
  ipcMain.on("snooze-update", (e) => trusted(e) && snooze());
  ipcMain.handle("set-auto-download", (e, on: unknown) => (trusted(e) ? setAutoDownload(on === true) : null));
}
