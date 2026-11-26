import { RpcClient } from "@finx/client";
import { MockServer, parseStress } from "@finx/client/mock";
import { PROTOCOL_VERSION, type ModelsCompleteParams, type ModelsCompleteResult } from "@finx/protocol";
import { app, BrowserWindow, MessageChannelMain, type WebContents } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { KernelKind, KernelStatusView } from "../../shared/bridge";
import { testHome } from "../build";
import { LineCutter } from "../frames";
import { platform } from "../platform";
import { startBrowserHost } from "../browser/host";
import { startDocxHost } from "../docx/host";
import { socketTransport, Supervisor, type KernelStatus, type ListFollower } from "./supervisor";

// The windows' connections to finx (desktop-design §3.2, desktop-kernel-
// integration §3): each window gets a MessagePort whose other end is here,
// joined to its own socket connection to finx's service. Text passes through
// as it is, NDJSON both ways: nothing here parses it. The supervisor keeps a
// matching service running and says how it is.

/**
 * finx: the app's own finx (packaged), or the repository's build (pnpm dev).
 * FINXWORK_KERNEL=mock runs the demo's mock server in this process instead,
 * for working on the window without Rust.
 */
export const kernelKind: KernelKind = process.env.FINXWORK_KERNEL === "mock" ? "mock" : "finx";

export const finxHome = process.env.FINX_HOME || (testHome ? path.join(testHome, "finx") : path.join(os.homedir(), ".finx"));

/** The finx this app starts: FINXWORK_FINX, the one inside the app, or the repository's debug build. */
export function kernelBinary(): string | null {
  const candidates = [
    process.env.FINXWORK_FINX,
    app.isPackaged ? platform.kernelBinary() : path.resolve(app.getAppPath(), "../../target/debug/finx"),
  ];
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

/** The version of that finx: from kernel.json, written when the app was packaged, or by asking it. */
function kernelVersion(binary: string | null): string | null {
  try {
    const manifest = path.join(process.resourcesPath, "kernel.json");
    if (app.isPackaged && !process.env.FINXWORK_FINX && fs.existsSync(manifest)) {
      return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
    }
    if (binary) return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/).pop() ?? null;
  } catch {
    // An unknown version is not replaced on version grounds; capabilities still count.
  }
  return null;
}

let supervisor: Supervisor | null = null;

function trace(message: string) {
  if (process.env.FINXWORK_TRACE) console.log(`[finxwork] ${message}`);
}

/** Starts keeping finx running; the windows follow its state. */
export function startKernel(lists?: ListFollower) {
  if (kernelKind !== "finx" || supervisor) return;
  const binary = kernelBinary();
  const endpoint = platform.kernelEndpoint(finxHome);
  supervisor = new Supervisor({
    endpoint,
    home: finxHome,
    binary,
    expected: kernelVersion(binary),
    environment: () => platform.loginEnvironment(),
    log: path.join(finxHome, "logs", "serve.out.log"),
    idleExitSecs: 600,
    client: { name: "finxwork-supervisor", version: app.getVersion() },
    required: ["sessions_subscribe", "session_metadata", "transcript_task_end", "auth", "model_connections", "input_queue", "message_resend", "workbooks"],
    starts: path.join(app.getPath("userData"), "kernel-starts.json"),
    trace,
    lists,
  });
  supervisor.onChange((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kernel-state", view(s));
  });
  supervisor.start();
  app.on("before-quit", () => supervisor?.stop());
  // The browser tools' pages show in the app (browser-design §8.3).
  const ready = async () => {
    await supervisor!.ready();
    return supervisor!.current.endpoint;
  };
  startBrowserHost(ready, trace);
  // The kernel's Word documents are saved here (word-design §2).
  startDocxHost(ready, trace);
}

function view(s: KernelStatus): KernelStatusView {
  return { ...s, home: finxHome };
}

/** The kernel's state, for a window that just opened. */
export function kernelStatus(): KernelStatusView {
  if (supervisor) return view(supervisor.current);
  return { state: "ready", endpoint: "mock", binary: null, log: "", home: finxHome };
}

export function retryKernel() {
  supervisor?.retry();
}

export function restartKernel(now: boolean) {
  void supervisor?.restart(now);
}

interface Upstream {
  write(text: string): void;
  close(): void;
}

let mock: MockServer | undefined;

function mockUpstream(deliver: (text: string) => void): Upstream {
  // FINXWORK_MOCK_STRESS="bots=1200,sessions=1500": a heavy owner's lists, for stress tests.
  mock ??= new MockServer({ stress: parseStress(process.env.FINXWORK_MOCK_STRESS) });
  const conn = mock.connect({ write: deliver });
  return { write: (text) => conn.receive(text), close: () => conn.close() };
}

/** A connection of a window's own to finx's service, once it is ready. */
function socketUpstream(deliver: (text: string) => void, closed: () => void): Upstream {
  let socket: net.Socket | null = null;
  let gone = false;
  const pending: string[] = [];
  const lines = new LineCutter();
  supervisor!
    .ready()
    .then(() => {
      if (gone) return;
      socket = net.createConnection(supervisor!.current.endpoint);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        for (const text of pending.splice(0)) socket!.write(text);
      });
      socket.on("data", (chunk: string) => {
        const text = lines.push(chunk);
        if (text) deliver(text);
      });
      socket.on("error", () => socket?.destroy());
      socket.on("close", closed);
    })
    .catch(closed);
  return {
    write: (text) => (socket && !socket.connecting ? socket.write(text) : pending.push(text)),
    close: () => {
      gone = true;
      socket?.destroy();
    },
  };
}

const connections = new Map<WebContents, Upstream>();

/** Gives the window a new port to finx; one it had before is closed (a reload or a reconnect asks again). */
export function connectKernel(wc: WebContents) {
  const before = connections.get(wc);
  before?.close();
  const { port1, port2 } = new MessageChannelMain();
  const deliver = (text: string) => port1.postMessage(text);
  // The window hears that the connection ended as a message that is not text.
  const ended = () => port1.postMessage({ closed: true });
  const up = kernelKind === "finx" ? socketUpstream(deliver, ended) : mockUpstream(deliver);
  connections.set(wc, up);
  port1.on("message", (e) => typeof e.data === "string" && up.write(e.data));
  port1.on("close", () => up.close());
  port1.start();
  wc.postMessage("finx-kernel", null, [port2]);
  if (!before) {
    wc.once("destroyed", () => {
      connections.get(wc)?.close();
      connections.delete(wc);
    });
  }
}

/**
 * Runs a single stateless `models/complete` call against the active kernel.
 * Aborting `signal` tears down the local socket immediately so the server cancels the in-flight stream.
 */
export async function completeWithKernel(params: ModelsCompleteParams, signal?: AbortSignal): Promise<ModelsCompleteResult> {
  if (signal?.aborted) throw new Error("Aborted");
  if (kernelKind === "mock") {
    mock ??= new MockServer({ stress: parseStress(process.env.FINXWORK_MOCK_STRESS) });
    let onText: ((t: string) => void) | undefined;
    let onClose: (() => void) | undefined;
    const conn = mock.connect({ write: (t) => onText?.(t) });
    const rpc = new RpcClient({
      send: (t) => conn.receive(t),
      onText: (cb) => { onText = cb; return () => { onText = undefined; }; },
      onClose: (cb) => { onClose = cb; return () => { onClose = undefined; }; },
    });
    const abort = () => { conn.close(); onClose?.(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await rpc.request("initialize", { protocol_version: PROTOCOL_VERSION, client_info: { name: "finxwork-translate", version: app.getVersion() } });
      return await rpc.request("models/complete", params);
    } finally {
      signal?.removeEventListener("abort", abort);
      conn.close();
    }
  }
  if (!supervisor) throw new Error("Kernel is not running");
  await supervisor.ready();
  if (signal?.aborted) throw new Error("Aborted");
  const socket = net.createConnection(supervisor.current.endpoint);
  socket.unref();
  const abort = () => socket.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Aborted")));
    });
    const rpc = new RpcClient(socketTransport(socket));
    await rpc.request("initialize", { protocol_version: PROTOCOL_VERSION, client_info: { name: "finxwork-translate", version: app.getVersion() } });
    return await rpc.request("models/complete", params);
  } finally {
    signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}
