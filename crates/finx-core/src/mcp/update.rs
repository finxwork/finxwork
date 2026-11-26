//! Connector update checks and package spec rewriting for local package runners
//! (`npx`, `pnpx`, `bunx`, `uvx`) and curated managed connectors (`dingtalk`, `feishu`, `wecom`).

use std::path::Path;
use std::time::Duration;

use finx_protocol::McpServerConfig;
use finx_protocol::customize::McpUpdateCheckResult;
use finx_protocol::customize::McpUpdateStatus;
use serde_json::Value;

use crate::connectors;
use crate::mcp::cache;
use crate::paths::FinxHome;
use crate::runtime::Workspace;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageRunner {
    Npm,
    PyPi,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageSpec {
    pub runner: PackageRunner,
    pub name: String,
    /// Exact pinned version if the configured spec already pins one (e.g. `1.2.3`).
    pub pinned_version: Option<String>,
    /// Index in `config.args` where the package spec lives.
    pub arg_index: usize,
    /// Leading flag prefix when passed as `--package=<spec>` or `--from=<spec>`.
    pub arg_prefix: String,
    /// Optional Python extras such as `[extra]` for `uvx`.
    pub extras: String,
}

/// Whether checking for updates is supported for this connector.
pub fn is_supported(home: &Path, config: &McpServerConfig) -> bool {
    if config.url.is_some() {
        return false;
    }
    connectors::for_server(home, config).is_some() || parse_package(config).is_some()
}

/// Extracts the registry package spec from a local package runner command (`npx`, `pnpx`, `bunx`, `uvx`).
pub fn parse_package(config: &McpServerConfig) -> Option<PackageSpec> {
    if config.url.is_some() || config.connector.is_some() {
        return None;
    }
    let command = config.command.as_deref()?.trim();
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let program = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(base)
        .to_ascii_lowercase();

    match program.as_str() {
        "npx" | "pnpx" | "bunx" => parse_npm_args(&config.args),
        "uvx" => parse_uvx_args(&config.args),
        _ => None,
    }
}

fn parse_npm_args(args: &[String]) -> Option<PackageSpec> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            break;
        }
        if arg == "-p" || arg == "--package" {
            let spec = args.get(i + 1)?;
            return build_npm_spec(spec, i + 1, "");
        }
        if let Some(rest) = arg.strip_prefix("--package=") {
            return build_npm_spec(rest, i, "--package=");
        }
        if matches!(arg, "-c" | "--call" | "--cache" | "--registry" | "--userconfig" | "--node-options") {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        return build_npm_spec(arg, i, "");
    }
    None
}

fn build_npm_spec(raw: &str, arg_index: usize, arg_prefix: &str) -> Option<PackageSpec> {
    let raw = raw.trim();
    if raw.is_empty()
        || raw.starts_with('.')
        || raw.starts_with('/')
        || raw.starts_with('~')
        || raw.contains("://")
        || raw.starts_with("file:")
        || raw.starts_with("git+")
        || raw.starts_with("github:")
    {
        return None;
    }
    let (name, version) = if let Some(rest) = raw.strip_prefix('@') {
        match rest.find('@') {
            Some(pos) => (&raw[..pos + 1], Some(&rest[pos + 1..])),
            None => (raw, None),
        }
    } else {
        match raw.find('@') {
            Some(pos) => (&raw[..pos], Some(&raw[pos + 1..])),
            None => (raw, None),
        }
    };
    if name.is_empty() || (name.starts_with('@') && !name.contains('/')) {
        return None;
    }
    let pinned_version = version.and_then(exact_version);
    Some(PackageSpec {
        runner: PackageRunner::Npm,
        name: name.to_string(),
        pinned_version,
        arg_index,
        arg_prefix: arg_prefix.to_string(),
        extras: String::new(),
    })
}

fn parse_uvx_args(args: &[String]) -> Option<PackageSpec> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            break;
        }
        if arg == "--from" {
            let spec = args.get(i + 1)?;
            return build_pypi_spec(spec, i + 1, "");
        }
        if let Some(rest) = arg.strip_prefix("--from=") {
            return build_pypi_spec(rest, i, "--from=");
        }
        if matches!(
            arg,
            "-p" | "--python" | "--with" | "--with-editable" | "--with-requirements" | "--index-url" | "--default-index" | "--extra-index-url" | "--cache-dir"
        ) {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        return build_pypi_spec(arg, i, "");
    }
    None
}

fn build_pypi_spec(raw: &str, arg_index: usize, arg_prefix: &str) -> Option<PackageSpec> {
    let raw = raw.trim();
    if raw.is_empty()
        || raw.starts_with('.')
        || raw.starts_with('/')
        || raw.starts_with('~')
        || raw.contains("://")
        || raw.starts_with("git+")
    {
        return None;
    }
    // Separate optional version operator (`==`, `>=`, `<=`, `~=`, `!=`, `<`, `>`, `@`).
    let split_at = raw
        .find("==")
        .or_else(|| raw.find(">="))
        .or_else(|| raw.find("<="))
        .or_else(|| raw.find("~="))
        .or_else(|| raw.find("!="))
        .or_else(|| raw.find(['@', '>', '<']));
    let (head, version_part) = match split_at {
        Some(pos) => (&raw[..pos], Some(&raw[pos..])),
        None => (raw, None),
    };
    let (name, extras) = match head.find('[') {
        Some(pos) => (&head[..pos], &head[pos..]),
        None => (head, ""),
    };
    let name = name.trim();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return None;
    }
    let pinned_version = version_part
        .and_then(|v| v.strip_prefix("==").or_else(|| v.strip_prefix('@')))
        .and_then(exact_version);
    Some(PackageSpec {
        runner: PackageRunner::PyPi,
        name: name.to_string(),
        pinned_version,
        arg_index,
        arg_prefix: arg_prefix.to_string(),
        extras: extras.to_string(),
    })
}

fn exact_version(raw: &str) -> Option<String> {
    let v = raw.trim().trim_start_matches(['v', 'V']);
    if v.is_empty() || !v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    if v.chars().any(|c| matches!(c, '^' | '~' | '*' | 'x' | 'X' | ' ' | ',' | '|')) {
        return None;
    }
    Some(v.to_string())
}

/// Returns updated `args` pinning the package in `spec` to `version`.
pub fn rewrite_args_for_version(args: &[String], spec: &PackageSpec, version: &str) -> Vec<String> {
    let mut next = args.to_vec();
    if spec.arg_index < next.len() {
        next[spec.arg_index] = match spec.runner {
            PackageRunner::Npm => format!("{}{}@{}", spec.arg_prefix, spec.name, version),
            PackageRunner::PyPi => format!("{}{}{}=={}", spec.arg_prefix, spec.name, spec.extras, version),
        };
    }
    next
}

/// Returns true when `latest` is strictly newer than `current`.
pub fn is_newer(current: &str, latest: &str) -> bool {
    let cur = normalize_version(current);
    let lat = normalize_version(latest);
    if cur.is_empty() || lat.is_empty() || cur == lat {
        return false;
    }
    match (parse_semver(cur), parse_semver(lat)) {
        (Some((c_nums, c_pre)), Some((l_nums, l_pre))) => {
            let len = c_nums.len().max(l_nums.len());
            for idx in 0..len {
                let c = c_nums.get(idx).copied().unwrap_or(0);
                let l = l_nums.get(idx).copied().unwrap_or(0);
                if l != c {
                    return l > c;
                }
            }
            match (c_pre, l_pre) {
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (Some(c), Some(l)) => l > c,
                (None, None) => false,
            }
        }
        _ => cur != lat,
    }
}

fn normalize_version(v: &str) -> &str {
    v.trim().trim_start_matches(['v', 'V'])
}

fn parse_semver(v: &str) -> Option<(Vec<u64>, Option<&str>)> {
    let without_build = v.split('+').next().unwrap_or(v);
    let (core, pre) = match without_build.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (without_build, None),
    };
    let mut nums = Vec::new();
    for part in core.split('.') {
        nums.push(part.parse::<u64>().ok()?);
    }
    (!nums.is_empty()).then_some((nums, pre))
}

fn http_client() -> Result<reqwest::Client, String> {
    let tls = finx_llm::tls_client_config().map_err(|e| e.to_string())?;
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .connect_timeout(Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("finx/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_npm_latest(http: &reqwest::Client, base_url: &str, package: &str) -> Result<String, String> {
    let url = format!("{}/{}", base_url.trim_end_matches('/'), package);
    let resp = http
        .get(&url)
        .header("Accept", "application/vnd.npm.install-v1+json")
        .send()
        .await
        .map_err(|e| format!("查询 npm 版本失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("查询 npm 版本失败：HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("解析 npm 响应失败：{e}"))?;
    body.pointer("/dist-tags/latest")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "npm 响应缺少最新版本信息".to_string())
}

async fn fetch_pypi_latest(http: &reqwest::Client, base_url: &str, package: &str) -> Result<String, String> {
    let url = format!("{}/pypi/{}/json", base_url.trim_end_matches('/'), package);
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("查询 PyPI 版本失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("查询 PyPI 版本失败：HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("解析 PyPI 响应失败：{e}"))?;
    body.pointer("/info/version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "PyPI 响应缺少最新版本信息".to_string())
}

async fn fetch_github_latest(http: &reqwest::Client, base_url: &str, repo: &str) -> Result<String, String> {
    let url = format!("{}/repos/{}/releases/latest", base_url.trim_end_matches('/'), repo);
    let resp = http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("查询 GitHub 版本失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("查询 GitHub 版本失败：HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("解析 GitHub 响应失败：{e}"))?;
    body.get("tag_name")
        .and_then(Value::as_str)
        .map(normalize_version)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "GitHub 响应缺少最新版本信息".to_string())
}

fn npm_package_from_tarball_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.host_str() != Some("registry.npmjs.org") {
        return None;
    }
    let path = parsed.path().trim_start_matches('/');
    let (pkg, _) = path.split_once("/-/")?;
    (!pkg.is_empty()).then(|| pkg.to_string())
}

fn github_repo_from_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.host_str() != Some("github.com") {
        return None;
    }
    let mut segments = parsed.path_segments()?;
    let owner = segments.next().filter(|s| !s.is_empty())?;
    let repo = segments.next().filter(|s| !s.is_empty())?.trim_end_matches(".git");
    Some(format!("{owner}/{repo}"))
}

/// Checks whether a connector has an available update.
pub async fn check_update(
    home: &FinxHome,
    workspace: &Workspace,
    config: &McpServerConfig,
    editable: bool,
) -> Result<McpUpdateCheckResult, String> {
    if let Some(m) = connectors::for_server(home.root(), config) {
        return check_managed_update(home, &m).await;
    }
    let Some(spec) = parse_package(config) else {
        return Ok(McpUpdateCheckResult {
            name: config.name.clone(),
            status: McpUpdateStatus::Unsupported,
            current_version: None,
            latest_version: None,
            can_upgrade: false,
            package: None,
            release_url: None,
            detail: Some("当前连接器类型不支持自动检查更新".into()),
        });
    };

    let http = http_client()?;
    let (latest, release_url) = match spec.runner {
        PackageRunner::Npm => (
            fetch_npm_latest(&http, "https://registry.npmjs.org", &spec.name).await?,
            Some(format!("https://www.npmjs.com/package/{}", spec.name)),
        ),
        PackageRunner::PyPi => (
            fetch_pypi_latest(&http, "https://pypi.org", &spec.name).await?,
            Some(format!("https://pypi.org/project/{}/", spec.name)),
        ),
    };

    let dir = crate::mcp::views::workspace_dir(workspace);
    let cached_version = cache::read(&home.mcp_cache_dir(), config, &dir)
        .and_then(|entry| entry.server_version);
    let mut current = spec.pinned_version.clone().or(cached_version);
    if current.is_none() {
        let mut probe_cfg = config.clone();
        probe_cfg.enabled = None;
        let checks = crate::mcp::check_servers(
            vec![probe_cfg],
            None,
            vec![dir.clone()],
            workspace.cwd.clone(),
            workspace.project_root.clone(),
            Some(home.mcp_cache_dir()),
            Some(home.root().to_path_buf()),
        )
        .await;
        current = checks
            .into_iter()
            .next()
            .and_then(|c| c.info)
            .map(|i| i.version)
            .filter(|v| !v.trim().is_empty());
    }

    let (status, can_upgrade) = match &current {
        Some(cur) if is_newer(cur, &latest) => (McpUpdateStatus::UpdateAvailable, editable),
        Some(_) => (McpUpdateStatus::UpToDate, false),
        None => (McpUpdateStatus::Unknown, editable),
    };

    Ok(McpUpdateCheckResult {
        name: config.name.clone(),
        status,
        current_version: current,
        latest_version: Some(latest),
        can_upgrade,
        package: Some(spec.name),
        release_url,
        detail: None,
    })
}

async fn check_managed_update(home: &FinxHome, m: &connectors::Manifest) -> Result<McpUpdateCheckResult, String> {
    let installed = connectors::installed_version(home.root(), m);
    if installed.as_deref() != Some(m.version.as_str()) {
        return Ok(McpUpdateCheckResult {
            name: m.id.clone(),
            status: McpUpdateStatus::UpdateAvailable,
            current_version: installed,
            latest_version: Some(m.version.clone()),
            can_upgrade: true,
            package: Some(m.id.clone()),
            release_url: Some(m.source.clone()),
            detail: None,
        });
    }

    let http = http_client()?;
    let upstream = if let Some(url) = connectors::artifact_url(m)
        && let Some(pkg) = npm_package_from_tarball_url(url)
    {
        fetch_npm_latest(&http, "https://registry.npmjs.org", &pkg).await
    } else if let Some(repo) = github_repo_from_url(&m.source) {
        fetch_github_latest(&http, "https://api.github.com", &repo).await
    } else {
        Ok(m.version.clone())
    };

    match upstream {
        Ok(latest) if is_newer(&m.version, &latest) => Ok(McpUpdateCheckResult {
            name: m.id.clone(),
            status: McpUpdateStatus::UpdateAvailable,
            current_version: Some(m.version.clone()),
            latest_version: Some(latest),
            // Managed connectors only install SHA-256 pinned manifests bundled with finx.
            can_upgrade: false,
            package: Some(m.id.clone()),
            release_url: Some(m.source.clone()),
            detail: Some("上游已发布新版本，需等待 FinxWork 更新内置清单后升级".into()),
        }),
        Ok(latest) => Ok(McpUpdateCheckResult {
            name: m.id.clone(),
            status: McpUpdateStatus::UpToDate,
            current_version: Some(m.version.clone()),
            latest_version: Some(latest),
            can_upgrade: false,
            package: Some(m.id.clone()),
            release_url: Some(m.source.clone()),
            detail: None,
        }),
        Err(err) => Err(err),
    }
}

/// Fetches the latest registry version for a parsed local package spec.
pub async fn fetch_latest_for_package(spec: &PackageSpec) -> Result<String, String> {
    let http = http_client()?;
    match spec.runner {
        PackageRunner::Npm => fetch_npm_latest(&http, "https://registry.npmjs.org", &spec.name).await,
        PackageRunner::PyPi => fetch_pypi_latest(&http, "https://pypi.org", &spec.name).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    fn stdio(cmd: &str, args: &[&str]) -> McpServerConfig {
        McpServerConfig {
            name: "demo".into(),
            command: Some(cmd.into()),
            args: args.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn parses_npm_and_uvx_packages() {
        let s = parse_package(&stdio("npx", &["-y", "bytedance-careers-mcp"])).unwrap();
        assert_eq!(s.runner, PackageRunner::Npm);
        assert_eq!(s.name, "bytedance-careers-mcp");
        assert_eq!(s.pinned_version, None);
        assert_eq!(s.arg_index, 1);
        assert_eq!(
            rewrite_args_for_version(&["-y".into(), "bytedance-careers-mcp".into()], &s, "1.2.3"),
            vec!["-y", "bytedance-careers-mcp@1.2.3"]
        );

        let scoped = parse_package(&stdio("pnpx", &["--package=@acme/mcp@1.0.0", "acme-mcp"])).unwrap();
        assert_eq!(scoped.name, "@acme/mcp");
        assert_eq!(scoped.pinned_version.as_deref(), Some("1.0.0"));
        assert_eq!(scoped.arg_prefix, "--package=");
        assert_eq!(
            rewrite_args_for_version(&["--package=@acme/mcp@1.0.0".into(), "acme-mcp".into()], &scoped, "1.1.0"),
            vec!["--package=@acme/mcp@1.1.0", "acme-mcp"]
        );

        let uvx = parse_package(&stdio("uvx", &["--from", "mcp-server-git[extra]==0.6.1", "mcp-server-git"])).unwrap();
        assert_eq!(uvx.runner, PackageRunner::PyPi);
        assert_eq!(uvx.name, "mcp-server-git");
        assert_eq!(uvx.extras, "[extra]");
        assert_eq!(uvx.pinned_version.as_deref(), Some("0.6.1"));
        assert_eq!(
            rewrite_args_for_version(&["--from".into(), "mcp-server-git[extra]==0.6.1".into(), "mcp-server-git".into()], &uvx, "0.7.0"),
            vec!["--from", "mcp-server-git[extra]==0.7.0", "mcp-server-git"]
        );

        assert!(parse_package(&stdio("npx", &["-y", "./local-pkg"])).is_none());
        assert!(parse_package(&stdio("node", &["server.js"])).is_none());
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("1.0.2", "1.0.10"));
        assert!(is_newer("v1.0.0-beta.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "v1.0.0"));
        assert!(!is_newer("2.0.0", "1.9.9"));
    }

    #[test]
    fn extracts_upstream_targets_from_manifest_urls() {
        assert_eq!(
            npm_package_from_tarball_url("https://registry.npmjs.org/@wecom/cli-darwin-arm64/-/cli-darwin-arm64-1.3.4.tgz").as_deref(),
            Some("@wecom/cli-darwin-arm64")
        );
        assert_eq!(
            github_repo_from_url("https://github.com/larksuite/cli").as_deref(),
            Some("larksuite/cli")
        );
    }

    #[tokio::test]
    async fn fetches_latest_from_mock_registries() {
        async fn serve_once(body: &'static str) -> String {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                }
            });
            format!("http://{addr}")
        }

        let http = http_client().unwrap();
        let npm_base = serve_once(r#"{"dist-tags":{"latest":"2.4.1"}}"#).await;
        assert_eq!(fetch_npm_latest(&http, &npm_base, "demo-mcp").await.unwrap(), "2.4.1");

        let pypi_base = serve_once(r#"{"info":{"version":"0.9.3"}}"#).await;
        assert_eq!(fetch_pypi_latest(&http, &pypi_base, "mcp-demo").await.unwrap(), "0.9.3");

        let gh_base = serve_once(r#"{"tag_name":"v1.5.0"}"#).await;
        assert_eq!(fetch_github_latest(&http, &gh_base, "org/repo").await.unwrap(), "1.5.0");
    }
}
