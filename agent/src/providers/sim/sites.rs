//! nginx virtual hosts.
//!
//! A site is a vhost file in the in-memory tree plus a row here; the two
//! are written together so the editor and `site.list` never disagree.

use std::sync::Arc;

use async_trait::async_trait;

use super::certs;
use super::files::{clean_path, path_base, tree_size, uid_for};
use super::services::transition;
use super::state::Sim;
use crate::providers::{
    Ctx, PResult, ProviderError, SiteConfigResult, SiteCreateParams, SiteInfo, SiteRemoveParams,
    SiteTestConfigResult, SiteUpdateParams, Sites,
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

    async fn test_config(&self, _ctx: &Ctx) -> PResult<SiteTestConfigResult> {
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
}
