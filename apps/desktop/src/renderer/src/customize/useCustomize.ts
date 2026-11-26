import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcError } from "@finx/client";
import type { ConfigEdit, ConfigLayer, ConfigReadResult, McpChangedParams, McpCheckResult, McpListResult, McpServerView, McpUpdateCheckResult, McpUpgradeResult, SkillsListResult } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import { errorText, useStore, type Store } from "../store";
import { skillItems, type SkillItem } from "./model";

const t = i18n.getFixedT(null, "customize");

// The page's data (customize-design §10.3): skills/list, mcp/list and config/read for the
// project of the new session page; read again on skills/changed, config/changed and
// mcp/changed (asking subscribes), and when the window comes back. Changes show at once and
// go back if finx refuses them; removals wait for the toast's Undo.

/** How long a removal can be undone: the toast's time. */
const UNDO_MS = 5200;

export type Customize = ReturnType<typeof useCustomize>;

export function useCustomize(cwd: string | null) {
  const st = useStore();
  const rpc = st.rpc;
  const [skills, setSkills] = useState<SkillsListResult | null>(null);
  const [mcp, setMcp] = useState<McpListResult | null>(null);
  const [config, setConfig] = useState<ConfigReadResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Switches turned here that finx has not confirmed yet: skill path or server name → on. */
  const [switching, setSwitching] = useState<Map<string, boolean>>(new Map());
  /** Removed here, waiting for the toast's Undo to pass. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [checkingUpdate, setCheckingUpdate] = useState<Set<string>>(new Set());
  const [upgrading, setUpgrading] = useState<Set<string>>(new Set());
  const [updates, setUpdates] = useState<Map<string, McpUpdateCheckResult>>(new Map());
  /** Servers waiting for their sign-in in the browser: name → the address to open again. */
  const [signingIn, setSigningIn] = useState<Map<string, string>>(new Map());
  const loginStops = useRef(new Map<string, () => void>());
  useEffect(() => () => {
    for (const stop of loginStops.current.values()) stop();
    loginStops.current.clear();
  }, [rpc]);
  /** Catalog entries being added. */
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const params = useMemo(() => (cwd ? { cwd } : {}), [cwd]);

  const readSkills = useCallback(async () => {
    if (rpc) setSkills(await rpc.request("skills/list", params));
  }, [rpc, params]);
  const readServers = useCallback(async () => {
    if (!rpc) return;
    const [m, c] = await Promise.all([rpc.request("mcp/list", params), rpc.request("config/read", { ...params, layers: true })]);
    setMcp(m);
    setConfig(c);
  }, [rpc, params]);
  const readAll = useCallback(
    () =>
      Promise.all([readSkills(), readServers()])
        .then(() => setFailed(null))
        .catch((e) => setFailed(errorText(e))),
    [readSkills, readServers],
  );

  useEffect(() => {
    if (!rpc) return;
    setSkills(null);
    setMcp(null);
    setConfig(null);
    void readAll();
    const offs = [
      rpc.on("skills/changed", () => void readSkills().catch(() => {})),
      rpc.on("config/changed", () => void readServers().then(readSkills).catch(() => {})),
      rpc.on("mcp/changed", () => void readServers().catch(() => {})),
    ];
    const focus = () => void readAll();
    window.addEventListener("focus", focus);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("focus", focus);
    };
  }, [rpc, readAll, readSkills, readServers]);

  // What finx says now makes a switch turned here moot.
  useEffect(() => {
    setSwitching((m) => (m.size ? new Map() : m));
  }, [skills, mcp]);

  // Removals still waiting go through when the page closes.
  const removals = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => Promise<unknown> }>());
  useEffect(
    () => () => {
      for (const r of removals.current.values()) {
        clearTimeout(r.timer);
        void r.commit().catch(() => {});
      }
      removals.current.clear();
    },
    [],
  );

  /** Takes `key` off the page now, and runs `commit` once the toast's Undo has passed. */
  const removeLater = useCallback(
    (key: string, text: string, commit: () => Promise<unknown>) => {
      setHidden((h) => new Set(h).add(key));
      const unhide = () => setHidden((h) => (h.delete(key) ? new Set(h) : h));
      const timer = setTimeout(() => {
        removals.current.delete(key);
        commit()
          .then(() => readAll())
          .catch((e) => st.show(errorText(e), undefined, true))
          .finally(unhide);
      }, UNDO_MS);
      removals.current.set(key, { timer, commit });
      st.show(text, () => {
        clearTimeout(timer);
        removals.current.delete(key);
        unhide();
      });
    },
    [st, readAll],
  );

  /** The file of a layer and its version as read, for a write that must not overwrite a newer one. */
  const layerInfo = useCallback((layer: ConfigLayer) => config?.layers?.find((l) => l.layer === layer) ?? null, [config]);

  /** config/write against the version read; when the file changed meanwhile, read it again and write once more. */
  const write = useCallback(
    async (layer: ConfigLayer, edits: ConfigEdit[]) => {
      if (!rpc) throw new Error(i18n.t("common:kernel.connecting"));
      const call = (expected_version?: string | null) => rpc.request("config/write", { layer, edits, cwd: cwd ?? undefined, expected_version });
      try {
        return await call(layerInfo(layer)?.version);
      } catch (e) {
        if (!(e instanceof RpcError && e.kind === "config_version_conflict")) throw e;
        const fresh = await rpc.request("config/read", { ...params, layers: true });
        setConfig(fresh);
        return call(fresh.layers?.find((l) => l.layer === layer)?.version);
      }
    },
    [rpc, cwd, params, layerInfo],
  );

  /** mcp/check: connects once, lists the tools, and the cache the page reads remembers them. */
  const check = useCallback(
    async (name: string): Promise<McpCheckResult | null> => {
      if (!rpc) return null;
      setChecking((c) => new Set(c).add(name));
      try {
        const r = await rpc.request("mcp/check", { name, ...params });
        await readServers();
        return r;
      } catch (e) {
        st.show(errorText(e), undefined, true);
        return null;
      } finally {
        setChecking((c) => {
          const next = new Set(c);
          next.delete(name);
          return next;
        });
      }
    },
    [rpc, params, readServers, st],
  );

  /** mcp/check_update: queries upstream registry or bundled manifest for a newer version. */
  const checkUpdate = useCallback(
    async (name: string): Promise<McpUpdateCheckResult | null> => {
      if (!rpc) return null;
      setCheckingUpdate((c) => new Set(c).add(name));
      try {
        const r = await rpc.request("mcp/check_update", { name, ...params });
        setUpdates((m) => new Map(m).set(name, r));
        await readServers();
        if (r.status === "up_to_date") {
          st.show(t("toast.updateUpToDate", { name, version: r.current_version ?? r.latest_version ?? "" }));
        } else if (r.status === "update_available") {
          st.show(
            r.current_version
              ? t("toast.updateAvailable", { name, current: r.current_version, latest: r.latest_version ?? "" })
              : t("toast.updateAvailableLatest", { name, latest: r.latest_version ?? "" }),
          );
        } else if (r.status === "unknown" && r.latest_version) {
          st.show(t("toast.updateAvailableLatest", { name, latest: r.latest_version }));
        } else {
          st.show(r.detail ?? t("toast.updateUnsupported", { name }));
        }
        return r;
      } catch (e) {
        st.show(errorText(e), undefined, true);
        return null;
      } finally {
        setCheckingUpdate((c) => {
          const next = new Set(c);
          next.delete(name);
          return next;
        });
      }
    },
    [rpc, params, readServers, st],
  );

  /** mcp/upgrade: updates a managed connector or local package connector to the latest version and rechecks it. */
  const upgrade = useCallback(
    async (name: string): Promise<McpUpgradeResult | null> => {
      if (!rpc) return null;
      setUpgrading((c) => new Set(c).add(name));
      try {
        const r = await rpc.request("mcp/upgrade", { name, ...params });
        setUpdates((m) => {
          const next = new Map(m);
          next.delete(name);
          return next;
        });
        await readServers();
        st.show(t("toast.upgraded", { name, version: r.current_version ?? "" }));
        return r;
      } catch (e) {
        st.show(errorText(e), undefined, true);
        return null;
      } finally {
        setUpgrading((c) => {
          const next = new Set(c);
          next.delete(name);
          return next;
        });
      }
    },
    [rpc, params, readServers, st],
  );

  /**
   * mcp/login for a server already added (mcp-design §13.8): opens the browser, waits for
   * finx to say the sign-in ended, then checks the server once.
   */
  const login = useCallback(
    async (name: string) => {
      if (!rpc || loginStops.current.has(name)) return;
      const events = new Map<string, McpChangedParams>();
      let loginId: string | null = null;
      let finish!: (p: McpChangedParams) => void;
      const ended = new Promise<McpChangedParams>((resolve) => { finish = resolve; });
      const showURL = (url: string) => {
        setSigningIn((m) => new Map(m).set(name, url));
        window.finx?.openExternal(url);
      };
      const accept = (p: McpChangedParams) => {
        if (p.authorize_url) showURL(p.authorize_url);
        else finish(p);
      };
      const off = rpc.on("mcp/changed", (p) => {
        if (p.name !== name || !p.login_id) return;
        events.set(p.login_id, p);
        if (p.login_id === loginId) accept(p);
      });
      let abandoned = false;
      loginStops.current.set(name, () => {
        abandoned = true;
        off();
        finish({ name });
        void rpc.request("mcp/login_cancel", { name }).catch(() => {});
      });
      setSigningIn((m) => new Map(m).set(name, ""));
      try {
        const r = await rpc.request("mcp/login", { name, ...params });
        if (abandoned) {
          await rpc.request("mcp/login_cancel", { name });
          return;
        }
        loginId = r.login_id;
        const early = events.get(loginId);
        if (early) accept(early);
        else showURL(r.authorize_url);
        const error = (await ended).login_error;
        if (abandoned) return;
        if (error) st.show(t("toast.loginFailed", { name, error }), undefined, true);
        else {
          st.show(t("toast.signedIn", { name }));
          await check(name);
        }
      } catch (e) {
        st.show(errorText(e), undefined, true);
      } finally {
        off();
        loginStops.current.delete(name);
        setSigningIn((m) => {
          const next = new Map(m);
          next.delete(name);
          return next;
        });
      }
    },
    [rpc, params, check, st],
  );

  /** mcp/logout: forgets the server's sign-in, then checks it, so the page says it needs one. */
  const logout = useCallback(
    async (name: string) => {
      if (!rpc) return;
      try {
        await rpc.request("mcp/logout", { name });
        st.show(t("toast.signedOut", { name }));
        await check(name);
      } catch (e) {
        st.show(errorText(e), undefined, true);
      }
    },
    [rpc, check, st],
  );

  // ---- skills ----

  const items = useMemo(
    () =>
      skillItems(skills)
        .filter((i) => !hidden.has(`skill:${i.dir}`))
        .map((i) => (switching.has(i.dir) ? { ...i, on: switching.get(i.dir)! } : i)),
    [skills, hidden, switching],
  );

  const switchSkill = useCallback(
    async (item: SkillItem, on: boolean, done: string) => {
      if (!rpc) return;
      setSwitching((m) => new Map(m).set(item.dir, on));
      try {
        await rpc.request("skills/set_enabled", { path: item.dir, enabled: on });
        await readSkills();
        st.show(done);
      } catch (e) {
        setSwitching((m) => {
          const next = new Map(m);
          next.delete(item.dir);
          return next;
        });
        st.show(errorText(e), undefined, true);
      }
    },
    [rpc, readSkills, st],
  );

  const removeSkill = useCallback(
    (item: SkillItem) => {
      if (!rpc) return;
      removeLater(`skill:${item.dir}`, t("toast.skillRemoved", { name: item.entry.name }), () => rpc.request("skills/remove", { path: item.dir }));
    },
    [rpc, removeLater],
  );

  // ---- servers ----

  const servers = useMemo(
    () =>
      (mcp?.servers ?? [])
        .filter((s) => !hidden.has(`server:${s.name}`))
        .map((s) => (switching.has(s.name) ? { ...s, enabled: switching.get(s.name)! } : s)),
    [mcp, hidden, switching],
  );

  /**
   * On or off where it is defined; a server of the repository for the person alone, in the
   * personal project layer (§10.4): off writes `enabled = false` there, on takes it out.
   */
  const switchServer = useCallback(
    async (s: McpServerView, on: boolean, done: string) => {
      // On: take out the setting that turned it off where finx may write it, else say `true` for
      // the person; off: where it is defined, or for the person.
      const writable = (l: ConfigLayer | null | undefined): l is ConfigLayer => l === "user" || l === "user_project";
      const ownLayer: ConfigLayer = s.editable && writable(s.layer) ? s.layer : cwd ? "user_project" : "user";
      const layer: ConfigLayer = on && writable(s.disabled_by) ? s.disabled_by : ownLayer;
      const value = on ? (layer === s.disabled_by ? null : true) : false;
      const key = `mcp_servers.${quoteKey(s.name)}.enabled`;
      setSwitching((m) => new Map(m).set(s.name, on));
      try {
        const r = await write(layer, [{ key_path: key, value, merge: "replace" }]);
        await readServers();
        const over = r.overridden_by?.[0];
        if (over) st.show(t(on ? "toast.overriddenOff" : "toast.overriddenOn", { name: s.name, file: over.file ?? over.layer }), undefined, true);
        else st.show(done);
        if (on && s.status.state !== "ok") void check(s.name);
      } catch (e) {
        setSwitching((m) => {
          const next = new Map(m);
          next.delete(s.name);
          return next;
        });
        st.show(errorText(e), undefined, true);
      }
    },
    [write, readServers, check, st, cwd],
  );

  const removeServer = useCallback(
    (s: McpServerView) => {
      const credentials = !!s.connector || (s.credentials ?? []).length > 0;
      removeLater(`server:${s.name}`, t(credentials ? "toast.serverRemovedWithSecret" : "toast.serverRemoved", { name: s.name }), async () => {
        if (s.connector) await rpc?.request("mcp/logout", { name: s.name });
        return write(s.layer, [{ key_path: `mcp_servers.${quoteKey(s.name)}`, value: null, merge: "replace" }]);
      },
      );
    },
    [rpc, write, removeLater],
  );

  /**
   * Adds or changes a server (§10.4): its secrets go to the keychain first, then its settings
   * to `layer` (and out of `movedFrom`, when its scope changed), then one check. `upsert`
   * changes only the fields given (null takes one out), keeping what else the file says.
   */
  const saveServer = useCallback(
    async (layer: ConfigLayer, name: string, server: Record<string, unknown>, secrets: [string, string][], movedFrom?: ConfigLayer, merge: "replace" | "upsert" = "replace") => {
      if (!rpc) throw new Error(i18n.t("common:kernel.connecting"));
      for (const [credential, value] of secrets) await rpc.request("credentials/set", { name: credential, value });
      const key = `mcp_servers.${quoteKey(name)}`;
      const written = await write(layer, [{ key_path: key, value: server, merge }]);
      if (movedFrom && movedFrom !== layer) await write(movedFrom, [{ key_path: key, value: null, merge: "replace" }]);
      await readServers();
      return { written, check: await check(name) };
    },
    [rpc, write, readServers, check],
  );

  return {
    cwd,
    skills,
    items,
    mcp,
    servers,
    config,
    failed,
    loaded: skills !== null && mcp !== null && config !== null,
    checking,
    checkingUpdate,
    upgrading,
    updates,
    signingIn,
    adding,
    setAdding,
    readAll,
    readSkills,
    readServers,
    layerInfo,
    write,
    check,
    checkUpdate,
    upgrade,
    login,
    logout,
    switchSkill,
    removeSkill,
    switchServer,
    removeServer,
    saveServer,
  };
}

/** A name as one segment of a key path. */
export function quoteKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** The project the new session page has chosen, as the page's (DQ-25). */
export function pageCwd(st: Store, recent: string[]): string | null {
  return st.draft.noProject ? null : (st.draft.cwd ?? recent[0] ?? null);
}
