//! WorkBuddy China desktop connection. Its login is read-only and refreshed by
//! WorkBuddy itself. Protocol checked against the installed desktop 5.11.3.
use crate::{
    ConnectionError, Result,
    adapter::ProductAdapter,
    platform::{Environment, Login, digest},
};
use async_trait::async_trait;
use finx_llm::{Credentials, ThinkingLevel, connection::Authorization};
use finx_protocol::api::ConnectionModel;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

#[cfg(test)]
mod tests;
mod transport;

pub(crate) const BASE: &str = "https://www.workbuddy.cn/v2";

// Intentionally no Debug. This payload remains in memory; no refresh token is read.
#[derive(Serialize, Deserialize)]
struct Session {
    uid: String,
    access: String,
    domain: String,
}

pub(crate) fn source_login(value: &Value) -> Result<Login> {
    let field = |v: &Value, key: &str| {
        v[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| ConnectionError::format("source_login", key))
    };
    let uid = field(&value["account"], "uid")?;
    if value["account"]["enterpriseId"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return Err(ConnectionError::new(
            "unsupported_account",
            "当前 WorkBuddy 连接仅支持中国版个人账户",
        ));
    }
    let domain = field(&value["auth"], "domain")?;
    if ![
        "www.workbuddy.cn",
        "copilot.tencent.com",
        "www.codebuddy.cn",
    ]
    .contains(&domain.as_str())
    {
        return Err(ConnectionError::new(
            "unsupported_endpoint",
            "此 WorkBuddy 登录域名暂不支持",
        ));
    }
    let access = field(&value["auth"], "accessToken")?;
    if reqwest::header::HeaderValue::from_str(&access).is_err()
        || reqwest::header::HeaderValue::from_str(&uid).is_err()
    {
        return Err(ConnectionError::format("source_login", "accessToken/uid"));
    }
    let expires = value["auth"]["expiresAt"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| ConnectionError::format("source_login", "expiresAt"))?;
    Ok(Login {
        identity: digest(format!("workbuddy-cn:{uid}").as_bytes()),
        subject: Some("WorkBuddy".into()),
        token: serde_json::to_string(&Session {
            uid,
            access,
            domain,
        })
        .map_err(|_| ConnectionError::unsupported())?,
        expires,
    })
}

pub(crate) struct WorkBuddy {
    identity: String,
    env: Arc<dyn Environment>,
    #[cfg(test)]
    endpoint: String,
}
impl WorkBuddy {
    pub(crate) fn new(identity: String, env: Arc<dyn Environment>) -> Self {
        Self {
            identity,
            env,
            #[cfg(test)]
            endpoint: "https://www.workbuddy.cn".into(),
        }
    }
    fn endpoint(&self) -> &str {
        #[cfg(test)]
        {
            &self.endpoint
        }
        #[cfg(not(test))]
        {
            "https://www.workbuddy.cn"
        }
    }
    async fn credentials(&self) -> Result<Credentials> {
        let login = self.env.login().await?;
        if login.identity != self.identity {
            return Err(ConnectionError::new(
                "identity_changed",
                "WorkBuddy 账户已切换，请移除旧连接后重新连接",
            ));
        }
        if login.expires <= self.env.now() {
            return Err(ConnectionError::login());
        }
        let session: Session =
            serde_json::from_str(&login.token).map_err(|_| ConnectionError::unsupported())?;
        let mut headers = self.env.headers().await?;
        headers.insert("X-User-Id".into(), session.uid);
        headers.insert("X-Domain".into(), session.domain);
        Ok(Credentials {
            api_key: Some(session.access),
            headers,
        })
    }
}

#[async_trait]
impl ProductAdapter for WorkBuddy {
    async fn catalog(&mut self, http: &reqwest::Client) -> Result<Vec<ConnectionModel>> {
        let credentials = self.credentials().await?;
        let mut request = http
            .get(format!("{}/v3/config", self.endpoint()))
            .timeout(Duration::from_secs(30))
            .bearer_auth(credentials.api_key.unwrap_or_default());
        for (name, value) in credentials.headers {
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .map_err(|e| ConnectionError::network(&e, "catalog"))?;
        let status = response.status().as_u16();
        if status != 200 {
            let mut error = match status {
                401 => ConnectionError::login(),
                403 => ConnectionError::new(
                    "permission_denied",
                    "WorkBuddy 拒绝访问模型目录，请在来源应用检查账户",
                ),
                429 => ConnectionError::new("rate_limited", "WorkBuddy 请求过于频繁，请稍后重试"),
                _ => ConnectionError::new("service_unavailable", "WorkBuddy 模型目录暂时不可用"),
            }
            .at("catalog");
            error.http_status = Some(status);
            return Err(error);
        }
        // A config contains no credentials; still bound it before parsing.
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| ConnectionError::network(&e, "catalog"))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(ConnectionError::format("catalog", "size"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ConnectionError::format("catalog", "json"))?;
        if body["code"].as_i64() != Some(0) {
            return Err(
                ConnectionError::new("catalog_rejected", "WorkBuddy 拒绝了模型目录请求")
                    .at("catalog"),
            );
        }
        catalog(&body["data"])
    }
    async fn authorize(
        &mut self,
        _http: &reqwest::Client,
        _rejected: bool,
    ) -> Result<Authorization> {
        // Re-read on every authorization, including the one retry after a 401.
        // WorkBuddy owns refresh rotation; never renew or overwrite its session.
        Ok(Authorization {
            base_url: format!("{}/v2", self.endpoint()),
            credentials: self.credentials().await?,
            transport: Some(Arc::new(transport::Http)),
        })
    }
}

fn catalog(config: &Value) -> Result<Vec<ConnectionModel>> {
    let entries = config["models"]
        .as_array()
        .ok_or_else(|| ConnectionError::format("catalog", "models"))?;
    let ids = config["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == "cli"))
        .and_then(|a| a["models"].as_array())
        .ok_or_else(|| ConnectionError::format("catalog", "agents.cli.models"))?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for id in ids.iter().filter_map(Value::as_str) {
        if !crate::valid_id(id) || !seen.insert(id) {
            continue;
        }
        let Some(m) = entries.iter().find(|m| m["id"] == id) else {
            continue;
        };
        // Only the chat-completions tool-capable catalog; no custom URLs, image
        // generation, or unverified Claude Messages routes.
        if m["supportsToolCall"] != true || id.starts_with("claude-") {
            continue;
        }
        let r = &m["reasoning"];
        let mut thinking: Vec<ThinkingLevel> = r["supportedEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|s| s.parse::<ThinkingLevel>().ok())
            .filter(|l| l.is_effort())
            .collect();
        let default = r["defaultEffort"]
            .as_str()
            .or_else(|| r["effort"].as_str())
            .and_then(|s| s.parse::<ThinkingLevel>().ok())
            .filter(|l| l.is_effort());
        if thinking.is_empty() {
            thinking.extend(default);
        }
        if m["supportsReasoning"] != true {
            thinking.clear();
        }
        if !thinking.is_empty() && m["onlyReasoning"] != true && r["canDisableThinking"] == true {
            thinking.insert(0, ThinkingLevel::Off);
        }
        let default_thinking = default
            .filter(|v| thinking.contains(v))
            .unwrap_or(ThinkingLevel::Default);
        let limit = |key: &str| {
            m[key]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
        };
        out.push(ConnectionModel {
            id: id.into(),
            name: m["name"].as_str().unwrap_or(id).into(),
            names: BTreeMap::new(),
            api: None,
            context_window: limit("maxInputTokens"),
            max_output_tokens: limit("maxOutputTokens"),
            reasoning: m["supportsReasoning"] == true,
            images: m["supportsImages"] == true,
            thinking,
            default_thinking,
        });
    }
    // Several upstream IDs share a display name (Hy4 free vs standard).
    let mut counts = BTreeMap::new();
    for m in &out {
        *counts.entry(m.name.clone()).or_insert(0) += 1;
    }
    for m in &mut out {
        if counts[&m.name] > 1 {
            m.name = format!("{} ({})", m.name, m.id);
        }
    }
    if out.is_empty() {
        return Err(
            ConnectionError::new("catalog_empty", "WorkBuddy 目录中没有受支持的模型").at("catalog"),
        );
    }
    Ok(out)
}
