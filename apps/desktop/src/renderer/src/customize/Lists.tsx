import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import type { McpServerView } from "@finx/protocol";
import { catalogConnectors, catalogSkills, type CatalogConnector, type CatalogSkill } from "../../../shared/catalog";
import { Icon } from "../icons";
import type { CustomizeView } from "../store";
import { addedConnector, addedSkill, brokenSkills, catalogOf, catalogText, connectorGroup, fromRepo, statusOf, type ConnectorGroup, type SkillGroup, type SkillItem } from "./model";
import { catalogLogo, MoreButton, Section, ServerTile, SkillTile, Status, Switch, tilde, type MenuItem } from "./parts";
import type { Customize } from "./useCustomize";

// 我的 (one to a row, grouped by where each lives) and 发现 (two to a row), for skills and
// connectors (customize-design §10.2).

export type Actions = {
  open: (detail: NonNullable<CustomizeView["detail"]>) => void;
  upload: () => void;
  create?: () => void;
  useSkill: (name: string) => void;
  addCustom: () => void;
  edit: (s: McpServerView) => void;
  showBroken: () => void;
  discover: () => void;
  installSkill: (c: CatalogSkill) => void;
  addConnector: (c: CatalogConnector) => void;
  toggleSkill: (item: SkillItem, on: boolean) => void;
  toggleServer: (s: McpServerView, on: boolean) => void;
};

export function skillMenu(item: SkillItem, a: Actions, c: Customize, t: TFunction<"customize">, withView: boolean): MenuItem[] {
  return [
    ...(withView ? [{ id: "view", label: t("skill.view"), icon: "info" as const, run: () => a.open({ kind: "skill", id: item.dir, tab: "overview" }) }] : []),
    // A skill turned off is not offered to the message box.
    ...(item.on ? [{ id: "use", label: t("skill.use"), icon: "chat" as const, run: () => a.useSkill(item.entry.name) }] : []),
    { id: "reveal", label: t("skill.reveal"), icon: "folder" as const, run: () => window.finx?.revealPath(item.dir) },
    // Only the person's own, in ~/.finx/skills (DD-35, DD-36).
    ...(item.entry.removable ? [null, { id: "remove", label: t("skill.remove"), icon: "trash" as const, danger: true, run: () => c.removeSkill(item) }] : []),
  ];
}

export function serverMenu(s: McpServerView, a: Actions, c: Customize, t: TFunction<"customize">, withView: boolean): MenuItem[] {
  const busy = c.checkingUpdate.has(s.name) || c.upgrading.has(s.name);
  return [
    ...(withView ? [{ id: "view", label: t("connector.view"), icon: "info" as const, run: () => a.open({ kind: "connector", id: s.name, tab: "overview" }) }] : []),
    ...(s.editable && !s.connector && withView ? [{ id: "edit", label: t("connector.edit"), icon: "edit" as const, run: () => a.edit(s) }] : []),
    ...(s.status.state !== "untrusted" ? [{ id: "check", label: t("connector.recheck"), icon: "retry" as const, run: () => void c.check(s.name) }] : []),
    ...(s.update_supported && s.status.state !== "untrusted"
      ? [{ id: "checkUpdate", label: t("connector.checkUpdate"), icon: "arrowUp" as const, disabled: busy, run: () => void c.checkUpdate(s.name) }]
      : []),
    ...(s.file ? [{ id: "reveal", label: t("connector.revealFile"), icon: "folder" as const, run: () => window.finx?.revealPath(s.file!) }] : []),
    ...(s.editable ? [null, { id: "remove", label: t("connector.remove"), icon: "trash" as const, danger: true, run: () => c.removeServer(s) }] : []),
  ];
}

export function MySkills({ c, a, project }: { c: Customize; a: Actions; project: string | null }) {
  const { t } = useTranslation("customize");
  const group = (g: SkillGroup) => c.items.filter((i) => i.group === g);
  const broken = brokenSkills(c.skills);
  const note = broken.length > 0 && (
    <div className="cz-anote">
      <Icon name="warn" />
      <span>
        <Trans t={t} i18nKey="broken.note" count={broken.length} values={{ path: tilde(broken[0].path), reason: broken[0].detail ?? "" }} components={{ code: <code /> }} />
      </span>
      <button className="link" onClick={a.showBroken}>
        {t("broken.view")}
      </button>
    </div>
  );
  const rows = (items: SkillItem[]) => (
    <div className="cz-rows">
      {items.map((i) => (
        <SkillRow key={i.dir} item={i} c={c} a={a} />
      ))}
    </div>
  );
  const personal = group("user");
  return (
    <>
      <Section title={t("group.personal")} count={personal.length} note={note}>
        {personal.length ? (
          rows(personal)
        ) : (
          <div className="cz-empty">
            <Icon name="skill" />
            <b>{t("empty.skills")}</b>
            <span>{t("empty.skillsHint")}</span>
            <div className="acts">
              <button className="btn" onClick={a.upload}>
                <Icon name="upload" />
                {t("add.upload").replace("…", "")}
              </button>
              {a.create && (
                <button className="btn" onClick={a.create}>
                  <Icon name="chat" />
                  {t("add.create")}
                </button>
              )}
            </div>
          </div>
        )}
      </Section>
      {group("project").length > 0 && (
        <Section title={t("group.repo", { project })} count={group("project").length} hint={t("group.repoSkillsHint")}>
          {rows(group("project"))}
        </Section>
      )}
      {group("extra").length > 0 && (
        <Section title={t("group.extra")} count={group("extra").length} hint={t("group.extraHint")}>
          {rows(group("extra"))}
        </Section>
      )}
      {group("system").length > 0 && (
        <Section title={t("group.system")} count={group("system").length} hint={t("group.systemHint")}>
          {rows(group("system"))}
        </Section>
      )}
    </>
  );
}

function SkillRow({ item, c, a }: { item: SkillItem; c: Customize; a: Actions }) {
  const { t } = useTranslation("customize");
  const open = () => a.open({ kind: "skill", id: item.dir, tab: "overview" });
  return (
    <div className={`cz-row ${item.on ? "" : "off"}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}>
      <SkillTile />
      <div className="rt">
        <div className="rn">
          <span className="nm">{item.entry.name}</span>
          {item.from && <span className="badge">{t(item.group === "project" ? "skill.fromApp" : "skill.sharedWith", { from: item.from })}</span>}
        </div>
        <div className="rd">{item.entry.description}</div>
      </div>
      <div className="ra">
        {!item.on && <span className="cz-st">{t(item.offByDefault ? "skill.offByDefault" : "skill.off")}</span>}
        <Switch on={item.on} label={item.on ? t("skill.turnOff") : t("skill.turnOn")} onChange={(on) => a.toggleSkill(item, on)} />
        <MoreButton label={t("more")} items={() => skillMenu(item, a, c, t, true)} />
      </div>
    </div>
  );
}

export function MyConnectors({ c, a, project }: { c: Customize; a: Actions; project: string | null }) {
  const { t } = useTranslation("customize");
  if (c.servers.length === 0)
    return (
      <section className="cz-sect">
        <div className="cz-empty">
          <Icon name="plug" />
          <b>{t("empty.connectors")}</b>
          <span>{t("empty.connectorsHint")}</span>
          <div className="acts">
            <button className="btn" onClick={a.discover}>
              {t("empty.seeCatalog")}
            </button>
            <button className="btn" onClick={a.addCustom}>
              <Icon name="plus" />
              {t("empty.addCustom")}
            </button>
          </div>
        </div>
      </section>
    );
  const by = (g: ConnectorGroup) => c.servers.filter((s) => connectorGroup(s.layer) === g);
  const rows = (list: McpServerView[]) => (
    <div className="cz-rows">
      {list.map((s) => (
        <ServerRow key={s.name} s={s} c={c} a={a} />
      ))}
    </div>
  );
  const groups: { g: ConnectorGroup; title: string; hint?: string }[] = [
    { g: "user", title: t("group.connected") },
    { g: "user_project", title: t("group.thisProject", { project }), hint: t("group.forYou") },
    { g: "project", title: t("group.repo", { project }), hint: t("group.repoConnectorsHint") },
    { g: "flag", title: t("group.flag") },
  ];
  return (
    <>
      {groups.map(({ g, title, hint }) =>
        by(g).length ? (
          <Section key={g} title={title} count={by(g).length} hint={hint}>
            {rows(by(g))}
          </Section>
        ) : null,
      )}
    </>
  );
}

function ServerRow({ s, c, a }: { s: McpServerView; c: Customize; a: Actions }) {
  const { t } = useTranslation("customize");
  const cat = catalogOf(s);
  const repo = fromRepo(s);
  const open = () => a.open({ kind: "connector", id: s.name, tab: "overview" });
  const label = repo ? (s.enabled ? t("connector.turnOffForYou") : t("connector.turnOnForYou")) : s.enabled ? t("connector.turnOff") : t("connector.turnOn");
  const description = cat ? catalogText(t, `catalog.connectors.${cat.id}`) : s.description;
  const update = c.updates.get(s.name);
  const checkingUpdate = c.checkingUpdate.has(s.name);
  const upgrading = c.upgrading.has(s.name);
  const hasUpdate = !!update?.latest_version && (update.status === "update_available" || (update.status === "unknown" && update.can_upgrade));
  return (
    <div className={`cz-row ${s.enabled ? "" : "off"}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}>
      <ServerTile name={cat?.name ?? s.name} mono={cat?.mono} icon={s.icon ?? catalogLogo(cat)} />
      <div className="rt">
        <div className="rn">
          <span className="nm">{cat?.name ?? s.name}</span>
          {!cat && !repo && <span className="badge">{t("connector.custom")}</span>}
          {hasUpdate && <span className="badge acc">{t("connector.updateAvailable", { version: update.latest_version })}</span>}
        </div>
        {description ? (
          <div className="rd">{description}</div>
        ) : (
          <div className="rd mono" title={s.summary}>
            {s.summary}
          </div>
        )}
      </div>
      <div className="ra">
        {upgrading ? (
          <span className="cz-st">
            <span className="mini-spin cz-spin" />
            {t("connector.upgrading")}
          </span>
        ) : checkingUpdate ? (
          <span className="cz-st">
            <span className="mini-spin cz-spin" />
            {t("connector.checkingUpdate")}
          </span>
        ) : (
          <>
            {hasUpdate && update.can_upgrade && (
              <button
                className="link"
                onClick={(e) => {
                  e.stopPropagation();
                  void c.upgrade(s.name);
                }}
              >
                {t("connector.upgrade")}
              </button>
            )}
            <Status look={statusOf(s, c.checking.has(s.name))} onCheck={() => void c.check(s.name)} onLogin={c.signingIn.has(s.name) ? undefined : () => void c.login(s.name)} />
          </>
        )}
        {s.status.state !== "untrusted" && <Switch disabled={!!s.connector && s.auth_state !== "logged_in"} on={s.enabled} label={label} onChange={(on) => a.toggleServer(s, on)} />}
        <MoreButton label={t("more")} items={() => serverMenu(s, a, c, t, true)} />
      </div>
    </div>
  );
}

/** The round + of a card: a spinner while it is added, then a check. */
function AddMark({ added, busy, name, onAdd }: { added: boolean; busy: boolean; name: string; onAdd: () => void }) {
  const { t } = useTranslation("customize");
  if (added)
    return (
      <span className="cz-inst done" title={t("skill.added")}>
        <Icon name="check" />
      </span>
    );
  if (busy)
    return (
      <span className="cz-inst busy">
        <span className="mini-spin" />
      </span>
    );
  return (
    <button
      className="cz-inst"
      title={t("skill.add")}
      aria-label={`${t("skill.add")} ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
    >
      <Icon name="plus" />
    </button>
  );
}

function Card({ tile, name, added, description, by, mark, onOpen }: { tile: ReactNode; name: string; added: boolean; description: string; by: string; mark: ReactNode; onOpen: () => void }) {
  const { t } = useTranslation("customize");
  return (
    <div className="cz-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}>
      {tile}
      <div className="ct">
        <span className="nm">{name}</span>
        {added && <span className="badge">{t("skill.added")}</span>}
      </div>
      <div className="ca">{mark}</div>
      <div className="cd">{description}</div>
      <div className="cm">{by}</div>
    </div>
  );
}

export function DiscoverSkills({ c, a }: { c: Customize; a: Actions }) {
  const { t } = useTranslation("customize");
  if (catalogSkills.length === 0)
    return (
      <section className="cz-sect">
        <div className="cz-empty">
          <Icon name="skill" />
          <b>{t("empty.catalogSkills")}</b>
          <span>{t("empty.catalogSkillsHint")}</span>
          <div className="acts">
            <button className="btn" onClick={a.upload}>
              <Icon name="upload" />
              {t("add.upload").replace("…", "")}
            </button>
            {a.create && (
              <button className="btn" onClick={a.create}>
                <Icon name="chat" />
                {t("add.create")}
              </button>
            )}
          </div>
        </div>
      </section>
    );
  return (
    <Section title={t("group.catalogSkills")} count={catalogSkills.length}>
      <div className="cz-grid">
        {catalogSkills.map((cat) => {
          const mine = addedSkill(c.items, cat);
          return (
            <Card
              key={cat.id}
              tile={<SkillTile />}
              name={cat.id}
              added={!!mine}
              description={catalogText(t, `catalog.skills.${cat.id}`)}
              by={t("catalog.by")}
              mark={<AddMark added={!!mine} busy={c.adding.has(`skill:${cat.id}`)} name={cat.id} onAdd={() => a.installSkill(cat)} />}
              onOpen={() => a.open(mine ? { kind: "skill", id: mine.dir, tab: "overview" } : { kind: "skill", id: cat.id, catalog: true, tab: "overview" })}
            />
          );
        })}
      </div>
    </Section>
  );
}

export function DiscoverConnectors({ c, a }: { c: Customize; a: Actions }) {
  const { t } = useTranslation("customize");
  if (catalogConnectors.length === 0)
    return (
      <section className="cz-sect">
        <div className="cz-empty">
          <Icon name="plug" />
          <b>{t("empty.catalogConnectors")}</b>
          <span>{t("empty.catalogConnectorsHint")}</span>
          <div className="acts">
            <button className="btn" onClick={a.addCustom}>
              <Icon name="plus" />
              {t("empty.addCustom")}
            </button>
          </div>
        </div>
      </section>
    );
  return (
    <Section title={t("group.catalogConnectors")} count={catalogConnectors.length}>
      <div className="cz-grid">
        {catalogConnectors.map((cat) => {
          const mine = addedConnector(c.servers, cat);
          return (
            <Card
              key={cat.id}
              tile={<ServerTile name={cat.name} mono={cat.mono} icon={mine?.icon ?? catalogLogo(cat)} />}
              name={cat.name}
              added={!!mine}
              description={catalogText(t, `catalog.connectors.${cat.id}`)}
              by={cat.by}
              mark={<AddMark added={!!mine} busy={c.adding.has(`server:${cat.id}`)} name={cat.name} onAdd={() => a.addConnector(cat)} />}
              onOpen={() => a.open(mine ? { kind: "connector", id: mine.name, tab: "overview" } : { kind: "connector", id: cat.id, catalog: true, tab: "overview" })}
            />
          );
        })}
      </div>
    </Section>
  );
}
