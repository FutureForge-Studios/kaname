//! The path guard at the RPC boundary.
//!
//! This is the first thing every path argument meets, before any provider
//! sees it, and it carries one rule the provider's own guard does not: a
//! denied set covering the agent's state directory, which holds the private
//! key the host enrolled with. A file verb that could read or overwrite
//! that key would turn a file browser into an identity theft.

use std::io;
use std::path::Path;

use crate::wire::{ErrorCode, WireError};

/// Re-validates every path that crosses the RPC boundary. The denied set
/// exists so no file verb can read or overwrite the agent's own key
/// material, whether it is named directly or reached by symlink.
#[derive(Clone, Debug, Default)]
pub struct PathGuard {
    denied: Vec<String>,
}

impl PathGuard {
    /// Builds a guard denying `dirs`, each made absolute and cleaned with
    /// POSIX rules.
    pub fn new(dirs: &[&Path]) -> Self {
        let mut guard = PathGuard::default();
        for dir in dirs {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let absolute = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
            let text = absolute.to_string_lossy().replace('\\', "/");
            guard.denied.push(clean(&text));
        }
        guard
    }

    /// Builds a guard from already-absolute POSIX directories, without the
    /// absolutisation `new` performs. What is under test in the suite is
    /// `check`, not the constructor.
    #[cfg(test)]
    pub fn denying(dirs: &[&str]) -> Self {
        PathGuard {
            denied: dirs.iter().map(|d| d.to_string()).collect(),
        }
    }

    /// Validates one path and returns its cleaned form. Handlers overwrite
    /// their parameter with the result, so a provider only ever sees a
    /// normalised path the guard has looked at.
    pub fn check(&self, raw: &str) -> Result<String, WireError> {
        if raw.is_empty() {
            return Err(WireError::invalid("path is required"));
        }
        if raw.contains('\0') {
            return Err(WireError::invalid("path may not contain a null byte"));
        }
        if !raw.starts_with('/') {
            return Err(WireError::invalid(format!("path must be absolute: {raw}")));
        }
        if raw.split('/').any(|segment| segment == "..") {
            return Err(WireError::invalid(format!(
                "path may not traverse upwards: {raw}"
            )));
        }

        // Managed hosts are POSIX, so paths are cleaned with POSIX rules
        // even when the agent itself is running the simulator elsewhere.
        let cleaned = clean(raw);

        let resolved = resolve_existing(&cleaned)
            .map_err(|e| WireError::new(ErrorCode::IoError, format!("cannot resolve {cleaned}: {e}")))?;
        if resolved.contains("/../") || resolved.ends_with("/..") {
            return Err(WireError::new(
                ErrorCode::PermissionDenied,
                format!("path escapes through a symlink: {raw}"),
            ));
        }
        for denied in &self.denied {
            if within(&cleaned, denied) || within(&resolved, denied) {
                return Err(WireError::new(
                    ErrorCode::PermissionDenied,
                    format!("path is reserved by the agent: {raw}"),
                ));
            }
        }
        Ok(cleaned)
    }

    /// Validates a batch. One bad member fails the whole batch: returning
    /// the good paths alongside an error would let a caller that ignores
    /// the error act on half a request that was never validated.
    pub fn check_all(&self, raws: &[String]) -> Result<Vec<String>, WireError> {
        if raws.is_empty() {
            return Err(WireError::invalid("at least one path is required"));
        }
        raws.iter().map(|raw| self.check(raw)).collect()
    }
}

/// Go's `path.Clean` for POSIX paths: collapses repeated separators, drops
/// `.` segments, resolves `..` lexically and strips a trailing slash.
pub fn clean(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let rooted = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match out.last() {
                Some(&last) if last != ".." => {
                    out.pop();
                }
                _ => {
                    if !rooted {
                        out.push("..");
                    }
                }
            },
            s => out.push(s),
        }
    }
    if rooted {
        format!("/{}", out.join("/"))
    } else if out.is_empty() {
        ".".to_string()
    } else {
        out.join("/")
    }
}

/// Go's `path.Join`: empty elements are ignored and the result is cleaned.
fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => String::new(),
        (true, false) => clean(b),
        (false, true) => clean(a),
        (false, false) => clean(&format!("{a}/{b}")),
    }
}

/// Go's `path.Dir`.
fn dir(path: &str) -> String {
    let cut = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    clean(&path[..cut])
}

/// Go's `path.Base`.
fn base(path: &str) -> &str {
    if path.is_empty() {
        return ".";
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/";
    }
    match trimmed.rfind('/') {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

/// Resolves the symlinks of the deepest part of the path that exists, then
/// re-attaches the part that does not. A path being created still gets its
/// parents checked.
pub fn resolve_existing(p: &str) -> io::Result<String> {
    let mut current = p.to_string();
    let mut remainder = String::new();

    loop {
        match std::fs::canonicalize(&current) {
            Ok(resolved) => {
                let resolved = resolved.to_string_lossy().replace('\\', "/");
                return Ok(join(&resolved, &remainder));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let parent = dir(&current);
        if parent == current {
            return Ok(p.to_string());
        }
        remainder = join(base(&current), &remainder);
        current = parent;
    }
}

/// Whether `candidate` is `root` or lies beneath it. A sibling whose name
/// merely starts with the root is not within it.
pub fn within(candidate: &str, root: &str) -> bool {
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_everything_that_could_escape() {
        let guard = PathGuard::denying(&[]);
        let cases: &[(&str, &str, ErrorCode)] = &[
            ("empty", "", ErrorCode::InvalidParams),
            ("relative", "var/www/html", ErrorCode::InvalidParams),
            ("dot relative", "./var/www", ErrorCode::InvalidParams),
            ("bare traversal", "../../etc/shadow", ErrorCode::InvalidParams),
            (
                "traversal out of a legitimate root",
                "/var/www/../../etc/shadow",
                ErrorCode::InvalidParams,
            ),
            (
                "traversal wearing a dot segment",
                "/var/www/./../../etc",
                ErrorCode::InvalidParams,
            ),
            ("trailing traversal", "/var/www/..", ErrorCode::InvalidParams),
            ("traversal off the root", "/..", ErrorCode::InvalidParams),
            (
                "null byte truncation",
                "/var/www/index.html\x00.jpg",
                ErrorCode::InvalidParams,
            ),
            (
                "windows drive path",
                r"C:\Windows\System32\config\SAM",
                ErrorCode::InvalidParams,
            ),
            (
                "windows unc path",
                r"\\server\share\secret",
                ErrorCode::InvalidParams,
            ),
            (
                "windows relative backslash",
                r"..\..\etc\shadow",
                ErrorCode::InvalidParams,
            ),
        ];
        for (name, raw, code) in cases {
            match guard.check(raw) {
                Ok(got) => panic!("{name}: check({raw:?}) accepted the path and returned {got:?}"),
                Err(err) => assert_eq!(
                    err.code, *code,
                    "{name}: check({raw:?}) failed with the wrong code"
                ),
            }
        }
    }

    #[test]
    fn accepts_legitimate_paths_and_returns_the_cleaned_form() {
        let guard = PathGuard::denying(&[]);
        let cases = [
            ("/", "/"),
            ("/var/www", "/var/www"),
            ("/var/www/", "/var/www"),
            ("/var//www///html", "/var/www/html"),
            ("/var/./www/./html", "/var/www/html"),
            (
                "/etc/nginx/sites-available/example.conf",
                "/etc/nginx/sites-available/example.conf",
            ),
            // Nothing in the agent percent-decodes a path, so this is a
            // directory literally called "..%2f..", not a traversal.
            ("/var/www/..%2f..", "/var/www/..%2f.."),
        ];
        for (raw, want) in cases {
            let got = guard
                .check(raw)
                .unwrap_or_else(|e| panic!("check({raw:?}) rejected a legitimate path: {e}"));
            // Handlers overwrite their parameter with this value, so a guard
            // that returned the raw string would hand the provider an
            // unnormalised path it had never validated.
            assert_eq!(got, want, "check({raw:?})");
        }
    }

    #[test]
    fn refuses_the_agents_own_state_directory() {
        let guard = PathGuard::denying(&["/var/lib/kaname"]);
        for raw in [
            "/var/lib/kaname",
            "/var/lib/kaname/",
            "/var/lib/kaname/agent.key",
            "/var/lib/kaname/certs/client.pem",
            "/var/lib/kaname/./agent.key",
            "/var/lib//kaname//agent.key",
        ] {
            match guard.check(raw) {
                Ok(got) => panic!("check({raw:?}) reached the agent's key material as {got:?}"),
                Err(err) => assert_eq!(err.code, ErrorCode::PermissionDenied, "check({raw:?})"),
            }
        }
        // The prefix trap: a sibling whose name merely starts with the
        // guarded one is an ordinary directory and must stay reachable.
        for raw in [
            "/var/lib/kaname-backups",
            "/var/lib/kaname.old/notes.txt",
            "/var/lib",
            "/var/lib/other/kaname",
        ] {
            guard
                .check(raw)
                .unwrap_or_else(|e| panic!("check({raw:?}) was denied: {e}"));
        }
    }

    #[test]
    fn honours_every_denied_directory() {
        let guard = PathGuard::denying(&["/var/lib/kaname", "/etc/kaname"]);
        for raw in ["/var/lib/kaname/agent.key", "/etc/kaname/agent.toml"] {
            assert!(
                guard.check(raw).is_err(),
                "check({raw:?}) was allowed past a denied directory"
            );
        }
        guard.check("/srv/app").expect("an unrelated path was denied");
    }

    #[test]
    fn checks_every_member_of_a_batch() {
        let guard = PathGuard::denying(&["/var/lib/kaname"]);
        assert!(guard.check_all(&[]).is_err(), "an empty batch was accepted");

        // fs.remove and fs.chmod take a batch. Returning the good paths
        // alongside an error would let a caller that ignores the error act
        // on half a request that was never validated.
        for batch in [
            vec!["/var/www", "/var/www/../../etc/shadow"],
            vec!["/var/www", "/var/lib/kaname/agent.key"],
            vec!["/var/www", "relative"],
            vec!["/var/www", ""],
        ] {
            let batch: Vec<String> = batch.into_iter().map(String::from).collect();
            assert!(
                guard.check_all(&batch).is_err(),
                "check_all({batch:?}) was accepted"
            );
        }

        let got = guard
            .check_all(&["/var/www/".to_string(), "/etc//nginx".to_string()])
            .expect("a legitimate batch was rejected");
        assert_eq!(got, vec!["/var/www", "/etc/nginx"]);
    }

    #[test]
    fn within_does_not_mistake_a_sibling_for_a_child() {
        let cases = [
            ("/var/lib/kaname", "/var/lib/kaname", true),
            ("/var/lib/kaname/agent.key", "/var/lib/kaname", true),
            // The prefix trap that decides whether the denied set works.
            ("/var/lib/kaname-backups", "/var/lib/kaname", false),
            ("/var/lib/kanameX", "/var/lib/kaname", false),
            ("/var/lib", "/var/lib/kaname", false),
            ("/etc/shadow", "/var/lib/kaname", false),
        ];
        for (candidate, root, want) in cases {
            assert_eq!(within(candidate, root), want, "within({candidate:?}, {root:?})");
        }
    }

    #[test]
    fn clean_matches_go_path_clean() {
        assert_eq!(clean(""), ".");
        assert_eq!(clean("/"), "/");
        assert_eq!(clean("//"), "/");
        assert_eq!(clean("/a/b/../c"), "/a/c");
        assert_eq!(clean("/../a"), "/a");
        assert_eq!(clean("a/../../b"), "../b");
        assert_eq!(clean("a/./b/"), "a/b");
        assert_eq!(dir("/a/b"), "/a");
        assert_eq!(dir("/a"), "/");
        assert_eq!(dir("/"), "/");
        assert_eq!(base("/a/b/"), "b");
        assert_eq!(base("/"), "/");
        assert_eq!(join("/a", "b/c"), "/a/b/c");
        assert_eq!(join("/a", ""), "/a");
    }

    #[test]
    fn symlinks_are_followed_into_the_denied_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical tempdir");
        let state = root.join("state");
        std::fs::create_dir(&state).unwrap();
        std::fs::write(state.join("agent.key"), b"secret").unwrap();
        let link = root.join("innocent");
        std::os::unix::fs::symlink(&state, &link).unwrap();

        let guard = PathGuard::new(&[&state]);
        let via_link = format!("{}/agent.key", link.display());
        let err = guard
            .check(&via_link)
            .expect_err("a symlink into the state dir was accepted");
        assert_eq!(err.code, ErrorCode::PermissionDenied);

        // A file that does not exist yet under the symlink is still caught:
        // its existing parents are what get resolved.
        let fresh = format!("{}/new/agent.key", link.display());
        assert_eq!(guard.check(&fresh).unwrap_err().code, ErrorCode::PermissionDenied);

        // And a neighbour outside the denied set passes through cleaned.
        let ok = format!("{}//other/", root.display());
        assert_eq!(guard.check(&ok).unwrap(), format!("{}/other", root.display()));
    }
}
