//! A2A's JSON-RPC binding (docs/kernel/bot-contacts-design.md §5.1, §5.4, §5.5): one POST per
//! call, server-sent events for a stream, polling when the other side does not stream.

use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use eventsource_stream::Event;
use eventsource_stream::EventStreamError;
use eventsource_stream::Eventsource;
use finx_core::PeerError;
use finx_core::PeerEvent;
use finx_core::PeerImage;
use finx_core::PeerMessage;
use finx_core::PeerThread;
use futures::Stream;
use futures::StreamExt;
use futures::channel::mpsc::UnboundedSender;
use futures::stream::BoxStream;
use reqwest::Url;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::events::Assembler;
use crate::events::error_message;
use crate::events::error_reason;
use crate::net;

const A2A_VERSION: &str = "1.0";
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const RESUME_ATTEMPTS: u32 = 3;

/// Where one bot answers and, when the card names one, the tenant to put in each request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub url: String,
    pub tenant: Option<String>,
}

/// How the other side takes a credential. It only ever goes to the endpoint it was added for.
#[derive(Clone, PartialEq, Eq)]
pub enum Auth {
    None,
    ApiKey { header: String, value: String },
    Bearer { token: String },
    Basic { username: String, password: String },
}

impl Auth {
    /// The scheme name the card and the bot settings speak in.
    pub fn scheme(&self) -> &'static str {
        match self {
            Auth::None => "none",
            Auth::ApiKey { .. } => "api_key",
            Auth::Bearer { .. } => "bearer",
            Auth::Basic { .. } => "basic",
        }
    }

    fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Auth::None => request,
            Auth::ApiKey { header, value } if !value.is_empty() => {
                match reqwest::header::HeaderName::from_bytes(header.as_bytes()) {
                    Ok(header) => request.header(header, value),
                    Err(_) => request,
                }
            }
            Auth::Bearer { token } if !token.is_empty() => request.bearer_auth(token),
            Auth::Basic { username, password } if !username.is_empty() => {
                request.basic_auth(username, Some(password))
            }
            _ => request,
        }
    }
}

impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::None => f.write_str("None"),
            Auth::ApiKey { header, .. } => f
                .debug_struct("ApiKey")
                .field("header", header)
                .field("value", &"<redacted>")
                .finish(),
            Auth::Bearer { .. } => f
                .debug_struct("Bearer")
                .field("token", &"<redacted>")
                .finish(),
            Auth::Basic { username, .. } => f
                .debug_struct("Basic")
                .field("username", username)
                .field("password", &"<redacted>")
                .finish(),
        }
    }
}

/// What a client may do besides the card's own limits.
#[derive(Clone, Debug, Default)]
pub struct ClientOptions {
    /// The development switch for an A2A service on this machine.
    pub allow_local: bool,
}

/// Why a call to the other side failed.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("the other side needs a credential again: {0}")]
    Auth(String),
    #[error("the other side no longer has this task: {0}")]
    Gone(String),
    #[error("{message}")]
    Http {
        status: Option<u16>,
        message: String,
    },
    #[error("{message}")]
    JsonRpc { reason: String, message: String },
    #[error("{0}")]
    Protocol(String),
    #[error("the request was cancelled")]
    Cancelled,
}

impl ClientError {
    fn body(error: net::BodyError) -> Self {
        match error {
            net::BodyError::TooLarge(_) => ClientError::Protocol(error.to_string()),
            net::BodyError::Transport(message) => ClientError::Http { status: None, message },
        }
    }

    fn http(error: impl fmt::Display) -> Self {
        ClientError::Http {
            status: None,
            message: error.to_string(),
        }
    }
}

/// The JSON-RPC client for one endpoint. Cheap to clone; clones share the HTTP connection pool.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    endpoint: Endpoint,
    auth: Auth,
    url: Url,
    next_id: AtomicI64,
}

type SseStream =
    Pin<Box<dyn Stream<Item = Result<Event, EventStreamError<net::BodyError>>> + Send>>;

/// The most one round's stream may read, counting the base64 overhead: several files of the
/// largest size (§5.3) still fit.
const SSE_MAX: u64 = 320 * 1024 * 1024;
/// The most a whole (non-streamed) answer may read.
const JSON_MAX: u64 = 80 * 1024 * 1024;
/// An error's words are short; anything beyond this is ignored.
const ERROR_MAX: u64 = 64 * 1024;

enum Reply {
    Sse(SseStream),
    Json(Value),
}

impl Client {
    pub fn new(
        endpoint: Endpoint,
        auth: Auth,
        options: ClientOptions,
    ) -> Result<Self, ClientError> {
        let url = Url::parse(&endpoint.url)
            .map_err(|e| ClientError::Protocol(format!("the endpoint is not a URL: {e}")))?;
        net::check_url(&url, options.allow_local).map_err(ClientError::Protocol)?;
        let no_proxy = options.allow_local && url.host_str().is_some_and(net::is_loopback_host);
        let http = net::client(options.allow_local, no_proxy).map_err(ClientError::Protocol)?;
        Ok(Client {
            inner: Arc::new(Inner {
                http,
                endpoint,
                auth,
                url,
                next_id: AtomicI64::new(1),
            }),
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.inner.endpoint
    }

    /// Sends one message and gives this round's events. A server without streaming is sent
    /// `SendMessage` instead, and a task that is not finished yet is polled.
    pub async fn send(
        &self,
        message: PeerMessage,
        thread: PeerThread,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, ClientError> {
        let params = self.message_params(message, &thread);
        let reply = self.send_message(&params, &cancel).await?;
        let (tx, rx) = futures::channel::mpsc::unbounded();
        let client = self.clone();
        let worker_cancel = cancel.clone();
        tokio::spawn(async move {
            match reply {
                Reply::Sse(stream) => {
                    pump_sse(stream, Assembler::default(), tx, worker_cancel).await
                }
                Reply::Json(value) => {
                    let mut assembler = Assembler::default();
                    if !send_events(&tx, assembler.apply(&value)) {
                        return;
                    }
                    if assembler.is_terminal() {
                        let _ = send_events(&tx, assembler.finish());
                        return;
                    }
                    let Some(task_id) = assembler.thread().task_id.clone() else {
                        let _ = tx.unbounded_send(PeerEvent::Failed(
                            PeerError::new(
                                "bot_peer_failed",
                                "the other side accepted the message without a task",
                            )
                            .retryable(),
                        ));
                        return;
                    };
                    poll_task(&client, task_id, assembler, tx, worker_cancel).await;
                }
            }
        });
        Ok(Box::pin(rx))
    }

    /// Picks up a task that has not ended. If it ended while this side was away, the result is
    /// replayed through the assembler; otherwise the task is subscribed to.
    pub async fn resume(
        &self,
        thread: PeerThread,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, PeerEvent>, ClientError> {
        let Some(task_id) = thread.task_id.clone() else {
            return Err(ClientError::Protocol("there is no task to resume".into()));
        };
        let mut attempts = 0;
        loop {
            attempts += 1;
            let params = self.task_params(&task_id);
            let reply = tokio::select! {
                _ = cancel.cancelled() => return Err(ClientError::Cancelled),
                reply = self.rpc("GetTask", params) => reply?,
            };
            let Reply::Json(value) = reply else {
                return Err(ClientError::Protocol(
                    "GetTask answered with a stream".into(),
                ));
            };
            let mut assembler = Assembler::default();
            let mut initial = assembler.apply(&value);
            if assembler.is_terminal() {
                initial.extend(assembler.finish());
                return Ok(Box::pin(futures::stream::iter(initial)));
            }
            let params = self.task_params(&task_id);
            let subscribe = tokio::select! {
                _ = cancel.cancelled() => return Err(ClientError::Cancelled),
                reply = self.rpc("SubscribeToTask", params) => reply,
            };
            match subscribe {
                Ok(Reply::Sse(stream)) => {
                    let (tx, rx) = futures::channel::mpsc::unbounded();
                    if !send_events(&tx, initial) {
                        return Ok(Box::pin(rx));
                    }
                    let worker_cancel = cancel.clone();
                    tokio::spawn(async move {
                        pump_sse(stream, assembler, tx, worker_cancel).await;
                    });
                    return Ok(Box::pin(rx));
                }
                Ok(Reply::Json(value)) => {
                    initial.extend(assembler.apply(&value));
                    if assembler.is_terminal() {
                        initial.extend(assembler.finish());
                        return Ok(Box::pin(futures::stream::iter(initial)));
                    }
                    let (tx, rx) = futures::channel::mpsc::unbounded();
                    if !send_events(&tx, initial) {
                        return Ok(Box::pin(rx));
                    }
                    let client = self.clone();
                    let worker_cancel = cancel.clone();
                    tokio::spawn(async move {
                        poll_task(&client, task_id, assembler, tx, worker_cancel).await;
                    });
                    return Ok(Box::pin(rx));
                }
                Err(error @ ClientError::Gone(_)) => return Err(error),
                Err(error) if attempts < RESUME_ATTEMPTS => {
                    tracing::debug!(%error, "could not subscribe to the task, looking again");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Asks the other side to stop. A task that cannot be cancelled or is already gone counts as
    /// stopped.
    pub async fn cancel(&self, thread: &PeerThread) -> Result<(), ClientError> {
        let Some(task_id) = thread.task_id.as_deref() else {
            return Ok(());
        };
        let params = self.task_params(task_id);
        match self.rpc("CancelTask", params).await {
            Ok(_) => Ok(()),
            Err(ClientError::JsonRpc { reason, .. })
                if matches!(reason.as_str(), "TASK_NOT_CANCELABLE" | "TASK_NOT_FOUND") =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn message_params(&self, message: PeerMessage, thread: &PeerThread) -> Value {
        let mut parts = Vec::with_capacity(1 + message.images.len());
        parts.push(json!({ "text": message.text }));
        for PeerImage { media_type, data } in message.images {
            parts.push(json!({ "raw": data, "mediaType": media_type }));
        }
        let mut body = json!({
            "messageId": message.id,
            "role": "ROLE_USER",
            "parts": parts,
        });
        if let Some(context_id) = thread.context_id.as_deref() {
            body["contextId"] = json!(context_id);
        }
        if let Some(task_id) = thread.task_id.as_deref() {
            body["taskId"] = json!(task_id);
        }
        let mut params = json!({ "message": body });
        self.add_tenant(&mut params);
        params
    }

    fn task_params(&self, task_id: &str) -> Value {
        let mut params = json!({ "id": task_id });
        self.add_tenant(&mut params);
        params
    }

    fn add_tenant(&self, params: &mut Value) {
        if let Some(tenant) = self.inner.endpoint.tenant.as_deref() {
            params["tenant"] = json!(tenant);
        }
    }

    /// Tries the streaming method, then the plain one. The card's `capabilities.streaming` is
    /// not carried into [`Endpoint`], so a server that refuses streaming is recognized by its
    /// answer instead of being asked up front.
    async fn send_message(
        &self,
        params: &Value,
        cancel: &CancellationToken,
    ) -> Result<Reply, ClientError> {
        let streaming = tokio::select! {
            _ = cancel.cancelled() => return Err(ClientError::Cancelled),
            reply = self.rpc("SendStreamingMessage", params.clone()) => reply,
        };
        match streaming {
            Ok(reply) => Ok(reply),
            Err(error) if streaming_unsupported(&error) => tokio::select! {
                _ = cancel.cancelled() => Err(ClientError::Cancelled),
                reply = self.rpc("SendMessage", params.clone()) => reply,
            },
            Err(error) => Err(error),
        }
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Reply, ClientError> {
        let response = self
            .request(method, params)
            .send()
            .await
            .map_err(ClientError::http)?;
        let status = response.status();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(ClientError::Auth(format!("HTTP {status}")));
        }
        if !status.is_success() {
            return Err(response_error(response).await);
        }
        if is_event_stream(&response) {
            Ok(Reply::Sse(Box::pin(net::body(response, SSE_MAX).eventsource())))
        } else {
            let bytes = net::read_body(response, JSON_MAX)
                .await
                .map_err(ClientError::body)?;
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|e| ClientError::Protocol(format!("the answer is not JSON: {e}")))?;
            if let Some(error) = value.get("error") {
                return Err(client_error_from_jsonrpc(error));
            }
            Ok(Reply::Json(value))
        }
    }

    fn request(&self, method: &str, params: Value) -> reqwest::RequestBuilder {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        // The URL is fixed for the life of the client, and redirects are only followed within
        // its origin, so a credential cannot be sent to another host.
        self.inner.auth.apply(
            self.inner
                .http
                .post(self.inner.url.clone())
                .header("A2A-Version", A2A_VERSION)
                .json(&body),
        )
    }
}

fn is_event_stream(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"))
}

async fn response_error(response: reqwest::Response) -> ClientError {
    let status = response.status().as_u16();
    let body = net::read_body(response, ERROR_MAX).await.unwrap_or_default();
    if let Ok(value) = serde_json::from_slice::<Value>(&body)
        && let Some(error) = value.get("error")
    {
        return client_error_from_jsonrpc(error);
    }
    ClientError::Http {
        status: Some(status),
        message: format!("the other side answered with HTTP {status}"),
    }
}

fn client_error_from_jsonrpc(error: &Value) -> ClientError {
    let reason = error_reason(error).unwrap_or_default();
    let message = error_message(error);
    match reason {
        "TASK_NOT_FOUND" => ClientError::Gone(message),
        "AUTH_REQUIRED" => ClientError::Auth(message),
        _ => ClientError::JsonRpc {
            reason: reason.to_string(),
            message,
        },
    }
}

fn streaming_unsupported(error: &ClientError) -> bool {
    match error {
        ClientError::JsonRpc { reason, .. } => {
            matches!(
                reason.as_str(),
                "UNSUPPORTED_OPERATION" | "STREAMING_NOT_SUPPORTED" | "METHOD_NOT_FOUND"
            )
        }
        ClientError::Http {
            status: Some(404 | 405),
            ..
        } => true,
        _ => false,
    }
}

fn send_events(tx: &UnboundedSender<PeerEvent>, events: Vec<PeerEvent>) -> bool {
    for event in events {
        if tx.unbounded_send(event).is_err() {
            return false;
        }
    }
    true
}

/// Reads one SSE stream to its terminal state. Cancelling stops it without touching the other
/// side's task; the caller sends `CancelTask` when it means to stop it.
async fn pump_sse(
    mut stream: SseStream,
    mut assembler: Assembler,
    tx: UnboundedSender<PeerEvent>,
    cancel: CancellationToken,
) {
    loop {
        let item = tokio::select! {
            _ = cancel.cancelled() => return,
            item = stream.next() => item,
        };
        match item {
            Some(Ok(event)) => {
                if !(event.event.is_empty() || event.event == "message")
                    || event.data.trim().is_empty()
                {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
                    tracing::debug!("ignored an A2A event that is not JSON");
                    continue;
                };
                if !send_events(&tx, assembler.apply(&value)) {
                    return;
                }
                if assembler.is_terminal() {
                    let _ = send_events(&tx, assembler.finish());
                    return;
                }
            }
            Some(Err(error)) => {
                tracing::debug!(%error, "the A2A event stream failed");
                let _ = tx.unbounded_send(PeerEvent::Failed(stream_failure(error)));
                return;
            }
            None => {
                // The stream ended without a terminal state: the caller resumes the task instead
                // of treating whatever arrived as the reply.
                let _ = tx.unbounded_send(PeerEvent::Failed(
                    PeerError::new(
                        "bot_peer_lost",
                        "the other side closed the stream before the task finished",
                    )
                    .retryable(),
                ));
                return;
            }
        }
    }
}

/// What a broken stream means: too much data ends the task (there is nothing to resume into),
/// while a lost connection is picked up again (§5.5).
fn stream_failure(error: EventStreamError<net::BodyError>) -> PeerError {
    match error {
        EventStreamError::Transport(net::BodyError::TooLarge(_)) => PeerError::new(
            "bot_peer_too_large",
            "the other side sent more than this side keeps",
        ),
        _ => PeerError::new("bot_peer_lost", "the connection to the other side was lost").retryable(),
    }
}

/// Polls a task that was accepted but not finished (a server without streaming, or a
/// `SendMessage` answer that is still working).
async fn poll_task(
    client: &Client,
    task_id: String,
    mut assembler: Assembler,
    tx: UnboundedSender<PeerEvent>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
        let params = client.task_params(&task_id);
        let reply = tokio::select! {
            _ = cancel.cancelled() => return,
            reply = client.rpc("GetTask", params) => reply,
        };
        match reply {
            Ok(Reply::Json(value)) => {
                if !send_events(&tx, assembler.apply(&value)) {
                    return;
                }
                if assembler.is_terminal() {
                    let _ = send_events(&tx, assembler.finish());
                    return;
                }
            }
            Ok(Reply::Sse(_)) => {
                let _ = tx.unbounded_send(PeerEvent::Failed(PeerError::new(
                    "bot_peer_failed",
                    "GetTask answered with a stream",
                )));
                return;
            }
            Err(error) => {
                let _ = tx.unbounded_send(PeerEvent::Failed(error.to_peer_error()));
                return;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::body_string_contains;
    use wiremock::matchers::header;
    use wiremock::matchers::method;

    #[test]
    fn too_much_data_ends_the_task_but_a_lost_connection_is_retried() {
        let too_large = stream_failure(EventStreamError::Transport(net::BodyError::TooLarge(
            SSE_MAX,
        )));
        assert_eq!(too_large.kind, "bot_peer_too_large");
        assert!(!too_large.retryable, "resuming into the same stream helps nothing");
        let lost = stream_failure(EventStreamError::Transport(net::BodyError::Transport(
            "reset".into(),
        )));
        assert_eq!(lost.kind, "bot_peer_lost");
        assert!(lost.retryable);
    }

    fn labels(events: &[PeerEvent]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                PeerEvent::Thread(thread) => {
                    format!("thread:{:?}/{:?}", thread.context_id, thread.task_id)
                }
                PeerEvent::Working => "working".to_string(),
                PeerEvent::Said { text } => format!("said:{text}"),
                PeerEvent::File { name, .. } => format!("file:{name}"),
                PeerEvent::Asked { text } => format!("asked:{text}"),
                PeerEvent::Done => "done".to_string(),
                PeerEvent::Failed(error) => format!("failed:{}", error.kind),
            })
            .collect()
    }

    async fn events(stream: BoxStream<'static, PeerEvent>) -> Vec<PeerEvent> {
        let mut stream = stream;
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            events.push(event);
        }
        events
    }

    fn client(server: &MockServer, auth: Auth) -> Client {
        Client::new(
            Endpoint {
                url: server.uri(),
                tenant: Some("tenant-1".to_string()),
            },
            auth,
            ClientOptions { allow_local: true },
        )
        .expect("client")
    }

    fn message() -> PeerMessage {
        PeerMessage {
            id: "m1".to_string(),
            text: "hello".to_string(),
            images: vec![PeerImage {
                media_type: "image/png".to_string(),
                data: "aGk=".to_string(),
            }],
        }
    }

    const ROUND: &str = concat!(
        "data: {\"result\":{\"task\":{\"id\":\"450d\",\"contextId\":\"19da\",\"status\":{\"state\":\"TASK_STATE_SUBMITTED\"}}},\"id\":\"t1\",\"jsonrpc\":\"2.0\"}\n\n",
        "data: {\"result\":{\"statusUpdate\":{\"taskId\":\"450d\",\"contextId\":\"19da\",\"status\":{\"state\":\"TASK_STATE_WORKING\"}}},\"id\":\"t1\",\"jsonrpc\":\"2.0\"}\n\n",
        "data: {\"result\":{\"artifactUpdate\":{\"taskId\":\"450d\",\"contextId\":\"19da\",\"artifact\":{\"artifactId\":\"a02f\",\"parts\":[{\"text\":\"收到\"}]}}},\"id\":\"t1\",\"jsonrpc\":\"2.0\"}\n\n",
        "data: {\"result\":{\"artifactUpdate\":{\"taskId\":\"450d\",\"contextId\":\"19da\",\"artifact\":{\"artifactId\":\"a02f\",\"parts\":[{\"text\":\"\"}]},\"append\":true,\"lastChunk\":true}},\"id\":\"t1\",\"jsonrpc\":\"2.0\"}\n\n",
        "data: {\"result\":{\"statusUpdate\":{\"taskId\":\"450d\",\"contextId\":\"19da\",\"status\":{\"state\":\"TASK_STATE_COMPLETED\",\"message\":{\"parts\":[{\"text\":\"收到\"}]}}}},\"id\":\"t1\",\"jsonrpc\":\"2.0\"}\n\n",
    );

    #[tokio::test]
    async fn sends_a_versioned_signed_request_and_reads_the_stream() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendStreamingMessage"))
            .and(body_string_contains("\"tenant\":\"tenant-1\""))
            .and(body_string_contains("\"messageId\":\"m1\""))
            .and(body_string_contains("\"role\":\"ROLE_USER\""))
            .and(body_string_contains("\"text\":\"hello\""))
            .and(header("A2A-Version", "1.0"))
            .and(header("X-API-Key", "secret"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(ROUND, "text/event-stream"))
            .mount(&server)
            .await;
        let client = client(
            &server,
            Auth::ApiKey {
                header: "X-API-Key".to_string(),
                value: "secret".to_string(),
            },
        );
        let stream = client
            .send(message(), PeerThread::default(), CancellationToken::new())
            .await
            .expect("send");
        assert_eq!(
            labels(&events(stream).await),
            [
                "thread:Some(\"19da\")/Some(\"450d\")",
                "working",
                "working",
                "said:收到",
                "done"
            ]
        );
    }

    #[tokio::test]
    async fn basic_sends_the_user_name_and_password() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            // base64("ann:pa:ss")
            .and(header("Authorization", "Basic YW5uOnBhOnNz"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(ROUND, "text/event-stream"))
            .mount(&server)
            .await;
        let client = client(
            &server,
            Auth::Basic {
                username: "ann".to_string(),
                password: "pa:ss".to_string(),
            },
        );
        let stream = client
            .send(message(), PeerThread::default(), CancellationToken::new())
            .await
            .expect("send");
        assert!(labels(&events(stream).await).contains(&"done".to_string()));
        assert!(!format!("{:?}", Auth::Basic { username: "ann".into(), password: "pa:ss".into() }).contains("pa:ss"));
    }

    #[tokio::test]
    async fn a_server_without_streaming_is_asked_plainly() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendStreamingMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "error": { "code": -32601, "message": "no streaming", "data": [{ "reason": "UNSUPPORTED_OPERATION" }] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 2,
                "result": { "task": {
                    "id": "task-1", "contextId": "ctx-1",
                    "status": { "state": "TASK_STATE_COMPLETED", "message": { "parts": [{ "text": "AB" }] } },
                    "artifacts": [{ "artifactId": "a", "parts": [{ "text": "A" }, { "text": "B" }] }]
                } }
            })))
            .mount(&server)
            .await;
        let client = client(&server, Auth::None);
        let stream = client
            .send(message(), PeerThread::default(), CancellationToken::new())
            .await
            .expect("send");
        assert_eq!(
            labels(&events(stream).await),
            ["thread:Some(\"ctx-1\")/Some(\"task-1\")", "said:AB", "done"]
        );
    }

    #[tokio::test]
    async fn an_unfinished_task_is_polled() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendStreamingMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "error": { "code": -32601, "message": "no streaming", "data": [{ "reason": "UNSUPPORTED_OPERATION" }] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 2,
                "result": { "task": {
                    "id": "task-1", "contextId": "ctx-1",
                    "status": { "state": "TASK_STATE_WORKING" }
                } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 3,
                "result": { "task": {
                    "id": "task-1", "contextId": "ctx-1",
                    "status": { "state": "TASK_STATE_COMPLETED", "message": { "parts": [{ "text": "done" }] } }
                } }
            })))
            .mount(&server)
            .await;
        let client = client(&server, Auth::None);
        let stream = client
            .send(message(), PeerThread::default(), CancellationToken::new())
            .await
            .expect("send");
        assert_eq!(
            labels(&events(stream).await),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "said:done",
                "done"
            ]
        );
    }

    #[tokio::test]
    async fn a_missing_task_is_gone_by_reason_not_by_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("SendStreamingMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "error": { "code": -32602, "message": "Task not found", "data": [{ "reason": "TASK_NOT_FOUND" }] }
            })))
            .mount(&server)
            .await;
        let client = client(&server, Auth::None);
        let error = client
            .send(message(), PeerThread::default(), CancellationToken::new())
            .await
            .err()
            .expect("must fail");
        assert!(matches!(error, ClientError::Gone(_)), "{error:?}");
    }

    #[tokio::test]
    async fn a_finished_task_is_replayed_on_resume() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "result": { "task": {
                    "id": "task-1", "contextId": "ctx-1",
                    "status": { "state": "TASK_STATE_COMPLETED", "message": { "parts": [{ "text": "finished" }] } }
                } }
            })))
            .mount(&server)
            .await;
        let client = client(&server, Auth::None);
        let thread = PeerThread {
            context_id: Some("ctx-1".to_string()),
            task_id: Some("task-1".to_string()),
            ..Default::default()
        };
        let stream = client
            .resume(thread, CancellationToken::new())
            .await
            .expect("resume");
        assert_eq!(
            labels(&events(stream).await),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "said:finished",
                "done"
            ]
        );
    }

    #[tokio::test]
    async fn cancelling_an_unfinished_task_that_cannot_be_cancelled_is_fine() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("CancelTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "error": { "code": -32002, "message": "Task cannot be cancelled", "data": [{ "reason": "TASK_NOT_CANCELABLE" }] }
            })))
            .mount(&server)
            .await;
        let client = client(&server, Auth::None);
        let thread = PeerThread {
            context_id: None,
            task_id: Some("task-1".to_string()),
            ..Default::default()
        };
        client.cancel(&thread).await.expect("cancel is best effort");
    }
}
