//! Bots (docs/kernel/bot-design.md §5): who each bot is, kept in `~/.finx/bots/<id>/bot.json`,
//! its row as the list shows it, and the `bots/*` methods. A bot's conversation is a session;
//! its hub hands the events that change the row here instead of to the session list.

use base64::Engine as _;
use bytes::Bytes;
use finx_core::BotIdentity;
use finx_core::FinxHome;
use finx_core::PeerRef;
use finx_core::SessionRef;
use finx_core::SessionStore;
use finx_core::StartOptions;
use finx_core::Workspace;
use finx_llm::ThinkingLevel;
use finx_protocol::Event;
use finx_protocol::EventMsg;
use finx_protocol::PermissionMode;
use finx_protocol::api::SessionInfo;
use finx_protocol::api::SessionState;
use finx_protocol::api::method;
use finx_protocol::bot::Avatar;
use finx_protocol::bot::AvatarInput;
use finx_protocol::bot::BotAvatarResult;
use finx_protocol::bot::BotCreateParams;
use finx_protocol::bot::BotResult;
use finx_protocol::bot::BotAccept;
use finx_protocol::bot::BotAuth;
use finx_protocol::bot::BotProtocol;
use finx_protocol::bot::BotSkill;
use finx_protocol::bot::BotSource;
use finx_protocol::bot::BotSourceKind;
use finx_protocol::bot::BotAddParams;
use finx_protocol::bot::BotPreviewParams;
use finx_protocol::bot::BotSummary;
use finx_protocol::bot::CardProblem;
use finx_protocol::bot::BotCredential;
use finx_protocol::bot::BotCredentialParams;
use finx_protocol::bot::BotUpdateParams;
use finx_protocol::bot::RemotePreview;
use finx_a2a::card::Card;
use finx_a2a::card::CardOptions;
use finx_protocol::bot::BotsChangedParams;
use finx_protocol::bot::BotsResult;
use finx_protocol::bot::LastMessage;
use finx_protocol::bot::RoutineSummary;
use finx_protocol::bot::Speaker;
use finx_rpc::RpcError;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::conn::ConnHandle;
use crate::errors;
use crate::hub::AttachRequest;
use crate::hub::HubCmd;
use crate::hub::HubHandle;
use crate::hub::SummaryBase;
use crate::list;
use crate::list::ListFeed;
use crate::mirror::SessionMirror;
use crate::server::ResumeOverrides;
use crate::server::Server;

/// The name every user's first bot has (PRD DD-108).
const DEFAULT_NAME: &str = "FinxBot";
/// Characters in a name, once trimmed.
const NAME_MAX: usize = 20;
/// Characters of a message kept for the list.
const TEXT_MAX: usize = 1000;
/// An uploaded avatar, after the client scaled it to 256 px.
const PNG_MAX: usize = 1 << 20;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// What `bot.json` holds.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct BotFile {
    version: u32,
    id: String,
    name: String,
    avatar: Avatar,
    #[serde(default)]
    default: bool,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    muted: bool,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    /// What its next conversation starts with: what `bots/create` was told, then what the last one
    /// had when it was cleared. While one runs, it keeps its own (`set_model`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permission_mode: Option<PermissionMode>,
    /// The list's row, kept for when the conversation is not loaded.
    #[serde(default)]
    summary: Kept,
    /// Another subject's bot (bot-contacts-design §3): where it answers, and what its card said.
    /// Absent for this computer's own bots, and for files written before version 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<BotSourceFile>,
}

/// The `source` of an external bot as `bot.json` keeps it: the card's facts plus what is needed
/// to reach it again, which the list does not show.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct BotSourceFile {
    kind: BotSourceKind,
    protocol: BotProtocol,
    card_url: String,
    endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tenant: Option<String>,
    /// The host the words go to, with its port.
    host: String,
    card_sha256: String,
    /// RFC 3339: when the card was last read (§5.6).
    card_read_at: String,
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(default)]
    skills: Vec<BotSkill>,
    #[serde(default)]
    accepts: Vec<BotAccept>,
    auth: BotAuth,
    /// The header the card puts an API key in (§5.6); `None` for no credential or a bearer one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key_header: Option<String>,
    #[serde(default)]
    noticed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    needs_review: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    offered_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    card_problem: Option<CardProblem>,
}

impl BotSourceFile {
    /// What the list and the bot's settings show (§4.3, §4.4).
    fn view(&self) -> BotSource {
        BotSource {
            kind: self.kind,
            protocol: self.protocol,
            host: self.host.clone(),
            provider: self.provider.clone(),
            description: self.description.clone(),
            skills: self.skills.clone(),
            accepts: self.accepts.clone(),
            auth: self.auth,
            noticed: self.noticed,
            needs_review: self.needs_review.clone(),
            offered_name: self.offered_name.clone(),
            card_problem: self.card_problem,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last: Option<LastMessage>,
    #[serde(default)]
    unread: u32,
}

struct Bot {
    file: BotFile,
    // From its conversation's events while it is loaded.
    typing: bool,
    agents_working: u32,
    waiting: Option<String>,
    failed: bool,
    /// Its routines as its row shows them: the routines' side says when they change.
    routines: Vec<RoutineSummary>,
}

impl Bot {
    fn new(file: BotFile) -> Self {
        Self {
            file,
            typing: false,
            agents_working: 0,
            waiting: None,
            failed: false,
            routines: Vec::new(),
        }
    }

    fn summary(&self, routines_error: Option<&str>) -> BotSummary {
        let f = &self.file;
        BotSummary {
            id: f.id.clone(),
            name: f.name.clone(),
            avatar: f.avatar.clone(),
            default: f.default,
            pinned: f.pinned,
            session_id: f.session_id.clone(),
            last: f.summary.last.clone(),
            unread: f.summary.unread,
            typing: self.typing,
            agents_working: self.agents_working,
            waiting: self.waiting.clone(),
            failed: self.failed,
            muted: f.muted,
            created_at: f.created_at.clone(),
            routines: self.routines.clone(),
            routines_error: routines_error.map(str::to_string),
            source: f.source.as_ref().map(BotSourceFile::view),
        }
    }
}

/// Every bot, and who follows the list.
pub(crate) struct Registry {
    home: FinxHome,
    /// `None` until read from disk, on first use.
    bots: Mutex<Option<BTreeMap<String, Bot>>>,
    feed: ListFeed,
    /// One `bot.json` write at a time, each with the bot as it is then: the last write is the
    /// latest state.
    writing: Mutex<()>,
    /// One `bots/open` at a time, so a bot never gets two conversations.
    opening: tokio::sync::Mutex<()>,
    /// Why routines cannot be used here, which every row says.
    routines_error: Mutex<Option<String>>,
    /// The service of each loaded external bot's conversation, so a new credential or card
    /// reaches it without reloading the conversation.
    peers: Mutex<std::collections::HashMap<String, std::sync::Weak<LivePeer>>>,
}

/// An external bot's service that can be swapped while its conversation is loaded: the next
/// round uses the new one; a round already running finishes with the old.
pub(crate) struct LivePeer(Mutex<Arc<dyn finx_core::Peer>>);

impl LivePeer {
    fn current(&self) -> Arc<dyn finx_core::Peer> {
        self.0.lock().clone()
    }
}

#[async_trait::async_trait]
impl finx_core::Peer for LivePeer {
    async fn send(
        &self,
        message: finx_core::PeerMessage,
        thread: finx_core::PeerThread,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<futures::stream::BoxStream<'static, finx_core::PeerEvent>, finx_core::PeerError> {
        self.current().send(message, thread, cancel).await
    }

    async fn resume(
        &self,
        thread: finx_core::PeerThread,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<futures::stream::BoxStream<'static, finx_core::PeerEvent>, finx_core::PeerError> {
        self.current().resume(thread, cancel).await
    }

    async fn cancel(&self, thread: finx_core::PeerThread) {
        self.current().cancel(thread).await
    }
}

impl Registry {
    pub(crate) fn new(home: FinxHome) -> Self {
        Self {
            home,
            bots: Mutex::new(None),
            feed: ListFeed::default(),
            writing: Mutex::new(()),
            opening: tokio::sync::Mutex::new(()),
            routines_error: Mutex::new(None),
            peers: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Runs `f` on every bot, read from disk the first time. Blocking I/O then.
    fn with<R>(&self, f: impl FnOnce(&mut BTreeMap<String, Bot>) -> R) -> R {
        let mut bots = self.bots.lock();
        let bots = bots.get_or_insert_with(|| read_all(&self.home));
        f(bots)
    }

    fn with_bot<R>(&self, id: &str, f: impl FnOnce(&mut Bot) -> R) -> Result<R, RpcError> {
        self.with(|bots| bots.get_mut(id).map(f)).ok_or_else(|| errors::bot_not_found(id))
    }

    /// Writes the bot's file as it is now. Blocking I/O.
    fn save(&self, id: &str) -> Result<(), RpcError> {
        let _writing = self.writing.lock();
        let Some(file) = self.with(|bots| bots.get(id).map(|b| b.file.clone())) else {
            return Ok(());
        };
        let dir = self.home.bot_dir(id);
        private_dir(&dir).map_err(|e| RpcError::internal(format!("cannot create {}: {e}", dir.display())))?;
        let text = serde_json::to_vec_pretty(&file).map_err(|e| RpcError::internal(e.to_string()))?;
        finx_core::config_edit::replace_file(&dir.join("bot.json"), &text)
            .map_err(|e| RpcError::internal(format!("cannot write the bot: {e}")))
    }

    /// [`Self::save`] off the caller's thread, for the hub, which never blocks.
    fn save_later(self: &Arc<Self>, id: &str) {
        let (registry, id) = (self.clone(), id.to_string());
        tokio::task::spawn_blocking(move || {
            if let Err(err) = registry.save(&id) {
                tracing::warn!(bot = %id, "cannot save the bot: {}", err.message);
            }
        });
    }

    /// Every bot's row, or those that `keep` says.
    fn rows(&self, keep: impl Fn(&str) -> bool) -> Vec<BotSummary> {
        let error = self.routines_error.lock().clone();
        self.with(|bots| bots.values().filter(|bot| keep(&bot.file.id)).map(|bot| bot.summary(error.as_deref())).collect())
    }

    fn row(&self, id: &str) -> Result<BotSummary, RpcError> {
        self.rows(|bot| bot == id).pop().ok_or_else(|| errors::bot_not_found(id))
    }

    fn announce(&self, ids: &[&str], deleted: Vec<String>) {
        let bots = self.rows(|bot| ids.contains(&bot));
        self.feed.send(Bytes::from(finx_rpc::notification(
            method::BOTS_CHANGED,
            &BotsChangedParams { bots, deleted },
        )));
    }

    /// Every external bot with a conversation, for the startup sweep (§5.5).
    pub(crate) fn remote_sessions(&self) -> Vec<String> {
        self.with(|bots| {
            bots.values()
                .filter(|bot| bot.file.source.is_some())
                .filter_map(|bot| bot.file.session_id.clone())
                .collect()
        })
    }

    /// The bot's external source, cloned out for the session that talks to it.
    pub(crate) fn source(&self, id: &str) -> Option<BotSourceFile> {
        self.with(|bots| bots.get(id).and_then(|bot| bot.file.source.clone()))
    }

    /// Replaces an external bot's source after its card was read again (§5.6).
    fn set_source(&self, id: &str, source: BotSourceFile) -> Result<(), RpcError> {
        self.with_bot(id, |bot| {
            bot.file.source = Some(source);
        })?;
        Ok(())
    }

    /// The bot's name now, for a conversation being loaded.
    pub(crate) fn name(&self, id: &str) -> Option<String> {
        self.with(|bots| bots.get(id).map(|b| b.file.name.clone()))
    }

    /// Reads the list now, if it was not read yet. Blocking I/O.
    pub(crate) fn load(&self) {
        self.with(|_| ());
    }

    pub(crate) fn exists(&self, id: &str) -> bool {
        self.with(|bots| bots.contains_key(id))
    }

    /// The bot's routines changed; its row shows them.
    pub(crate) fn set_routines(&self, id: &str, routines: Vec<RoutineSummary>) {
        let changed = self.with(|bots| {
            bots.get_mut(id).is_some_and(|bot| {
                let changed = bot.routines != routines;
                bot.routines = routines;
                changed
            })
        });
        if changed {
            self.announce(&[id], Vec::new());
        }
    }

    /// Why routines cannot be used here, which every row says from now on.
    pub(crate) fn set_routines_error(&self, why: Option<String>) {
        *self.routines_error.lock() = why;
        let ids: Vec<String> = self.with(|bots| bots.keys().cloned().collect());
        self.announce(&ids.iter().map(String::as_str).collect::<Vec<_>>(), Vec::new());
    }

    #[cfg(test)]
    pub(crate) fn routines_error(&self) -> Option<String> {
        self.routines_error.lock().clone()
    }

    #[cfg(test)]
    pub(crate) fn add_for_test(&self, id: &str) {
        let mut file = new_file("测试".into(), Avatar::Mark, false);
        file.id = id.to_string();
        self.with(|bots| bots.insert(id.to_string(), Bot::new(file)));
    }

    /// An event of a bot's loaded conversation: the row may change (bot-design §5.2).
    pub(crate) fn on_event(self: &Arc<Self>, id: &str, event: &Event, mirror: &SessionMirror) {
        let (changed, kept) = {
            let mut guard = self.bots.lock();
            let Some(bot) = guard.as_mut().and_then(|bots| bots.get_mut(id)) else {
                return;
            };
            let before = (bot.typing, bot.agents_working, bot.waiting.clone(), bot.failed);
            let mut kept = false;
            match &event.msg {
                // A message to the user is a bubble from the call's start, as the client shows it.
                EventMsg::ToolStarted { name, args, .. } if name == finx_core::bot::SEND_TO_USER => {
                    if !finx_core::bot::sends_files(args)
                        && let Some(text) = finx_core::bot::words_of(args)
                    {
                        bot.file.summary.last = Some(last(Speaker::Bot, text, 0, None, event.ts));
                        bot.file.summary.unread += 1;
                        kept = true;
                    }
                }
                // Files count once they were found to be there (bot-design §3.12).
                EventMsg::ToolCompleted { result, .. } if result.tool_name == finx_core::bot::SEND_TO_USER && !result.is_error => {
                    if let Some((text, images, file)) = result.details.as_ref().and_then(|d| finx_core::bot::attachment_summary(d.as_str())) {
                        bot.file.summary.last = Some(last(Speaker::Bot, &text, images, file, event.ts));
                        bot.file.summary.unread += 1;
                        kept = true;
                    }
                }
                EventMsg::MessageCompleted {
                    message: finx_llm::Message::User(user),
                    mail: None,
                    ..
                } => {
                    let images = user.content.iter().filter(|c| matches!(c, finx_llm::UserContent::Image { .. })).count();
                    bot.file.summary.last = Some(last(Speaker::User, &user.text_content(), images as u32, None, event.ts));
                    kept = true;
                }
                // What a sub-agent told the owner is a message like the bot's own
                // (agent-messaging-design §17).
                EventMsg::MessageCompleted {
                    message: finx_llm::Message::User(user),
                    mail: Some(mail),
                    ..
                } if mail.kind == finx_protocol::MailKind::ToUser => {
                    bot.file.summary.last = Some(last(Speaker::Bot, finx_core::bot::told_words(&user.text_content()), 0, None, event.ts));
                    bot.file.summary.unread += 1;
                    kept = true;
                }
                EventMsg::ApprovalRequested { .. } => {
                    bot.file.summary.unread += 1;
                    kept = true;
                }
                // What a sub-agent asks counts like the bot's own.
                EventMsg::AgentEvent { event, .. } if matches!(event.msg, EventMsg::ApprovalRequested { .. }) => {
                    bot.file.summary.unread += 1;
                    kept = true;
                }
                _ => {}
            }
            bot.typing = mirror.busy();
            bot.agents_working = mirror.agents_working();
            bot.waiting = mirror.first_approval().map(str::to_string);
            bot.failed = mirror.state() == SessionState::Failed;
            (kept || before != (bot.typing, bot.agents_working, bot.waiting.clone(), bot.failed), kept)
        };
        if kept {
            self.save_later(id);
        }
        if changed {
            self.announce(&[id], Vec::new());
        }
    }

    /// The bot's conversation was unloaded: nothing runs.
    pub(crate) fn on_unloaded(&self, id: &str) {
        let changed = self.with(|bots| {
            bots.get_mut(id).is_some_and(|bot| {
                let was = bot.typing || bot.agents_working > 0 || bot.waiting.is_some() || bot.failed;
                (bot.typing, bot.agents_working, bot.waiting, bot.failed) = (false, 0, None, false);
                was
            })
        });
        if changed {
            self.announce(&[id], Vec::new());
        }
    }
}

fn last(from: Speaker, text: &str, images: u32, file: Option<String>, ts: finx_llm::Timestamp) -> LastMessage {
    LastMessage {
        from,
        text: text.chars().take(TEXT_MAX).collect(),
        images,
        file,
        ts: list::rfc3339(ts),
    }
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Every `bots/<id>/bot.json` that reads; the others are skipped with a warning.
/// The host a card's interface lives on, with its port when it names one (§4.2).
fn host_of(endpoint: &str) -> Result<String, RpcError> {
    let url = url::Url::parse(endpoint).map_err(|_| errors::bot_invalid("the card's interface is not an address"))?;
    let host = url.host_str().ok_or_else(|| errors::bot_invalid("the card's interface has no host"))?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn skills_of(card: &Card) -> Vec<BotSkill> {
    card.skills
        .iter()
        .map(|skill| BotSkill {
            name: skill.name.clone(),
            description: skill.description.clone(),
        })
        .collect()
}

fn accepts_of(card: &Card) -> Vec<BotAccept> {
    use finx_a2a::card::Accept;
    card.accepts
        .iter()
        .map(|accept| match accept {
            Accept::Text => BotAccept::Text,
            Accept::Image => BotAccept::Image,
        })
        .collect()
}

fn auth_kind(auth: &finx_a2a::Auth) -> BotAuth {
    match auth {
        finx_a2a::Auth::None => BotAuth::None,
        finx_a2a::Auth::ApiKey { .. } => BotAuth::ApiKey,
        finx_a2a::Auth::Bearer { .. } => BotAuth::Bearer,
        finx_a2a::Auth::Basic { .. } => BotAuth::Basic,
    }
}

/// What the keychain keeps for a credential the owner typed in the shape `auth` asks for: the
/// secret itself for an API key or a bearer token (as bots always kept it), JSON for Basic.
/// `None` when the bot needs no credential.
fn stored_credential(auth: BotAuth, credential: Option<&BotCredential>) -> Result<Option<String>, RpcError> {
    fn required(kind: &str) -> RpcError {
        errors::bot_auth_required(format!("this bot needs a {kind} credential"))
    }
    match (auth, credential) {
        (BotAuth::None, _) => Ok(None),
        (BotAuth::ApiKey | BotAuth::Bearer, Some(BotCredential::Secret { value })) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        (BotAuth::ApiKey, _) => Err(required("API key")),
        (BotAuth::Bearer, _) => Err(required("bearer")),
        (BotAuth::Basic, Some(BotCredential::Basic { username, password })) => {
            let username = username.trim();
            // RFC 7617: the user name cannot hold a colon; the password may.
            if username.is_empty() || username.contains(':') || password.is_empty() {
                return Err(required("user name and password"));
            }
            Ok(Some(serde_json::json!({ "username": username, "password": password }).to_string()))
        }
        (BotAuth::Basic, _) => Err(required("user name and password")),
    }
}

/// Keeps a bot's credential in the keychain. Blocking I/O.
async fn keep_credential(id: &str, value: String) -> Result<(), RpcError> {
    let name = format!("bot.{id}");
    match tokio::task::spawn_blocking(move || finx_llm::credentials::set(&name, &value)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(why)) => {
            tracing::warn!(bot = %id, "cannot keep the bot's credential: {why}");
            Err(errors::bot_auth_required("this bot's credential could not be saved"))
        }
        Err(err) => {
            tracing::warn!(bot = %id, "cannot keep the bot's credential: {err}");
            Err(errors::bot_auth_required("this bot's credential could not be saved"))
        }
    }
}

/// A bot's avatar without an icon: a steady colour from its name, as a new bot gets one (§4.2).
fn hue_for(name: &str) -> finx_protocol::bot::AvatarHue {
    use finx_protocol::bot::AvatarHue as H;
    const HUES: [H; 8] = [H::Slate, H::Sage, H::Clay, H::Ochre, H::Plum, H::Teal, H::Rose, H::Stone];
    let mut hash: u32 = 2166136261;
    for byte in name.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(16777619);
    }
    HUES[(hash % 8) as usize]
}

fn read_all(home: &FinxHome) -> BTreeMap<String, Bot> {
    let mut bots = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(home.bots_dir()) else {
        return bots;
    };
    for entry in entries.flatten() {
        let path = entry.path().join("bot.json");
        if !path.is_file() {
            continue;
        }
        match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<BotFile>(&b).map_err(|e| e.to_string())) {
            Ok(mut file) if entry.file_name().to_str() == Some(file.id.as_str()) => {
                // Version 1 is a local bot: it has no `source`. The field's default reads it,
                // and the next save writes version 2 (D-700).
                if file.version < 2 {
                    file.version = 2;
                }
                bots.insert(file.id.clone(), Bot::new(file));
            }
            Ok(_) => tracing::warn!(path = %path.display(), "skipping a bot whose id is not its folder's name"),
            Err(err) => tracing::warn!(path = %path.display(), "skipping a bot that cannot be read: {err}"),
        }
    }
    bots
}

/// A name as kept: trimmed, 1 to 20 characters.
fn clean_name(name: &str) -> Result<String, RpcError> {
    let name = name.trim();
    match name.chars().count() {
        0 => Err(errors::bot_invalid("the name is empty")),
        n if n > NAME_MAX => Err(errors::bot_invalid(format!("the name is longer than {NAME_MAX} characters"))),
        _ => Ok(name.to_string()),
    }
}

impl Server {
    fn bots(&self) -> &Arc<Registry> {
        &self.0.bots
    }

    /// `bots/subscribe`: every bot now, the default one made first when there is none, and
    /// `bots/changed` from then on. Blocking I/O.
    pub fn bots_subscribe(&self, conn: &ConnHandle, respond: impl FnOnce(Result<BotsResult, RpcError>) -> Vec<u8>) {
        let registry = self.bots();
        registry.feed.watch(conn);
        let result = self.make_default_bot().map(|()| BotsResult { bots: registry.rows(|_| true) });
        let failed = result.is_err();
        registry.feed.start(conn, respond(result));
        if failed {
            registry.feed.cancel(conn.id);
        }
    }

    pub fn bots_unsubscribe(&self, conn: &ConnHandle) {
        self.bots().feed.cancel(conn.id);
    }

    /// The default bot, when there is no bot at all (bot-design §2.1).
    fn make_default_bot(&self) -> Result<(), RpcError> {
        let registry = self.bots();
        let id = registry.with(|bots| {
            if !bots.is_empty() {
                return None;
            }
            let file = new_file(DEFAULT_NAME.into(), Avatar::Mark, true);
            let id = file.id.clone();
            bots.insert(id.clone(), Bot::new(file));
            Some(id)
        });
        match id {
            Some(id) => self.made(&id),
            None => Ok(()),
        }
    }

    /// Writes a new bot's folder and file. Blocking I/O.
    fn made(&self, id: &str) -> Result<(), RpcError> {
        let files = self.0.home.bot_files_dir(id);
        private_dir(&self.0.home.bot_dir(id))
            .and_then(|()| std::fs::create_dir_all(&files))
            .map_err(|e| RpcError::internal(format!("cannot create {}: {e}", files.display())))?;
        self.bots().save(id)
    }

    /// `bots/create`. Blocking I/O.
    pub fn bots_create(&self, params: BotCreateParams) -> Result<BotResult, RpcError> {
        let name = clean_name(&params.name)?;
        let file = new_file(name, Avatar::Mark, false);
        let id = file.id.clone();
        let avatar = self.avatar_of(&id, &params.avatar, false, None)?;
        let registry = self.bots();
        registry.with(|bots| bots.insert(id.clone(), Bot::new(BotFile { avatar, model: params.model, thinking: params.thinking, ..file })));
        if let Err(err) = self.made(&id) {
            registry.with(|bots| bots.remove(&id));
            return Err(err);
        }
        registry.announce(&[&id], Vec::new());
        Ok(BotResult { bot: registry.row(&id)? })
    }

    /// `bots/preview`: reads the card at a link, for the confirmation page (§4.2, §5.2).
    pub async fn bots_preview(&self, params: BotPreviewParams) -> Result<RemotePreview, RpcError> {
        self.external()?;
        let options = self.card_options();
        let card = Card::read(&params.url, &options).await.map_err(errors::from_card)?;
        let icon = finx_a2a::card::icon(&card, &options).await.map(|png| {
            use base64::Engine as _;
            format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
        });
        Ok(RemotePreview {
            name: card.name.clone(),
            description: card.description.clone(),
            icon,
            provider: card.provider.clone(),
            host: host_of(&card.endpoint.url)?,
            skills: skills_of(&card),
            accepts: accepts_of(&card),
            auth: auth_kind(&card.auth),
            card_sha256: Card::hash(&card),
        })
    }

    /// `bots/add`: adds another subject's bot, after the owner saw its card (§4.2, §5.2).
    pub async fn bots_add(&self, params: BotAddParams) -> Result<BotResult, RpcError> {
        self.external()?;
        let options = self.card_options();
        let card = Card::read(&params.url, &options).await.map_err(errors::from_card)?;
        if Card::hash(&card) != params.card_sha256 {
            return Err(errors::bot_card_changed());
        }
        let id = uuid::Uuid::now_v7().to_string();
        let credential = stored_credential(auth_kind(&card.auth), params.credential.as_ref())?;
        // The icon and the avatar can fail: nothing is kept until they are done, so a failed
        // add leaves no credential behind (bot-contacts-design §5.6).
        let icon = finx_a2a::card::icon(&card, &options).await;
        let avatar = match icon {
            Some(png) => {
                use base64::Engine as _;
                let input = AvatarInput::Image {
                    png: base64::engine::general_purpose::STANDARD.encode(png),
                };
                self.avatar_of(&id, &input, false, None)?
            }
            None => Avatar::Mono {
                hue: hue_for(&card.name),
            },
        };
        let host = host_of(&card.endpoint.url)?;
        let now = list::now();
        let file = BotFile {
            version: 2,
            id: id.clone(),
            name: card.name.clone(),
            avatar,
            default: false,
            pinned: false,
            muted: false,
            created_at: now.clone(),
            session_id: None,
            model: None,
            thinking: None,
            permission_mode: None,
            summary: Kept::default(),
            source: Some(BotSourceFile {
                kind: BotSourceKind::Remote,
                protocol: BotProtocol::A2a,
                card_url: params.url,
                endpoint: card.endpoint.url.clone(),
                tenant: card.endpoint.tenant.clone(),
                host,
                card_sha256: params.card_sha256,
                card_read_at: now,
                description: card.description.clone(),
                provider: card.provider.clone(),
                skills: skills_of(&card),
                accepts: accepts_of(&card),
                auth: auth_kind(&card.auth),
                api_key_header: match &card.auth {
                    finx_a2a::Auth::ApiKey { header, .. } => Some(header.clone()),
                    _ => None,
                },
                noticed: false,
                needs_review: None,
                offered_name: None,
                card_problem: None,
            }),
        };
        let registry = self.bots();
        registry.with(|bots| bots.insert(id.clone(), Bot::new(file)));
        if let Err(err) = self.made(&id) {
            registry.with(|bots| bots.remove(&id));
            return Err(err);
        }
        // Last, once the bot is on disk: a credential that cannot be kept takes the bot with it,
        // so the list never shows one that cannot answer.
        if let Some(value) = credential
            && let Err(err) = keep_credential(&id, value).await
        {
            registry.with(|bots| bots.remove(&id));
            let _ = std::fs::remove_dir_all(self.0.home.bot_dir(&id));
            return Err(err);
        }
        registry.announce(&[&id], Vec::new());
        Ok(BotResult { bot: registry.row(&id)? })
    }

    /// `bots/credential`: the owner replaces an external bot's credential, in the shape its card
    /// asks for now; a credential scheme change waiting for them is settled by it (§5.6).
    pub async fn bots_credential(&self, params: BotCredentialParams) -> Result<BotResult, RpcError> {
        let id = params.bot_id;
        let Some(mut source) = self.bots().source(&id) else {
            self.bots().with_bot(&id, |_| ())?;
            return Err(errors::bot_not_supported());
        };
        let Some(value) = stored_credential(source.auth, Some(&params.credential))? else {
            return Err(errors::bot_auth_required("this bot takes no credential"));
        };
        keep_credential(&id, value).await?;
        if source.needs_review.is_some() {
            source.needs_review = None;
            self.save_source(&id, source).await?;
        } else {
            self.bots().announce(&[&id], Vec::new());
        }
        self.renew_peer(&id).await;
        Ok(BotResult { bot: self.bots().row(&id)? })
    }

    /// `bots/reread`: reads an external bot's card now (§5.6). Unlike the daily reading, a card
    /// that cannot be read is an error the owner sees.
    pub async fn bots_reread(&self, id: &str) -> Result<BotResult, RpcError> {
        if self.bots().source(id).is_none() {
            self.bots().with_bot(id, |_| ())?;
            return Err(errors::bot_not_supported());
        }
        self.read_card(id, true).await?;
        Ok(BotResult { bot: self.bots().row(id)? })
    }

    /// The card reader's options, from `[bots]` (§5.8).
    fn card_options(&self) -> CardOptions {
        CardOptions {
            allow_local: self.0.bot_settings.allow_local,
        }
    }

    /// Adding another subject's bot is off unless `bots.external` says otherwise (§5.8, D-717).
    fn external(&self) -> Result<(), RpcError> {
        if self.0.bot_settings.external {
            Ok(())
        } else {
            Err(errors::bot_not_supported())
        }
    }

    /// Reads an external bot's card again when it is a day old, and follows what changed
    /// (§5.6). It never blocks the conversation: failures leave the last card in use.
    async fn refresh_card(&self, id: &str) -> Result<(), RpcError> {
        self.read_card(id, false).await
    }

    /// Reads the card and follows what changed (§5.6). `now`: the owner asked, so it is read
    /// whatever its age and a failure to read it is returned.
    async fn read_card(&self, id: &str, now_asked: bool) -> Result<(), RpcError> {
        let Some(mut source) = self.bots().source(id) else {
            return Ok(());
        };
        let now = chrono::Utc::now();
        let read_at = chrono::DateTime::parse_from_rfc3339(&source.card_read_at)
            .map(|time| time.with_timezone(&chrono::Utc))
            .unwrap_or(now);
        if !now_asked && now - read_at < chrono::Duration::hours(24) {
            return Ok(());
        }
        let options = self.card_options();
        let card = match Card::read(&source.card_url, &options).await {
            Ok(card) => card,
            Err(err) if now_asked => return Err(errors::from_card(err)),
            Err(_) => {
                // Seven days without a card: the bot's settings say so; the last one stays in use.
                if now - read_at > chrono::Duration::days(7) && source.card_problem != Some(CardProblem::Unreachable) {
                    source.card_problem = Some(CardProblem::Unreachable);
                    self.save_source(id, source).await?;
                }
                return Ok(());
            }
        };
        let host = host_of(&card.endpoint.url)?;
        if host != source.host {
            // Its interface moved to another host: not accepted; the old one stays in use.
            source.card_problem = Some(CardProblem::Moved);
            source.card_read_at = now.to_rfc3339();
            self.save_source(id, source).await?;
            return if now_asked { Err(errors::from_card(finx_a2a::CardError::Moved(host))) } else { Ok(()) };
        }
        let was = source.auth;
        let hash = Card::hash(&card);
        source.card_read_at = now.to_rfc3339();
        source.card_sha256 = hash;
        source.endpoint = card.endpoint.url.clone();
        source.tenant = card.endpoint.tenant.clone();
        source.description = card.description.clone();
        source.provider = card.provider.clone();
        source.skills = skills_of(&card);
        source.accepts = accepts_of(&card);
        source.auth = auth_kind(&card.auth);
        source.api_key_header = match &card.auth {
            finx_a2a::Auth::ApiKey { header, .. } => Some(header.clone()),
            _ => None,
        };
        source.card_problem = None;
        if was != source.auth {
            // The credential scheme changed: the owner confirms before the bot is used again
            // (§5.6).
            source.needs_review = Some("the credential scheme changed".to_string());
        }
        let current = self.bots().with_bot(id, |bot| bot.file.name.clone())?;
        if card.name != current {
            // A card is not a way to rename a bot silently (§5.6).
            source.offered_name = Some(card.name.clone());
        }
        let renew = was == source.auth;
        self.save_source(id, source).await?;
        // Same scheme: the conversation follows a moved endpoint or tenant now. A new scheme
        // waits for the owner's new credential (`bots/credential`).
        if renew {
            self.renew_peer(id).await;
        }
        Ok(())
    }

    /// Writes a changed source and tells the list (§5.6).
    async fn save_source(&self, id: &str, source: BotSourceFile) -> Result<(), RpcError> {
        let registry = self.bots().clone();
        registry.set_source(id, source)?;
        let (registry, owned) = (registry.clone(), id.to_string());
        tokio::task::spawn_blocking(move || registry.save(&owned))
            .await
            .map_err(|e| RpcError::internal(e.to_string()))??;
        self.bots().announce(&[id], Vec::new());
        Ok(())
    }

    /// The service behind an external bot, with its credential from the keychain (§5.3, §5.6).
    /// `None` for this computer's own bots. Blocking I/O: the keychain.
    pub(crate) fn peer_connection(&self, id: &str) -> Result<Option<(Arc<dyn finx_core::Peer>, PeerRef)>, RpcError> {
        let Some((peer, at)) = self.peer_now(id)? else {
            return Ok(None);
        };
        let live = Arc::new(LivePeer(Mutex::new(peer)));
        self.bots().peers.lock().insert(id.to_string(), Arc::downgrade(&live));
        Ok(Some((live, at)))
    }

    /// Gives a loaded conversation the bot's service as its source and keychain say now (§5.6).
    /// A credential that is missing or unusable leaves the old one; the next round says why.
    async fn renew_peer(&self, id: &str) {
        let Some(live) = self.bots().peers.lock().get(id).and_then(std::sync::Weak::upgrade) else {
            return;
        };
        let (server, owned) = (self.clone(), id.to_string());
        match tokio::task::spawn_blocking(move || server.peer_now(&owned)).await {
            Ok(Ok(Some((peer, _)))) => *live.0.lock() = peer,
            Ok(Err(err)) => tracing::debug!(bot = %id, "the conversation keeps its service: {}", err.message),
            _ => {}
        }
    }

    /// The service behind an external bot right now. Blocking I/O: the keychain.
    fn peer_now(&self, id: &str) -> Result<Option<(Arc<dyn finx_core::Peer>, PeerRef)>, RpcError> {
        let Some(source) = self.bots().source(id) else {
            return Ok(None);
        };
        let credential = || {
            finx_llm::credentials::get(&format!("bot.{id}")).ok_or_else(|| {
                errors::bot_auth_required("this bot's credential is missing: set it in the bot's settings")
            })
        };
        let auth = match source.auth {
            BotAuth::None => finx_a2a::Auth::None,
            BotAuth::ApiKey => finx_a2a::Auth::ApiKey {
                header: source.api_key_header.clone().unwrap_or_else(|| "X-API-Key".to_string()),
                value: credential()?,
            },
            BotAuth::Bearer => finx_a2a::Auth::Bearer { token: credential()? },
            BotAuth::Basic => {
                #[derive(serde::Deserialize)]
                struct Kept {
                    username: String,
                    password: String,
                }
                let kept: Kept = serde_json::from_str(&credential()?).map_err(|_| {
                    errors::bot_auth_required("this bot's credential is not a user name and password: set it in the bot's settings")
                })?;
                finx_a2a::Auth::Basic { username: kept.username, password: kept.password }
            }
        };
        let peer = finx_a2a::A2aPeer::new(finx_a2a::Source {
            endpoint: source.endpoint,
            host: source.host.clone(),
            tenant: source.tenant,
            auth,
            allow_local: self.0.bot_settings.allow_local,
        });
        Ok(Some((
            Arc::new(peer),
            PeerRef {
                host: source.host,
            },
        )))
    }

    /// The avatar to keep for `input`; an image is written to the bot's folder. Blocking I/O.
    fn avatar_of(&self, id: &str, input: &AvatarInput, default: bool, before: Option<&Avatar>) -> Result<Avatar, RpcError> {
        Ok(match input {
            AvatarInput::Mark if default => Avatar::Mark,
            AvatarInput::Mark => return Err(errors::bot_default("only the default bot has the mark")),
            AvatarInput::Char { shape, hue } => Avatar::Char { shape: *shape, hue: *hue },
            AvatarInput::Mono { hue } => Avatar::Mono { hue: *hue },
            AvatarInput::Image { png } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(png.trim())
                    .map_err(|_| errors::bot_invalid("the image is not base64"))?;
                if !bytes.starts_with(PNG_SIGNATURE) {
                    return Err(errors::bot_invalid("the image is not a PNG"));
                }
                if bytes.len() > PNG_MAX {
                    return Err(errors::bot_invalid("the image is larger than 1 MB"));
                }
                let dir = self.0.home.bot_dir(id);
                private_dir(&dir).map_err(|e| RpcError::internal(e.to_string()))?;
                finx_core::config_edit::replace_file(&dir.join("avatar.png"), &bytes)
                    .map_err(|e| RpcError::internal(format!("cannot write the avatar: {e}")))?;
                let rev = match before {
                    Some(Avatar::Image { rev }) => rev + 1,
                    _ => 1,
                };
                Avatar::Image { rev }
            }
        })
    }

    /// `bots/update`: a new name reaches a loaded conversation's model at its next turn.
    /// Blocking I/O.
    pub fn bots_update(&self, params: BotUpdateParams) -> Result<BotResult, RpcError> {
        if params.noticed.is_some() || params.accept_review.is_some() || params.adopt_name.is_some() {
            self.bots().with_bot(&params.bot_id, |bot| {
                let Some(source) = bot.file.source.as_mut() else {
                    return Err(errors::bot_not_supported());
                };
                if let Some(noticed) = params.noticed {
                    source.noticed = noticed;
                }
                if params.accept_review == Some(true) {
                    source.needs_review = None;
                }
                if params.adopt_name == Some(true)
                    && let Some(name) = source.offered_name.take()
                {
                    bot.file.name = name;
                }
                Ok(())
            })??;
        }
        let registry = self.bots();
        let name = params.name.as_deref().map(clean_name).transpose()?;
        let (default, before) = registry.with_bot(&params.bot_id, |b| (b.file.default, b.file.avatar.clone()))?;
        let avatar = match &params.avatar {
            Some(input) => Some(self.avatar_of(&params.bot_id, input, default, Some(&before))?),
            None => None,
        };
        let renamed = registry.with_bot(&params.bot_id, |bot| {
            if let Some(avatar) = avatar {
                bot.file.avatar = avatar;
            }
            if let Some(pinned) = params.pinned {
                bot.file.pinned = pinned;
            }
            if let Some(muted) = params.muted {
                bot.file.muted = muted;
            }
            match name {
                Some(name) if name != bot.file.name => {
                    bot.file.name = name.clone();
                    bot.file.session_id.clone().map(|session| (session, name))
                }
                _ => None,
            }
        })?;
        registry.save(&params.bot_id)?;
        if let Some((session, name)) = renamed
            && let Some(hub) = self.hub(&session)
        {
            let _ = hub.tx.try_send(Box::new(HubCmd::BotName { name }));
        }
        registry.announce(&[&params.bot_id], Vec::new());
        Ok(BotResult { bot: registry.row(&params.bot_id)? })
    }

    /// `bots/avatar`. Blocking I/O.
    pub fn bots_avatar(&self, id: &str) -> Result<BotAvatarResult, RpcError> {
        self.bots().with_bot(id, |_| ())?;
        let bytes = std::fs::read(self.0.home.bot_dir(id).join("avatar.png"))
            .map_err(|_| errors::bot_invalid("the bot has no uploaded avatar"))?;
        Ok(BotAvatarResult {
            data: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
        })
    }

    /// `bots/read` (`unread` 0) and `bots/unread` (`unread` 1). Blocking I/O.
    pub fn bots_set_unread(&self, id: &str, unread: u32) -> Result<(), RpcError> {
        let registry = self.bots();
        let changed = registry.with_bot(id, |bot| std::mem::replace(&mut bot.file.summary.unread, unread) != unread)?;
        if changed {
            registry.save(id)?;
            registry.announce(&[id], Vec::new());
        }
        Ok(())
    }

    /// `bots/open`: attaches the bot's conversation, loading it, or starting it when there is
    /// none (bot-design §5.4).
    pub async fn bots_open(&self, id: &str, attach: AttachRequest) -> Result<(), RpcError> {
        self.open_bot(id, Some(attach)).await.map(|_| ())
    }

    /// The bot's conversation loaded for what the service itself does with it: nothing
    /// attaches, nothing is written, and it unloads again when nothing uses it (routine-design §5.5).
    pub(crate) async fn load_bot_session(&self, id: &str) -> Result<HubHandle, RpcError> {
        let session = self.open_bot(id, None).await?;
        self.hub(&session).ok_or_else(|| errors::session_closed(&session))
    }

    /// The bot's conversation if it is loaded.
    pub(crate) fn bot_hub(&self, id: &str) -> Option<HubHandle> {
        let session = self.bots().with_bot(id, |bot| bot.file.session_id.clone()).ok()??;
        self.hub(&session)
    }

    pub(crate) fn bot_exists(&self, id: &str) -> Result<(), RpcError> {
        if self.bots().exists(id) { Ok(()) } else { Err(errors::bot_not_found(id)) }
    }

    /// Loads or starts the bot's conversation; returns its session.
    async fn open_bot(&self, id: &str, attach: Option<AttachRequest>) -> Result<String, RpcError> {
        // A card is read again on opening, at most once a day (§5.6); reading it cannot block
        // the conversation.
        let _ = self.refresh_card(id).await;
        let registry = self.bots().clone();
        let _opening = registry.opening.lock().await;
        let (session, name, start) = {
            let (registry, id) = (registry.clone(), id.to_string());
            tokio::task::spawn_blocking(move || registry.with_bot(&id, |b| (b.file.session_id.clone(), b.file.name.clone(), (b.file.model.clone(), b.file.thinking, b.file.permission_mode))))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))??
        };
        if let Some(session) = session {
            let on_disk = self.is_loaded(&session) || self.store().header(&SessionRef::Id(session.clone())).is_ok_and(|(h, _)| h.id == session);
            if on_disk {
                self.load_session(&session, ResumeOverrides::default(), attach).await?;
                return Ok(session);
            }
        }
        let session = self.start_bot_session(id, name, start, attach).await?;
        registry.with_bot(id, |bot| bot.file.session_id = Some(session.clone()))?;
        let saved = {
            let (registry, id) = (registry.clone(), id.to_string());
            tokio::task::spawn_blocking(move || registry.save(&id)).await.map_err(|e| RpcError::internal(e.to_string()))?
        };
        registry.announce(&[id], Vec::new());
        saved.map(|()| session)
    }

    /// Starts a bot's conversation in its folder.
    async fn start_bot_session(&self, id: &str, name: String, (model, thinking, permission_mode): (Option<String>, Option<ThinkingLevel>, Option<PermissionMode>), attach: Option<AttachRequest>) -> Result<String, RpcError> {
        self.make_room().await?;
        let folder = self.0.home.bot_files_dir(id);
        std::fs::create_dir_all(&folder).map_err(|e| RpcError::internal(format!("cannot create {}: {e}", folder.display())))?;
        let workspace = Workspace::open(&self.0.home, &folder, &self.0.overrides).map_err(errors::from_runtime)?;
        // Another subject's bot answers from its own service: no model is resolved here (§5.3).
        let remote = self.peer_connection(id)?;
        let model = match &remote {
            Some(_) => finx_core::A2A_MODEL.to_string(),
            None => self.session_model(model, workspace.config.model.clone()).await?,
        };
        let store: Arc<dyn SessionStore> = self.store().clone();
        let mut deps = workspace.kernel_deps(self.0.llm.clone(), store, &[]).map_err(errors::from_runtime)?;
        if let Some((peer, _)) = &remote {
            deps.peer = Some(peer.clone());
        }
        deps.browser_pool = Some(self.0.browser_pool.clone());
        deps.docs = Some(self.0.docs.clone());
        deps.decks = Some(self.0.decks.clone());
        deps.words = Some(self.0.words.clone());
        deps.mcp_servers = self.session_mcp_servers(&workspace, &[]);
        deps.routines = Some(self.0.routines.clone());
        let options = StartOptions {
            model,
            thinking: thinking.unwrap_or(workspace.config.thinking),
            permission_mode: permission_mode.unwrap_or(workspace.config.permission_mode),
            cwd: workspace.cwd.clone(),
            home: self.0.home.clone(),
            project_root: None,
            trusted: workspace.trusted,
            config: Arc::new(workspace.config),
            interactive_approvals: true,
            bot: Some(BotIdentity { id: id.to_string(), name }),
            peer: remote.as_ref().map(|(_, peer)| peer.clone()),
        };
        let kernel = finx_core::Kernel::start(options, deps).await.map_err(|e| errors::from_kernel(e, "new"))?;
        if let Some(text) = self.0.routines.listing_of(id) {
            kernel.set_routines(text);
        }
        let now = list::now();
        let base = SummaryBase {
            created_at: now.clone(),
            preview: None,
            updated_at: now,
            no_project: true,
        };
        Ok(self.register(kernel, Vec::new(), attach, base, Some(id.to_string())))
    }

    /// `bots/clear`: the conversation goes to the trash; the next `bots/open` starts another, with
    /// the settings this one has, which the bot's settings show as the bot's.
    pub async fn bots_clear(&self, id: &str) -> Result<(), RpcError> {
        let registry = self.bots().clone();
        let current = registry.with_bot(id, |bot| bot.file.session_id.clone())?;
        let settings = match &current {
            Some(session) => self.conversation_settings(session).await,
            None => None,
        };
        let session = registry.with_bot(id, |bot| {
            if let Some(info) = settings {
                bot.file.model = Some(info.model);
                bot.file.thinking = Some(info.thinking);
                bot.file.permission_mode = Some(info.permission_mode);
            }
            bot.file.summary = Kept::default();
            bot.file.session_id.take()
        })?;
        self.drop_conversation(session).await?;
        let saved = {
            let (registry, id) = (registry.clone(), id.to_string());
            tokio::task::spawn_blocking(move || registry.save(&id)).await.map_err(|e| RpcError::internal(e.to_string()))?
        };
        registry.announce(&[id], Vec::new());
        saved
    }

    /// `bots/delete`: the bot's folder goes to `trash/bots/`, its conversation to the trash.
    pub async fn bots_delete(&self, id: &str) -> Result<(), RpcError> {
        let registry = self.bots().clone();
        if registry.with_bot(id, |bot| bot.file.default)? {
            return Err(errors::bot_default("the default bot cannot be deleted"));
        }
        let session = registry.with_bot(id, |bot| bot.file.session_id.take())?;
        self.0.routines.bot_deleted(id).await;
        self.drop_conversation(session).await?;
        let (home, dir_id) = (self.0.home.clone(), id.to_string());
        tokio::task::spawn_blocking(move || {
            // Ids are never reused, so its name there is free.
            let trash = home.root().join("trash").join("bots");
            std::fs::create_dir_all(&trash)?;
            std::fs::rename(home.bot_dir(&dir_id), trash.join(&dir_id))
        })
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?
        .map_err(|e| RpcError::internal(format!("cannot move the bot to the trash: {e}")))?;
        registry.with(|bots| bots.remove(id));
        registry.announce(&[], vec![id.to_string()]);
        Ok(())
    }

    /// A conversation's settings, loading it if need be. A log that will not load is no reason to
    /// keep it: clearing goes on, and the next conversation starts on the defaults.
    async fn conversation_settings(&self, session: &str) -> Option<SessionInfo> {
        self.load_session(session, ResumeOverrides::default(), None).await.ok()?;
        self.info(session).await.ok()
    }

    /// Closes a bot's conversation, waiting for its log, and moves the log to the trash.
    async fn drop_conversation(&self, session: Option<String>) -> Result<(), RpcError> {
        let Some(session) = session else {
            return Ok(());
        };
        if self.is_loaded(&session) {
            self.close_session(&session).await?;
        }
        let server = self.clone();
        tokio::task::spawn_blocking(move || match server.trash_log(&session) {
            Err(err) if err.data.as_ref().and_then(|d| d.get("kind")).and_then(|k| k.as_str()) == Some("session_not_found") => Ok(()),
            other => other,
        })
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?
    }
}

fn new_file(name: String, avatar: Avatar, default: bool) -> BotFile {
    BotFile {
        version: 2,
        id: uuid::Uuid::now_v7().to_string(),
        name,
        avatar,
        default,
        pinned: false,
        muted: false,
        created_at: list::now(),
        session_id: None,
        model: None,
        thinking: None,
        permission_mode: None,
        summary: Kept::default(),
        source: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> (tempfile::TempDir, FinxHome) {
        let dir = tempfile::tempdir().unwrap();
        let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
        home.ensure().unwrap();
        (dir, home)
    }

    fn bot_file(id: &str, version: u32) -> serde_json::Value {
        serde_json::json!({
            "version": version,
            "id": id,
            "name": "FinxBot",
            "avatar": { "kind": "char", "shape": "tall", "hue": "slate" },
            "default": true,
            "pinned": false,
            "muted": false,
            "created_at": "2026-11-14T00:00:00Z",
            "summary": { "unread": 0 }
        })
    }

    #[test]
    fn a_version_one_bot_reads_and_upgrades_to_version_two() {
        let (_dir, home) = home();
        let id = "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
        let dir = home.bot_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bot.json"), serde_json::to_vec(&bot_file(id, 1)).unwrap()).unwrap();

        let bots = read_all(&home);
        let bot = bots.get(id).expect("the version 1 bot reads");
        assert_eq!(bot.file.version, 2, "it is upgraded in memory");
        assert!(bot.file.source.is_none(), "a version 1 bot is a local bot");
        assert!(bot.summary(None).source.is_none());
        assert!(bot.summary(None).default, "nothing else about it changes");
    }

    #[test]
    fn an_external_bots_source_is_kept_and_shown() {
        let (_dir, home) = home();
        let id = "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
        let dir = home.bot_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        let mut file = bot_file(id, 2);
        file["default"] = serde_json::json!(false);
        file["name"] = serde_json::json!("某医院预约助手");
        file["source"] = serde_json::json!({
            "kind": "remote", "protocol": "a2a",
            "card_url": "https://example-hospital.cn/.well-known/agent-card.json",
            "endpoint": "https://example-hospital.cn/a2a",
            "host": "example-hospital.cn",
            "card_sha256": "abc",
            "card_read_at": "2026-11-14T12:00:00Z",
            "description": "查询科室排班",
            "provider": "某某医院",
            "skills": [{ "name": "查排班", "description": "按日期查" }],
            "accepts": ["text"],
            "auth": "api_key",
            "noticed": false
        });
        std::fs::write(dir.join("bot.json"), serde_json::to_vec(&file).unwrap()).unwrap();

        let bots = read_all(&home);
        let bot = bots.get(id).expect("the external bot reads");
        let source = bot.file.source.as_ref().expect("its source");
        assert_eq!(source.host, "example-hospital.cn");
        assert_eq!(source.auth, BotAuth::ApiKey);
        let view = bot.summary(None).source.expect("the list shows it");
        assert_eq!(view.host, "example-hospital.cn");
        assert_eq!(view.provider.as_deref(), Some("某某医院"));
        assert_eq!(view.accepts, vec![BotAccept::Text]);
        assert!(!view.noticed);
        assert!(view.needs_review.is_none());
    }
}
