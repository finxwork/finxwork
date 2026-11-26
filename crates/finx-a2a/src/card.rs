//! Reading an external bot's agent card (docs/kernel/bot-contacts-design.md §5.2): find it, keep
//! the request inside the limits, pick the A2A 1.0 JSON-RPC interface, and hash what the bot is
//! so a later reading can tell whether it changed.

use std::fmt::Write as _;
use std::time::Duration;

use futures::StreamExt;
use reqwest::Url;
use serde_json::Map;
use serde_json::Value;

use crate::client::Auth;
use crate::client::Endpoint;
use crate::net;

const CARD_PATH: &str = "/.well-known/agent-card.json";
const MAX_CARD: usize = 256 * 1024;
const CARD_TIMEOUT: Duration = Duration::from_secs(10);

/// What the card reading may be allowed to do.
#[derive(Clone, Debug, Default)]
pub struct CardOptions {
    /// The development switch for an A2A service on this machine.
    pub allow_local: bool,
}

/// What the card says the bot takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accept {
    Text,
    Image,
}

/// One of the bot's skills, as the confirmation page shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
}

/// The parts of an agent card this version uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub name: String,
    pub description: String,
    /// `provider.organization`, when the card has one.
    pub provider: Option<String>,
    /// Kept as given; this crate does not download it.
    pub icon_url: Option<String>,
    pub endpoint: Endpoint,
    pub auth: Auth,
    pub accepts: Vec<Accept>,
    pub skills: Vec<Skill>,
    pub streaming: bool,
}

impl Card {
    /// Reads a card. The URL may be the card itself or any address on the bot's site; otherwise
    /// `/.well-known/agent-card.json` of its origin is read.
    pub async fn read(url: &str, options: &CardOptions) -> Result<Card, CardError> {
        let given = Url::parse(url)
            .map_err(|_| CardError::Unreachable("the address is not a URL".into()))?;
        net::check_url(&given, options.allow_local).map_err(CardError::Unreachable)?;
        let no_proxy = options.allow_local && given.host_str().is_some_and(net::is_loopback_host);
        let client = net::client(options.allow_local, no_proxy).map_err(CardError::Unreachable)?;
        let (value, card_url) = match fetch_json(&client, &given).await? {
            Some(value) => (value, given.clone()),
            None => {
                if given.path() == CARD_PATH {
                    return Err(CardError::Invalid(
                        "the address is the card's location but it is not a card".into(),
                    ));
                }
                let origin = origin(&given)?;
                let well_known = origin.join(CARD_PATH).map_err(|e| {
                    CardError::Unreachable(format!("the card address is not usable: {e}"))
                })?;
                net::check_url(&well_known, options.allow_local).map_err(CardError::Unreachable)?;
                match fetch_json(&client, &well_known).await? {
                    Some(value) => (value, well_known),
                    None => {
                        return Err(CardError::Unreachable(
                            "there is no agent card at this address".into(),
                        ));
                    }
                }
            }
        };
        parse_card(&value, &card_url)
    }

    /// SHA-256 over the fields this version uses, in a fixed order. A change to anything else on
    /// the card (its version, a skill's tags, the icon) does not change it.
    pub fn hash(card: &Card) -> String {
        #[derive(serde::Serialize)]
        struct Hashed<'a> {
            name: &'a str,
            description: &'a str,
            provider: &'a Option<String>,
            endpoint: &'a str,
            tenant: &'a Option<String>,
            auth: String,
            accepts: Vec<&'static str>,
            skills: Vec<HashedSkill<'a>>,
        }

        #[derive(serde::Serialize)]
        struct HashedSkill<'a> {
            name: &'a str,
            description: &'a str,
        }

        let hashed = Hashed {
            name: &card.name,
            description: &card.description,
            provider: &card.provider,
            endpoint: &card.endpoint.url,
            tenant: &card.endpoint.tenant,
            auth: match &card.auth {
                Auth::None => "none".to_string(),
                Auth::ApiKey { header, .. } => format!("api_key:{header}"),
                Auth::Bearer { .. } => "bearer".to_string(),
                Auth::Basic { .. } => "basic".to_string(),
            },
            accepts: card
                .accepts
                .iter()
                .map(|accept| match accept {
                    Accept::Text => "text",
                    Accept::Image => "image",
                })
                .collect(),
            skills: card
                .skills
                .iter()
                .map(|skill| HashedSkill {
                    name: &skill.name,
                    description: &skill.description,
                })
                .collect(),
        };
        let bytes = serde_json::to_vec(&hashed).unwrap_or_default();
        hex(ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref())
    }
}

/// Why a card could not be used.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CardError {
    #[error("cannot read the card at this address: {0}")]
    Unreachable(String),
    #[error("this is not a usable agent card: {0}")]
    Invalid(String),
    #[error("the card uses a way of connecting this version does not support: {0}")]
    Unsupported(String),
    #[error("the card points at another address: {0}")]
    Moved(String),
}

impl CardError {
    /// The service layer's error code.
    pub fn kind(&self) -> &'static str {
        match self {
            CardError::Unreachable(_) => "bot_card_unreachable",
            CardError::Invalid(_) => "bot_card_invalid",
            CardError::Unsupported(_) => "bot_card_unsupported",
            CardError::Moved(_) => "bot_card_moved",
        }
    }

    /// The interface host when the card points elsewhere.
    pub fn host(&self) -> Option<&str> {
        match self {
            CardError::Moved(host) => Some(host),
            _ => None,
        }
    }
}

async fn fetch_json(client: &reqwest::Client, url: &Url) -> Result<Option<Value>, CardError> {
    let response = client
        .get(url.clone())
        .timeout(CARD_TIMEOUT)
        .send()
        .await
        .map_err(|e| CardError::Unreachable(format!("{}: {e}", host_of(url))))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body = read_limited(response).await?;
    Ok(serde_json::from_slice(&body).ok())
}

async fn read_limited(response: reqwest::Response) -> Result<Vec<u8>, CardError> {
    let too_large = || CardError::Invalid("the card is larger than 256 KB".to_string());
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CARD as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| CardError::Unreachable(format!("the card was cut off: {e}")))?;
        if body.len() + chunk.len() > MAX_CARD {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_card(value: &Value, card_url: &Url) -> Result<Card, CardError> {
    let object = value
        .as_object()
        .ok_or_else(|| CardError::Invalid("the card is not a JSON object".to_string()))?;
    let name = required_string(object, "name")?;
    if name.trim().is_empty() {
        return Err(CardError::Invalid("the card has no name".to_string()));
    }
    let description = required_string(object, "description")?;
    // Required by the protocol and useful for detecting a different card, but not shown here.
    let _version = required_string(object, "version")?;
    let provider = match object.get("provider") {
        None | Some(Value::Null) => None,
        Some(provider) => {
            let organization = provider
                .get("organization")
                .and_then(Value::as_str)
                .filter(|organization| !organization.is_empty())
                .ok_or_else(|| {
                    CardError::Invalid("the provider has no organization".to_string())
                })?;
            Some(organization.to_string())
        }
    };
    let icon_url = object
        .get("iconUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .map(str::to_string);
    let streaming = object
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("streaming"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let accepts = input_modes(object)?;
    let auth = parse_auth(object)?;
    let endpoint = parse_endpoint(object, card_url)?;
    let skills = parse_skills(object)?;
    Ok(Card {
        name,
        description,
        provider,
        icon_url,
        endpoint,
        auth,
        accepts,
        skills,
        streaming,
    })
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, CardError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CardError::Invalid(format!("the card has no {key}")))
}

fn input_modes(object: &Map<String, Value>) -> Result<Vec<Accept>, CardError> {
    let modes = match object.get("defaultInputModes") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => value
            .as_array()
            .ok_or_else(|| CardError::Invalid("defaultInputModes is not a list".to_string()))?
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
    };
    let mut accepts = Vec::new();
    if modes.iter().any(|mode| mode.starts_with("text/")) {
        accepts.push(Accept::Text);
    }
    if modes.iter().any(|mode| mode.starts_with("image/")) {
        accepts.push(Accept::Image);
    }
    if !accepts.contains(&Accept::Text) {
        return Err(CardError::Unsupported(
            "the bot does not accept text".to_string(),
        ));
    }
    Ok(accepts)
}

fn parse_auth(object: &Map<String, Value>) -> Result<Auth, CardError> {
    let requirements = match object.get("securityRequirements") {
        None | Some(Value::Null) => return Ok(Auth::None),
        Some(value) => value
            .as_array()
            .ok_or_else(|| CardError::Invalid("securityRequirements is not a list".to_string()))?,
    };
    if requirements.is_empty() {
        return Ok(Auth::None);
    }
    let schemes =
        match object.get("securitySchemes") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_object().ok_or_else(|| {
                CardError::Invalid("securitySchemes is not an object".to_string())
            })?),
        };
    for requirement in requirements {
        let schemes_in_requirement = requirement
            .get("schemes")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                CardError::Invalid("a security requirement has no schemes".to_string())
            })?;
        // An empty requirement is the protocol's way of saying a credential is optional.
        if schemes_in_requirement.is_empty() {
            return Ok(Auth::None);
        }
        // One requirement with several schemes asks for all of them; one credential cannot do
        // that, so this alternative is skipped.
        if schemes_in_requirement.len() != 1 {
            continue;
        }
        let Some((scheme_name, _)) = schemes_in_requirement.iter().next() else {
            continue;
        };
        let schemes = schemes.ok_or_else(|| {
            CardError::Invalid(format!("securitySchemes does not define {scheme_name}"))
        })?;
        let scheme = schemes.get(scheme_name).ok_or_else(|| {
            CardError::Invalid(format!("securitySchemes does not define {scheme_name}"))
        })?;
        if let Some(auth) = parse_scheme(scheme)? {
            return Ok(auth);
        }
    }
    Err(CardError::Unsupported(
        "the card's credential scheme is not supported".to_string(),
    ))
}

fn parse_scheme(scheme: &Value) -> Result<Option<Auth>, CardError> {
    if let Some(api_key) = scheme.get("apiKeySecurityScheme") {
        let location = api_key
            .get("location")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = api_key
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if location == "header" && !name.is_empty() {
            return Ok(Some(Auth::ApiKey {
                header: name.to_string(),
                value: String::new(),
            }));
        }
        return Ok(None);
    }
    if let Some(http) = scheme.get("httpAuthSecurityScheme") {
        let name = http
            .get("scheme")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if name.eq_ignore_ascii_case("bearer") {
            return Ok(Some(Auth::Bearer {
                token: String::new(),
            }));
        }
        // Basic sends the password with every request; the endpoint is HTTPS (or this
        // machine) by `net::check_url`, so it never travels in the clear.
        if name.eq_ignore_ascii_case("basic") {
            return Ok(Some(Auth::Basic {
                username: String::new(),
                password: String::new(),
            }));
        }
        return Ok(None);
    }
    // OAuth2, OpenID Connect, mutual TLS, other HTTP schemes (Digest…): not in this version.
    Ok(None)
}

fn parse_endpoint(object: &Map<String, Value>, card_url: &Url) -> Result<Endpoint, CardError> {
    let interfaces = object
        .get("supportedInterfaces")
        .and_then(Value::as_array)
        .ok_or_else(|| CardError::Invalid("the card has no supportedInterfaces".to_string()))?;
    let interface = interfaces
        .iter()
        .find(|interface| {
            interface.get("protocolBinding").and_then(Value::as_str) == Some("JSONRPC")
                && interface.get("protocolVersion").and_then(Value::as_str) == Some("1.0")
        })
        .ok_or_else(|| {
            CardError::Unsupported("the card offers no A2A 1.0 JSON-RPC interface".to_string())
        })?;
    let raw = interface
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| CardError::Invalid("the interface has no URL".to_string()))?;
    let url = Url::parse(raw)
        .map_err(|e| CardError::Invalid(format!("the interface URL is not a URL: {e}")))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(CardError::Invalid(
            "the interface is not an HTTP address".to_string(),
        ));
    }
    let same_origin = url.scheme() == card_url.scheme()
        && url.host_str().map(str::to_ascii_lowercase)
            == card_url.host_str().map(str::to_ascii_lowercase)
        && url.port_or_known_default() == card_url.port_or_known_default();
    if !same_origin {
        return Err(CardError::Moved(host_of(&url)));
    }
    let tenant = interface
        .get("tenant")
        .and_then(Value::as_str)
        .filter(|tenant| !tenant.is_empty())
        .map(str::to_string);
    Ok(Endpoint {
        url: url.to_string(),
        tenant,
    })
}

fn parse_skills(object: &Map<String, Value>) -> Result<Vec<Skill>, CardError> {
    let Some(skills) = object.get("skills") else {
        return Ok(Vec::new());
    };
    let skills = skills
        .as_array()
        .ok_or_else(|| CardError::Invalid("skills is not a list".to_string()))?;
    let mut out = Vec::with_capacity(skills.len());
    for skill in skills {
        let skill = skill
            .as_object()
            .ok_or_else(|| CardError::Invalid("a skill is not an object".to_string()))?;
        let name = required_string(skill, "name")?;
        let description = required_string(skill, "description")?;
        out.push(Skill { name, description });
    }
    Ok(out)
}

fn origin(url: &Url) -> Result<Url, CardError> {
    let mut origin = url.clone();
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    Ok(origin)
}

fn host_of(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => String::new(),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::method;
    use wiremock::matchers::path;

    fn card_json(interface: &str) -> Value {
        json!({
            "name": "Example Bot",
            "description": "Answers questions.",
            "version": "1.2.0",
            "iconUrl": "https://example.com/icon.png",
            "provider": { "organization": "Example Inc", "url": "https://example.com" },
            "supportedInterfaces": [{
                "url": interface,
                "protocolBinding": "JSONRPC",
                "protocolVersion": "1.0",
                "tenant": "tenant-1"
            }],
            "capabilities": { "streaming": true },
            "defaultInputModes": ["text/plain", "image/png"],
            "defaultOutputModes": ["text/plain"],
            "skills": [{ "id": "s1", "name": "Answer", "description": "Answers a question.", "tags": ["chat"] }],
            "securitySchemes": {
                "key": { "apiKeySecurityScheme": { "location": "header", "name": "X-API-Key" } }
            },
            "securityRequirements": [{ "schemes": { "key": { "list": [] } } }]
        })
    }

    #[tokio::test]
    async fn reads_a_card_from_the_link_itself() {
        let server = MockServer::start().await;
        let interface = format!("{}/a2a", server.uri());
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(card_json(&interface)))
            .mount(&server)
            .await;
        let card = Card::read(
            &format!("{}/", server.uri()),
            &CardOptions { allow_local: true },
        )
        .await
        .expect("card");
        assert_eq!(card.name, "Example Bot");
        assert_eq!(card.endpoint.tenant.as_deref(), Some("tenant-1"));
        assert_eq!(card.accepts, [Accept::Text, Accept::Image]);
        assert!(card.streaming);
        assert_eq!(
            card.auth,
            Auth::ApiKey {
                header: "X-API-Key".to_string(),
                value: String::new()
            }
        );
        assert_eq!(card.skills[0].name, "Answer");
    }

    #[tokio::test]
    async fn falls_back_to_the_well_known_path() {
        let server = MockServer::start().await;
        let interface = format!("{}/a2a", server.uri());
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_raw("<html></html>", "text/html"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/.well-known/agent-card.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(card_json(&interface)))
            .mount(&server)
            .await;
        let card = Card::read(&server.uri(), &CardOptions { allow_local: true })
            .await
            .expect("card");
        assert_eq!(card.endpoint.url, interface);
    }

    #[tokio::test]
    async fn an_ip_literal_is_refused_unless_local_is_allowed() {
        let server = MockServer::start().await;
        let error = Card::read(&server.uri(), &CardOptions::default())
            .await
            .expect_err("must refuse");
        assert_eq!(error.kind(), "bot_card_unreachable");
    }

    #[tokio::test]
    async fn an_interface_on_another_origin_is_moved() {
        let server = MockServer::start().await;
        let card = card_json("https://other.example/a2a");
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(card))
            .mount(&server)
            .await;
        let error = Card::read(
            &format!("{}/", server.uri()),
            &CardOptions { allow_local: true },
        )
        .await
        .expect_err("moved");
        assert_eq!(error.kind(), "bot_card_moved");
        assert_eq!(error.host(), Some("other.example"));
    }

    #[tokio::test]
    async fn an_oauth_card_is_unsupported() {
        let server = MockServer::start().await;
        let mut card = card_json(&format!("{}/a2a", server.uri()));
        card["securitySchemes"] = json!({ "oauth": { "oauth2SecurityScheme": { "flows": {} } } });
        card["securityRequirements"] = json!([{ "schemes": { "oauth": { "list": [] } } }]);
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(card))
            .mount(&server)
            .await;
        let error = Card::read(
            &format!("{}/", server.uri()),
            &CardOptions { allow_local: true },
        )
        .await
        .expect_err("unsupported");
        assert_eq!(error.kind(), "bot_card_unsupported");
    }

    #[test]
    fn a_basic_card_asks_for_a_user_name_and_a_password() {
        let card_url = Url::parse("https://example.com/.well-known/agent-card.json").expect("URL");
        let mut card = card_json("https://example.com/a2a");
        card["securitySchemes"] = json!({ "pw": { "httpAuthSecurityScheme": { "scheme": "Basic" } } });
        card["securityRequirements"] = json!([{ "schemes": { "pw": { "list": [] } } }]);
        let card = parse_card(&card, &card_url).expect("card");
        assert_eq!(card.auth.scheme(), "basic");
        let mut digest = card_json("https://example.com/a2a");
        digest["securitySchemes"] = json!({ "d": { "httpAuthSecurityScheme": { "scheme": "digest" } } });
        digest["securityRequirements"] = json!([{ "schemes": { "d": { "list": [] } } }]);
        assert_eq!(parse_card(&digest, &card_url).expect_err("digest").kind(), "bot_card_unsupported");
    }

    #[test]
    fn the_hash_ignores_what_this_version_does_not_use() {
        let card_url = Url::parse("https://example.com/.well-known/agent-card.json").expect("URL");
        let first = card_json("https://example.com/a2a");
        let mut second = first.clone();
        second["version"] = json!("9.9.9");
        second["skills"][0]["tags"] = json!(["other"]);
        second["iconUrl"] = json!("https://example.com/other.png");
        let first = parse_card(&first, &card_url).expect("card");
        let second = parse_card(&second, &card_url).expect("card");
        assert_eq!(Card::hash(&first), Card::hash(&second));

        let mut changed = card_json("https://example.com/a2a");
        changed["description"] = json!("Answers other questions.");
        let changed = parse_card(&changed, &card_url).expect("card");
        assert_ne!(Card::hash(&first), Card::hash(&changed));
    }
}

/// The card's icon, downloaded with the same limits as the card itself and kept only when it is
/// a PNG (§5.2). `None` when there is none, or it cannot be used: a bot simply has no icon.
pub async fn icon(card: &Card, options: &CardOptions) -> Option<Vec<u8>> {
    const ICON_MAX: u64 = 1024 * 1024;
    let url = reqwest::Url::parse(card.icon_url.as_deref()?).ok()?;
    net::check_url(&url, options.allow_local).ok()?;
    let http = net::client(options.allow_local, url.host_str().is_some_and(net::is_loopback_host)).ok()?;
    let response = http.get(url).send().await.ok()?.error_for_status().ok()?;
    let bytes = net::read_body(response, ICON_MAX).await.ok()?;
    bytes.starts_with(b"\x89PNG\r\n\x1a\n").then_some(bytes)
}
