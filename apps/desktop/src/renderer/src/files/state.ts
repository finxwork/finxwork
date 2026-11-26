import { useEffect, useSyncExternalStore } from "react";
import { FileDoc, baseName, docViewingBlock, presentationViewingBlock, sheetViewingBlock, type RpcClient } from "@finx/client";
import type { FilesListResult, FilesReadResult } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import { closeDoc, docTab, lockedPath, openDoc, refreshDoc, setDocInfo, setDocPassword, sheetViewingOf, type DocAnchor, type DocTab } from "../docs/state";
import { isRpcKind } from "../rpcError";
import { errorText, type Store } from "../store";
import { isLegacyWord, isPresentation, isWord, mayBeStudy, opensAsDoc, previewable } from "./kind";
import { kernelAuthority, openKernelPresentation } from "../docs/pptx/kernel";
import { readPresentation, type PresentationProgress } from "../docs/pptx/progress";
import { PresentationDoc } from "../docs/pptx/document";
import { openKernelWord } from "../docs/docx/kernel";
import { WordDoc } from "../docs/docx/document";

// The file panel's files (file-panel-design §10), by session: the open tabs with their
// documents, and the folders of the tree. Kept outside the components, so a panel that is
// closed, or a session left for another, finds them as they were. finx is told what to watch
// as tabs and folders come and go, and what it says changed is read again.

/** Lines to bring into view and mark; `seq` grows each time, so the same lines again still move there. */
export type Target = { line: number; endLine?: number; seq: number };

export type Tab = {
  /** Absolute, as finx resolves it. */
  path: string;
  name: string;
  /** Under the session's folder; null outside it. */
  rel: string | null;
  /** How it read; null while it reads. */
  read: FilesReadResult | null;
  /** Why it could not be read. */
  error: string | null;
  /** A text file's document: what is on disk and what is being edited. */
  doc: FileDoc | null;
  presentation: PresentationDoc | null;
  presentationProgress?: PresentationProgress;
  /** A .docx: the kernel's document, the editor its replica (word-design §6). */
  word: WordDoc | null;
  /** Markdown and SVG: showing what the file looks like, not its source. */
  preview: boolean;
  target: Target | null;
  /** The editor's own state (CodeMirror's), kept across tab switches; only the editor reads it. */
  editor: unknown;
  scroll: number;
  /** A PDF's or a workbook's, shown by pdf.js or the grid instead of read as text: its document in finx (docs/state) once open. */
  opened: OpenedDoc | null;
};

/** `locked`: it waits for its password, `wrong` once one was refused; `opening`: doc/open on its way. */
export type OpenedDoc = { docId: string | null; locked: { wrong: boolean; anchor?: DocAnchor } | null; opening: Promise<void> | null };

/** A folder of the tree: its entries once read. */
export type Dir = { list: FilesListResult | null; error: string | null };

export type SessionFiles = {
  session: string;
  /** The session's folder: the tree's root, and what paths are relative to. */
  cwd: string;
  tabs: Tab[];
  active: string | null;
  /** The tree is shown; null until the panel first shows, which decides by its width. */
  tree: boolean | null;
  expanded: Set<string>;
  dirs: Map<string, Dir>;
  /** Grows with every change, for the components that show it. */
  rev: number;
  /** What finx was last told to watch. */
  watched: string;
};

const t = i18n.getFixedT(null, "session");
const sessions = new Map<string, SessionFiles>();
const listeners = new Map<string, Set<() => void>>();
let rpc: RpcClient | null = null;
let seq = 0;

/** The connection to finx the panel talks over; after a new one, what is watched is told again. */
export function setFilesConnection(next: RpcClient | null) {
  if (next === rpc) return;
  rpc = next;
  for (const s of sessions.values()) {
    s.watched = "";
    watchSoon(s);
  }
}

function changed(s: SessionFiles) {
  s.rev++;
  listeners.get(s.session)?.forEach((f) => f());
  watchSoon(s);
}

export function filesOf(session: string, cwd: string): SessionFiles {
  let s = sessions.get(session);
  if (!s) {
    s = { session, cwd, tabs: [], active: null, tree: null, expanded: new Set([cwd]), dirs: new Map(), rev: 0, watched: "" };
    sessions.set(session, s);
  }
  return s;
}

/** A session's files, the component drawn again as they change. */
export function useFiles(session: string, cwd: string): SessionFiles {
  const s = filesOf(session, cwd);
  useSyncExternalStore(
    (f) => {
      let set = listeners.get(session);
      if (!set) listeners.set(session, (set = new Set()));
      set.add(f);
      return () => void set.delete(f);
    },
    () => s.rev,
  );
  return s;
}

const sep = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
export const joinPath = (dir: string, name: string) => (dir.endsWith(sep(dir)) ? dir + name : dir + sep(dir) + name);
export const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || path;
const under = (dir: string, path: string) => path.startsWith(dir + sep(dir));
export const relativeTo = (dir: string, path: string) => (under(dir, path) ? path.slice(dir.length + 1) : null);

// ── tabs ──

/** Opens a file in the panel (or brings its tab forward), at the lines given; the tree shows where it is. */
export function openFile(s: SessionFiles, path: string, at?: { line?: number; endLine?: number }) {
  let tab = s.tabs.find((x) => x.path === path);
  if (!tab) {
    tab = newTab(s, path);
    s.tabs.push(tab);
    if (tab.opened) openAsDoc(s, tab);
    else void load(s, tab);
  }
  s.active = path;
  if (at?.line) tab.target = { line: at.line, endLine: at.endLine, seq: ++seq };
  reveal(s, parentOf(path));
  changed(s);
}

function newTab(s: SessionFiles, path: string, asDoc = opensAsDoc(path) || mayBeStudy(path)): Tab {
  const opened = asDoc ? { docId: null, locked: null, opening: null } : null;
  return { path, name: baseName(path), rel: relativeTo(s.cwd, path), read: null, error: null, doc: null, presentation: null, word: null, preview: previewable(path), target: null, editor: null, scroll: 0, opened };
}

/** Opens a document tab's file in finx, with its password when one was given; an anchor is gone to once it opens. */
function openAsDoc(s: SessionFiles, tab: Tab, anchor?: DocAnchor, password?: string): Promise<void> {
  const doc = tab.opened!;
  const opening = (async () => {
    if (!rpc) return void (tab.error = t("files.offline"));
    try {
      const opened = await openDoc(rpc, s.session, { path: tab.path }, anchor, password);
      // finx may not hand back the password it opened with; doc.js needs it all the same.
      if (opened && password && !opened.password) setDocPassword(s.session, opened.info.doc_id, password);
      doc.docId = opened?.info.doc_id ?? null;
      doc.locked = opened ? null : { wrong: password !== undefined, anchor };
      tab.error = null;
    } catch (e) {
      // A zip or dcm that is not a study: shown as any other file.
      if (mayBeStudy(tab.path) && isRpcKind(e, "doc_unavailable") && (e.data as { unsupported?: boolean } | null)?.unsupported) {
        tab.opened = null;
        void load(s, tab);
        return;
      }
      tab.error = errorText(e);
    }
  })().finally(() => {
    if (doc.opening === opening) doc.opening = null;
    changed(s);
  });
  doc.opening = opening;
  changed(s);
  return opening;
}

/**
 * A PDF's file changed under its tab (written again, its password changed): what showed is let go
 * and the file opened afresh, asking for its password again if it has one.
 */
function reopenDoc(s: SessionFiles, tab: Tab, anchor?: DocAnchor): Promise<void> {
  const doc = tab.opened!;
  if (doc.opening) return doc.opening;
  const docId = doc.docId;
  doc.docId = null;
  doc.locked = null;
  const reopening = (async () => {
    if (docId) await closeDoc(rpc, s.session, docId);
    return openAsDoc(s, tab, anchor);
  })();
  doc.opening = reopening;
  return reopening;
}

/** An encrypted PDF's password, from the tab that asks for it. */
export function unlockDoc(s: SessionFiles, tab: Tab, password: string): Promise<void> {
  return openAsDoc(s, tab, tab.opened?.locked?.anchor, password);
}

/** The document a session's panel shows in front, if it is one: what "this page" means to the agent (§7.4). */
export function viewingDoc(session: string): DocTab | undefined {
  const s = sessions.get(session);
  const tab = s?.tabs.find((x) => x.path === s.active);
  return docTab(session, tab?.opened?.docId);
}

/** What goes along with a message while the file panel shows a document: the PDF's page, or the
 *  workbook's selected cells (§7.4). Undefined when the panel is closed or shows something else. */
export function viewingBlock(session: string, panelOpen: boolean) {
  if (!panelOpen) return undefined;
  const s = sessions.get(session);
  const front = s?.tabs.find((x) => x.path === s.active);
  if (front && isPresentation(front.path)) return presentationViewingBlock(front.path, !!front.presentation?.dirty);
  const tab = viewingDoc(session);
  if (!tab) return undefined;
  const sheet = tab.info.layout === "grid" ? sheetViewingOf(session) : undefined;
  return sheet
    ? sheetViewingBlock(sheet.path, sheet.doc_id, sheet.sheet, sheet.range, sheet.text)
    : docViewingBlock(tab.info.path, tab.info.doc_id, tab.page, tab.info.pages ?? 0);
}

/** Reads a tab's file (again): a document's disk version moves on, or the edits wait for a choice. */
async function load(s: SessionFiles, tab: Tab) {
  // A document is finx's, kept up to date there.
  if (!rpc || tab.opened || isLegacyWord(tab.path)) return;
  try {
    if (isWord(tab.path)) return await loadWord(s, tab);
    if (isPresentation(tab.path)) {
      if (kernelAuthority()) return await loadKernelPresentation(s, tab);
      const file = await readPresentation(rpc, s.session, tab.path, (progress) => {
        if (!s.tabs.includes(tab)) return;
        tab.presentationProgress = progress;
        changed(s);
      });
      // A pending read must not recreate an editor after its tab was closed.
      if (!s.tabs.includes(tab)) return;
      if (tab.presentation) tab.presentation.diskChanged(file);
      else tab.presentation = new PresentationDoc(file, async (data, base_hash) => {
        if (!rpc) throw new Error(t("files.offline"));
        return rpc.request("pptx/write", { session_id: s.session, path: tab.path, data, base_hash });
      }, () => changed(s));
      tab.error = null;
      tab.presentationProgress = undefined;
      changed(s);
      return;
    }
    const read = await rpc.request("files/read", { session_id: s.session, path: tab.path });
    tab.read = read;
    tab.error = null;
    const version = textVersion(read);
    if (version) {
      if (tab.doc) tab.doc.diskChanged(version);
      else tab.doc = new FileDoc(version, { write: (text, base) => write(s, tab, text, base), changed: () => changed(s) });
    }
  } catch (e) {
    tab.error = errorText(e);
    tab.doc?.diskChanged(null);
  }
  changed(s);
}

/** A presentation held by the kernel: the editor joins its deck as a replica. On a later read
 *  (the file changed on disk) unsaved edits wait for a choice; with none, the deck is read anew. */
async function loadKernelPresentation(s: SessionFiles, tab: Tab) {
  if (!rpc) return;
  const doc = tab.presentation;
  if (doc?.kernel) {
    const disk = await rpc.request("files/read", { session_id: s.session, path: tab.path }).catch(() => null);
    // No hash for a file too large to read whole: the kernel's save still checks it.
    if (disk && !disk.hash) return;
    const hash = disk?.hash ?? null;
    if (hash === doc.file.hash || doc.state === "saving") return;
    if (!hash || doc.dirty) return doc.diskChanged(hash ? { ...doc.file, hash } : null);
    doc.takeDisk(await openKernelPresentation(rpc, s.session, tab.path, true));
    changed(s);
    return;
  }
  tab.presentationProgress = { stage: "reading", completed: 0, total: 0 };
  changed(s);
  const file = await openKernelPresentation(rpc, s.session, tab.path);
  if (!s.tabs.includes(tab)) { file.kernel?.close(); return; }
  tab.presentation = new PresentationDoc(file, async () => { throw new Error("the kernel writes this deck"); }, () => changed(s));
  tab.error = null;
  tab.presentationProgress = undefined;
  changed(s);
}

/** A Word document held by the kernel: the editor joins as its replica. On a later read (the file
 *  changed on disk) unsaved edits wait for a choice; with none, the document is opened anew. */
async function loadWord(s: SessionFiles, tab: Tab) {
  if (!rpc) return;
  const doc = tab.word;
  if (doc) {
    const disk = await rpc.request("files/read", { session_id: s.session, path: tab.path }).catch(() => null);
    if (disk && !disk.hash) return;
    if (doc.diskChanged(disk?.hash ?? null)) doc.takeDisk(await openKernelWord(rpc, s.session, tab.path, true));
    changed(s);
    return;
  }
  const file = await openKernelWord(rpc, s.session, tab.path);
  if (!s.tabs.includes(tab)) { file.kernel.close(); return; }
  tab.word = new WordDoc(file, () => changed(s));
  tab.error = null;
  changed(s);
}

/** "Reload": a Word document's unsaved edits are dropped for the file as it is now. */
export async function takeWordDisk(s: SessionFiles, tab: Tab) {
  if (!rpc || !tab.word) return;
  try {
    tab.word.takeDisk(await openKernelWord(rpc, s.session, tab.path, true));
    tab.error = null;
  } catch (e) { tab.error = errorText(e); }
  changed(s);
}

/** A text file's contents as read, with the hash a write is checked against. */
function textVersion(read: FilesReadResult): { text: string; hash: string } | null {
  return read.kind === "text" && typeof read.text === "string" && read.hash ? { text: read.text, hash: read.hash } : null;
}

async function write(s: SessionFiles, tab: Tab, text: string, base: string | null) {
  if (!rpc) throw new Error(t("files.offline"));
  const r = await rpc.request("files/write", { session_id: s.session, path: tab.path, text, ...(base ? { base_hash: base } : {}) });
  return { status: r.status, hash: r.hash ?? null, message: r.message ?? null };
}

export function activate(s: SessionFiles, path: string) {
  if (s.active === path) return;
  s.active = path;
  changed(s);
}

/** Closes a tab, saving it first; one with a choice still to make stays, and says so. */
export async function closeTab(st: Store, s: SessionFiles, path: string) {
  const tab = s.tabs.find((x) => x.path === path);
  if (!tab) return;
  await tab.doc?.flush();
  await tab.presentation?.flush();
  await tab.word?.flush();
  if (tab.doc?.dirty || tab.presentation?.dirty || tab.word?.dirty) {
    s.active = path;
    changed(s);
    st.show(t("files.unsavedClose", { name: tab.name }), undefined, true);
    return;
  }
  if (tab.opened?.docId) void closeDoc(rpc, s.session, tab.opened.docId);
  tab.presentation?.dispose();
  tab.word?.dispose();
  const i = s.tabs.indexOf(tab);
  s.tabs.splice(i, 1);
  if (s.active === path) s.active = (s.tabs[i] ?? s.tabs[i - 1])?.path ?? null;
  changed(s);
}

/** Saves what every open file of every session has not saved yet (the window hides, the panel goes). */
export function flushAll(s?: SessionFiles): Promise<void> {
  const all = s ? [s] : [...sessions.values()];
  return Promise.all(all.flatMap((x) => x.tabs.flatMap((tab) => [tab.doc?.flush(), tab.presentation?.flush(), tab.word?.flush()]))).then(() => {});
}

/** Explicitly reload an externally changed presentation, discarding the local editor. */
export async function takePresentationDisk(s: SessionFiles, tab: Tab) {
  if (!rpc || !tab.presentation) return;
  try {
    const file = tab.presentation.kernel
      ? await openKernelPresentation(rpc, s.session, tab.path, true)
      : await rpc.request("pptx/read", { session_id: s.session, path: tab.path });
    tab.presentation.takeDisk(file);
    tab.error = null;
  } catch (e) { tab.error = errorText(e); }
  changed(s);
}

/** "Load the disk's version": the edits are dropped for what is there now. */
export async function takeDisk(s: SessionFiles, tab: Tab) {
  if (!rpc || !tab.doc) return;
  try {
    const read = await rpc.request("files/read", { session_id: s.session, path: tab.path });
    tab.read = read;
    const version = textVersion(read);
    if (version) tab.doc.takeDisk(version);
  } catch (e) {
    tab.error = errorText(e);
  }
  changed(s);
}

export function setPreview(s: SessionFiles, tab: Tab, preview: boolean) {
  tab.preview = preview;
  changed(s);
}

// ── the tree ──

export function setTree(s: SessionFiles, shown: boolean) {
  s.tree = shown;
  if (shown) void listDir(s, s.cwd);
  changed(s);
}

/** Reads a folder's entries; read before, they show until the new ones come. */
export async function listDir(s: SessionFiles, dir: string, again = false) {
  const had = s.dirs.get(dir);
  if (had && !again) return;
  if (!had) s.dirs.set(dir, { list: null, error: null });
  if (!rpc) return;
  try {
    const list = await rpc.request("files/list", { session_id: s.session, path: dir });
    s.dirs.set(dir, { list, error: null });
  } catch (e) {
    s.dirs.set(dir, { list: null, error: errorText(e) });
  }
  changed(s);
}

export function toggleDir(s: SessionFiles, dir: string) {
  if (s.expanded.has(dir)) s.expanded.delete(dir);
  else {
    s.expanded.add(dir);
    void listDir(s, dir);
  }
  changed(s);
}

/** Opens the folders down to `dir` (in the session's folder), so the tree shows it. */
function reveal(s: SessionFiles, dir: string) {
  if (dir !== s.cwd && !under(s.cwd, dir)) return;
  for (let d = dir; d === s.cwd || under(s.cwd, d); d = parentOf(d)) {
    s.expanded.add(d);
    void listDir(s, d);
    if (d === s.cwd) break;
  }
}

// ── what changes on disk ──

const watchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Tells finx, after the moment's changes, what this session's panel shows: its tabs and open folders. */
function watchSoon(s: SessionFiles) {
  clearTimeout(watchTimers.get(s.session));
  watchTimers.set(
    s.session,
    setTimeout(() => {
      const paths = [...s.tabs.map((x) => x.path), ...[...s.expanded].filter((d) => s.dirs.get(d)?.list)].sort();
      const key = JSON.stringify(paths);
      if (!rpc || key === s.watched) return;
      s.watched = key;
      rpc.request("files/watch", { session_id: s.session, paths }).catch(() => (s.watched = ""));
    }, 150),
  );
}

/** finx says these changed: open files are read again, open folders listed again. */
export function filesChanged(session: string, paths: string[]) {
  const s = sessions.get(session);
  if (!s) return;
  for (const path of paths) {
    const tab = s.tabs.find((x) => x.path === path);
    const docId = tab?.opened?.docId;
    if (rpc && docId && docTab(s.session, docId)?.info.layout === "grid") void refreshDoc(rpc, s.session, docId).catch(() => reopenDoc(s, tab!));
    else if (tab?.opened) void reopenDoc(s, tab);
    else if (tab) void load(s, tab);
    if (s.dirs.has(path)) void listDir(s, path, true);
  }
}

/** The window came back: the file in front is read again, for a change that was missed. */
export function recheckActive() {
  for (const s of sessions.values()) {
    const tab = s.tabs.find((x) => x.path === s.active);
    if (tab && !tab.doc?.dirty) void load(s, tab);
  }
}

// ── from the conversation ──

/** The file panel in front, in place of the browser's. */
const showPanel = (st: Store) => st.set({ files: true, filesMax: false, browserMax: false, background: false });

/** A file opened from the conversation shows on its own: the tree stays closed unless the person opened it. */
const fileOnly = (s: SessionFiles) => {
  if (s.tree === null) s.tree = false;
};

/** A file a reply or a step points at, opened in the session's panel at its lines (DD-91). */
export function showFile(st: Store, session: string, cwd: string, path: string, at?: { line?: number; endLine?: number }) {
  const s = filesOf(session, cwd);
  fileOnly(s);
  openFile(s, path, at);
  showPanel(st);
}

/** A folder in the session's folder: the panel, its tree open down to it. */
export function showFolder(st: Store, session: string, cwd: string, dir: string) {
  const s = filesOf(session, cwd);
  s.tree = true;
  reveal(s, dir);
  s.expanded.add(dir);
  void listDir(s, dir);
  changed(s);
  showPanel(st);
}

/** Whether a folder is the session's or in it (shown in the panel's tree, not the file manager). */
export const inSession = (cwd: string, path: string) => path === cwd || under(cwd, path);

/**
 * A document from the conversation (a file tile, a citation), in the session's panel at
 * `anchor`. One named by its id is found by its path first. Whether it shows (not waiting for its password).
 */
export async function showDoc(st: Store, session: string, cwd: string, what: { path: string } | { doc_id: string }, anchor?: DocAnchor): Promise<boolean> {
  if (!rpc) return false;
  const s = filesOf(session, cwd);
  const path = "path" in what ? what.path : (docTab(session, what.doc_id)?.info.path ?? (await pathOfDoc(rpc, session, what.doc_id)));
  fileOnly(s);
  openFile(s, path);
  showPanel(st);
  const tab = s.tabs.find((x) => x.path === path);
  if (!tab?.opened) return false;
  await tab.opened.opening;
  if (!anchor) return !!tab.opened.docId;
  if (tab.opened.locked) tab.opened.locked.anchor = anchor;
  else if (tab.opened.docId) {
    try {
      await openDoc(rpc, session, { doc_id: tab.opened.docId }, anchor);
    } catch (e) {
      if (isPasswordError(e)) await reopenDoc(s, tab, anchor);
      else throw e;
    }
  }
  return !!tab.opened.docId;
}

/** The file of a document not open in this session; one that wants its password is still found, to ask in its tab. */
async function pathOfDoc(rpc: RpcClient, session: string, docId: string): Promise<string> {
  try {
    return (await rpc.request("doc/open", { session_id: session, doc_id: docId })).info.path;
  } catch (e) {
    const path = lockedPath(e);
    if (path) return path;
    throw e;
  }
}

/** finx could not open a document without its password: one whose file changed since, say. */
export const isPasswordError = (e: unknown) => isRpcKind(e, "doc_password");

/**
 * Something about an open PDF failed for want of its password (its file changed and finx read it
 * again): its tab asks for the password instead. Whether one did.
 */
export async function lockedOut(session: string, docId: string, e: unknown): Promise<boolean> {
  if (!isPasswordError(e)) return false;
  const s = sessions.get(session);
  const tab = s?.tabs.find((x) => x.opened?.docId === docId);
  if (!s || !tab) return false;
  s.active = tab.path;
  await reopenDoc(s, tab);
  return true;
}

/**
 * finx says the agent opened a document: it gets a tab in the session's panel, which stays as it
 * is. Said again after the agent edits or saves a workbook: its tab takes the new revision, and
 * the grid reads its cells again (spreadsheet-design §8.4).
 */
export function useDocEvents(rpc: RpcClient | null, session: string, cwd: string | undefined) {
  useEffect(() => {
    if (!rpc || !cwd) return;
    return rpc.on("session/event", (p) => {
      if (p.session_id !== session || p.event.type !== "doc_opened") return;
      const s = filesOf(session, cwd);
      const path = p.event.info.path;
      setDocInfo(session, p.event.info);
      if (s.tabs.some((x) => x.path === path)) return;
      const tab = newTab(s, path, true);
      s.tabs.push(tab);
      s.active ??= path;
      openAsDoc(s, tab);
    });
  }, [rpc, session, cwd]);
}
