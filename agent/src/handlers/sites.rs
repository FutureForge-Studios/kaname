//! site.* — web server virtual hosts.

use std::sync::Arc;

use crate::providers::{
    OK, SiteActivateParams, SiteCreateParams, SiteListResult, SiteReleaseParams, SiteRemoveParams,
    SiteUpdateParams,
};
use crate::registry::{Registry, StreamMode};
use crate::wire::WireError;

use super::{
    Handlers, NEEDS_NGINX, NO_CAPS, check_enum, check_identifier, decode, invalid, method, or_default,
    present, reply,
};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "site.list",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, _req| async move {
            let sites = h.provider.sites().list(&ctx).await?;
            reply(SiteListResult { sites })
        },
    ));

    r.register(method(
        "site.create",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, req| async move {
            let mut p: SiteCreateParams = decode(&req)?;
            if p.name.is_empty() || p.server_names.is_empty() {
                return Err(invalid("name and at least one server name are required"));
            }
            p.webroot = h.paths.check(&p.webroot)?;
            check_enum(
                "runtime",
                &p.runtime,
                &["static", "php", "node", "python", "proxy", "container"],
            )?;
            if let Some(owner) = present(&p.owner) {
                check_identifier("owner", owner)?;
            }
            reply(h.provider.sites().create(&ctx, p).await?)
        },
    ));

    r.register(method(
        "site.update",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, req| async move {
            let mut p: SiteUpdateParams = decode(&req)?;
            if p.name.is_empty() {
                return Err(invalid("name is required"));
            }
            if let Some(webroot) = present(&p.webroot) {
                p.webroot = Some(h.paths.check(webroot)?);
            }
            reply(h.provider.sites().update(&ctx, p).await?)
        },
    ));

    r.register(method(
        "site.remove",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, req| async move {
            let p: SiteRemoveParams = decode(&req)?;
            if p.name.is_empty() {
                return Err(invalid("name is required"));
            }
            h.provider.sites().remove(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "site.test_config",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, _req| async move { reply(h.provider.sites().test_config(&ctx).await?) },
    ));

    r.register(method(
        "site.reload",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, _req| async move {
            h.provider.sites().reload(&ctx).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "site.release.create",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let mut p: SiteReleaseParams = decode(&req)?;
            check_release_request(&p)?;
            p.root = h.paths.check(&p.root)?;
            if let Some(upload) = present(&p.upload_path) {
                p.upload_path = Some(h.paths.check(upload)?);
            }
            p.keep = or_default(p.keep, 5).min(50);
            reply(h.provider.sites().release(&ctx, p).await?)
        },
    ));

    r.register(method(
        "site.release.activate",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let mut p: SiteActivateParams = decode(&req)?;
            if p.name.is_empty() {
                return Err(invalid("name is required"));
            }
            p.root = h.paths.check(&p.root)?;
            p.release_path = h.paths.check(&p.release_path)?;
            check_release_path(&p.root, &p.release_path)?;
            reply(h.provider.sites().activate(&ctx, p).await?)
        },
    ));
}

/* ------------------------------ releases ----------------------------- */

/// Everything about a release request that does not depend on the host.
/// The repository and branch end up in a `git` argv, so a value that git
/// would read as an option (a leading `-`) is refused outright rather
/// than left to the `--` separator alone.
pub(crate) fn check_release_request(p: &SiteReleaseParams) -> Result<(), WireError> {
    if p.name.is_empty() {
        return Err(invalid("name is required"));
    }
    check_release_name(&p.release)?;
    check_enum("source", &p.source, &["git", "upload"])?;
    if p.source == "git" {
        let Some(repo) = present(&p.repo_url) else {
            return Err(invalid("a git release needs repo_url"));
        };
        check_repo_url(repo)?;
    }
    if let Some(branch) = present(&p.branch) {
        check_branch(branch)?;
    }
    if let Some(sha) = present(&p.commit_sha) {
        if !(7..=40).contains(&sha.len())
            || !sha
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(invalid("commit_sha must be a git object id"));
        }
    }
    Ok(())
}

pub(crate) fn check_release_name(release: &str) -> Result<(), WireError> {
    let bytes = release.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || !bytes[0].is_ascii_alphanumeric() {
        return Err(invalid(
            "release must be 1-64 characters and start with a letter or digit",
        ));
    }
    if !bytes
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(invalid("release contains an illegal character"));
    }
    Ok(())
}

fn check_repo_url(repo: &str) -> Result<(), WireError> {
    if repo.starts_with('-') || repo.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid("repo_url is not a repository address"));
    }
    let scheme = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .any(|prefix| repo.starts_with(prefix));
    // scp-like `git@github.com:owner/repo.git`
    let scp = repo
        .split_once(':')
        .is_some_and(|(left, right)| left.contains('@') && !left.contains('/') && !right.is_empty());
    if !(scheme || scp) {
        return Err(invalid(
            "repo_url must be an https://, ssh:// or git@host:path address",
        ));
    }
    Ok(())
}

fn check_branch(branch: &str) -> Result<(), WireError> {
    let ok = !branch.starts_with('-')
        && !branch.contains("..")
        && branch.len() <= 200
        && branch
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'/'));
    if !ok {
        return Err(invalid("branch is not a valid branch name"));
    }
    Ok(())
}

/// A rollback may only point `current` at one of the site's own releases:
/// anything else would let the control plane aim the vhost at any
/// directory the agent can read.
pub(crate) fn check_release_path(root: &str, release_path: &str) -> Result<(), WireError> {
    let releases = format!("{}/releases/", root.trim_end_matches('/'));
    let Some(rest) = release_path.strip_prefix(&releases) else {
        return Err(invalid(format!("release_path must be inside {releases}")));
    };
    check_release_name(rest.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &str, branch: &str) -> SiteReleaseParams {
        SiteReleaseParams {
            name: "shop".into(),
            root: "/var/www/shop".into(),
            release: "20261107T101500Z-abcd1234".into(),
            source: "git".into(),
            repo_url: Some(repo.into()),
            branch: Some(branch.into()),
            ..Default::default()
        }
    }

    #[test]
    fn git_releases_refuse_anything_git_would_read_as_an_option() {
        assert!(check_release_request(&git("https://github.com/acme/shop.git", "main")).is_ok());
        assert!(check_release_request(&git("git@github.com:acme/shop.git", "release/2.1")).is_ok());
        assert!(check_release_request(&git("--upload-pack=touch /tmp/x", "main")).is_err());
        assert!(check_release_request(&git("/srv/repo", "main")).is_err());
        assert!(check_release_request(&git("https://x/y.git", "--force")).is_err());
        assert!(check_release_request(&git("https://x/y.git", "a..b")).is_err());
        let mut no_repo = git("https://x/y.git", "main");
        no_repo.repo_url = None;
        assert!(check_release_request(&no_repo).is_err());
        let mut bad_sha = git("https://x/y.git", "main");
        bad_sha.commit_sha = Some("ABCDEF1".into());
        assert!(check_release_request(&bad_sha).is_err());
    }

    #[test]
    fn release_names_and_rollback_targets_stay_inside_the_site() {
        assert!(check_release_name("../etc").is_err());
        assert!(check_release_name("a/b").is_err());
        assert!(check_release_name("").is_err());
        assert!(check_release_path("/var/www/shop", "/var/www/shop/releases/r1").is_ok());
        assert!(check_release_path("/var/www/shop", "/var/www/other/releases/r1").is_err());
        assert!(check_release_path("/var/www/shop", "/var/www/shop/releases/r1/sub").is_err());
        assert!(check_release_path("/var/www/shop", "/var/www/shop/current").is_err());
    }
}
