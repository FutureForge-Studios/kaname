//! Websites.
//!
//! Virtual hosts are rendered from a template rather than assembled from
//! operator-supplied config text: the panel chooses a runtime and a set of
//! names, and this file decides what nginx actually reads. Nothing the
//! control plane sends is written into the config verbatim without
//! validation first.
//!
//! A managed vhost carries its own metadata in a leading comment, which is
//! how site.update can change one field without re-deriving the rest by
//! parsing nginx's grammar.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde::{Deserialize, Serialize};

use super::Shared;
use super::certs::{certificate_paths, check_domain};
use super::common::{conflict, invalid, is_not_exist, not_found, precondition};
use super::exec::{ExecOptions, dir_exists, file_exists, run_combined, run_with, write_atomic};
use super::paths::{DEFAULT_DIR_MODE, is_protected_root, validate_path, wrap_fs_error};
use crate::providers::*;

const SITE_MARKER: &str = "# kaname-site: ";

const SITES_AVAILABLE: &str = "/etc/nginx/sites-available";
const SITES_ENABLED: &str = "/etc/nginx/sites-enabled";
const NGINX_CONF_D: &str = "/etc/nginx/conf.d";

static SERVER_NAME_DIRECTIVE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*server_name\s+([^;]+);").unwrap());
static ROOT_DIRECTIVE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*root\s+([^;]+);").unwrap());
static UPSTREAM_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:https?://)?(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):[0-9]{1,5}(?:/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$",
    )
    .unwrap()
});
static UNIX_UPSTREAM_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^unix:/[A-Za-z0-9._/-]+$").unwrap());
static PHP_VERSION_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9]+\.[0-9]+$").unwrap());

/// What site.create recorded, read back so site.update can be a merge
/// rather than a rewrite from guesses.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SiteMetadata {
    pub name: String,
    pub server_names: Vec<String>,
    pub webroot: String,
    pub runtime: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub runtime_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub upstream: String,
    pub force_https: bool,
}

pub struct SiteOps(pub Arc<Shared>);

#[async_trait]
impl Sites for SiteOps {
    async fn list(&self, ctx: &Ctx) -> PResult<Vec<SiteInfo>> {
        self.0.require(cap::NGINX)?;

        let dir = config_root();
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if is_not_exist(&e) => return Ok(Vec::new()),
            Err(e) => return Err(wrap_fs_error(dir, e)),
        };

        let mut sites = Vec::new();
        for entry in entries.flatten() {
            ctx.check()?;
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = format!("{dir}/{name}");
            let Ok(raw) = std::fs::read_to_string(&full) else { continue };
            sites.push(describe_site(&name, &full, &raw));
        }

        sites.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(sites)
    }

    async fn create(&self, ctx: &Ctx, p: SiteCreateParams) -> PResult<SiteConfigResult> {
        self.0.require(cap::NGINX)?;
        check_site_name(&p.name)?;
        for name in &p.server_names {
            check_domain(name)?;
        }
        let runtime_version = p.runtime_version.clone().unwrap_or_default();
        let upstream = p.upstream.clone().unwrap_or_default();
        check_runtime_version(&p.runtime, &runtime_version)?;
        check_upstream(&p.runtime, &upstream)?;

        let target = config_path(&p.name);
        if file_exists(&target) {
            return Err(conflict(format!("site {} already exists", p.name)));
        }

        mkdir_all(&p.webroot, DEFAULT_DIR_MODE).map_err(|e| wrap_fs_error(&p.webroot, e))?;
        if let Some(owner) = p.owner.as_deref().filter(|o| !o.is_empty()) {
            let account = nix::unistd::User::from_name(owner)
                .ok()
                .flatten()
                .ok_or_else(|| not_found(format!("user {owner}")))?;
            std::os::unix::fs::chown(&p.webroot, Some(account.uid.as_raw()), Some(account.gid.as_raw()))
                .map_err(|e| wrap_fs_error(&p.webroot, e))?;
        }

        let meta = SiteMetadata {
            name: p.name.clone(),
            server_names: p.server_names.clone(),
            webroot: p.webroot.clone(),
            runtime: p.runtime.clone(),
            runtime_version,
            upstream,
            force_https: p.force_https,
        };
        self.install(ctx, &meta, true).await?;
        Ok(SiteConfigResult { config_path: target })
    }

    async fn update(&self, ctx: &Ctx, p: SiteUpdateParams) -> PResult<SiteConfigResult> {
        self.0.require(cap::NGINX)?;
        check_site_name(&p.name)?;

        let target = config_path(&p.name);
        let raw = std::fs::read_to_string(&target).map_err(|e| wrap_fs_error(&target, e))?;
        let Some(mut meta) = read_metadata(&raw) else {
            return Err(precondition(format!(
                "{target} was not created by Kaname and will not be rewritten"
            )));
        };

        if !p.server_names.is_empty() {
            for name in &p.server_names {
                check_domain(name)?;
            }
            meta.server_names = p.server_names.clone();
        }
        if let Some(webroot) = p.webroot.as_deref().filter(|w| !w.is_empty()) {
            meta.webroot = validate_path(webroot)?;
        }
        if let Some(version) = p.runtime_version.as_deref().filter(|v| !v.is_empty()) {
            check_runtime_version(&meta.runtime, version)?;
            meta.runtime_version = version.to_string();
        }
        if let Some(upstream) = p.upstream.as_deref().filter(|u| !u.is_empty()) {
            check_upstream(&meta.runtime, upstream)?;
            meta.upstream = upstream.to_string();
        }
        if let Some(force_https) = p.force_https {
            meta.force_https = force_https;
        }

        let enabled = p.enabled.unwrap_or_else(|| is_enabled(&p.name));
        self.install(ctx, &meta, enabled).await?;
        Ok(SiteConfigResult { config_path: target })
    }

    async fn remove(&self, ctx: &Ctx, p: SiteRemoveParams) -> PResult<()> {
        self.0.require(cap::NGINX)?;
        check_site_name(&p.name)?;

        let target = config_path(&p.name);
        let raw = std::fs::read_to_string(&target).map_err(|e| wrap_fs_error(&target, e))?;
        let meta = read_metadata(&raw);

        let link = enabled_path(&p.name);
        remove_if_present(&link)?;
        remove_if_present(&target)?;

        if p.delete_webroot {
            if let Some(meta) = meta.filter(|m| !m.webroot.is_empty()) {
                if is_protected_root(&meta.webroot) {
                    return Err(ProviderError::PermissionDenied(format!(
                        "{} is protected from recursive deletion",
                        meta.webroot
                    )));
                }
                if let Err(e) = std::fs::remove_dir_all(&meta.webroot) {
                    if !is_not_exist(&e) {
                        return Err(wrap_fs_error(&meta.webroot, e));
                    }
                }
            }
        }
        self.reload(ctx).await
    }

    async fn test_config(&self, ctx: &Ctx) -> PResult<SiteTestConfigResult> {
        self.0.require(cap::NGINX)?;

        // nginx -t writes its verdict to stderr in both the pass and fail
        // case, so the operator sees the same text either way.
        match run_combined(ctx, ExecOptions::new("nginx", ["-t"]).c_locale()).await {
            Ok(out) => Ok(SiteTestConfigResult {
                valid: true,
                output: out.trim().to_string(),
            }),
            Err(ProviderError::Exec { output, .. }) => Ok(SiteTestConfigResult {
                valid: false,
                output,
            }),
            Err(err) => Err(err),
        }
    }

    async fn reload(&self, ctx: &Ctx) -> PResult<()> {
        self.0.require(cap::NGINX)?;

        // Validating first is what stops a bad vhost from taking every site
        // on the host down with it.
        let verdict = self.test_config(ctx).await?;
        if !verdict.valid {
            return Err(ProviderError::exec(
                "nginx -t",
                "the configuration did not pass validation",
                verdict.output,
            ));
        }

        if self.0.has(cap::SYSTEMD) {
            run_with(ctx, ExecOptions::new("systemctl", ["reload", "nginx"]).c_locale()).await?;
            return Ok(());
        }
        run_with(ctx, ExecOptions::new("nginx", ["-s", "reload"]).c_locale()).await?;
        Ok(())
    }
}

/* ------------------------------ rendering ---------------------------- */

impl SiteOps {
    /// Writes the vhost, points sites-enabled at it (or does not), and only
    /// reloads once nginx has accepted the result. A config that fails
    /// validation is rolled back rather than left in place.
    async fn install(&self, ctx: &Ctx, meta: &SiteMetadata, enabled: bool) -> PResult<()> {
        let target = config_path(&meta.name);
        let previous = std::fs::read(&target).ok();

        let certs = meta.server_names.first().and_then(|name| certificate_paths(name));
        let rendered = render_site(meta, certs.as_ref().map(|(c, k)| (c.as_str(), k.as_str())))?;
        let parent = Path::new(&target).parent().unwrap_or(Path::new("/"));
        mkdir_all(&parent.to_string_lossy(), DEFAULT_DIR_MODE)
            .map_err(|e| wrap_fs_error(&parent.to_string_lossy(), e))?;
        write_atomic(Path::new(&target), rendered.as_bytes(), 0o644).map_err(|e| wrap_fs_error(&target, e))?;

        set_enabled(&meta.name, enabled)?;

        if let Err(err) = self.reload(ctx).await {
            match previous {
                Some(previous) => {
                    let _ = write_atomic(Path::new(&target), &previous, 0o644);
                }
                None => {
                    let _ = std::fs::remove_file(&target);
                    let _ = std::fs::remove_file(enabled_path(&meta.name));
                }
            }
            return Err(err);
        }
        Ok(())
    }
}

fn set_enabled(name: &str, enabled: bool) -> PResult<()> {
    if !dir_exists(SITES_ENABLED) {
        // Single-directory layouts (conf.d) have no enable step; the file
        // existing is what enables the site.
        return Ok(());
    }

    let link = enabled_path(name);
    if !enabled {
        return remove_if_present(&link);
    }
    if std::fs::symlink_metadata(&link).is_ok() {
        return Ok(());
    }
    std::os::unix::fs::symlink(config_path(name), &link).map_err(|e| wrap_fs_error(&link, e))
}

/// The nginx server block(s) for a managed site. `certs` is the
/// `(fullchain, privkey)` pair for the first server name when one exists;
/// without it a site that asked for HTTPS is served plain until a
/// certificate lands.
pub fn render_site(meta: &SiteMetadata, certs: Option<(&str, &str)>) -> PResult<String> {
    if meta.server_names.is_empty() {
        return Err(invalid("a virtual host needs at least one server name"));
    }
    let encoded = serde_json::to_string(meta)?;

    let names = meta.server_names.join(" ");
    let secure = meta.force_https && certs.is_some();

    let mut b = String::new();
    b.push_str(SITE_MARKER);
    b.push_str(&encoded);
    b.push_str("\n# Managed by Kaname. Edits are overwritten on the next site update.\n\n");

    if let (true, Some((chain, key))) = (secure, certs) {
        b.push_str(&format!(
            "server {{\n    listen 80;\n    listen [::]:80;\n    server_name {names};\n"
        ));
        b.push_str(&format!(
            "    location /.well-known/acme-challenge/ {{ root {}; }}\n",
            meta.webroot
        ));
        b.push_str("    location / { return 301 https://$host$request_uri; }\n}\n\n");

        b.push_str(&format!(
            "server {{\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n    server_name {names};\n"
        ));
        b.push_str(&format!("    ssl_certificate {chain};\n    ssl_certificate_key {key};\n"));
        b.push_str("    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_prefer_server_ciphers off;\n");
    } else {
        b.push_str(&format!(
            "server {{\n    listen 80;\n    listen [::]:80;\n    server_name {names};\n"
        ));
    }

    b.push_str(&format!("    root {};\n    index index.html index.htm;\n", meta.webroot));
    b.push_str(&format!("    access_log /var/log/nginx/{}.access.log;\n", meta.name));
    b.push_str(&format!("    error_log /var/log/nginx/{}.error.log;\n", meta.name));
    b.push_str("    client_max_body_size 64m;\n\n");

    match meta.runtime.as_str() {
        "static" => {
            b.push_str("    location / {\n        try_files $uri $uri/ =404;\n    }\n");
        }
        "php" => {
            let socket = php_socket(&meta.runtime_version);
            b.push_str("    index index.php index.html;\n");
            b.push_str("    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n");
            b.push_str("    location ~ \\.php$ {\n");
            b.push_str("        include fastcgi_params;\n");
            b.push_str("        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n");
            b.push_str(&format!("        fastcgi_pass unix:{socket};\n"));
            b.push_str("    }\n");
            b.push_str("    location ~ /\\.(?!well-known).* { deny all; }\n");
        }
        "node" | "python" | "proxy" | "container" => {
            b.push_str("    location / {\n");
            b.push_str(&format!("        proxy_pass {};\n", normalize_upstream(&meta.upstream)));
            b.push_str("        proxy_http_version 1.1;\n");
            b.push_str("        proxy_set_header Host $host;\n");
            b.push_str("        proxy_set_header X-Real-IP $remote_addr;\n");
            b.push_str("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n");
            b.push_str("        proxy_set_header X-Forwarded-Proto $scheme;\n");
            b.push_str("        proxy_set_header Upgrade $http_upgrade;\n");
            b.push_str("        proxy_set_header Connection \"upgrade\";\n");
            b.push_str("        proxy_read_timeout 300s;\n");
            b.push_str("    }\n");
        }
        other => return Err(invalid(format!("runtime {other:?} is not supported"))),
    }

    b.push_str("}\n");
    Ok(b)
}

/* ------------------------------- reading ----------------------------- */

pub fn describe_site(name: &str, config_path: &str, raw: &str) -> SiteInfo {
    if let Some(meta) = read_metadata(raw) {
        return SiteInfo {
            name: meta.name.clone(),
            webroot: meta.webroot,
            server_names: meta.server_names,
            runtime: meta.runtime,
            runtime_version: Some(meta.runtime_version).filter(|v| !v.is_empty()),
            enabled: is_enabled(&meta.name),
            config_path: config_path.to_string(),
        };
    }

    // A vhost Kaname did not write still deserves a row, derived from the
    // two directives that are unambiguous to read.
    let bare = name.strip_suffix(".conf").unwrap_or(name);
    let mut info = SiteInfo {
        name: bare.to_string(),
        server_names: Vec::new(),
        runtime: "static".into(),
        enabled: is_enabled(bare),
        config_path: config_path.to_string(),
        ..Default::default()
    };
    if let Some(caps) = SERVER_NAME_DIRECTIVE.captures(raw) {
        info.server_names = caps[1].split_whitespace().map(str::to_string).collect();
    }
    if let Some(caps) = ROOT_DIRECTIVE.captures(raw) {
        info.webroot = caps[1].trim().to_string();
    }
    if raw.contains("fastcgi_pass") {
        info.runtime = "php".into();
    } else if raw.contains("proxy_pass") {
        info.runtime = "proxy".into();
    }
    info
}

pub fn read_metadata(raw: &str) -> Option<SiteMetadata> {
    for line in raw.splitn(4, '\n') {
        let Some(encoded) = line.strip_prefix(SITE_MARKER) else { continue };
        let meta: SiteMetadata = serde_json::from_str(encoded).ok()?;
        return if meta.name.is_empty() { None } else { Some(meta) };
    }
    None
}

fn config_root() -> &'static str {
    if dir_exists(SITES_AVAILABLE) { SITES_AVAILABLE } else { NGINX_CONF_D }
}

fn config_path(name: &str) -> String {
    format!("{}/{name}.conf", config_root())
}

fn enabled_path(name: &str) -> String {
    format!("{SITES_ENABLED}/{name}.conf")
}

fn is_enabled(name: &str) -> bool {
    if !dir_exists(SITES_ENABLED) {
        return file_exists(&config_path(name));
    }
    std::fs::symlink_metadata(enabled_path(name)).is_ok()
}

/// Picks the FPM socket for a version, falling back to whatever single
/// socket the host happens to have.
fn php_socket(version: &str) -> String {
    if !version.is_empty() {
        return format!("/run/php/php{version}-fpm.sock");
    }
    for candidate in ["/run/php/php-fpm.sock", "/run/php-fpm/www.sock", "/var/run/php-fpm/www.sock"] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "/run/php/php-fpm.sock".to_string()
}

pub fn normalize_upstream(upstream: &str) -> String {
    if upstream.starts_with("http://") || upstream.starts_with("https://") || upstream.starts_with("unix:") {
        return upstream.to_string();
    }
    format!("http://{upstream}")
}

fn mkdir_all(path: &str, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(mode).create(path)
}

fn remove_if_present(path: &str) -> PResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if is_not_exist(&e) => Ok(()),
        Err(e) => Err(wrap_fs_error(path, e)),
    }
}

/* ------------------------------ validation --------------------------- */

pub fn check_site_name(name: &str) -> PResult<()> {
    if name.is_empty() || name.len() > 128 {
        return Err(invalid("site name must be between 1 and 128 characters"));
    }
    for c in name.bytes() {
        match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-' | b'_' => {}
            _ => return Err(invalid("site name contains an illegal character")),
        }
    }
    if name.starts_with('.') {
        return Err(invalid("site name may not start with a dot"));
    }
    Ok(())
}

pub fn check_runtime_version(runtime: &str, version: &str) -> PResult<()> {
    if version.is_empty() {
        return Ok(());
    }
    if runtime == "php" && !PHP_VERSION_PATTERN.is_match(version) {
        return Err(invalid("php version must look like 8.3"));
    }
    for c in version.bytes() {
        match c {
            b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' => {}
            _ => return Err(invalid("runtime version contains an illegal character")),
        }
    }
    Ok(())
}

/// Refuses anything that is not a host:port or unix socket, because the
/// value is written into a proxy_pass directive.
pub fn check_upstream(runtime: &str, upstream: &str) -> PResult<()> {
    let needs_upstream = matches!(runtime, "node" | "python" | "proxy" | "container");
    if upstream.is_empty() {
        if needs_upstream {
            return Err(invalid(format!("runtime {runtime} needs an upstream")));
        }
        return Ok(());
    }
    if !needs_upstream {
        return Err(invalid(format!("runtime {runtime} does not take an upstream")));
    }
    if UNIX_UPSTREAM_PATTERN.is_match(upstream) || UPSTREAM_PATTERN.is_match(upstream) {
        return Ok(());
    }
    Err(invalid("upstream must be host:port, http://host:port or unix:/path"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(runtime: &str) -> SiteMetadata {
        SiteMetadata {
            name: "shop".into(),
            server_names: vec!["shop.example.com".into(), "www.shop.example.com".into()],
            webroot: "/var/www/shop".into(),
            runtime: runtime.into(),
            runtime_version: String::new(),
            upstream: String::new(),
            force_https: false,
        }
    }

    #[test]
    fn static_sites_render_the_plain_template() {
        let rendered = render_site(&meta("static"), None).unwrap();
        let expected = "# kaname-site: {\"name\":\"shop\",\"server_names\":[\"shop.example.com\",\"www.shop.example.com\"],\"webroot\":\"/var/www/shop\",\"runtime\":\"static\",\"force_https\":false}
# Managed by Kaname. Edits are overwritten on the next site update.

server {
    listen 80;
    listen [::]:80;
    server_name shop.example.com www.shop.example.com;
    root /var/www/shop;
    index index.html index.htm;
    access_log /var/log/nginx/shop.access.log;
    error_log /var/log/nginx/shop.error.log;
    client_max_body_size 64m;

    location / {
        try_files $uri $uri/ =404;
    }
}
";
        assert_eq!(rendered, expected);
    }

    #[test]
    fn https_renders_a_redirect_and_a_tls_block_only_with_a_certificate() {
        let mut m = meta("php");
        m.force_https = true;
        m.runtime_version = "8.3".into();

        let plain = render_site(&m, None).unwrap();
        assert!(!plain.contains("listen 443 ssl"));
        assert!(plain.contains("fastcgi_pass unix:/run/php/php8.3-fpm.sock;"));
        assert!(plain.contains("location ~ /\\.(?!well-known).* { deny all; }"));
        assert!(plain.contains("\"runtime_version\":\"8.3\""));

        let secure = render_site(&m, Some(("/etc/letsencrypt/live/shop.example.com/fullchain.pem", "/etc/letsencrypt/live/shop.example.com/privkey.pem"))).unwrap();
        assert!(secure.contains("    location /.well-known/acme-challenge/ { root /var/www/shop; }\n    location / { return 301 https://$host$request_uri; }\n}\n\nserver {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n"));
        assert!(secure.contains("    ssl_certificate /etc/letsencrypt/live/shop.example.com/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_prefer_server_ciphers off;\n"));
    }

    #[test]
    fn proxy_runtimes_render_proxy_pass_with_a_scheme() {
        let mut m = meta("node");
        m.upstream = "127.0.0.1:3000".into();
        let rendered = render_site(&m, None).unwrap();
        assert!(rendered.contains("        proxy_pass http://127.0.0.1:3000;\n        proxy_http_version 1.1;\n"));
        assert!(rendered.contains("        proxy_set_header Connection \"upgrade\";\n        proxy_read_timeout 300s;\n    }\n}\n"));
        assert!(rendered.contains("\"upstream\":\"127.0.0.1:3000\""));

        m.upstream = "unix:/run/app.sock".into();
        assert!(render_site(&m, None).unwrap().contains("proxy_pass unix:/run/app.sock;"));

        assert!(render_site(&meta("ruby"), None).is_err());
        let mut nameless = meta("static");
        nameless.server_names.clear();
        assert!(render_site(&nameless, None).is_err());
    }

    #[test]
    fn metadata_round_trips_through_the_marker_comment() {
        let rendered = render_site(&meta("static"), None).unwrap();
        assert_eq!(read_metadata(&rendered), Some(meta("static")));
        assert_eq!(read_metadata("server {}\n"), None);
        assert_eq!(read_metadata("# kaname-site: {\"name\":\"\"}\n"), None);
        assert_eq!(read_metadata("# kaname-site: not json\n"), None);
    }

    #[test]
    fn foreign_vhosts_are_described_from_their_directives() {
        let raw = "server {\n    listen 80;\n    server_name legacy.example.com alt.example.com;\n    root /srv/legacy;\n    location ~ \\.php$ { fastcgi_pass unix:/run/php/php-fpm.sock; }\n}\n";
        let info = describe_site("legacy.conf", "/etc/nginx/sites-available/legacy.conf", raw);
        assert_eq!(info.name, "legacy");
        assert_eq!(info.server_names, vec!["legacy.example.com", "alt.example.com"]);
        assert_eq!(info.webroot, "/srv/legacy");
        assert_eq!(info.runtime, "php");
        assert_eq!(info.runtime_version, None);

        let managed = describe_site("shop.conf", "/x/shop.conf", &render_site(&meta("static"), None).unwrap());
        assert_eq!(managed.name, "shop");
        assert_eq!(managed.runtime, "static");
    }

    #[test]
    fn upstreams_and_versions_are_validated_per_runtime() {
        assert!(check_upstream("static", "").is_ok());
        assert!(check_upstream("static", "127.0.0.1:3000").is_err());
        assert!(check_upstream("node", "").is_err());
        assert!(check_upstream("node", "127.0.0.1:3000").is_ok());
        assert!(check_upstream("proxy", "http://backend:8080/api").is_ok());
        assert!(check_upstream("proxy", "[::1]:8080").is_ok());
        assert!(check_upstream("python", "unix:/run/gunicorn.sock").is_ok());
        assert!(check_upstream("node", "127.0.0.1:3000; rm -rf /").is_err());
        assert!(check_upstream("node", "localhost").is_err());

        assert!(check_runtime_version("php", "8.3").is_ok());
        assert!(check_runtime_version("php", "latest").is_err());
        assert!(check_runtime_version("node", "20-alpine").is_ok());
        assert!(check_runtime_version("node", "20 alpine").is_err());
        assert!(check_runtime_version("node", "").is_ok());
    }

    #[test]
    fn site_names_are_filesystem_safe() {
        assert!(check_site_name("shop.example.com").is_ok());
        assert!(check_site_name(".hidden").is_err());
        assert!(check_site_name("a/b").is_err());
        assert!(check_site_name("").is_err());
        assert_eq!(normalize_upstream("backend:80"), "http://backend:80");
        assert_eq!(normalize_upstream("https://backend:443"), "https://backend:443");
    }
}
