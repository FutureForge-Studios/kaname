//! nginx virtual hosts.
//!
//! A site is a vhost file in the in-memory tree plus a row here; the two
//! are written together so the editor and `site.list` never disagree.

use std::sync::Arc;

use async_trait::async_trait;

use sha2::{Digest, Sha256};

use super::certs;
use super::files::{MemFs, clean_path, path_base, tree_size, uid_for};
use super::services::transition;
use super::state::Sim;
use crate::providers::{
    Ctx, PResult, ProviderError, SiteActivateParams, SiteActivateResult, SiteConfigResult, SiteCreateParams,
    SiteInfo, SiteReleaseParams, SiteReleaseResult, SiteRemoveParams, SiteTestConfigResult, SiteUpdateParams,
    Sites,
};

#[derive(Clone)]
pub struct Site {
    pub info: SiteInfo,
    pub upstream: String,
    pub force_https: bool,
}

/// name, server names, webroot, runtime, upstream, php version, tls.
type SiteSeed = (
    String,
    Vec<String>,
    String,
    &'static str,
    &'static str,
    &'static str,
    bool,
);

pub fn build_web(sim: &Sim) {
    let domain = sim.id.domain.clone();

    let seeds: Vec<SiteSeed> = vec![
        (
            domain.clone(),
            vec![domain.clone(), format!("www.{domain}")],
            format!("/var/www/{domain}/public"),
            "static",
            "",
            "",
            true,
        ),
        (
            format!("api.{domain}"),
            vec![format!("api.{domain}")],
            format!("/var/www/api.{domain}/public"),
            "proxy",
            "",
            "http://127.0.0.1:3000",
            true,
        ),
        (
            format!("blog.{domain}"),
            vec![format!("blog.{domain}")],
            format!("/var/www/blog.{domain}/public"),
            "php",
            "8.2",
            "",
            true,
        ),
        (
            format!("app.{domain}"),
            vec![format!("app.{domain}")],
            format!("/var/www/app.{domain}/current"),
            "node",
            "20",
            "http://127.0.0.1:4000",
            true,
        ),
        (
            format!("staging.{domain}"),
            vec![format!("staging.{domain}")],
            format!("/var/www/staging.{domain}/public"),
            "static",
            "",
            "",
            false,
        ),
    ];

    let mut sites = Vec::new();
    for (name, names, webroot, runtime, version, upstream, enabled) in seeds {
        let info = SiteInfo {
            config_path: format!("/etc/nginx/sites-available/{name}"),
            name: name.clone(),
            webroot: webroot.clone(),
            server_names: names,
            runtime: runtime.into(),
            runtime_version: if version.is_empty() {
                None
            } else {
                Some(version.into())
            },
            enabled,
        };
        let entry = Site {
            info,
            upstream: upstream.into(),
            force_https: true,
        };

        {
            let mut fs = sim.fs.write();
            fs.file(&entry.info.config_path, &render_site_config(&entry));
            if enabled {
                fs.link(
                    &format!("/etc/nginx/sites-enabled/{name}"),
                    &format!("../sites-available/{name}"),
                );
            }
            fs.dir_as(&webroot, "0755", "www-data", 33);
        }
        seed_webroot(sim, &entry);
        sites.push(entry);
    }
    sim.world.lock().sites = sites;

    certs::build_certs(sim);
}

pub fn seed_webroot(sim: &Sim, entry: &Site) {
    let mut fs = sim.fs.write();
    let root = &entry.info.webroot;
    match entry.info.runtime.as_str() {
        "php" => {
            fs.file_as(&format!("{root}/index.php"), "<?php\ndeclare(strict_types=1);\nrequire __DIR__ . '/../vendor/autoload.php';\n\n$app = new App\\Kernel();\n$app->handle($_SERVER, $_GET, $_POST);\n", "0644", "www-data", 33);
            fs.file_as(
                &format!("{root}/.htaccess"),
                "RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^ index.php [L]\n",
                "0644",
                "www-data",
                33,
            );
            fs.dir_as(&format!("{root}/wp-content/uploads"), "0755", "www-data", 33);
            fs.blob(&format!("{root}/wp-content/uploads/2026-08-hero.jpg"), 1_884_112);
        }
        "node" => {
            fs.file_as(&format!("{root}/server.js"), "import { createServer } from 'node:http';\n\ncreateServer((_req, res) => {\n  res.writeHead(200, { 'content-type': 'application/json' });\n  res.end(JSON.stringify({ ok: true }));\n}).listen(4000);\n", "0644", "deploy", 1000);
            fs.file_as(
                &format!("{root}/package.json"),
                &format!(
                    "{{\n  \"name\": \"{}\",\n  \"type\": \"module\",\n  \"private\": true\n}}\n",
                    entry.info.name
                ),
                "0644",
                "deploy",
                1000,
            );
        }
        "proxy" => {
            fs.file_as(&format!("{root}/index.html"), "<!doctype html>\n<title>upstream</title>\n<p>Requests are proxied to the application server.</p>\n", "0644", "www-data", 33);
        }
        _ => {
            fs.file_as(
                &format!("{root}/index.html"),
                &static_index_html(&entry.info.name),
                "0644",
                "www-data",
                33,
            );
            fs.file_as(
                &format!("{root}/robots.txt"),
                "User-agent: *\nDisallow:\n",
                "0644",
                "www-data",
                33,
            );
            fs.file_as(&format!("{root}/assets/app.css"), ":root{color-scheme:dark}\nbody{margin:0;font:16px/1.6 system-ui,sans-serif;background:#0b0c0e;color:#e7e9ec}\nmain{max-width:60ch;margin:12vh auto;padding:0 1.5rem}\n", "0644", "www-data", 33);
            fs.blob(&format!("{root}/assets/app.js"), 118_442);
            fs.blob(&format!("{root}/favicon.ico"), 15_086);
        }
    }
}

fn static_index_html(name: &str) -> String {
    format!(
        "<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>{name}</title>
    <link rel=\"stylesheet\" href=\"/assets/app.css\" />
  </head>
  <body>
    <main>
      <h1>{name}</h1>
      <p>Served by nginx from this host.</p>
    </main>
    <script src=\"/assets/app.js\" defer></script>
  </body>
</html>
"
    )
}

pub fn render_site_config(entry: &Site) -> String {
    let mut b = String::new();
    let names = entry.info.server_names.join(" ");
    let name = &entry.info.name;

    if entry.force_https {
        b.push_str(&format!(
            "server {{\n    listen 80;\n    listen [::]:80;\n    server_name {names};\n    return 301 https://$host$request_uri;\n}}\n\n"
        ));
    }
    b.push_str(&format!(
        "server {{\n    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n    server_name {names};\n\n"
    ));
    b.push_str(&format!(
        "    ssl_certificate     /etc/letsencrypt/live/{name}/fullchain.pem;\n"
    ));
    b.push_str(&format!(
        "    ssl_certificate_key /etc/letsencrypt/live/{name}/privkey.pem;\n"
    ));
    b.push_str("    include snippets/ssl-params.conf;\n\n");
    b.push_str(&format!("    root {};\n", entry.info.webroot));
    b.push_str(&format!("    access_log /var/log/nginx/{name}.access.log;\n"));
    b.push_str(&format!("    error_log  /var/log/nginx/{name}.error.log;\n\n"));

    match entry.info.runtime.as_str() {
        "php" => {
            let version = entry.info.runtime_version.clone().unwrap_or_else(|| "8.2".into());
            b.push_str("    index index.php index.html;\n\n    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n\n");
            b.push_str(&format!(
                "    location ~ \\.php$ {{\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:/run/php/php{version}-fpm.sock;\n    }}\n"
            ));
        }
        "proxy" | "node" | "container" => {
            let upstream = if entry.upstream.is_empty() {
                "http://127.0.0.1:3000"
            } else {
                entry.upstream.as_str()
            };
            b.push_str(&format!(
                "    location / {{\n        proxy_pass {upstream};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }}\n"
            ));
        }
        "python" => {
            b.push_str("    location / {\n        include uwsgi_params;\n        uwsgi_pass unix:/run/uwsgi/app.sock;\n    }\n");
        }
        _ => {
            b.push_str(
                "    index index.html;\n\n    location / {\n        try_files $uri $uri/ =404;\n    }\n",
            );
        }
    }
    b.push_str("}\n");
    b
}

const SITES_ENABLED: &str = "/etc/nginx/sites-enabled";

/// The first syntax fault nginx would report in one vhost, phrased the
/// way `nginx -t` phrases it. Deliberately shallow: it knows blocks and
/// statements, not directive names, which is what makes an edit made in
/// the file manager either load or not.
fn vhost_fault(path: &str, content: &str) -> Option<String> {
    let mut depth: i64 = 0;
    for (index, raw) in content.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        for ch in line.chars() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth < 0 {
                        return Some(format!("nginx: [emerg] unexpected \"}}\" in {path}:{line_no}"));
                    }
                }
                _ => {}
            }
        }
        if !(line.ends_with(';') || line.ends_with('{') || line.ends_with('}')) {
            return Some(format!(
                "nginx: [emerg] directive \"{}\" is not terminated by \";\" in {path}:{line_no}",
                line.split_whitespace().next().unwrap_or(line)
            ));
        }
    }
    if depth > 0 {
        let last = content.lines().count();
        return Some(format!(
            "nginx: [emerg] unexpected end of file, expecting \"}}\" in {path}:{last}"
        ));
    }
    None
}

pub struct SimSites(pub Arc<Sim>);

#[async_trait]
impl Sites for SimSites {
    async fn list(&self, _ctx: &Ctx) -> PResult<Vec<SiteInfo>> {
        let w = self.0.world.lock();
        let mut out: Vec<SiteInfo> = w.sites.iter().map(|s| s.info.clone()).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn create(&self, _ctx: &Ctx, p: SiteCreateParams) -> PResult<SiteConfigResult> {
        let webroot = clean_path(&p.webroot)?;
        let entry = {
            let mut w = self.0.world.lock();
            if w.sites.iter().any(|s| s.info.name == p.name) {
                return Err(ProviderError::conflict(format!("site {} already exists", p.name)));
            }
            let info = SiteInfo {
                name: p.name.clone(),
                webroot: webroot.clone(),
                server_names: p.server_names.clone(),
                runtime: p.runtime.clone(),
                runtime_version: p.runtime_version.clone().filter(|v| !v.is_empty()),
                enabled: true,
                config_path: format!("/etc/nginx/sites-available/{}", p.name),
            };
            let entry = Site {
                info,
                upstream: p.upstream.clone().unwrap_or_default(),
                force_https: p.force_https,
            };
            w.sites.push(entry.clone());
            entry
        };

        let (owner, uid) = match p.owner.as_deref().filter(|o| !o.is_empty()) {
            Some(o) => (o.to_string(), uid_for(o)),
            None => ("www-data".to_string(), 33),
        };

        {
            let mut fs = self.0.fs.write();
            fs.file(&entry.info.config_path, &render_site_config(&entry));
            fs.link(
                &format!("/etc/nginx/sites-enabled/{}", p.name),
                &format!("../sites-available/{}", p.name),
            );
            fs.dir_as(&webroot, "0755", &owner, uid);
        }
        seed_webroot(&self.0, &entry);

        Ok(SiteConfigResult {
            config_path: entry.info.config_path,
        })
    }

    async fn update(&self, _ctx: &Ctx, p: SiteUpdateParams) -> PResult<SiteConfigResult> {
        let snapshot = {
            let mut w = self.0.world.lock();
            let Some(entry) = w.sites.iter_mut().find(|s| s.info.name == p.name) else {
                return Err(ProviderError::not_found(format!("site {}", p.name)));
            };
            if !p.server_names.is_empty() {
                entry.info.server_names = p.server_names.clone();
            }
            if let Some(webroot) = p.webroot.as_deref().filter(|w| !w.is_empty()) {
                entry.info.webroot = clean_path(webroot)?;
            }
            if let Some(v) = p.runtime_version.clone().filter(|v| !v.is_empty()) {
                entry.info.runtime_version = Some(v);
            }
            if let Some(u) = p.upstream.clone().filter(|u| !u.is_empty()) {
                entry.upstream = u;
            }
            if let Some(force) = p.force_https {
                entry.force_https = force;
            }
            if let Some(enabled) = p.enabled {
                entry.info.enabled = enabled;
            }
            entry.clone()
        };

        {
            let mut fs = self.0.fs.write();
            fs.file(&snapshot.info.config_path, &render_site_config(&snapshot));
            let link = format!("/etc/nginx/sites-enabled/{}", p.name);
            if snapshot.info.enabled {
                fs.link(&link, &format!("../sites-available/{}", p.name));
            } else {
                fs.detach(&link);
            }
        }
        Ok(SiteConfigResult {
            config_path: snapshot.info.config_path,
        })
    }

    async fn remove(&self, _ctx: &Ctx, p: SiteRemoveParams) -> PResult<()> {
        let (webroot, config_path) = {
            let mut w = self.0.world.lock();
            let Some(idx) = w.sites.iter().position(|s| s.info.name == p.name) else {
                return Err(ProviderError::not_found(format!("site {}", p.name)));
            };
            let site = w.sites.remove(idx);
            (site.info.webroot, site.info.config_path)
        };

        let mut fs = self.0.fs.write();
        fs.detach(&config_path);
        fs.detach(&format!("/etc/nginx/sites-enabled/{}", p.name));
        if p.delete_webroot {
            if let Some(n) = fs.detach(&webroot) {
                debug_assert_eq!(n.name, path_base(&webroot));
                self.0.account_bytes(-tree_size(&n));
            }
        }
        Ok(())
    }

    /// `nginx -t` over what is really enabled. This used to answer "syntax
    /// is ok" unconditionally, so a vhost broken in the file manager could
    /// never fail the pre-reload check the control plane relies on to keep
    /// one bad site from taking the whole host offline. It now reads every
    /// file under sites-enabled and reports the first fault the way nginx
    /// does: unbalanced braces and directives missing their semicolon.
    async fn test_config(&self, _ctx: &Ctx) -> PResult<SiteTestConfigResult> {
        let faults = {
            let fs = self.0.fs.read();
            let enabled: Vec<String> = match fs.lookup(SITES_ENABLED, true) {
                Ok((dir, _)) => dir.children.keys().cloned().collect(),
                Err(_) => Vec::new(),
            };
            let mut faults = Vec::new();
            for name in enabled {
                let path = format!("{SITES_ENABLED}/{name}");
                match fs.lookup(&path, true) {
                    Ok((node, _)) => {
                        if let Some(fault) = vhost_fault(&path, &String::from_utf8_lossy(&node.data)) {
                            faults.push(fault);
                        }
                    }
                    Err(_) => faults.push(format!(
                        "nginx: [emerg] open() \"{path}\" failed (2: No such file or directory) in /etc/nginx/nginx.conf:60"
                    )),
                }
            }
            faults
        };

        if let Some(first) = faults.first() {
            return Ok(SiteTestConfigResult {
                valid: false,
                output: format!("{first}\nnginx: configuration file /etc/nginx/nginx.conf test failed\n"),
            });
        }
        Ok(SiteTestConfigResult {
            valid: true,
            output: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\n\
                     nginx: configuration file /etc/nginx/nginx.conf test is successful\n"
                .into(),
        })
    }

    async fn reload(&self, _ctx: &Ctx) -> PResult<()> {
        transition(&self.0, "nginx.service", "reload").map(|_| ())
    }

    /// A release is a real directory in the in-memory tree and `current` a
    /// real symlink, so the file manager, a later rollback and the unit
    /// tests all see the same thing a Linux host would. Git cannot be
    /// reached from a simulated host, so a git release is a deterministic
    /// stand-in tree that records the revision it represents; an upload
    /// release copies what was staged (or what the site already serves).
    async fn release(&self, _ctx: &Ctx, p: SiteReleaseParams) -> PResult<SiteReleaseResult> {
        let root = clean_path(&p.root)?;
        let releases = format!("{root}/releases");
        let target = format!("{releases}/{}", p.release);
        let mut log = Vec::new();

        let commit_sha = if p.source == "git" {
            Some(p.commit_sha.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| {
                simulated_head(
                    p.repo_url.as_deref().unwrap_or_default(),
                    p.branch.as_deref().unwrap_or("main"),
                    &p.release,
                )
            }))
        } else {
            None
        };

        let mut fs = self.0.fs.write();
        if fs.lookup(&target, false).is_ok() {
            return Err(ProviderError::conflict(format!("{target} already exists")));
        }

        match p.source.as_str() {
            "git" => {
                let repo = p.repo_url.clone().unwrap_or_default();
                let branch = p.branch.clone().unwrap_or_else(|| "main".into());
                let sha = commit_sha.clone().unwrap_or_default();
                log.push(format!("cloning {repo} ({branch}) into {target}"));
                fs.dir_as(&target, "0755", "www-data", 33);
                fs.file_as(
                    &format!("{target}/index.html"),
                    &format!(
                        "<!doctype html>\n<title>{}</title>\n<p>Release {} of {repo}@{sha}</p>\n",
                        p.name, p.release
                    ),
                    "0644",
                    "www-data",
                    33,
                );
                log.push(format!("checked out {sha}"));
            }
            _ => {
                let source = clean_path(p.upload_path.as_deref().unwrap_or(&format!("{root}/upload")))?;
                let (node, _) = fs.lookup(&source, true).map_err(|_| {
                    ProviderError::PreconditionFailed(format!("nothing has been uploaded to {source}"))
                })?;
                if !node.is_dir() {
                    return Err(ProviderError::PreconditionFailed(format!(
                        "{source} is not a directory"
                    )));
                }
                let mut tree = node.clone();
                // The webroot can be the deploy root itself, and copying
                // `releases/` into a release would nest every previous
                // release inside the new one.
                for skip in ["releases", "current", ".kaname-release"] {
                    tree.children.remove(skip);
                }
                tree.name = p.release.clone();
                log.push(format!("copying {} entries from {source}", tree.children.len()));
                self.0.account_bytes(tree_size(&tree));
                fs.mkdir_all(&releases).children.insert(p.release.clone(), tree);
            }
        }
        fs.file_as(
            &format!("{target}/.kaname-release"),
            &release_manifest(&p, commit_sha.as_deref()),
            "0644",
            "www-data",
            33,
        );

        let current = format!("{root}/current");
        swap_current(&mut fs, &current, &target)?;
        log.push(format!("{current} -> {target}"));

        let mut pruned = Vec::new();
        for (path, bytes) in prune_releases(&mut fs, &releases, &target, p.keep.max(1) as usize) {
            self.0.account_bytes(-bytes);
            log.push(format!("pruned {path}"));
            pruned.push(path);
        }

        Ok(SiteReleaseResult {
            release_path: target,
            current_path: current,
            commit_sha,
            pruned,
            log,
        })
    }

    async fn activate(&self, _ctx: &Ctx, p: SiteActivateParams) -> PResult<SiteActivateResult> {
        let root = clean_path(&p.root)?;
        let target = clean_path(&p.release_path)?;
        let mut fs = self.0.fs.write();
        match fs.lookup(&target, false) {
            Ok((node, _)) if node.is_dir() => {}
            _ => {
                return Err(ProviderError::not_found(format!(
                    "release directory {target} is not on this host"
                )));
            }
        }
        let current = format!("{root}/current");
        let previous = swap_current(&mut fs, &current, &target)?;
        Ok(SiteActivateResult {
            current_path: current,
            release_path: target,
            previous,
        })
    }
}

/// What the simulated `git rev-parse HEAD` answers: stable for one
/// repository, branch and release, different across releases.
fn simulated_head(repo: &str, branch: &str, release: &str) -> String {
    let digest = Sha256::digest(format!("{repo}\n{branch}\n{release}").as_bytes());
    hex::encode(digest)[..40].to_string()
}

fn release_manifest(p: &SiteReleaseParams, sha: Option<&str>) -> String {
    serde_json::json!({
        "site": p.name,
        "release": p.release,
        "source": p.source,
        "repo_url": p.repo_url,
        "branch": p.branch,
        "commit_sha": sha,
    })
    .to_string()
}

/// Points `current` at `target`, refusing to replace a real directory —
/// that would be a site's only copy of its files, not a previous release.
fn swap_current(fs: &mut MemFs, current: &str, target: &str) -> PResult<Option<String>> {
    let previous = match fs.lookup(current, false) {
        Ok((node, _)) if node.kind == "symlink" => Some(node.target.clone()),
        Ok(_) => {
            return Err(ProviderError::PreconditionFailed(format!(
                "{current} is a real directory, not a release symlink; move it aside before deploying"
            )));
        }
        Err(_) => None,
    };
    fs.link(current, target);
    Ok(previous)
}

/// Keeps the newest `keep` releases (names sort by time) and never the
/// one just written or the one `current` points at.
fn prune_releases(fs: &mut MemFs, releases: &str, keep_path: &str, keep: usize) -> Vec<(String, i64)> {
    let names: Vec<String> = match fs.lookup(releases, false) {
        Ok((dir, _)) => dir.children.keys().cloned().collect(),
        Err(_) => return Vec::new(),
    };
    let mut sorted = names;
    sorted.sort();
    sorted.reverse();
    let mut pruned = Vec::new();
    for name in sorted.into_iter().skip(keep) {
        let path = format!("{releases}/{name}");
        if path == keep_path {
            continue;
        }
        if let Some(node) = fs.detach(&path) {
            pruned.push((path, tree_size(&node)));
        }
    }
    pruned.sort();
    pruned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{
        DnsPublishParams, DnsPublishedRecord, DnsResolveParams, FsWriteParams, Options, ProviderRef,
    };

    async fn open_sim(name: &str) -> ProviderRef {
        super::super::open(Options {
            agent_version: "0.1.0".into(),
            state_dir: std::env::temp_dir().join(format!("kaname-sim-sites-{name}")),
        })
        .await
        .expect("opening the simulator")
    }

    fn git_release(release: &str) -> SiteReleaseParams {
        SiteReleaseParams {
            name: "shop".into(),
            root: "/var/www/shop".into(),
            release: release.into(),
            source: "git".into(),
            repo_url: Some("https://github.com/acme/shop.git".into()),
            branch: Some("main".into()),
            keep: 5,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_deploy_writes_a_release_and_a_rollback_switches_back_to_it() {
        let provider = open_sim("release").await;
        let ctx = Ctx::background();
        let sites = provider.sites();

        let first = sites
            .release(&ctx, git_release("20261101T000000Z-a"))
            .await
            .unwrap();
        assert_eq!(first.release_path, "/var/www/shop/releases/20261101T000000Z-a");
        assert_eq!(first.current_path, "/var/www/shop/current");
        let sha = first.commit_sha.clone().unwrap();
        assert_eq!(sha.len(), 40);

        let second = sites
            .release(&ctx, git_release("20261102T000000Z-b"))
            .await
            .unwrap();
        assert_ne!(second.commit_sha, first.commit_sha);
        let entry = provider
            .files()
            .stat(&ctx, "/var/www/shop/current")
            .await
            .unwrap();
        assert_eq!(entry.kind, "symlink");
        assert_eq!(entry.link_target.as_deref(), Some(second.release_path.as_str()));
        // `current` resolves into the release, so whatever serves it sees it.
        let manifest = provider
            .files()
            .read(
                &ctx,
                crate::providers::FsReadParams {
                    path: "/var/www/shop/current/.kaname-release".into(),
                    max_bytes: 4096,
                },
            )
            .await
            .unwrap();
        assert!(
            manifest.content.contains("20261102T000000Z-b"),
            "{}",
            manifest.content
        );

        let back = sites
            .activate(
                &ctx,
                SiteActivateParams {
                    name: "shop".into(),
                    root: "/var/www/shop".into(),
                    release_path: first.release_path.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(back.previous.as_deref(), Some(second.release_path.as_str()));
        let entry = provider
            .files()
            .stat(&ctx, "/var/www/shop/current")
            .await
            .unwrap();
        assert_eq!(entry.link_target.as_deref(), Some(first.release_path.as_str()));

        // The same release twice is refused rather than overwritten.
        assert!(matches!(
            sites.release(&ctx, git_release("20261101T000000Z-a")).await,
            Err(ProviderError::Conflict(_))
        ));
        provider.close().await;
    }

    #[tokio::test]
    async fn a_release_that_is_not_on_the_host_cannot_be_rolled_back_to() {
        let provider = open_sim("release-missing").await;
        let err = provider
            .sites()
            .activate(
                &Ctx::background(),
                SiteActivateParams {
                    name: "shop".into(),
                    root: "/var/www/shop".into(),
                    release_path: "/var/www/shop/releases/gone".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::NotFound(ref m) if m.contains("is not on this host")),
            "{err:?}"
        );
        provider.close().await;
    }

    #[tokio::test]
    async fn an_upload_release_copies_the_webroot_and_retention_prunes_old_releases() {
        let provider = open_sim("release-upload").await;
        let ctx = Ctx::background();
        provider
            .files()
            .write(
                &ctx,
                FsWriteParams {
                    path: "/var/www/shop/index.html".into(),
                    content: "<p>uploaded</p>".into(),
                    encoding: "utf8".into(),
                    create_parents: true,
                    mode: None,
                },
            )
            .await
            .unwrap();

        let mut upload = SiteReleaseParams {
            name: "shop".into(),
            root: "/var/www/shop".into(),
            source: "upload".into(),
            upload_path: Some("/var/www/shop".into()),
            keep: 2,
            ..Default::default()
        };
        let mut releases = Vec::new();
        for n in 1..=3 {
            upload.release = format!("2026110{n}T000000Z");
            releases.push(provider.sites().release(&ctx, upload.clone()).await.unwrap());
        }
        assert_eq!(releases[0].commit_sha, None);
        // The webroot is the deploy root here; earlier releases are not
        // copied into the new one.
        assert!(
            provider
                .files()
                .stat(&ctx, "/var/www/shop/releases/20261103T000000Z/releases")
                .await
                .is_err()
        );
        assert!(
            provider
                .files()
                .stat(&ctx, "/var/www/shop/releases/20261103T000000Z/index.html")
                .await
                .is_ok()
        );
        assert_eq!(
            releases[2].pruned,
            vec!["/var/www/shop/releases/20261101T000000Z".to_string()]
        );

        let nothing = SiteReleaseParams {
            upload_path: Some("/var/www/nowhere".into()),
            release: "x1".into(),
            ..upload
        };
        assert!(matches!(
            provider.sites().release(&ctx, nothing).await,
            Err(ProviderError::PreconditionFailed(_))
        ));
        provider.close().await;
    }

    /// Suspending is `site.update` with `enabled: false`: the vhost leaves
    /// sites-enabled, the config still tests clean, the site stays listed,
    /// an unrelated update does not quietly resume it, and resuming links
    /// it again.
    #[tokio::test]
    async fn a_suspended_site_stays_listed_disabled_until_it_is_resumed() {
        let provider = open_sim("suspend").await;
        let ctx = Ctx::background();
        let sites = provider.sites();
        let name = sites
            .list(&ctx)
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.enabled)
            .unwrap()
            .name;
        let link = format!("/etc/nginx/sites-enabled/{name}");
        let update = |enabled: Option<bool>| SiteUpdateParams {
            name: name.clone(),
            enabled,
            ..Default::default()
        };

        sites.update(&ctx, update(Some(false))).await.unwrap();
        assert!(provider.files().stat(&ctx, &link).await.is_err());
        assert!(sites.test_config(&ctx).await.unwrap().valid);
        let listed = sites.list(&ctx).await.unwrap();
        assert!(!listed.iter().find(|s| s.name == name).unwrap().enabled);

        sites
            .update(
                &ctx,
                SiteUpdateParams {
                    force_https: Some(true),
                    ..update(None)
                },
            )
            .await
            .unwrap();
        assert!(provider.files().stat(&ctx, &link).await.is_err());

        sites.update(&ctx, update(Some(true))).await.unwrap();
        assert!(provider.files().stat(&ctx, &link).await.is_ok());
        assert!(
            sites
                .list(&ctx)
                .await
                .unwrap()
                .iter()
                .find(|s| s.name == name)
                .unwrap()
                .enabled
        );
        provider.close().await;
    }

    /// The `_kaname` proof Kaname hands the operator resolves once it is
    /// published, and stops resolving when the zone is withdrawn.
    #[tokio::test]
    async fn the_resolver_serves_what_kaname_published() {
        let provider = open_sim("dns-publish").await;
        let ctx = Ctx::background();
        let query = || DnsResolveParams {
            name: "_kaname.shop.example.".into(),
            r#type: "txt".into(),
            resolver: None,
        };
        assert!(provider.dns().resolve(&ctx, query()).await.unwrap().is_empty());

        provider
            .dns()
            .publish(
                &ctx,
                DnsPublishParams {
                    zone: "shop.example".into(),
                    records: vec![DnsPublishedRecord {
                        name: "_kaname.shop.example".into(),
                        r#type: "TXT".into(),
                        content: "kaname-verification=abc".into(),
                        ttl: Some(300),
                    }],
                },
            )
            .await
            .unwrap();
        let answer = provider.dns().resolve(&ctx, query()).await.unwrap();
        assert_eq!(answer[0].values, vec!["kaname-verification=abc".to_string()]);

        provider
            .dns()
            .publish(
                &ctx,
                DnsPublishParams {
                    zone: "shop.example".into(),
                    records: vec![],
                },
            )
            .await
            .unwrap();
        assert!(provider.dns().resolve(&ctx, query()).await.unwrap().is_empty());
        provider.close().await;
    }

    #[test]
    fn rendered_vhosts_pass_the_syntax_check() {
        for runtime in ["static", "php", "node", "python", "proxy", "container"] {
            let entry = Site {
                info: SiteInfo {
                    name: "t".into(),
                    webroot: "/var/www/t".into(),
                    server_names: vec!["t.example.com".into()],
                    runtime: runtime.into(),
                    runtime_version: None,
                    enabled: true,
                    config_path: "/etc/nginx/sites-available/t".into(),
                },
                upstream: "http://127.0.0.1:3000".into(),
                force_https: true,
            };
            assert_eq!(vhost_fault("/x", &render_site_config(&entry)), None, "{runtime}");
        }
    }

    #[test]
    fn faults_are_reported_like_nginx() {
        let open = vhost_fault("/v", "server {\n    listen 80;\n");
        assert!(open.unwrap().contains("unexpected end of file"));
        let bare = vhost_fault("/v", "server {\n    listen 80\n}\n");
        assert!(
            bare.unwrap()
                .contains("directive \"listen\" is not terminated by \";\" in /v:2")
        );
        let extra = vhost_fault("/v", "}\n");
        assert!(extra.unwrap().contains("unexpected \"}\""));
    }
}
