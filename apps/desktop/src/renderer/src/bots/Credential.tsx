import { useTranslation } from "react-i18next";
import type { BotAuth, BotCredential } from "@finx/protocol";

/** What the owner is typing, before it is shaped for the card's scheme. */
export type CredentialDraft = { secret: string; username: string; password: string };

export const emptyDraft: CredentialDraft = { secret: "", username: "", password: "" };

/** The draft in the shape `auth` asks for; `null` while it is not complete, or none is needed. */
export function credentialOf(auth: BotAuth, draft: CredentialDraft): BotCredential | null {
  switch (auth) {
    case "api_key":
    case "bearer":
      return draft.secret.trim() ? { kind: "secret", value: draft.secret.trim() } : null;
    case "basic":
      return draft.username.trim() && draft.password ? { kind: "basic", username: draft.username.trim(), password: draft.password } : null;
    default:
      return null;
  }
}

/**
 * The fields a card's scheme asks for: one secret for an API key or a bearer token, a user name and
 * a password for HTTP Basic. The owner never picks the scheme; the card does.
 */
export function CredentialFields({ auth, draft, onChange, autoFocus, saved }: {
  auth: BotAuth;
  draft: CredentialDraft;
  onChange: (draft: CredentialDraft) => void;
  autoFocus?: boolean;
  /** A credential is already kept: the fields replace it. */
  saved?: boolean;
}) {
  const { t } = useTranslation("bots");
  if (auth === "none") return null;
  if (auth === "basic") {
    return (
      <div className="bs-cred">
        <label className="bs-name">
          <span>{t("credential.username")}</span>
          <input className="field" value={draft.username} autoFocus={autoFocus} autoComplete="off" spellCheck={false} placeholder={saved ? t("credential.keep") : undefined} onChange={(e) => onChange({ ...draft, username: e.target.value })} />
        </label>
        <label className="bs-name">
          <span>{t("credential.password")}</span>
          <input className="field" type="password" value={draft.password} autoComplete="off" placeholder={saved ? t("credential.keep") : undefined} onChange={(e) => onChange({ ...draft, password: e.target.value })} />
        </label>
      </div>
    );
  }
  return (
    <div className="bs-cred">
      <label className="bs-name">
        <span>{t(auth === "bearer" ? "credential.token" : "credential.key")}</span>
        <input className="field" type="password" value={draft.secret} autoFocus={autoFocus} autoComplete="off" placeholder={saved ? t("credential.keep") : undefined} onChange={(e) => onChange({ ...draft, secret: e.target.value })} />
      </label>
    </div>
  );
}
