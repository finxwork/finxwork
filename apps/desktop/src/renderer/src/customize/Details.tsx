import { useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { McpServerView, McpToolsResult, SkillsFilesResult } from "@finx/protocol";
import { catalogConnectors, catalogSkills, commandLine, oneClick, type CatalogConnector } from "../../../shared/catalog";
import { agoText } from "../format";
import { Icon } from "../icons";
import { errorText, useNow, useStore, type CustomizeView } from "../store";
import type { Actions } from "./Lists";
import { SkillContents } from "./SkillContents";
import { addedConnector, addedSkill, catalogOf, catalogText, fromRepo, statusOf, type SkillItem } from "./model";
import { catalogLogo, MoreButton, ServerTile, SkillTile, Switch, tilde, type MenuItem } from "./parts";
import type { Customize } from "./useCustomize";

// A card's own page (customize-design §10.1): back to the list, the item with its actions,
// tabs on a hairline, then what it does on the left and the facts about it on the right.

type Detail = NonNullable<CustomizeView["detail"]>;

/** Where the catalog's skill files are. */
export function catalogDir(): string {
  return window.finx?.catalogDir || "/catalog/skills";
}

function Back({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button className="cz-back" onClick={onBack}>
      <Icon name="arrowLeft" />
      {label}
    </button>
  );
}

function Hero({ tile, name, badge, meta, acts }: { tile: ReactNode; name: string; badge?: ReactNode; meta: ReactNode[]; acts: ReactNode }) {
  return (
    <div className="cz-hero">
      {tile}
      <div className="dt">
        <h1>
          {name}
          {badge}
        </h1>
        <div className="cz-meta">
          {meta.map((m, i) => (
            <span key={i} className="cz-meta-i">
              {i > 0 && <i>·</i>}
              {m}
            </span>
          ))}
        </div>
      </div>
      <div className="cz-acts">{acts}</div>
    </div>
  );
}

function Tabs({ tabs, on, onTab }: { tabs: { id: string; label: string; n?: number }[]; on: string; onTab: (id: string) => void }) {
  return (
    <div className="cz-dtabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={on === tab.id} className={`cz-dtab ${on === tab.id ? "on" : ""}`} onClick={() => onTab(tab.id)}>
          {tab.label}
          {tab.n !== undefined && <span className="n"> · {tab.n}</span>}
        </button>
      ))}
    </div>
  );
}

function Fact({ k, children, stack, mono }: { k: string; children: ReactNode; stack?: boolean; mono?: boolean }) {
  return (
    <div className={`cz-kv ${stack ? "stack" : ""}`}>
      <span className="k">{k}</span>
      <span className={`v ${mono ? "mono" : ""}`}>{children}</span>
    </div>
  );
}

function SolidAdd({ busy, label, busyLabel, onAdd }: { busy: boolean; label: string; busyLabel: string; onAdd: () => void }) {
  return busy ? (
    <button className="btn cz-solid" disabled>
      <span className="mini-spin cz-spin-solid" />
      {busyLabel}
    </button>
  ) : (
    <button className="btn cz-solid" onClick={onAdd}>
      <Icon name="plus" />
      {label}
    </button>
  );
}

/**
 * A skill's page (customize-design §10.13; the look is docs/desktop/skill-detail-demo.html): the
 * connector page's one column. Back alone on the top line; the tile and name large with the
 * item's controls at the right; its facts in a row, with a line under them when there is
 * something to know about where it lives; then what it does, under its own heading; then its files, the folder as a tree beside the open file.
 */
export function SkillPage({ c, a, detail, project, onBack }: { c: Customize; a: Actions; detail: Detail; project: string | null; onBack: () => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const item: SkillItem | null = detail.catalog ? null : (c.items.find((i) => i.dir === detail.id) ?? null);
  const cat = detail.catalog ? (catalogSkills.find((x) => x.id === detail.id) ?? null) : (item?.catalog ?? null);
  const installed = detail.catalog && cat ? addedSkill(c.items, cat) : null;
  const dir = item?.dir ?? (cat ? `${catalogDir()}/${cat.id}` : null);
  const [files, setFiles] = useState<SkillsFilesResult | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  useEffect(() => {
    if (!dir || !st.rpc) return;
    let current = true;
    st.rpc.request("skills/files", { path: dir }).then(
      (f) => current && (setFiles(f), setFilesError(null)),
      (e) => current && setFilesError(errorText(e)),
    );
    return () => {
      current = false;
    };
  }, [dir, st.rpc]);
  // Added from its page: the page of the skill it became.
  useEffect(() => {
    if (installed) a.open({ kind: "skill", id: installed.dir, tab: detail.tab });
  }, [installed, a, detail.tab]);
  // Gone (removed elsewhere): back to the list.
  const gone = c.loaded && !item && !cat;
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);
  if (!item && !cat) return null;
  const name = item?.entry.name ?? cat!.id;
  const count = files ? files.files.filter((f) => !f.dir).length : (cat?.files ?? 0);
  const description = item?.entry.description ?? catalogText(t, `catalog.skills.${cat!.id}`);
  const source = item
    ? item.group === "system"
      ? t("skill.source.system")
      : item.from
        ? t(item.group === "project" ? "skill.fromApp" : "skill.sharedWith", { from: item.from })
        : item.group === "project"
          ? t("skill.source.repo")
          : item.group === "extra"
            ? t("skill.source.extra")
            : t(`skill.source.${item.entry.source?.kind ?? "local"}` as "skill.source.local")
    : t("catalog.by");
  const command = `/skill:${name}`;
  const copy = () => {
    void navigator.clipboard?.writeText(command);
    st.show(t("skill.copied", { command }));
  };
  const menu = (): MenuItem[] =>
    item
      ? [
          { id: "reveal", label: t("skill.reveal"), icon: "folder" as const, run: () => window.finx?.revealPath(item.dir) },
          // Only the person's own, in ~/.finx/skills (DD-35, DD-36).
          ...(item.entry.removable ? [null, { id: "remove", label: t("skill.removeSkill"), icon: "trash" as const, danger: true, run: () => c.removeSkill(item) }] : []),
        ]
      : [];
  const badge = item?.group === "system" ? t("skill.builtIn") : item?.group === "project" ? t("skill.source.repo") : null;
  // A built-in skill needs none: its badge says what it is.
  const note = item?.offByDefault ? (
    <Trans t={t} i18nKey="skill.offByDefaultNote" values={{ folder: `${item.from ?? ".claude"}/skills` }} components={{ code: <code /> }} />
  ) : item?.group === "project" ? (
    t("skill.repoNote")
  ) : item?.from ? (
    <Trans t={t} i18nKey="skill.sharedNote" values={{ folder: `~/${item.from}/skills` }} components={{ code: <code /> }} />
  ) : item?.group === "extra" ? (
    t("skill.extraNote")
  ) : null;
  return (
    <div className={`cz-dpage ${item && !item.on ? "off" : ""}`}>
      <div className="cz-dbar">
        <Back label={t("skill.back")} onBack={onBack} />
      </div>
      <div className="cz-dhead">
        <div className="cz-dtitle">
          <SkillTile size="xl" />
          <h1>{name}</h1>
          {badge && <span className="badge">{badge}</span>}
          <div className="cz-dacts">
            {item ? (
              <>
                {/* A skill turned off is not offered to the message box. */}
                <button className="btn" disabled={!item.on} onClick={() => a.useSkill(item.entry.name)}>
                  <Icon name="chat" />
                  {t("skill.use")}
                </button>
                <label className="cz-swl">
                  {t("skill.enabled")}
                  <Switch on={item.on} label={item.on ? t("skill.turnOff") : t("skill.turnOn")} onChange={(on) => a.toggleSkill(item, on)} />
                </label>
                <MoreButton label={t("more")} items={menu} />
              </>
            ) : (
              <SolidAdd busy={c.adding.has(`skill:${cat!.id}`)} label={t("skill.add")} busyLabel={t("skill.adding")} onAdd={() => a.installSkill(cat!)} />
            )}
          </div>
        </div>
        <div className="cz-facts">
          <DFact k={t("skill.sourceLabel")}>{source}</DFact>
          {item ? (
            <>
              {(item.group === "user" || item.group === "project") && <DFact k={t("skill.scopeLabel")}>{t(`skill.scope.${item.group}`, { project })}</DFact>}
              <DFact k={t("skill.invoke")}>
                <span className="cut">{command}</span>
                {!item.entry.model_invocable && <span className="sub">{t("skill.userOnly")}</span>}
                <button className="cz-ghost" title={t("skill.copy")} aria-label={t("skill.copy")} onClick={copy}>
                  <Icon name="copy" />
                </button>
              </DFact>
              <DFact k={t("skill.path")} grow>
                <span className="cut" title={item.dir}>
                  {tilde(item.dir)}
                </span>
                <button className="cz-ghost" title={t("skill.reveal")} aria-label={t("skill.reveal")} onClick={() => window.finx?.revealPath(item.dir)}>
                  <Icon name="folder" />
                </button>
              </DFact>
            </>
          ) : (
            <>
              <DFact k={t("skill.license")}>{cat!.license === "finxwork" ? t("skill.licenseFinxwork") : cat!.license}</DFact>
              <DFact k={t("skill.addTo")} grow>
                <span className="cut">{`~/.finx/skills/${cat!.id}`}</span>
              </DFact>
            </>
          )}
        </div>
        {/* Only something to know, never to do: a quiet line under the facts it explains. */}
        {note && <p className="cz-aside">{note}</p>}
      </div>
      {description && (
        <section className="cz-dsum">
          <div className="k">{t("skill.summary")}</div>
          <p>{description}</p>
        </section>
      )}
      <section className="cz-dfiles">
        <div className="cz-th">
          <h2>{t("skill.filesTitle")}</h2>
          <span className="n">{count}</span>
        </div>
        {dir && <SkillContents key={dir} dir={dir} files={files} error={filesError} reveal={!!item} />}
      </section>
    </div>
  );
}

/** One of a page's facts: a small label over its value. */
function DFact({ k, grow, children }: { k: string; grow?: boolean; children: ReactNode }) {
  return (
    <div className={`cz-fact ${grow ? "grow" : ""}`}>
      <div className="k">{k}</div>
      <div className="v">{children}</div>
    </div>
  );
}

export function ConnectorPage({ c, a, detail, project, onBack, onTab }: { c: Customize; a: Actions; detail: Detail; project: string | null; onBack: () => void; onTab: (tab: string) => void }) {
  const server = detail.catalog ? null : (c.servers.find((s) => s.name === detail.id) ?? null);
  const cat = detail.catalog ? (catalogConnectors.find((x) => x.id === detail.id) ?? null) : null;
  const added = cat ? addedConnector(c.servers, cat) : null;
  // Added from its page: the page of the server it became.
  useEffect(() => {
    if (added) a.open({ kind: "connector", id: added.name, tab: "overview" });
  }, [added, a]);
  const gone = c.loaded && !server && !cat;
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);
  if (server) return <ServerPage c={c} a={a} s={server} onBack={onBack} />;
  if (cat) return <CatalogConnectorPage c={c} a={a} cat={cat} project={project} onBack={onBack} />;
  return null;
}

/** Where a remote server's account lives, as people say it: its host without the service label. */
function accountHost(url: string): string {
  const host = URL.parse(url)?.hostname ?? "";
  return host.replace(/^(mcp|api|www|server|gateway|sse)\./, "");
}

/**
 * A connector's page (customize-design §10.12; the look is docs/desktop/connector-detail-demo.html):
 * back on the top line, the logo and name large with the item's controls at the right, its facts
 * in one row, a note when something needs the person, what it does under its own heading, then
 * its tools a line each.
 */
function ServerPage({ c, a, s, onBack }: { c: Customize; a: Actions; s: McpServerView; onBack: () => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const now = useNow(60_000);
  const cat = catalogOf(s);
  const repo = fromRepo(s);
  const look = statusOf(s, c.checking.has(s.name));
  const untrusted = s.status.state === "untrusted";
  const remote = s.transport !== "stdio";
  const [tools, setTools] = useState<McpToolsResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (untrusted || !st.rpc) return;
    let current = true;
    st.rpc.request("mcp/tools", { name: s.name, ...(c.cwd ? { cwd: c.cwd } : {}) }).then(
      (r) => current && setTools(r),
      () => current && setTools({ tools: [], source: "none" }),
    );
    return () => {
      current = false;
    };
  }, [untrusted, st.rpc, s.name, c.cwd, s.status.checked_at, s.status.state]);
  const name = cat?.name ?? s.name;
  const copy = () => {
    void navigator.clipboard?.writeText(s.summary);
    st.show(t(remote ? "connector.copiedAddress" : "connector.copiedCommand"));
  };

  // The state in a word, coloured as the list colours it.
  const [stCls, stDot, stText] =
    look.kind === "ok"
      ? ["ok", "on", t("connector.stateOk")]
      : look.kind === "failed"
        ? ["bad", "bad", t("connector.failed")]
        : look.kind === "needs_login"
          ? ["warn", "warn", t("connector.needsLogin")]
          : look.kind === "off"
            ? ["", "", look.forYou ? t("connector.offForYou") : t("connector.off")]
            : look.kind === "checking"
              ? ["", "", t("connector.checking")]
              : look.kind === "untrusted"
                ? ["warn", "warn", t("connector.stateUntrusted")]
                : ["", "", t("connector.unknown")];
  // How it is let in: the account it signs in with, or the secret it sends.
  const keyNames = (s.credentials ?? []).map((cr) => cr.replace(new RegExp(`^mcp\\.${s.name}\\.?`), "").replace(/^header\./, "")).filter(Boolean);
  const access =
    s.auth === "oauth"
      ? { k: t("connector.account"), v: s.connector ? (catalogConnectors.find((x) => x.managed === s.connector)?.name ?? s.connector) : accountHost(s.summary), sub: s.auth_state === "logged_in" ? t("connector.signedIn") : t("connector.signedOut") }
      : s.auth === "credential"
        ? { k: remote ? t("connector.token") : t("connector.secret"), v: keyNames.join(", "), sub: s.auth_state === "missing" ? t("connector.keyMissing") : t("connector.keySaved") }
        : null;

  const update = c.updates.get(s.name);
  const checkingUpdate = c.checkingUpdate.has(s.name);
  const upgrading = c.upgrading.has(s.name);
  const hasUpdate = !!update?.latest_version && (update.status === "update_available" || (update.status === "unknown" && update.can_upgrade));

  const menu = (): MenuItem[] => [
    ...(s.editable && !s.connector ? [{ id: "edit", label: t("connector.edit"), icon: "edit" as const, run: () => a.edit(s) }, null] : []),
    ...(!untrusted ? [{ id: "check", label: t("connector.recheck"), icon: "retry" as const, run: () => void c.check(s.name) }] : []),
    ...(s.update_supported && !untrusted
      ? [{ id: "checkUpdate", label: t("connector.checkUpdate"), icon: "arrowUp" as const, disabled: checkingUpdate || upgrading, run: () => void c.checkUpdate(s.name) }]
      : []),
    ...(s.connector && cat ? [{ id: "reinstall", label: t("managed.reinstall"), icon: "retry" as const, run: () => a.addConnector(cat) }] : []),
    ...(!s.connector ? [{ id: "copy", label: remote ? t("connector.copyAddress") : t("connector.copyCommand"), icon: "copy" as const, run: copy }] : []),
    ...(s.auth === "oauth" && s.auth_state === "logged_in" ? [{ id: "logout", label: t("connector.signOut"), icon: "logout" as const, run: () => void c.logout(s.name) }] : []),
    ...(s.editable ? [null, { id: "remove", label: t("connector.removeConnector"), icon: "trash" as const, danger: true, run: () => c.removeServer(s) }] : []),
  ];

  const signing = c.signingIn.get(s.name);
  let note: ReactNode = null;
  if (untrusted)
    note = (
      <Note kind="warn" title={t("connector.untrustedTitle")}>
        <Trans t={t} i18nKey="connector.untrustedNote" components={{ code: <code /> }} />
      </Note>
    );
  else if ((s.enabled || s.connector) && look.kind === "needs_login")
    note = (
      <Note
        kind="warn"
        title={t("connector.loginTitle")}
        action={
          signing !== undefined ? (
            <span className="cz-note-wait">
              <span className="mini-spin cz-spin" />
              {t("connector.signingIn")}
              <button className="link" data-authorize={signing} onClick={() => void navigator.clipboard?.writeText(signing)}>
                {t("addc.copyLink")}
              </button>
              <button className="link" onClick={() => void st.rpc?.request("mcp/login_cancel", { name: s.name }).catch((e) => st.show(String(e), undefined, true))}>{t("managed.cancel")}</button>
            </span>
          ) : (
            <button className="btn primary" onClick={() => void c.login(s.name)}>
              {t("connector.signIn")}
            </button>
          )
        }
      >
        {s.connector ? t("managed.authorizeHint", { name }) : t("connector.loginText", { account: accountHost(s.summary) })}
      </Note>
    );
  else if (s.enabled && look.kind === "failed")
    note = (
      <Note
        kind="bad"
        title={t("connector.failedText")}
        action={
          <button className="btn" onClick={() => void c.check(s.name)}>
            <Icon name="retry" />
            {t("connector.retry")}
          </button>
        }
      >
        {s.status.error && <span className="err">{s.status.error}</span>}
      </Note>
    );
  else if (s.auth_partial && s.auth_state === "logged_in")
    note = <Note kind="warn">{t("managed.partialPermissions")}</Note>;
  else if (repo)
    note = (
      <Note kind="info">
        <Trans t={t} i18nKey="connector.repoNote" values={{ file: s.layer === "project_json" ? ".mcp.json" : ".finx/config.toml" }} components={{ code: <code /> }} />
      </Note>
    );

  const list = tools?.tools ?? [];
  const from =
    tools?.source === "session"
      ? t("connector.toolsFromSessions", { count: s.status.sessions ?? 1 })
      : tools?.checked_at
        ? t("connector.checkedAt", { ago: agoText(new Date(tools.checked_at), now) })
        : "";
  const description = cat ? catalogText(t, `catalog.connectors.${cat.id}`) : s.description;
  const empty = look.kind === "needs_login" ? t("connector.toolsAfterLogin") : look.kind === "failed" ? t("connector.toolsAfterConnect") : t("connector.noTools");
  return (
    <div className={`cz-dpage ${s.enabled ? "" : "off"}`}>
      <div className="cz-dbar">
        <Back label={t("connector.back")} onBack={onBack} />
      </div>
      <div className="cz-dhead">
        {/* The controls belong to the item, so they sit on its line, centred on the logo. */}
        <div className="cz-dtitle">
          <ServerTile name={name} mono={cat?.mono} icon={s.icon ?? catalogLogo(cat)} size="xl" />
          <h1>{name}</h1>
          {!cat && <span className="badge">{repo ? t("connector.providerRepo") : t("connector.custom")}</span>}
          <div className="cz-dacts">
            {s.update_supported && !untrusted && (
              <button className="btn" disabled={checkingUpdate || upgrading} onClick={() => void c.checkUpdate(s.name)}>
                {checkingUpdate ? <span className="mini-spin" /> : <Icon name="arrowUp" />}
                {checkingUpdate ? t("connector.checkingUpdate") : t("connector.checkUpdate")}
              </button>
            )}
            {!untrusted && (
              <label className="cz-swl">
                {repo ? t("connector.enabledForYou") : t("connector.enabled")}
                <Switch disabled={!!s.connector && s.auth_state !== "logged_in"} on={s.enabled} label={s.enabled ? t("connector.turnOff") : t("connector.turnOn")} onChange={(on) => a.toggleServer(s, on)} />
              </label>
            )}
            <MoreButton label={t("more")} items={menu} />
          </div>
        </div>
        <div className="cz-facts">
          <div className="cz-fact">
            <div className="k">{t("connector.state")}</div>
            <div className={`v cz-st ${stCls}`}>
              <i className={`dotc ${stDot}`} />
              {stText}
            </div>
          </div>
          {s.server_version && (
            <div className="cz-fact">
              <div className="k">{t("connector.version")}</div>
              <div className="v">{s.server_version}</div>
            </div>
          )}
          {access && (
            <div className="cz-fact">
              <div className="k">{access.k}</div>
              <div className="v">
                {access.v}
                <span className="sub">{access.sub}</span>
              </div>
            </div>
          )}
          {s.connector ? (
            <div className="cz-fact grow">
              <div className="k">{t("connector.provider")}</div>
              <div className="v">{cat?.by ?? name}<span className="sub">{t("managed.officialComponent")}</span></div>
            </div>
          ) : (
          <div className="cz-fact grow">
            <div className="k">{remote ? t("connector.address") : t("connector.command")}</div>
            <div className="v">
              <span className="cut" title={s.summary}>
                {s.summary}
              </span>
              <button className="cz-ghost" title={remote ? t("connector.copyAddress") : t("connector.copyCommand")} aria-label={remote ? t("connector.copyAddress") : t("connector.copyCommand")} onClick={copy}>
                <Icon name="copy" />
              </button>
            </div>
          </div>
          )}
        </div>
      </div>
      {note}
      {hasUpdate && (
        <Note
          kind="info"
          title={t("connector.updateAvailableTitle", { latest: update.latest_version })}
          action={
            update.can_upgrade ? (
              <button className="btn primary" disabled={upgrading} onClick={() => void c.upgrade(s.name)}>
                {upgrading && <span className="mini-spin" />}
                {upgrading ? t("connector.upgrading") : t("connector.upgradeNow")}
              </button>
            ) : update.release_url ? (
              <button className="btn" onClick={() => window.finx?.openExternal(update.release_url!)}>
                {t("connector.viewRelease")}
              </button>
            ) : undefined
          }
        >
          {update.detail
            ? update.detail
            : update.current_version
              ? t("connector.updateAvailableBody", { current: update.current_version, latest: update.latest_version })
              : t("connector.updateAvailableUnknownBody", { latest: update.latest_version })}
        </Note>
      )}
      {description && (
        <section className="cz-dsum">
          <div className="k">{t("connector.summary")}</div>
          <p>{description}</p>
        </section>
      )}
      {!untrusted && (
        <section className="cz-dtools">
          <div className="cz-th">
            <h2>{t("connector.tools")}</h2>
            {list.length > 0 && <span className="n">{list.length}</span>}
            <span className="right">
              {list.length > 0 && from}
              <button className="link" onClick={() => void c.check(s.name)}>
                {t("connector.recheck")}
              </button>
            </span>
          </div>
          {tools === null ? (
            <p className="cz-dempty">{t("loading")}</p>
          ) : list.length === 0 ? (
            <p className="cz-dempty">{empty}</p>
          ) : (
            <div className="cz-tlist">
              {list.map((tool) => (
                <div key={tool.name} className={`cz-tool ${open === tool.name ? "open" : ""}`} onClick={() => setOpen(open === tool.name ? null : tool.name)}>
                  <span className="tn">{tool.name}</span>
                  <span className="td">{tool.description || tool.title}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** A note under the facts, when something needs the person: what, why, and its one action. */
function Note({ kind, title, children, action }: { kind: "warn" | "bad" | "info"; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`cz-note ${kind}`}>
      <Icon name={kind === "info" ? "info" : "warn"} />
      <div className="tx">
        {title && <b>{title}</b>}
        {children}
      </div>
      {action}
    </div>
  );
}

/** A catalog connector not added yet: what it is, what will run, and where it will be written. */
function CatalogConnectorPage({ c, a, cat, project, onBack }: { c: Customize; a: Actions; cat: CatalogConnector; project: string | null; onBack: () => void }) {
  const { t } = useTranslation("customize");
  const command = commandLine(cat);
  const busy = c.adding.has(`server:${cat.id}`);
  const file = c.layerInfo("user")?.file;
  // How to sign in is chosen when adding; the page shows the ways, the recommended first.
  const ways = cat.install.auth;
  const add = () => a.addConnector(cat);
  return (
    <>
      <Back label={t("connector.back")} onBack={onBack} />
      <Hero
        tile={<ServerTile name={cat.name} mono={cat.mono} icon={catalogLogo(cat)} size="xl" />}
        name={cat.name}
        meta={[cat.by]}
        acts={<SolidAdd busy={busy} label={t("connector.add")} busyLabel={t("connector.adding")} onAdd={add} />}
      />
      <Tabs tabs={[{ id: "overview", label: t("connector.tabs.overview") }]} on="overview" onTab={() => {}} />
      <div className="cz-cols">
        <div>
          <div className="cz-dsec">
            <h4>{t("connector.description")}</h4>
            <p>{catalogText(t, `catalog.connectors.${cat.id}`)}</p>
          </div>
          {cat.managed ? (
            <div className="cz-dsec"><h4>{t("managed.officialComponent")}</h4><p>{t("managed.installHint")}</p></div>
          ) : command ? (
            <div className="cz-dsec">
              <h4>{t("connector.runsHere")}</h4>
              <pre className="cz-code cz-line">{command}</pre>
              <p className="hint">{t(cat.managed ? "managed.installHint" : "connector.runsHereHint")}</p>
            </div>
          ) : (
            <div className="cz-dsec">
              <h4>{t("connector.address")}</h4>
              <pre className="cz-code cz-line">{"url" in cat.install ? cat.install.url : ""}</pre>
            </div>
          )}
        </div>
        <aside className="cz-side">
          <Fact k={t("connector.provider")}>{cat.by}</Fact>
          {!oneClick(cat) && (
            <Fact k={t("connector.ways")} stack>
              {ways.map((w, i) => (
                <span key={w.kind} className="cz-way">
                  {t(`addc.${w.kind}`)}
                  {i === 0 && <span className="badge acc">{t("addc.recommended")}</span>}
                </span>
              ))}
            </Fact>
          )}
          {file && (
            <Fact k={t("connector.writes")} stack mono>
              {tilde(file)}
            </Fact>
          )}
          <Fact k="">
            <button className="link" onClick={() => window.finx?.openExternal(cat.docs)}>
              {t("connector.docs")}
            </button>
          </Fact>
        </aside>
      </div>
    </>
  );
}
