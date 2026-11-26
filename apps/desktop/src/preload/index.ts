import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import type { Bridge, BrowserPanel, BrowserStill, BrowserTab, BrowserTabCommand, Command, KernelKind, KernelStatusView, MenuItem, MenuState, PlatformId, Preferences } from "../shared/bridge";
import type { Language } from "../shared/i18n";
import type { UpdateInfo } from "../shared/update";

// The only things the page gets from outside its sandbox (window.finx).
// Sessions come from finx over the port connectKernel hands out.
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--finx-${name}=`))?.split("=").slice(1).join("=") ?? "";

const listen = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => {
    ipcRenderer.removeListener(channel, h);
  };
};

// The kernel's port arrives here (ports can't cross the bridge's proxy);
// it goes on to the page's own world as a window message, where the page
// holds it directly.
ipcRenderer.on("finx-kernel", (e) => window.postMessage("finx-kernel", "*", e.ports));

const bridge: Bridge = {
  setBrowserPanel: (panel: BrowserPanel) => ipcRenderer.send("browser-panel", panel),
  openBrowser: (session) => ipcRenderer.invoke("browser-open", session),
  claimHomeBrowser: (session) => ipcRenderer.invoke("browser-claim-home", session),
  browserTabs: () => ipcRenderer.invoke("browser-tabs"),
  onBrowserTabs: (cb: (tabs: BrowserTab[]) => void) => listen("browser-tabs", cb),
  onBrowserComment: (cb) => listen("browser-comment", cb),
  showBrowserTab: (targetId: string) => ipcRenderer.send("browser-show", targetId),
  onBrowserStill: (cb: (still: BrowserStill) => void) => listen("browser-still", cb),
  browserTabCommand: (targetId: string, command: BrowserTabCommand) => ipcRenderer.send("browser-command", targetId, command),
  fetchBrowserPdf: (targetId: string) => ipcRenderer.invoke("browser-fetch-pdf", targetId),
  translateBlocks: (scopeId, req) => ipcRenderer.invoke("translate-blocks", scopeId, req),
  cancelTranslation: (scopeId: string) => ipcRenderer.send("translate-cancel", scopeId),
  browserMenuState: (targetId) => ipcRenderer.invoke("browser-menu-state", targetId),
  browserMenuAction: (targetId, action) => ipcRenderer.send("browser-menu-action", targetId, action),
  openPrivacySettings: () => ipcRenderer.send("open-privacy-settings"),
  localServers: () => ipcRenderer.invoke("browser-local-servers"),
  stopLocalServer: (port: number, pid: number) => ipcRenderer.invoke("browser-stop-local-server", port, pid),
  openSourceApp: (adapter?: "qwenwork" | "qoder" | "workbuddy") => ipcRenderer.invoke("open-source-app", adapter),
  sourceAppIcon: (adapter?: "qwenwork" | "qoder" | "workbuddy") => ipcRenderer.invoke("source-app-icon", adapter),
  platform: arg("platform") as PlatformId,
  userName: arg("user"),
  home: arg("home"),
  version: arg("version"),
  language: arg("lang") as Language,
  kernel: arg("kernel") as KernelKind,
  defaultMode: arg("mode") === "sessions" ? "sessions" : undefined,
  connectKernel: () => ipcRenderer.send("connect-kernel"),
  kernelStatus: () => ipcRenderer.invoke("kernel-status"),
  onKernelState: (cb: (s: KernelStatusView) => void) => listen("kernel-state", cb),
  retryKernel: () => ipcRenderer.send("retry-kernel"),
  restartKernel: (now: boolean) => ipcRenderer.send("restart-kernel", now),
  releaseMemory: () => webFrame.clearCache(),
  openSettings: (page?: string) => ipcRenderer.send("open-settings", page),
  systemBrowsers: () => ipcRenderer.invoke("system-browsers"),
  setUpSystemBrowser: () => ipcRenderer.invoke("system-browser-set-up"),
  openSystemBrowser: (id: string, page?: "extensions") => ipcRenderer.invoke("system-browser-open", id, page),
  openSystemBrowserQuietly: () => ipcRenderer.invoke("system-browser-open-quietly"),
  repairSystemBrowser: () => ipcRenderer.invoke("system-browser-repair"),
  diagnoseSystemBrowser: () => ipcRenderer.invoke("system-browser-diagnose"),
  takeOpenTarget: () => ipcRenderer.invoke("take-open-target"),
  onOpenTarget: (cb: () => void) => listen("open-target", cb),
  testNotification: () => ipcRenderer.send("test-notification"),
  openNotificationSettings: () => ipcRenderer.send("open-notification-settings"),
  screenLocked: () => ipcRenderer.invoke("screen-locked"),
  onScreenUnlocked: (cb: () => void) => listen("screen-unlocked", cb),
  showMainWindow: () => ipcRenderer.send("show-main-window"),
  revealBrowserExtension: () => ipcRenderer.send("system-browser-reveal-extension"),
  systemBrowserIcon: (id: string) => ipcRenderer.invoke("system-browser-icon", id),
  desktopControlStatus: (configured?: string) => ipcRenderer.invoke("desktop-control-status", configured),
  requestDesktopPermission: (kind: "accessibility" | "screen") => ipcRenderer.send("desktop-permission", kind),
  desktopApp: (key: string) => ipcRenderer.invoke("desktop-app", key),
  pickDesktopApp: () => ipcRenderer.invoke("pick-desktop-app"),
  onSettingsPage: (cb: (page: string) => void) => listen("settings-page", cb),
  settingsOpen: () => ipcRenderer.invoke("settings-open"),
  onSettingsOpen: (cb: (open: boolean) => void) => listen("settings-open", cb),
  popupMenu: (items: MenuItem[]) => ipcRenderer.invoke("popup-menu", items),
  menuShown: (items: MenuItem[]) => ipcRenderer.invoke("menu-shown", items),
  onCommand: (cb: (c: Command) => void) => listen("command", cb),
  setMenuState: (s: MenuState) => ipcRenderer.send("menu-state", s),
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  pickSaveFile: (defaultPath: string) => ipcRenderer.invoke("pick-save-file", defaultPath),
  pickSkillSource: () => ipcRenderer.invoke("pick-skill-source"),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  catalogDir: arg("catalog"),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  pickAvatar: () => ipcRenderer.invoke("pick-avatar"),
  pasteFiles: () => ipcRenderer.invoke("paste-files"),
  attachPaths: (paths: string[]) => ipcRenderer.invoke("attach-paths", paths),
  revealPath: (path: string) => ipcRenderer.send("reveal-path", path),
  readModel: (path: string) => ipcRenderer.invoke("read-model", path),
  pathInfo: (base: string, paths: string[]) => ipcRenderer.invoke("path-info", base, paths),
  openFile: (path: string, options?: { line?: number; app?: string }) => ipcRenderer.invoke("open-file", path, options),
  editors: () => ipcRenderer.invoke("editors"),
  openURL: (session: string, url: string) => ipcRenderer.invoke("browser-open-url", session, url),
  openPageFile: (session: string, path: string) => ipcRenderer.invoke("browser-open-file", session, path),
  openPagePreview: (path, rect) => ipcRenderer.invoke("page-preview-open", path, rect),
  placePagePreview: (rect) => ipcRenderer.send("page-preview-place", rect),
  closePagePreview: () => ipcRenderer.send("page-preview-close"),
  onPagePreview: (cb) => listen("page-preview", cb),
  openFolder: (path: string) => ipcRenderer.send("open-folder", path),
  openTerminal: (path: string) => ipcRenderer.send("open-terminal", path),
  gitBranch: (path: string) => ipcRenderer.invoke("git-branch", path),
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  showAbout: () => ipcRenderer.send("show-about"),
  getPreferences: () => ipcRenderer.invoke("preferences"),
  setPreferences: (p: Partial<Preferences>) => ipcRenderer.invoke("set-preferences", p),
  onPreferences: (cb) => listen("preferences-changed", cb),
  relaunch: () => ipcRenderer.send("relaunch"),
  updates: () => ipcRenderer.invoke("update-info"),
  onUpdate: (cb: (u: UpdateInfo) => void) => listen("update", cb),
  checkForUpdates: () => ipcRenderer.send("check-updates"),
  downloadUpdate: () => ipcRenderer.send("download-update"),
  installUpdate: () => ipcRenderer.send("install-update"),
  snoozeUpdate: () => ipcRenderer.send("snooze-update"),
  setAutoDownload: (on: boolean) => ipcRenderer.invoke("set-auto-download", on),
};

contextBridge.exposeInMainWorld("finx", bridge);
