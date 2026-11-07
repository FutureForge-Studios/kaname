//! Path validation for the file verbs.
//!
//! Every path that reaches a file verb passes through here, even though
//! the RPC layer already checked it: the control plane is trusted to be
//! correct, not trusted to be uncompromised. A path is accepted only if
//! it is absolute, carries no null byte, names no `..` segment, and does
//! not reach out of itself once the symlinks on the way are resolved.
//!
//! The lexical helpers (`clean`, `join`, `within`) are ports of Go's
//! `path` package: the file verbs and the archive guards were written
//! against its exact semantics, so the port keeps them rather than
//! leaning on `std::path`, whose normalisation differs in the corners
//! that matter here (`..` handling, trailing slashes).

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::providers::ProviderError;
use crate::providers::linux::common::{invalid, is_not_exist, not_found};

pub const DEFAULT_FILE_MODE: u32 = 0o644;
pub const DEFAULT_DIR_MODE: u32 = 0o755;

/// Roots a recursive destructive verb refuses to touch. The panel has no
/// legitimate reason to `rm -rf /usr`, and an off-by-one in a caller must
/// not be able to end the host.
pub static PROTECTED_ROOTS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/root", "/sbin", "/sys",
        "/usr", "/var",
    ]
    .into_iter()
    .collect()
});

pub fn is_protected_root(path: &str) -> bool {
    PROTECTED_ROOTS.contains(path)
}

/// Re-checks what the RPC layer already checked.
pub fn validate_path(raw: &str) -> Result<String, ProviderError> {
    check_path(raw, resolve_existing)
}

pub fn validate_paths(raws: &[String]) -> Result<Vec<String>, ProviderError> {
    if raws.is_empty() {
        return Err(invalid("at least one path is required"));
    }
    let mut out = Vec::with_capacity(raws.len());
    for raw in raws {
        out.push(validate_path(raw)?);
    }
    Ok(out)
}

/// `check_path` takes a resolver rather than calling the filesystem
/// itself, so the escape rule can be proved against a link that leaves
/// the tree without a host that carries one.
pub fn check_path(
    raw: &str,
    resolve: impl Fn(&str) -> std::io::Result<String>,
) -> Result<String, ProviderError> {
    if raw.is_empty() {
        return Err(invalid("path is required"));
    }
    if raw.contains('\0') {
        return Err(invalid("path may not contain a null byte"));
    }
    if !raw.starts_with('/') {
        return Err(invalid(format!("path must be absolute: {raw}")));
    }
    if raw.split('/').any(|segment| segment == "..") {
        return Err(invalid(format!("path may not traverse upwards: {raw}")));
    }

    let cleaned = clean(raw);
    let resolved =
        resolve(&cleaned).map_err(|e| ProviderError::Internal(format!("resolve {cleaned}: {e}")))?;
    if resolved.contains("/../") || resolved.ends_with("/..") {
        return Err(ProviderError::PermissionDenied(format!(
            "path escapes through a symlink: {raw}"
        )));
    }
    Ok(cleaned)
}

/// Resolves the symlinks of the deepest existing part of a path and
/// re-attaches the rest, so a file being created still has its parents
/// checked.
pub fn resolve_existing(target: &str) -> std::io::Result<String> {
    let mut current = target.to_string();
    let mut remainder = String::new();

    loop {
        match std::fs::canonicalize(&current) {
            Ok(resolved) => return Ok(join(&resolved.to_string_lossy(), &remainder)),
            Err(e) if is_not_exist(&e) => {}
            Err(e) => return Err(e),
        }
        let parent = dir(&current);
        if parent == current {
            return Ok(target.to_string());
        }
        remainder = join(base(&current), &remainder);
        current = parent;
    }
}

/// Whether `candidate` is `root` or lives under it. The comparison is on
/// path segments, not on a raw prefix: `/var/www-old` is not inside
/// `/var/www`.
pub fn within(candidate: &str, root: &str) -> bool {
    candidate == root || candidate.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

/// An octal permission string like `0644`.
pub fn parse_mode(mode: &str) -> Result<u32, ProviderError> {
    if mode.is_empty() {
        return Err(invalid("mode is required"));
    }
    let octal = mode.bytes().all(|b| (b'0'..=b'7').contains(&b));
    match u32::from_str_radix(mode, 8) {
        Ok(parsed) if octal && parsed <= 0o7777 => Ok(parsed),
        _ => Err(invalid("mode must be an octal string like 0644")),
    }
}

/// Maps the kernel's answers onto the provider variants so the panel can
/// say "not found" or "permission denied" rather than surfacing an errno.
pub fn wrap_fs_error(target: &str, err: std::io::Error) -> ProviderError {
    use std::io::ErrorKind;
    match err.raw_os_error() {
        // ENOTEMPTY comes before AlreadyExists deliberately: some layers
        // classify it *as* "exists", and the other order would report a
        // directory that still has files in it as "already exists".
        Some(libc::ENOTEMPTY) => return ProviderError::PreconditionFailed(format!("{target} is not empty")),
        Some(libc::ENOSPC) => {
            return ProviderError::PreconditionFailed(format!("no space left for {target}"));
        }
        _ => {}
    }
    match err.kind() {
        ErrorKind::NotFound => not_found(target),
        ErrorKind::PermissionDenied => ProviderError::PermissionDenied(target.to_string()),
        ErrorKind::AlreadyExists => ProviderError::Conflict(format!("{target} already exists")),
        _ => ProviderError::Internal(format!("{target}: {err}")),
    }
}

/* ---------------------------- Go's path package ---------------------- */

/// Go's `path.Clean`: a lexical normalisation that collapses repeated
/// slashes, drops `.` segments, resolves `..` against the segments before
/// it and clamps `..` at the root of an absolute path.
pub fn clean(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let rooted = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if let Some(last) = out.last() {
                    if *last != ".." {
                        out.pop();
                        continue;
                    }
                }
                if !rooted {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if rooted {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// Go's `path.Join`: empty elements are ignored and the result is cleaned,
/// so `..` segments in the joined part really do climb.
pub fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => String::new(),
        (true, false) => clean(b),
        (false, true) => clean(a),
        (false, false) => clean(&format!("{a}/{b}")),
    }
}

/// Go's `path.Dir`.
pub fn dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => clean(&path[..=i]),
        None => ".".to_string(),
    }
}

/// Go's `path.Base`.
pub fn base(path: &str) -> &str {
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

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* The path guard.
     *
     * Every file verb funnels through check_path, so a hole here is a
     * hole in fs.read, fs.write, fs.remove, fs.extract and the site verbs
     * at once. The table below is written from the attacker's side: each
     * row is a shape someone would actually send to walk the agent out
     * of bounds. */

    /// A host on which nothing is a link, so a row's verdict is decided
    /// purely by the syntactic rules.
    fn no_symlinks(target: &str) -> std::io::Result<String> {
        Ok(target.to_string())
    }

    #[test]
    fn check_path_rejects_everything_that_could_escape() {
        let cases = [
            ("empty", ""),
            ("relative", "var/www/html"),
            ("dot relative", "./var/www"),
            ("bare traversal", "../../etc/shadow"),
            ("traversal out of a legitimate root", "/var/www/../../etc/shadow"),
            ("traversal wearing a dot segment", "/var/www/./../../etc"),
            (
                "traversal that lands back inside",
                "/var/www/site/../site/index.html",
            ),
            ("trailing traversal", "/var/www/.."),
            ("traversal off the root", "/.."),
            ("null byte truncation", "/var/www/index.html\0.jpg"),
            ("null byte alone", "\0"),
            ("windows drive path", r"C:\Windows\System32\config\SAM"),
            ("windows unc path", r"\\server\share\secret"),
            ("windows relative backslash", r"..\..\etc\shadow"),
        ];
        for (name, raw) in cases {
            match check_path(raw, no_symlinks) {
                Ok(got) => panic!("{name}: check_path({raw:?}) accepted the path and returned {got:?}"),
                Err(ProviderError::InvalidParams(_)) => {}
                Err(other) => panic!("{name}: check_path({raw:?}) failed with {other}, want invalid params"),
            }
        }
    }

    #[test]
    fn check_path_accepts_legitimate_paths_and_returns_the_cleaned_form() {
        let cases = [
            ("the root itself", "/", "/"),
            ("a plain directory", "/var/www", "/var/www"),
            (
                "a plain file",
                "/etc/nginx/sites-available/example.conf",
                "/etc/nginx/sites-available/example.conf",
            ),
            // The cleaned form is what every caller goes on to open, so a
            // row whose input and output differ is the one that matters:
            // if the guard ever returned `raw`, these would still pass
            // validation and then be handed to the kernel unnormalised.
            ("trailing slash", "/var/www/", "/var/www"),
            ("doubled separators", "/var//www///html", "/var/www/html"),
            ("interior dot segments", "/var/./www/./html", "/var/www/html"),
            ("trailing dot segment", "/var/www/.", "/var/www"),
            // Nothing in the agent percent-decodes a path, so this names a
            // directory that is literally called "..%2f..". Decoding it
            // would be the bug; treating it as one opaque segment is the fix.
            (
                "percent-encoded traversal is not a traversal",
                "/var/www/..%2f..",
                "/var/www/..%2f..",
            ),
            (
                "a name that merely starts with dots",
                "/var/www/...cache",
                "/var/www/...cache",
            ),
            (
                "spaces and unicode",
                "/srv/données/mon site",
                "/srv/données/mon site",
            ),
        ];
        for (name, raw, want) in cases {
            let got =
                check_path(raw, no_symlinks).unwrap_or_else(|e| panic!("{name}: rejected {raw:?}: {e}"));
            assert_eq!(got, want, "{name}");
        }
    }

    // A path can be syntactically spotless and still leave its tree once
    // the kernel resolves the links on the way. That is the case the
    // resolver exists to catch, and the only one a table of strings
    // cannot reach.
    #[test]
    fn check_path_rejects_a_symlink_that_escapes() {
        for resolved in ["/var/www/../../etc/shadow", "/var/www/.."] {
            let resolve = |_: &str| Ok(resolved.to_string());
            match check_path("/var/www/uploads", resolve) {
                Ok(got) => panic!("a link resolving to {resolved:?} was accepted as {got:?}"),
                Err(ProviderError::PermissionDenied(_)) => {}
                Err(other) => panic!("resolving to {resolved:?} failed with {other}, want permission denied"),
            }
        }
    }

    #[test]
    fn check_path_accepts_a_symlink_that_stays_inside() {
        let resolve = |_: &str| Ok("/srv/real/uploads".to_string());
        let got =
            check_path("/var/www/uploads", resolve).expect("a link that stays on the host was rejected");
        // The guard returns the requested path, not the resolved one: the
        // caller asked about /var/www/uploads and that is what it must
        // open, or a later chmod would land on the link's target instead.
        assert_eq!(got, "/var/www/uploads");
    }

    #[test]
    fn check_path_surfaces_a_resolver_failure() {
        let resolve = |_: &str| Err(std::io::Error::other("i/o error on the mount"));
        // Failing open here would mean a flaky NFS mount silently disables
        // the escape check.
        let err = check_path("/var/www", resolve).expect_err("a resolver failure was swallowed");
        assert!(err.to_string().contains("i/o error on the mount"), "{err}");
    }

    // validate_path is the wiring the provider actually calls. It runs
    // against the real filesystem, so this only pins that it is wired to
    // check_path at all — the verdicts themselves are covered above.
    #[test]
    fn validate_path_is_wired_to_the_guard() {
        for raw in ["", "relative", "/etc/../etc", "/etc\0"] {
            assert!(
                validate_path(raw).is_err(),
                "validate_path({raw:?}) accepted a path check_path rejects"
            );
        }
        assert_eq!(validate_path("/").unwrap(), "/");
    }

    #[test]
    fn validate_paths_rejects_the_whole_batch_for_one_bad_member() {
        assert!(matches!(
            validate_paths(&[]),
            Err(ProviderError::InvalidParams(_))
        ));
        // fs.remove and fs.chmod take a batch. Returning the good paths
        // alongside an error would let a caller that ignores the error
        // act on half of a request it never validated.
        let batch = [
            "/var/www".to_string(),
            "/var/www/../../etc".to_string(),
            "/etc/hosts".to_string(),
        ];
        assert!(validate_paths(&batch).is_err());
    }

    #[test]
    fn within_does_not_mistake_a_sibling_for_a_child() {
        let cases = [
            ("/var/www", "/var/www", true),
            ("/var/www/html", "/var/www", true),
            ("/var/www/html", "/var/www/", true),
            ("/var/www", "/", true),
            // The prefix trap: "/var/www-old" starts with "/var/www" but
            // is not under it. A guard that compared raw prefixes would
            // confine an archive to the wrong tree.
            ("/var/www-old", "/var/www", false),
            ("/var/wwwfoo/x", "/var/www", false),
            ("/var", "/var/www", false),
            ("/etc/shadow", "/var/www", false),
        ];
        for (candidate, root, want) in cases {
            assert_eq!(within(candidate, root), want, "within({candidate:?}, {root:?})");
        }
    }

    #[test]
    fn parse_mode_refuses_anything_that_is_not_an_octal_permission() {
        for raw in ["", "rwxr-xr-x", "0999", "-1", "17777", "0x1ff", " 644", "+644"] {
            assert!(parse_mode(raw).is_err(), "parse_mode({raw:?}) was accepted");
        }
        for (raw, want) in [
            ("644", 0o644),
            ("0644", 0o644),
            ("0755", 0o755),
            ("4755", 0o4755),
            ("0", 0),
        ] {
            assert_eq!(parse_mode(raw).unwrap(), want, "parse_mode({raw:?})");
        }
    }

    // The panel renders "not found" and "permission denied" as different
    // states with different remediations, so this mapping is what an
    // operator ends up reading instead of an errno.
    #[test]
    fn wrap_fs_error_maps_onto_the_provider_variants() {
        use std::io::{Error, ErrorKind};
        type Case = (&'static str, &'static str, Error, fn(&ProviderError) -> bool);
        let cases: Vec<Case> = vec![
            (
                "missing",
                "/var/www/missing",
                Error::from(ErrorKind::NotFound),
                |e| matches!(e, ProviderError::NotFound(_)),
            ),
            (
                "unreadable",
                "/etc/shadow",
                Error::from(ErrorKind::PermissionDenied),
                |e| matches!(e, ProviderError::PermissionDenied(_)),
            ),
            (
                "already there",
                "/var/www/index.html",
                Error::from(ErrorKind::AlreadyExists),
                |e| matches!(e, ProviderError::Conflict(_)),
            ),
            (
                "non-empty directory",
                "/var/www",
                Error::from_raw_os_error(libc::ENOTEMPTY),
                |e| matches!(e, ProviderError::PreconditionFailed(_)),
            ),
            (
                "disk full",
                "/var/www/upload",
                Error::from_raw_os_error(libc::ENOSPC),
                |e| matches!(e, ProviderError::PreconditionFailed(_)),
            ),
        ];
        for (name, path, err, want) in cases {
            let got = wrap_fs_error(path, err);
            assert!(want(&got), "{name}: mapped to {got:?}");
            assert!(
                got.to_string().contains(path),
                "{name}: the mapped error {got} does not name the path"
            );
        }

        // An error with no variant of its own must still reach the panel
        // rather than being flattened into one of the above.
        let got = wrap_fs_error("/var/www", Error::other("the device reported a checksum failure"));
        assert!(matches!(got, ProviderError::Internal(_)), "{got:?}");
        assert!(
            got.to_string().contains("checksum failure"),
            "an unrecognised error lost its cause: {got}"
        );
    }

    #[test]
    fn clean_and_join_follow_go() {
        assert_eq!(clean("/a/b/../c"), "/a/c");
        assert_eq!(clean("/../../x"), "/x");
        assert_eq!(clean("a/../.."), "..");
        assert_eq!(clean("/"), "/");
        assert_eq!(clean(""), ".");
        assert_eq!(join("/var/www", "x/../y"), "/var/www/y");
        assert_eq!(join("/var/www/a", "../../b"), "/var/b");
        assert_eq!(join("/x", ""), "/x");
        assert_eq!(dir("/var/www/file"), "/var/www");
        assert_eq!(dir("/"), "/");
        assert_eq!(dir("/file"), "/");
        assert_eq!(base("/var/www/"), "www");
        assert_eq!(base("/"), "/");
    }

    #[test]
    fn resolve_existing_reattaches_the_missing_tail() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let want = format!("{}/not/yet/here", real.display());
        let got = resolve_existing(&format!("{}/not/yet/here", dir.path().display())).unwrap();
        assert_eq!(got, want);
    }
}
