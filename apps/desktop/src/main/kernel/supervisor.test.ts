import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { parseEnv, withLocale } from "./env.ts";
import { alive, lockPath, readRecord } from "./record.ts";
import { RpcClient } from "@finx/client";
import { Supervisor, sameBytes, socketTransport, tryConnect, type KernelStatus } from "./supervisor.ts";

// The supervisor against the real finx (the repository's debug build), in a
// FINX_HOME of its own: start, reuse, crash, replace, quit.

const finx = path.resolve(import.meta.dirname, "../../../../../target/debug/finx");
const built = fs.existsSync(finx);

// The desktop has a window keeping its loop alive, but the supervisor deliberately
// unrefs its service and control socket. Keep that same lifetime during each test.
let keepAlive: ReturnType<typeof setInterval>;
beforeEach(() => { keepAlive = setInterval(() => {}, 1000); });
afterEach(() => clearInterval(keepAlive));

test("the login environment is read between the marks, NUL-separated, without the shell's own variables", () => {
  const mark = "__M__";
  const out = `Welcome back!\n${mark}PATH=/opt/homebrew/bin:/usr/bin\0NOTE=two\nlines\0SHLVL=2\0_=/usr/bin/env\0PWD=/tmp\0${mark}bye`;
  assert.deepEqual(parseEnv(out, mark), { PATH: "/opt/homebrew/bin:/usr/bin", NOTE: "two\nlines" });
  assert.equal(parseEnv("no marks here", mark), null);
  assert.equal(withLocale({ PATH: "/bin" }).LANG, "en_US.UTF-8");
  assert.equal(withLocale({ PATH: "/bin", LC_ALL: "zh_CN.UTF-8" }).LANG, undefined);
});

const made: Supervisor[] = [];

/** Whatever a test left behind: the supervisors' connections and the services they started. */
async function cleanup() {
  const pids = new Set<number>();
  for (const s of made.splice(0)) {
    s.stop();
    const record = readRecord(s.current.endpoint);
    if (record && alive(record.pid)) pids.add(record.pid);
  }
  for (const pid of pids) {
    if (alive(pid)) process.kill(pid, "SIGTERM");
  }
  // Services flush their files on SIGTERM; remove the fixture only after they exit.
  await Promise.all([...pids].map((pid) => until(() => !alive(pid), 5000)));
}
after(cleanup);

function supervisor(home: string, o: { expected?: string | null; binary?: string; starts?: string } = {}) {
  const states: KernelStatus["state"][] = [];
  const s = new Supervisor({
    endpoint: path.join(home, "run", "finx.sock"),
    home,
    binary: o.binary ?? finx,
    expected: o.expected ?? null,
    starts: o.starts,
    environment: async () => ({ env: { ...process.env, FINX_CREDENTIAL_STORE: "file" }, source: "login", ms: 0 }),
    // As on a first run: the logs folder does not exist yet.
    log: path.join(home, "logs", "serve.out.log"),
    idleExitSecs: 30,
    client: { name: "supervisor-test" },
    required: ["sessions_subscribe", "session_metadata", "transcript_task_end", "auth"],
    backoff: [0, 50],
  });
  s.onChange((st) => states.push(st.state));
  made.push(s);
  return { s, states };
}

async function until(f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** The app's own finx in a folder of its own: a copy of the repository's, or, with `mark`, another build of the same version. */
function build(home: string, name: string, mark?: string) {
  const file = path.join(home, name, "finx");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(finx, file, fs.constants.COPYFILE_FICLONE);
  if (mark) fs.appendFileSync(file, mark);
  return file;
}

/** Runs an app of its own on `home` until its service answers, as an app that then quits leaves it; returns that service's record. */
async function serviceOf(home: string, binary: string, starts?: string) {
  const { s } = supervisor(home, { binary, starts });
  s.start();
  await s.ready();
  s.stop();
  return readRecord(s.current.endpoint)!;
}

/** A service other than `pid` has taken over, and the app is on it. */
const takenOver = (app: Supervisor, pid: number) =>
  until(() => {
    const now = readRecord(app.current.endpoint);
    return !!now && now.pid !== pid && app.current.state === "ready";
  });

test("starts finx when none runs, uses one that does, and starts it again after it dies", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    // Cold: nothing listens, so the supervisor starts finx and waits for it.
    const first = supervisor(home);
    first.s.start();
    await first.s.ready();
    const record = readRecord(first.s.current.endpoint);
    assert.ok(record && alive(record.pid), "the service wrote its record");
    assert.equal(first.s.current.ours, true);
    assert.equal(first.s.current.env, "login");
    assert.ok(first.states.includes("starting"));

    // Warm: a second app finds it and starts nothing.
    const second = supervisor(home);
    second.s.start();
    await second.s.ready();
    assert.equal(readRecord(second.s.current.endpoint)?.pid, record!.pid);
    second.s.stop();

    // finx dies: the supervisor notices on its control connection and starts another one.
    process.kill(record!.pid, "SIGKILL");
    await until(() => first.states.includes("reconnecting"));
    await until(() => first.s.current.state === "ready" && readRecord(first.s.current.endpoint)?.pid !== record!.pid);
    const replacement = readRecord(first.s.current.endpoint)!;
    assert.notEqual(replacement.pid, record!.pid);

    // Quitting the app leaves the service running.
    first.s.stop();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(replacement.pid), "the service outlives the app");
    process.kill(replacement.pid, "SIGTERM");
    await until(() => !alive(replacement.pid));
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service of another version is replaced once no task runs", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const old = supervisor(home);
    old.s.start();
    await old.s.ready();
    const before = readRecord(old.s.current.endpoint)!;
    old.s.stop();
    // An app that expects another version: it uses the running service at once, then swaps it.
    const app = supervisor(home, { expected: "99.0.0" });
    app.s.start();
    await app.s.ready();
    await until(() => readRecord(app.s.current.endpoint)?.pid !== before.pid && app.s.current.state === "ready");
    // The replacement can answer before the old process finishes shutting down.
    await until(() => !alive(before.pid));
    assert.ok(!alive(before.pid), "the old service stopped");
    // The new one is the app's own: it stays, whatever version it reports.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(app.s.current.replacing, false);
    app.s.stop();
    const now = readRecord(app.s.current.endpoint);
    if (now) process.kill(now.pid, "SIGTERM");
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service running another build of the same version is replaced once no task runs", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const before = await serviceOf(home, build(home, "old"));
    // The version and the capabilities say nothing: only the files differ.
    const binary = build(home, "new", "another build");
    const app = supervisor(home, { binary });
    app.s.start();
    await app.s.ready();
    await takenOver(app.s, before.pid);
    await until(() => !alive(before.pid));
    assert.ok(!alive(before.pid), "the old service stopped");
    const now = readRecord(app.s.current.endpoint)!;
    assert.equal(now.version, before.version);
    assert.equal(fs.realpathSync(now.exe!), fs.realpathSync(binary), "the app is on its own finx");
    assert.equal(app.s.current.ours, true);
    // Once: its own service stays.
    await settle();
    assert.equal(app.s.current.replacing, false);
    assert.equal(readRecord(app.s.current.endpoint)?.pid, now.pid);
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service running another file with the same bytes stays", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const before = await serviceOf(home, build(home, "here"));
    // A copy of the app, as when it is opened from where it was built.
    const app = supervisor(home, { binary: build(home, "there") });
    app.s.start();
    await app.s.ready();
    assert.equal(app.s.current.replacing, false);
    assert.equal(app.s.current.ours, false, "it says the service is not the app's own");
    await settle();
    assert.equal(readRecord(app.s.current.endpoint)?.pid, before.pid);
    assert.ok(alive(before.pid));
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service whose own file was replaced since it started is replaced, though that file now holds the app's bytes", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const starts = path.join(home, "starts.json");
    const installed = build(home, "installed");
    const before = await serviceOf(home, installed, starts);
    // A new build goes over the installed app, but the copy it was built as is the one opened.
    const binary = build(home, "built", "new build");
    fs.copyFileSync(binary, installed + ".new");
    fs.renameSync(installed + ".new", installed);
    const app = supervisor(home, { binary, starts });
    app.s.start();
    await app.s.ready();
    await takenOver(app.s, before.pid);
    assert.equal(app.s.current.ours, true);
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service whose file is gone is replaced", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const old = build(home, "old");
    const before = await serviceOf(home, old);
    // The app it came from went to the Trash; the service runs on.
    fs.rmSync(path.dirname(old), { recursive: true });
    const app = supervisor(home, { binary: build(home, "new") });
    app.s.start();
    await app.s.ready();
    await takenOver(app.s, before.pid);
    assert.equal(app.s.current.ours, true);
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service stays when its record names no file, and when the app has no finx to start instead", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const before = await serviceOf(home, build(home, "old"));
    const endpoint = path.join(home, "run", "finx.sock");
    const missing = supervisor(home, { binary: path.join(home, "gone", "finx") });
    missing.s.start();
    await missing.s.ready();
    assert.equal(missing.s.current.replacing, false);
    missing.s.stop();
    const { exe: _exe, ...record } = readRecord(endpoint)!;
    fs.writeFileSync(lockPath(endpoint), JSON.stringify(record) + "\n");
    const unknown = supervisor(home, { binary: build(home, "new", "another build") });
    unknown.s.start();
    await unknown.s.ready();
    assert.equal(unknown.s.current.replacing, false);
    await settle();
    assert.ok(alive(before.pid));
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a finx serve started from a terminal stays when it runs the app's finx, and is otherwise replaced like an older app's", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const endpoint = path.join(home, "run", "finx.sock");
    const own = build(home, "own");
    const terminal = spawn(own, ["serve", "--listen", `unix://${endpoint}`, "--idle-exit", "30"], {
      stdio: "ignore",
      env: { ...process.env, FINX_HOME: home, FINX_CREDENTIAL_STORE: "file" },
    });
    await until(() => fs.existsSync(endpoint));
    const same = supervisor(home, { binary: own });
    same.s.start();
    await same.s.ready();
    assert.equal(same.s.current.ours, true);
    assert.equal(same.s.current.replacing, false);
    same.s.stop();
    await settle();
    assert.ok(alive(terminal.pid!), "the app's own finx stays, whoever started it");
    const other = supervisor(home, { binary: build(home, "new", "another build") });
    other.s.start();
    await other.s.ready();
    await takenOver(other.s, terminal.pid!);
    await until(() => !alive(terminal.pid!));
    assert.ok(!alive(terminal.pid!), "another build goes, as one of another version does");
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("two open apps of different builds do not keep replacing each other", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const endpoint = path.join(home, "run", "finx.sock");
    const first = supervisor(home, { binary: build(home, "first", "first build") });
    first.s.start();
    await first.s.ready();
    const before = readRecord(endpoint)!;
    // The second takes over as it opens; the first reconnects to whichever of them got there.
    const second = supervisor(home, { binary: build(home, "second", "second build") });
    second.s.start();
    await until(() => !alive(before.pid));
    await takenOver(first.s, before.pid);
    await takenOver(second.s, before.pid);
    const settled = readRecord(endpoint)!;
    await settle(1500);
    assert.equal(readRecord(endpoint)?.pid, settled.pid, "no more replacing");
    assert.ok(alive(settled.pid));
    for (const app of [first, second]) {
      assert.equal(app.s.current.state, "ready");
      assert.equal(app.s.current.replacing, false);
    }
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sameBytes tells files apart wherever they differ", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const file = (name: string, bytes: Buffer) => {
      fs.writeFileSync(path.join(dir, name), bytes);
      return path.join(dir, name);
    };
    const bytes = Buffer.alloc(2 * (1 << 20) + 5, 7);
    const a = file("a", bytes);
    assert.equal(await sameBytes(a, file("copy", bytes)), true);
    assert.equal(await sameBytes(a, file("shorter", bytes.subarray(1))), false);
    const late = Buffer.from(bytes);
    late[late.length - 1] = 8;
    assert.equal(await sameBytes(a, file("last-byte", late)), false, "the same size, past the first chunks");
    assert.equal(await sameBytes(a, path.join(dir, "missing")), false);
    assert.equal(await sameBytes(path.join(dir, "missing"), a), false);
    assert.equal(await sameBytes(file("empty", Buffer.alloc(0)), file("empty2", Buffer.alloc(0))), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A window puts the default bot to work; an app that would replace the service opens, and has to wait. */
async function botHoldsBack(replacing: (home: string) => { expected?: string; binary?: string }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  // The model: holds the bot's request until released, then answers with a message.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      await held;
      const call = { index: 0, id: "c1", type: "function", function: { name: "send_to_user", arguments: JSON.stringify({ text: "好了", end_turn: true }) } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  let client: { rpc: RpcClient; close: () => void } | null = null;
  try {
    const port = (provider.address() as AddressInfo).port;
    fs.writeFileSync(
      path.join(home, "models.toml"),
      `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
    );
    fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);
    const old = supervisor(home);
    old.s.start();
    await old.s.ready();
    const before = readRecord(old.s.current.endpoint)!;
    old.s.stop();
    // A window puts the default bot to work: its request to the model waits.
    const c = await tryConnect(old.s.current.endpoint, 2000);
    assert.ok(c.ok);
    const rpc = new RpcClient(socketTransport(c.socket));
    client = { rpc, close: () => c.socket.destroy() };
    await rpc.request("initialize", { protocol_version: 2, client_info: { name: "supervisor-test" } });
    const { bots } = await rpc.request("bots/subscribe", {});
    const opened = await rpc.request("bots/open", { bot_id: bots[0].id });
    let typing = false;
    rpc.on("bots/changed", (ch) => (typing ||= ch.bots.some((b) => b.typing)));
    await rpc.request("session/op", { session_id: opened.session_id, op: { type: "prompt", input: [{ type: "text", text: "在吗" }] } });
    await until(() => typing);
    // This app would replace the service, but the bot works.
    const app = supervisor(home, replacing(home));
    app.s.start();
    await app.s.ready();
    assert.equal(app.s.current.replacing, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(before.pid), "the service stays while the bot works");
    // Done: now it is replaced.
    release();
    await until(() => !alive(before.pid));
    await until(() => app.s.current.state === "ready" && readRecord(app.s.current.endpoint)?.pid !== before.pid);
  } finally {
    release();
    client?.close();
    provider.close();
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("a bot at work holds back replacing a service of another version until it is done", { skip: !built && "run `cargo build` first", timeout: 30_000 }, () =>
  botHoldsBack(() => ({ expected: "99.0.0" })),
);

test("a bot at work holds back replacing a service running another build until it is done", { skip: !built && "run `cargo build` first", timeout: 30_000 }, () =>
  botHoldsBack((home) => ({ binary: build(home, "new", "another build") })),
);

test("after an update puts a new finx at the app's path, the service still running the old one is replaced", { skip: !built && "run `cargo build` first", timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    // The app's own finx: same version before and after, as when only the window changed.
    const binary = path.join(home, "app", "finx");
    fs.mkdirSync(path.dirname(binary));
    fs.copyFileSync(finx, binary);
    const starts = path.join(home, "starts.json");
    const old = supervisor(home, { binary, starts });
    old.s.start();
    await old.s.ready();
    const before = readRecord(old.s.current.endpoint)!;
    old.s.stop();
    // Another app's start with the same file in place keeps the service.
    const same = supervisor(home, { binary, starts });
    same.s.start();
    await same.s.ready();
    assert.equal(same.s.current.replacing, false);
    same.s.stop();
    // The update: a new file at the same path (Squirrel swaps the whole bundle).
    fs.copyFileSync(finx, binary + ".new");
    fs.renameSync(binary + ".new", binary);
    const updated = supervisor(home, { binary, starts });
    updated.s.start();
    await updated.s.ready();
    await until(() => readRecord(updated.s.current.endpoint)?.pid !== before.pid && updated.s.current.state === "ready");
    await until(() => !alive(before.pid));
    assert.ok(!alive(before.pid), "the old service stopped");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(updated.s.current.replacing, false, "the new service, started from the new file, stays");
  } finally {
    await cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a socket path that is too long fails with a reason instead of starting finx", async () => {
  const home = path.join(os.tmpdir(), "x".repeat(90));
  const { s } = supervisor(home);
  s.start();
  await assert.rejects(s.ready(), /longer than 103 bytes/);
  assert.equal(s.current.state, "failed");
  assert.equal((await tryConnect(s.current.endpoint, 50)).ok, false);
});
