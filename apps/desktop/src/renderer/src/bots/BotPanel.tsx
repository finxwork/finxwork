import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvatarHue, AvatarInput, BotSummary } from "@finx/protocol";
import type { SessionView } from "@finx/client";
import { RenameField } from "../components";
import { MenuButton, PermissionItems } from "../composer/Composer";
import { permissionDesc, permissionTitle } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { clearBotChat, runBotAction } from "./actions";
import { BotAvatar } from "./Avatar";
import { AvatarChoices, NAME_MAX, pickPicture } from "./BotSheet";
import { ModelRows } from "./ModelRows";
import { CredentialFields, credentialOf, emptyDraft } from "./Credential";

/**
 * A bot's settings (bot-mode-design §6.5.1), opened from its name at the top of its page: its
 * avatar and name, changed where they are; the model it answers with and how hard it thinks; what
 * it may do without asking; clearing its chat; deleting it, unless it is the default bot. Beside the conversation, in
 * the place the file panel and the browser take.
 */
export function BotPanel({ bot, view, session, onClose }: { bot: BotSummary; view: SessionView | null; session: string | null; onClose: () => void }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  // The note about Full Access is there to lead here (bot-mode-design §6.13): here, it has done its work.
  useEffect(() => {
    if (!st.botAccessSeen) st.set({ botAccessSeen: true });
  }, []);
  return (
    <aside className="bgp bpn" aria-label={t("head.settings")}>
      <div className="bpn-top drag">
        <button className="tb" title={t("panel.close")} aria-label={t("panel.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bpn-body">
        <BotHero key={bot.id} bot={bot} />
        <div className="form">
          {bot.source && <ExternalSection bot={bot} />}
          {!bot.source && view && session && <ModelSection view={view} session={session} />}
          {!bot.source && view && session && <PermissionSection view={view} session={session} />}
          <section>
            <h3 className="fhead">{t("panel.notifications")}</h3>
            <div className="fgroup">
              <div className="frow">
                <span className="fl">{t("panel.muted")}</span>
                <div className="fv">
                  <button
                    className={`sw ${bot.muted ? "on" : ""}`}
                    role="switch"
                    aria-checked={!!bot.muted}
                    aria-label={t("panel.muted")}
                    onClick={() => void st.run(() => st.call("bots/update", { bot_id: bot.id, muted: !bot.muted }))}
                  />
                </div>
              </div>
            </div>
            <p className="set-note">{t("panel.mutedNote")}</p>
          </section>
          <section className="fgroup">
            <button className="frow bpn-end bpn-clear" onClick={() => clearBotChat(st, bot)}>
              {t("panel.clear")}
            </button>
            {!bot.default && (
              <button className="frow bpn-end bpn-del" onClick={() => runBotAction(st, bot, "delete")}>
                {t("menu.delete")}
              </button>
            )}
          </section>
        </div>
      </div>
    </aside>
  );
}

/**
 * Another subject's bot in its settings (bot-contacts-design §4.4, §5.6): who provides it, where
 * its words go, what it can do, and its credential; no model and no permissions, because neither
 * is ours.
 */
function ExternalSection({ bot }: { bot: BotSummary }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const source = bot.source!;
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const credential = credentialOf(source.auth, draft);
  const local = /^(localhost|127\.|\[::1\]|::1)/.test(source.host);
  return (
    <section className="bs-ext">
      {source.description && (
        <>
          <h3 className="fhead">{t("external.description")}</h3>
          <div className="fgroup">
            <p className="bs-desc">{source.description}</p>
          </div>
        </>
      )}
      {source.skills.length > 0 && (
        <>
          <h3 className="fhead">{t("external.skills")}</h3>
          <div className="fgroup">
            {source.skills.map((skill) => (
              <div className="frow bs-skill" key={skill.name}>
                <div>
                  <div className="bs-skill-n">{skill.name}</div>
                  {skill.description && <div className="fdesc">{skill.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {source.needs_review && (
        <div className="knote" role="status">
          <p className="knote-b">{t(source.auth === "none" ? "external.schemeDropped" : "external.schemeChanged", { auth: t(`external.auth.${source.auth}`) })}</p>
          {source.auth === "none" && (
            <div className="appr-f">
              <span className="appr-sp" />
              <button className="btn primary" onClick={() => void st.run(() => st.call("bots/update", { bot_id: bot.id, accept_review: true }))}>
                {t("external.review")}
              </button>
            </div>
          )}
        </div>
      )}
      {source.offered_name && (
        <div className="knote" role="status">
          <p className="knote-b">{t("external.offeredName", { name: source.offered_name })}</p>
          <div className="appr-f">
            <span className="appr-sp" />
            <button className="btn" onClick={() => void st.run(() => st.call("bots/update", { bot_id: bot.id, adopt_name: true }))}>
              {t("external.adoptName")}
            </button>
          </div>
        </div>
      )}
      {(source.card_problem === "moved" || source.card_problem === "unreachable") && (
        <p className="set-note bs-problem">{t(source.card_problem === "moved" ? "external.moved" : "external.unreachable")}</p>
      )}
      <h3 className="fhead">{t("external.access")}</h3>
      <div className="fgroup">
        {source.provider && (
          <div className="frow">
            <span className="fl">{t("external.provider")}</span>
            <div className="fv">{source.provider}</div>
          </div>
        )}
        <div className="frow">
          <span className="fl">{t("external.host")}</span>
          <div className="fv">
            <span className="mono">{source.host}</span>
            {local && <span className="bs-tag">{t("external.local")}</span>}
          </div>
        </div>
        <div className="frow">
          <span className="fl">{t("external.authKind")}</span>
          <div className="fv">{t(`external.auth.${source.auth}`)}</div>
        </div>
        {source.auth !== "none" && (
          <div className="frow bs-cred-row">
            <CredentialFields auth={source.auth} draft={draft} onChange={setDraft} saved={!source.needs_review} autoFocus={!!source.needs_review} />
            <div className="bs-cred-act">
              <button
                className="btn"
                disabled={!credential || busy}
                onClick={() => {
                  if (!credential) return;
                  setBusy(true);
                  void st
                    .run(async () => {
                      await st.call("bots/credential", { bot_id: bot.id, credential });
                      setDraft(emptyDraft);
                    }, t("external.credentialSaved"))
                    .finally(() => setBusy(false));
                }}
              >
                {t(source.needs_review ? "external.credentialSave" : "external.credentialReplace")}
              </button>
            </div>
          </div>
        )}
        <button
          className="frow bs-reread"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void st.run(() => st.call("bots/reread", { bot_id: bot.id }), t("external.rereadDone")).finally(() => setBusy(false));
          }}
        >
          {t("external.reread")}
        </button>
      </div>
      <p className="set-note">{t(source.auth === "none" ? "external.rereadHint" : "external.credentialHint")}</p>
    </section>
  );
}

/** Its avatar, which on hover says it can be changed: a click opens the characters and colours in place, and a choice applies at once. */
function BotHero({ bot }: { bot: BotSummary }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const [picking, setPicking] = useState(false);
  const spec = bot.avatar;
  const hue: AvatarHue = spec.kind === "char" || spec.kind === "mono" ? spec.hue : "slate";
  const save = (avatar: AvatarInput) => st.run(() => st.call("bots/update", { bot_id: bot.id, avatar }));
  return (
    <div className="bpn-hero">
      <button className="bpn-av" title={t("panel.avatar")} aria-label={t("panel.avatar")} aria-expanded={picking} onClick={() => setPicking(!picking)}>
        <BotAvatar bot={bot} size={72} />
        <span className="bpn-av-edit" aria-hidden="true">
          <Icon name="edit" />
        </span>
      </button>
      <BotName bot={bot} />
      {picking && (
        <div className="fgroup bpn-pick">
          <AvatarChoices avatar={spec} hue={hue} name={bot.name} mark={bot.default} onChoose={(a) => void save(a)} />
          <button
            className="link"
            onClick={async () => {
              const got = await pickPicture();
              if (!got) return;
              if ("error" in got) return st.show(t(got.error === "too_large" ? "sheet.tooLarge" : "sheet.unreadable"), undefined, true);
              await save({ kind: "image", png: got.png });
            }}
          >
            {t("sheet.upload")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Its name; a double click makes it a field. ↩ or leaving it keeps what is written, Esc what was there. */
function BotName({ bot }: { bot: BotSummary }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <RenameField
        initial={bot.name}
        className="bpn-rename"
        maxLength={NAME_MAX}
        end={(name) => {
          setEditing(false);
          const v = name?.trim();
          if (v && v !== bot.name) void st.run(() => st.call("bots/update", { bot_id: bot.id, name: v }));
        }}
      />
    );
  }
  return (
    <h3 className="bpn-name" title={t("panel.nameHint")} onDoubleClick={() => setEditing(true)}>
      {bot.name}
    </h3>
  );
}

/** The model this bot answers with and how hard it thinks: its conversation's own, as a session's are. */
function ModelSection({ view, session }: { view: SessionView; session: string }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const { model, thinking } = view.info;
  return (
    <section>
      <h3 className="fhead">{t("panel.model")}</h3>
      <ModelRows below model={model} thinking={thinking} onModel={(ref) => void st.op(session, { type: "set_model", model: ref })} onThinking={(l, shown) => void (shown && st.op(session, { type: "set_model", model: shown, thinking: l }))} />
      <p className="set-note">{t("panel.modelNote")}</p>
    </section>
  );
}

/** What this bot may do without asking: its conversation's permission mode, as a session's is. What it creates follows it (subagent-design §10.4), and the note says so. */
function PermissionSection({ view, session }: { view: SessionView; session: string }) {
  const { t } = useTranslation("bots");
  const { t: ts } = useTranslation("session");
  const st = useStore();
  const mode = view.info.permission_mode;
  return (
    <section className="bpn-perm">
      <h3 className="fhead">{t("panel.permission")}</h3>
      <div className="fgroup">
        <div className="frow">
          <span className="fl">{t("panel.permissionMode")}</span>
          <div className="fv">
            <MenuButton className="mb" align="right" below title={ts("composer.permission")} label={<><span className="lbl strong">{permissionTitle(mode)}</span><Icon name="chevD" /></>}>
              {(close) => <PermissionItems value={mode} onChange={(m) => void st.op(session, { type: "set_permission_mode", mode: m })} close={close} bypassNote={t("panel.bypassNote")} />}
            </MenuButton>
          </div>
        </div>
      </div>
      <p className="set-note">{t("panel.permissionNote", { desc: permissionDesc(mode) })}</p>
    </section>
  );
}
