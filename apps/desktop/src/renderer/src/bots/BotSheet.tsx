import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Avatar as AvatarSpec, AvatarHue, AvatarInput, AvatarShape, RemotePreview, ThinkingLevel } from "@finx/protocol";
import { RpcError } from "@finx/client";
import { Dialog } from "../components";
import { shownModel } from "../composer/Composer";
import { draftThinking, offersThinking } from "../format";
import { useStore } from "../store";
import { Avatar, hues, shapes } from "./Avatar";
import { ModelBlocked, ModelRows } from "./ModelRows";
import { CredentialFields, credentialOf, emptyDraft } from "./Credential";

const hueNames = Object.keys(hues) as AvatarHue[];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** At most 20 characters, as finx keeps names. */
export const NAME_MAX = 20;

/**
 * Making a bot (bot-mode-design §6.3): a name, an avatar, and the model it answers with and how hard
 * it thinks. A new bot comes with a character and a colour picked at random and the default model on
 * show, so a name and ↩ make one when that model can answer. Afterwards all of it is changed in its
 * settings (BotPanel).
 */
export function BotSheet() {
  const st = useStore();
  const { t } = useTranslation("bots");
  const canAdd = st.capabilities?.bots_external === true;
  const [tab, setTab] = useState<"new" | "add">("new");
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<RemotePreview | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const readCard = async () => {
    const given = url.trim();
    if (!given || reading) return;
    setReading(true);
    setProblem(null);
    try {
      setPreview(await st.call("bots/preview", { url: given }));
    } catch (e) {
      const err = e as RpcError;
      const movedHost = (err.data as { host?: string } | undefined)?.host;
      setProblem(
        t(
          err.kind === "bot_card_unreachable" ? "sheet.add.errors.unreachable"
          : err.kind === "bot_card_invalid" ? "sheet.add.errors.invalid"
          : err.kind === "bot_card_unsupported" ? "sheet.add.errors.unsupported"
          : err.kind === "bot_card_moved" ? "sheet.add.errors.moved"
          : err.kind === "bot_not_supported" ? "sheet.add.errors.off"
          : "sheet.add.errors.other",
          { host: movedHost },
        ),
      );
    } finally {
      setReading(false);
    }
  };
  const addExternal = async () => {
    if (!preview || reading) return;
    const credential = credentialOf(preview.auth, draft);
    if (preview.auth !== "none" && !credential) {
      setProblem(t("sheet.add.needsCredential"));
      return;
    }
    setReading(true);
    setProblem(null);
    try {
      const made = await st.call("bots/add", { url: url.trim(), card_sha256: preview.card_sha256, credential: credential ?? undefined });
      st.selectBot(made.bot.id);
      closeAll();
    } catch (e) {
      const err = e as RpcError;
      setProblem(t(
        err.kind === "bot_card_changed" ? "sheet.add.errors.changed"
        : err.kind === "bot_auth_required" ? "sheet.add.needsCredential"
        : "sheet.add.errors.other",
      ));
    } finally {
      setReading(false);
    }
  };
  const closeAll = () => st.set({ botSheet: null });
  const isLocal = /^(localhost|127\.|\[::1\]|::1)/.test(preview?.host ?? "");
  const initial = useMemo<AvatarSpec>(() => ({ kind: "char", shape: pick(shapes), hue: pick(hueNames) }), []);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AvatarSpec>(initial);
  // A picture picked here and not saved yet: its PNG (base64).
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [chosenLevel, setChosenLevel] = useState<ThinkingLevel | null>(null);
  const model = shownModel(chosenModel, st.models);
  const entry = st.models.models.find((m) => m.id === model);
  const thinking = draftThinking(entry, chosenLevel);
  const close = () => st.set({ botSheet: null });
  const hue = avatar.kind === "char" || avatar.kind === "mono" ? avatar.hue : (initial.kind === "char" ? initial.hue : "slate");
  const trimmed = name.trim();
  const ready = trimmed !== "" && Array.from(trimmed).length <= NAME_MAX && !!entry?.available && !busy;
  const upload = async () => {
    const got = await pickPicture();
    if (!got) return;
    if ("error" in got) return st.show(t(got.error === "too_large" ? "sheet.tooLarge" : "sheet.unreadable"), undefined, true);
    setPng(got.png);
    setAvatar({ kind: "image", rev: 0 });
  };
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const given: AvatarInput = png ? { kind: "image", png } : avatar.kind === "image" ? { kind: "char", shape: pick(shapes), hue } : avatar;
    const ok = await st.run(async () => {
      const r = await st.call("bots/create", { name: trimmed, avatar: given, model, thinking });
      st.selectBot(r.bot.id);
    });
    setBusy(false);
    if (ok) closeAll();
  };
  const tabBar = canAdd && !preview ? (
    <div className="bs-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "new"} className={tab === "new" ? "on" : ""} onClick={() => { setTab("new"); setProblem(null); }}>
        {t("sheet.newTab")}
      </button>
      <button type="button" role="tab" aria-selected={tab === "add"} className={tab === "add" ? "on" : ""} onClick={() => { setTab("add"); setProblem(null); }}>
        {t("sheet.addTab")}
      </button>
    </div>
  ) : null;
  if (tab === "add" && canAdd) {
    return (
      <Dialog label={t("sheet.add.title")} width={440} className="bsheet" onClose={closeAll}>
        {tabBar}
        <h3>{preview ? t("sheet.add.confirm") : t("sheet.add.title")}</h3>
        {!preview ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void readCard();
            }}
          >
            <p className="sub">{t("sheet.add.sub")}</p>
            <label className="bs-name">
              <span>{t("sheet.add.link")}</span>
              <input
                className="field"
                value={url}
                autoFocus
                placeholder={t("sheet.add.placeholder")}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            {problem && <p className="bs-problem">{problem}</p>}
            <div className="sheet-foot">
              <button type="button" className="link left" onClick={closeAll}>
                {t("sheet.cancel")}
              </button>
              <button type="submit" className="btn primary" disabled={reading || !url.trim()}>
                {reading ? t("sheet.add.reading") : t("sheet.add.read")}
              </button>
            </div>
          </form>
        ) : (
          <div className="bs-confirm">
            <div className="bs-top">
              {preview.icon ? <img className="bs-icon" src={preview.icon} alt="" width={64} height={64} /> : <Avatar spec={{ kind: "mono", hue: "sage" }} name={preview.name} size={64} />}
              <div>
                <div className="bs-who">{preview.name}</div>
                <div className="sub">{preview.description}</div>
              </div>
            </div>
            <dl className="bs-facts">
              <dt>{t("sheet.add.host")}</dt>
              <dd className="mono">{preview.provider ? `${preview.provider} · ` : ""}{preview.host}</dd>
              <dt>{t("sheet.add.skills")}</dt>
              <dd>
                {preview.skills.slice(0, 6).map((skill) => (
                  <div key={skill.name}>
                    <b>{skill.name}</b>
                    <span className="sub"> {skill.description}</span>
                  </div>
                ))}
                {preview.skills.length > 6 && <div className="sub">{t("sheet.add.more", { n: preview.skills.length - 6 })}</div>}
              </dd>
            </dl>
            <p className="bs-notice">{t(isLocal ? "sheet.add.noticeLocal" : "sheet.add.notice", { host: preview.host })}</p>
            {preview.auth !== "none" && (
              <div>
                <CredentialFields auth={preview.auth} draft={draft} onChange={setDraft} autoFocus />
                <p className="bs-hint">{t("sheet.add.credentialHint")}</p>
              </div>
            )}
            {problem && <p className="bs-problem">{problem}</p>}
            <div className="sheet-foot">
              <button type="button" className="link left" onClick={() => { setPreview(null); setProblem(null); setDraft(emptyDraft); }}>
                {t("sheet.add.back")}
              </button>
              <button type="button" className="btn" onClick={closeAll}>
                {t("sheet.cancel")}
              </button>
              <button type="button" className="btn primary" disabled={reading} onClick={() => void addExternal()}>
                {reading ? t("sheet.add.reading") : t("sheet.add.add")}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog label={t("sheet.newTitle")} width={440} className="bsheet" onClose={close}>
      {tabBar}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{t("sheet.newTitle")}</h3>
        <p className="sub">{t("sheet.sub")}</p>
        <div className="bs-top">
          <Avatar spec={avatar} name={trimmed} size={64} preview={png ? `data:image/png;base64,${png}` : undefined} />
          <label className="bs-name">
            <span>{t("sheet.name")}</span>
            <input
              className="field"
              value={name}
              autoFocus
              maxLength={NAME_MAX}
              placeholder={t("sheet.placeholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <div className="bs-k">{t("sheet.avatar")}</div>
        <AvatarChoices
          avatar={avatar}
          hue={hue}
          name={trimmed}
          onChoose={(spec) => {
            setAvatar(spec);
            setPng(null);
          }}
        />
        <div className="bs-k bs-model">{t("panel.model")}</div>
        <ModelRows
          model={model}
          thinking={thinking}
          // As a new session's: the level goes along when the new model offers it, else that model's own.
          onModel={(ref) => {
            const next = st.models.models.find((m) => m.id === ref);
            const kept = thinking !== "default" && offersThinking(next, thinking) ? thinking : null;
            setChosenModel(ref);
            setChosenLevel(kept);
            return draftThinking(next, kept);
          }}
          onThinking={setChosenLevel}
        />
        <ModelBlocked model={model} />
        <div className="sheet-foot">
          <button type="button" className="link left" onClick={() => void upload()}>
            {t("sheet.upload")}
          </button>
          <button type="button" className="btn" onClick={close}>
            {t("sheet.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!ready}>
            {t("sheet.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The characters, the first character of its name, and the colours; `mark` adds the FinxWork mark, the default bot's. */
export function AvatarChoices({ avatar, hue, name, mark = false, onChoose }: { avatar: AvatarSpec; hue: AvatarHue; name: string; mark?: boolean; onChoose: (spec: Exclude<AvatarSpec, { kind: "image" }>) => void }) {
  const { t } = useTranslation("bots");
  return (
    <>
      <div className="bs-shapes" role="radiogroup" aria-label={t("sheet.avatar")}>
        {mark && (
          <button type="button" role="radio" aria-checked={avatar.kind === "mark"} title={t("sheet.mark")} className={`bs-shape ${avatar.kind === "mark" ? "on" : ""}`} onClick={() => onChoose({ kind: "mark" })}>
            <Avatar spec={{ kind: "mark" }} name="" size={36} />
          </button>
        )}
        {shapes.map((shape: AvatarShape) => {
          const on = avatar.kind === "char" && avatar.shape === shape;
          return (
            <button key={shape} type="button" role="radio" aria-checked={on} title={t(`sheet.shapes.${shape}`)} className={`bs-shape ${on ? "on" : ""}`} onClick={() => onChoose({ kind: "char", shape, hue })}>
              <Avatar spec={{ kind: "char", shape, hue }} name="" size={36} />
            </button>
          );
        })}
        <button type="button" role="radio" aria-checked={avatar.kind === "mono"} title={t("sheet.mono")} className={`bs-shape ${avatar.kind === "mono" ? "on" : ""}`} onClick={() => onChoose({ kind: "mono", hue })}>
          <Avatar spec={{ kind: "mono", hue }} name={name || "字"} size={36} />
        </button>
      </div>
      <div className="bs-hues" role="radiogroup" aria-label={t("sheet.avatar")}>
        {hueNames.map((h) => {
          const on = (avatar.kind === "char" || avatar.kind === "mono") && avatar.hue === h;
          return (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={on}
              title={t(`sheet.hues.${h}`)}
              className={`bs-hue ${on ? "on" : ""}`}
              style={{ "--h": hues[h] } as React.CSSProperties}
              onClick={() => onChoose(avatar.kind === "mono" ? { kind: "mono", hue: h } : { kind: "char", shape: avatar.kind === "char" ? avatar.shape : pick(shapes), hue: h })}
            />
          );
        })}
      </div>
    </>
  );
}

/** A picture for an avatar: square, as a PNG, from the system's picker or the browser's. */
export async function pickPicture() {
  return window.finx ? window.finx.pickAvatar() : pickInPage();
}

/** A picture from the browser's own picker, cropped to a square and scaled to 256 px (a page without the app's bridge). */
function pickInPage(): Promise<{ png: string } | { error: "too_large" | "unreadable" } | null> {
  return new Promise((resolve) => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = "image/png,image/jpeg,image/heic";
    el.onchange = () => {
      const file = el.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 10 * 1024 * 1024) return resolve({ error: "too_large" });
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        canvas.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
        resolve({ png: canvas.toDataURL("image/png").split(",")[1] });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve({ error: "unreadable" });
      img.src = URL.createObjectURL(file);
    };
    el.click();
  });
}
