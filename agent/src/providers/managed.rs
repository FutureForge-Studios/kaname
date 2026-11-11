//! Managed app containers (KD-040).
//!
//! The one way the agent creates a container. The caller describes it in
//! a closed, typed spec (`ManagedContainerSpec`); this module decides
//! whether the spec is acceptable and is the only thing that turns one
//! into an Engine API create body. Nothing in the spec can ask for
//! privileged mode, added capabilities, a host namespace, a device, a
//! command line or a host IP — those are not fields, and the body fixes
//! them. What the spec can say is checked here, in the agent, whatever
//! the control plane already checked:
//!
//!  * the image names an explicit tag or digest;
//!  * every bind source lies under `MANAGED_APPS_ROOT/<install_id>/`,
//!    lexically and after resolving symlinks, so the runtime socket, the
//!    agent's key or `/etc` can never be mounted;
//!  * every published port binds 127.0.0.1 and nothing else;
//!  * names and labels are derived from the install id, so a managed
//!    container cannot be named over someone else's, and the destructive
//!    verb (`container.app.remove`) only ever matches Kaname's labels.

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use regex_lite::Regex;

use super::{ManagedContainerSpec, PResult, ProviderError};
use crate::handlers::pathguard::{clean, resolve_existing, within};

/// Where every install's bind mounts live. Not under the agent's state
/// directory (/var/lib/kaname), which holds the enrolled key and is denied
/// to every file verb.
pub const MANAGED_APPS_ROOT: &str = "/var/lib/kaname-apps";

pub const LABEL_MANAGED: &str = "io.kaname.managed";
pub const LABEL_INSTALL: &str = "io.kaname.install";
pub const LABEL_ROLE: &str = "io.kaname.role";

/// Fixed for every managed container; `unless-stopped` so a reboot brings
/// the app back and an operator's deliberate stop is respected.
pub const RESTART_POLICY: &str = "unless-stopped";
/// The only address a managed container's port is ever published on.
pub const LOOPBACK: &str = "127.0.0.1";
/// Bounds fork bombs inside an app without getting in the way of one.
pub const PIDS_LIMIT: i64 = 4096;

const MAX_ENV: usize = 64;
const MAX_ENV_VALUE: usize = 4096;
const MAX_MOUNTS: usize = 8;
const MAX_PORTS: usize = 4;
const MAX_ARGS: usize = 16;
const MAX_FILES: usize = 8;
const MAX_FILE_BYTES: usize = 64 * 1024;
/// The bounds of the one ulimit a spec may raise.
pub const NOFILE_RANGE: std::ops::RangeInclusive<i64> = 1024..=1_048_576;
/// The longest a one-shot task may run.
pub const MAX_TASK_SECONDS: i64 = 3600;
const MIN_MEMORY: i64 = 64 * 1024 * 1024;
const MAX_MEMORY: i64 = 256 * 1024 * 1024 * 1024;

static INSTALL_ID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").expect("install id pattern"));
static ROLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z][a-z0-9]{0,15}$").expect("role pattern"));
static ARG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9._:=+-]{0,127}$").expect("arg pattern"));
static FILE_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)*$").expect("file pattern")
});
static ENV_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$").expect("env pattern"));
/// Mirrors `containerImageRef` in the contract: an optional registry, a
/// lowercase repository path, and a tag, a digest or both — never neither.
static IMAGE_REF: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?",
        r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*",
        r"(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64}|:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}@sha256:[a-f0-9]{64})$",
    ))
    .expect("image reference pattern")
});

fn invalid(message: impl Into<String>) -> ProviderError {
    ProviderError::invalid(message)
}

/* -------------------------------- names ------------------------------ */

pub fn container_name(install_id: &str, role: &str) -> String {
    format!("kaname-{install_id}-{role}")
}

pub fn network_name(install_id: &str) -> String {
    format!("kaname-{install_id}")
}

/// The install's own directory under the managed root.
pub fn install_dir(root: &str, install_id: &str) -> String {
    format!("{}/{install_id}", root.trim_end_matches('/'))
}

/// The labels every managed network carries; containers add their role.
pub fn install_labels(install_id: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (LABEL_MANAGED.to_string(), "true".to_string()),
        (LABEL_INSTALL.to_string(), install_id.to_string()),
    ])
}

pub fn container_labels(install_id: &str, role: &str) -> BTreeMap<String, String> {
    let mut labels = install_labels(install_id);
    labels.insert(LABEL_ROLE.to_string(), role.to_string());
    labels
}

/// Whether a label set marks something this install's managed resource.
pub fn is_managed_by(labels: &BTreeMap<String, String>, install_id: &str) -> bool {
    labels.get(LABEL_MANAGED).map(String::as_str) == Some("true")
        && labels.get(LABEL_INSTALL).map(String::as_str) == Some(install_id)
}

/* ------------------------------ validation --------------------------- */

pub fn validate_install_id(install_id: &str) -> PResult<()> {
    if INSTALL_ID.is_match(install_id) {
        Ok(())
    } else {
        Err(invalid(
            "install_id must be 1-64 lowercase letters, digits or hyphens",
        ))
    }
}

pub fn validate_image(image: &str) -> PResult<()> {
    if image.len() > 255 || !IMAGE_REF.is_match(image) {
        return Err(invalid(format!(
            "image must be a reference with an explicit tag or digest: {image:?}"
        )));
    }
    Ok(())
}

fn validate_container_path(field: &str, path: &str) -> PResult<String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(invalid(format!("{field} must be a path of 1-4096 characters")));
    }
    if !path.starts_with('/') {
        return Err(invalid(format!("{field} must be absolute: {path}")));
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err(invalid(format!("{field} may not traverse upwards: {path}")));
    }
    Ok(clean(path))
}

/// A bind source must lie strictly below the install's directory, both as
/// written and once its existing part has been resolved: a symlink planted
/// inside an app's data cannot carry a later mount out of it.
pub fn check_source(root: &str, install_id: &str, source: &str) -> PResult<String> {
    let cleaned = validate_container_path("mount source", source)?;
    let base = install_dir(root, install_id);
    let inside = |p: &str| p != base && within(p, &base);
    if !inside(&cleaned) {
        return Err(ProviderError::PermissionDenied(format!(
            "mount source must lie under {base}/: {source}"
        )));
    }
    let resolved =
        resolve_existing(&cleaned).map_err(|e| invalid(format!("cannot resolve {cleaned}: {e}")))?;
    // The root itself may be a symlink an operator set up (a data disk);
    // what matters is that nothing *below* it leads elsewhere.
    let resolved_base =
        resolve_existing(&base).map_err(|e| invalid(format!("cannot resolve {base}: {e}")))?;
    if !(resolved != resolved_base && within(&resolved, &resolved_base)) {
        return Err(ProviderError::PermissionDenied(format!(
            "mount source escapes {base} through a symlink: {source}"
        )));
    }
    Ok(cleaned)
}

/// Every check the spec can be given without the runtime. Normalises
/// paths in place, so a provider only ever sees cleaned ones.
pub fn validate_spec(spec: &mut ManagedContainerSpec, root: &str) -> PResult<()> {
    validate_install_id(&spec.install_id)?;
    if !ROLE.is_match(&spec.role) {
        return Err(invalid(
            "role must be 1-16 lowercase letters or digits, starting with a letter",
        ));
    }
    validate_image(&spec.image)?;

    if spec.env.len() > MAX_ENV {
        return Err(invalid(format!("at most {MAX_ENV} environment variables")));
    }
    for (name, value) in &spec.env {
        if !ENV_NAME.is_match(name) {
            return Err(invalid(format!(
                "environment variable name {name:?} is not valid"
            )));
        }
        if value.len() > MAX_ENV_VALUE || value.contains('\0') {
            return Err(invalid(format!(
                "environment variable {name} must be at most {MAX_ENV_VALUE} bytes with no NUL"
            )));
        }
    }

    if spec.mounts.len() > MAX_MOUNTS {
        return Err(invalid(format!("at most {MAX_MOUNTS} mounts")));
    }
    let mut targets = std::collections::BTreeSet::new();
    for mount in &mut spec.mounts {
        mount.source = check_source(root, &spec.install_id, &mount.source)?;
        mount.target = validate_container_path("mount target", &mount.target)?;
        if mount.target == "/" {
            return Err(invalid("a mount may not cover the container's root"));
        }
        if !targets.insert(mount.target.clone()) {
            return Err(invalid(format!("{} is mounted twice", mount.target)));
        }
        for id in [mount.uid, mount.gid].into_iter().flatten() {
            if !(1..=65534).contains(&id) {
                return Err(invalid("a mount's uid and gid must be between 1 and 65534"));
            }
        }
    }

    if spec.ports.len() > MAX_PORTS {
        return Err(invalid(format!("at most {MAX_PORTS} published ports")));
    }
    let mut host_ports = std::collections::BTreeSet::new();
    for port in &spec.ports {
        if !(1..=65535).contains(&port.container_port) {
            return Err(invalid("container_port must be between 1 and 65535"));
        }
        if !(1024..=65535).contains(&port.host_port) {
            return Err(invalid("host_port must be between 1024 and 65535"));
        }
        if !host_ports.insert(port.host_port) {
            return Err(invalid(format!(
                "host port {} is published twice",
                port.host_port
            )));
        }
    }

    if let Some(memory) = spec.memory_bytes {
        if !(MIN_MEMORY..=MAX_MEMORY).contains(&memory) {
            return Err(invalid("memory_bytes must be between 64 MiB and 256 GiB"));
        }
    }
    if let Some(cpus) = spec.cpus {
        if !cpus.is_finite() || !(0.1..=256.0).contains(&cpus) {
            return Err(invalid("cpus must be between 0.1 and 256"));
        }
    }
    if let Some(nofile) = spec.nofile {
        if !NOFILE_RANGE.contains(&nofile) {
            return Err(invalid(format!(
                "nofile must be between {} and {}",
                NOFILE_RANGE.start(),
                NOFILE_RANGE.end()
            )));
        }
    }

    if spec.args.len() > MAX_ARGS {
        return Err(invalid(format!("at most {MAX_ARGS} arguments")));
    }
    for arg in &spec.args {
        if !ARG.is_match(arg) {
            return Err(invalid(format!(
                "argument {arg:?} must be a single token of letters, digits and ._:=+-"
            )));
        }
    }

    if spec.files.len() > MAX_FILES {
        return Err(invalid(format!("at most {MAX_FILES} files")));
    }
    for file in &mut spec.files {
        if file.path.len() > 256 || !FILE_PATH.is_match(&file.path) || file.path.split('/').any(|s| s == "..")
        {
            return Err(invalid(format!(
                "file path must be relative to the install directory: {:?}",
                file.path
            )));
        }
        // Checked as a bind source would be: it is one, read-only.
        check_source(
            root,
            &spec.install_id,
            &format!("{}/{}", install_dir(root, &spec.install_id), file.path),
        )?;
        if file.content.len() > MAX_FILE_BYTES || file.content.contains('\0') {
            return Err(invalid(format!(
                "file {} must be at most {MAX_FILE_BYTES} bytes with no NUL",
                file.path
            )));
        }
        file.target = validate_container_path("file target", &file.target)?;
        if file.target == "/" || !targets.insert(file.target.clone()) {
            return Err(invalid(format!("{} cannot be mounted here", file.target)));
        }
    }
    Ok(())
}

/// A one-shot task: a spec with nothing published, and a bounded wait.
pub fn validate_task(spec: &mut ManagedContainerSpec, timeout_seconds: i64, root: &str) -> PResult<()> {
    validate_spec(spec, root)?;
    if !spec.ports.is_empty() {
        return Err(invalid("a task publishes no ports"));
    }
    if !(1..=MAX_TASK_SECONDS).contains(&timeout_seconds) {
        return Err(invalid(format!(
            "timeout_seconds must be between 1 and {MAX_TASK_SECONDS}"
        )));
    }
    Ok(())
}

/// Where a spec's file lands on the host.
pub fn file_source(root: &str, install_id: &str, path: &str) -> String {
    format!("{}/{path}", install_dir(root, install_id))
}

/* ------------------------------ the body ----------------------------- */

/// The Engine API create body for a validated spec. Every field that
/// could widen what the container can reach on the host is written here
/// with its safe value, rather than left to the daemon's defaults.
pub fn create_body(spec: &ManagedContainerSpec) -> serde_json::Value {
    create_body_with(spec, RESTART_POLICY)
}

/// A one-shot task's body: the same guards, and never restarted.
pub fn task_body(spec: &ManagedContainerSpec) -> serde_json::Value {
    create_body_with(spec, "no")
}

fn create_body_with(spec: &ManagedContainerSpec, restart: &str) -> serde_json::Value {
    let network = network_name(&spec.install_id);
    let env: Vec<String> = spec.env.iter().map(|(k, v)| format!("{k}={v}")).collect();

    let mut exposed = serde_json::Map::new();
    let mut bindings = serde_json::Map::new();
    for port in &spec.ports {
        let key = format!("{}/tcp", port.container_port);
        exposed.insert(key.clone(), serde_json::json!({}));
        bindings.insert(
            key,
            serde_json::json!([{ "HostIp": LOOPBACK, "HostPort": port.host_port.to_string() }]),
        );
    }

    let mut mounts: Vec<serde_json::Value> = spec
        .mounts
        .iter()
        .map(|m| {
            serde_json::json!({
                "Type": "bind",
                "Source": m.source,
                "Target": m.target,
                "ReadOnly": m.read_only,
                "BindOptions": { "Propagation": "rprivate" },
            })
        })
        .collect();
    for file in &spec.files {
        mounts.push(serde_json::json!({
            "Type": "bind",
            "Source": file_source(MANAGED_APPS_ROOT, &spec.install_id, &file.path),
            "Target": file.target,
            "ReadOnly": true,
            "BindOptions": { "Propagation": "rprivate" },
        }));
    }

    let mut host = serde_json::json!({
        "Mounts": mounts,
        "PortBindings": bindings,
        "PublishAllPorts": false,
        "NetworkMode": network,
        "RestartPolicy": { "Name": restart },
        "Privileged": false,
        "CapAdd": [],
        "Devices": [],
        "DeviceCgroupRules": [],
        "SecurityOpt": ["no-new-privileges:true"],
        "IpcMode": "private",
        "PidMode": "",
        "UTSMode": "",
        "UsernsMode": "",
        "CgroupnsMode": "private",
        "ReadonlyRootfs": false,
        "AutoRemove": false,
        "PidsLimit": PIDS_LIMIT,
        "LogConfig": { "Type": "json-file", "Config": { "max-size": "10m", "max-file": "3" } },
    });
    if let Some(memory) = spec.memory_bytes {
        host["Memory"] = serde_json::json!(memory);
    }
    if let Some(cpus) = spec.cpus {
        host["NanoCpus"] = serde_json::json!((cpus * 1e9) as i64);
    }
    if let Some(nofile) = spec.nofile {
        host["Ulimits"] = serde_json::json!([{ "Name": "nofile", "Soft": nofile, "Hard": nofile }]);
    }

    let mut body = serde_json::json!({
        "Image": spec.image,
        "Env": env,
        "Labels": container_labels(&spec.install_id, &spec.role),
        "ExposedPorts": exposed,
        "HostConfig": host,
        "NetworkingConfig": {
            "EndpointsConfig": { network: { "Aliases": [spec.role] } }
        },
    });
    // Arguments to the image's own entrypoint; `Entrypoint` is never set.
    if !spec.args.is_empty() {
        body["Cmd"] = serde_json::json!(spec.args);
    }
    body
}

/// Splits an image reference into the `fromImage` and `tag` an image pull
/// takes. A digest travels inside `fromImage`.
pub fn pull_query(image: &str) -> (String, Option<String>) {
    if image.contains('@') {
        return (image.to_string(), None);
    }
    let slash = image.rfind('/').map(|i| i + 1).unwrap_or(0);
    match image[slash..].rfind(':') {
        Some(colon) => {
            let at = slash + colon;
            (image[..at].to_string(), Some(image[at + 1..].to_string()))
        }
        None => (image.to_string(), None),
    }
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ManagedMount, ManagedPort};

    const ROOT: &str = "/var/lib/kaname-apps";
    const ID: &str = "abcdef12-3456-4789-8abc-def012345678";

    fn spec() -> ManagedContainerSpec {
        ManagedContainerSpec {
            install_id: ID.into(),
            role: "app".into(),
            image: "ghost:5".into(),
            env: BTreeMap::from([("url".to_string(), "https://blog.example.com".to_string())]),
            mounts: vec![ManagedMount {
                source: format!("{ROOT}/{ID}/content"),
                target: "/var/lib/ghost/content".into(),
                ..Default::default()
            }],
            ports: vec![ManagedPort {
                container_port: 2368,
                host_port: 20001,
            }],
            ..Default::default()
        }
    }

    fn rejects(patch: impl FnOnce(&mut ManagedContainerSpec)) -> ProviderError {
        let mut s = spec();
        patch(&mut s);
        validate_spec(&mut s, ROOT).expect_err("spec should be refused")
    }

    #[test]
    fn a_well_formed_spec_passes_and_is_normalised() {
        let mut s = spec();
        s.mounts[0].source = format!("{ROOT}//{ID}/./content/");
        validate_spec(&mut s, ROOT).expect("valid spec");
        assert_eq!(s.mounts[0].source, format!("{ROOT}/{ID}/content"));
    }

    #[test]
    fn image_references_need_a_tag_or_digest_and_nothing_else() {
        for ok in [
            "ghost:5",
            "mysql:8.0",
            "louislam/uptime-kuma:1",
            "ghcr.io/owner/app:1.2.3",
            "registry.example.com:5000/team/app:v1",
            &format!("postgres@sha256:{}", "a".repeat(64)),
            &format!("postgres:16-alpine@sha256:{}", "b".repeat(64)),
        ] {
            assert!(validate_image(ok).is_ok(), "{ok}");
        }
        for bad in [
            "ghost",
            "Ghost:5",
            "ghost:5; rm -rf /",
            "ghost:5 --privileged",
            "../ghost:5",
            "ghost:",
            "ghost:5\n",
            "",
            &format!("x:{}", "a".repeat(300)),
            "postgres@sha256:short",
        ] {
            assert!(validate_image(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn bind_sources_outside_the_install_directory_are_refused() {
        for source in [
            "/var/run/docker.sock".to_string(),
            "/run/docker.sock".to_string(),
            "/var/lib/kaname/agent.key".to_string(),
            "/etc".to_string(),
            "/".to_string(),
            ROOT.to_string(),
            format!("{ROOT}/{ID}"),
            format!("{ROOT}/other-install/data"),
            format!("{ROOT}/{ID}-evil/data"),
            format!("{ROOT}/{ID}/../other/data"),
            "relative/path".to_string(),
        ] {
            let err = rejects(|s| s.mounts[0].source = source.clone());
            assert!(
                matches!(
                    err,
                    ProviderError::PermissionDenied(_) | ProviderError::InvalidParams(_)
                ),
                "{source}: {err:?}"
            );
        }
    }

    #[test]
    fn a_symlink_inside_the_install_directory_cannot_carry_a_mount_out() {
        let tmp = std::env::temp_dir().join(format!("kaname-managed-{}", std::process::id()));
        let root = tmp.join("apps");
        let install = root.join(ID);
        std::fs::create_dir_all(&install).unwrap();
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = install.join("data");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let root = root.to_string_lossy().to_string();
        let err = check_source(&root, ID, &format!("{root}/{ID}/data/sub")).expect_err("escape");
        assert!(matches!(err, ProviderError::PermissionDenied(_)), "{err:?}");
        assert!(check_source(&root, ID, &format!("{root}/{ID}/content")).is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ports_env_and_limits_are_bounded() {
        rejects(|s| s.ports[0].host_port = 80);
        rejects(|s| s.ports[0].host_port = 0);
        rejects(|s| s.ports[0].container_port = 70000);
        rejects(|s| {
            s.ports.push(ManagedPort {
                container_port: 80,
                host_port: 20001,
            })
        });
        rejects(|s| {
            s.ports = (0..5)
                .map(|i| ManagedPort {
                    container_port: 80,
                    host_port: 20000 + i,
                })
                .collect()
        });
        rejects(|s| {
            s.env.insert("BAD NAME".into(), "x".into());
        });
        rejects(|s| {
            s.env.insert("LD_PRELOAD=x;".into(), "x".into());
        });
        rejects(|s| {
            s.env.insert("OK".into(), "nul\0byte".into());
        });
        rejects(|s| {
            s.env.insert("OK".into(), "x".repeat(5000));
        });
        rejects(|s| s.env = (0..65).map(|i| (format!("V{i}"), String::new())).collect());
        rejects(|s| s.memory_bytes = Some(1024));
        rejects(|s| s.cpus = Some(f64::NAN));
        rejects(|s| s.cpus = Some(0.0));
        rejects(|s| s.role = "App".into());
        rejects(|s| s.role = "app/../db".into());
        rejects(|s| s.install_id = "../etc".into());
        rejects(|s| s.install_id = String::new());
        rejects(|s| s.mounts[0].target = "/".into());
        rejects(|s| s.mounts[0].target = "relative".into());
        rejects(|s| s.mounts[0].uid = Some(0));
        rejects(|s| {
            let again = s.mounts[0].clone();
            s.mounts.push(again);
        });
        rejects(|s| s.nofile = Some(10));
        rejects(|s| s.nofile = Some(10_000_000));
        rejects(|s| s.args = vec!["sh -c id".into()]);
        rejects(|s| s.args = vec!["run;reboot".into()]);
        rejects(|s| s.args = vec!["$(id)".into()]);
        rejects(|s| s.args = vec!["/bin/sh".into()]);
        rejects(|s| s.args = (0..17).map(|i| format!("a{i}")).collect());
    }

    fn file(path: &str, target: &str) -> crate::providers::ManagedFile {
        crate::providers::ManagedFile {
            path: path.into(),
            content: "<clickhouse/>".into(),
            target: target.into(),
        }
    }

    #[test]
    fn config_files_stay_under_the_install_directory_and_mount_read_only() {
        let mut s = spec();
        s.files = vec![file(
            "config/logs.xml",
            "/etc/clickhouse-server/config.d/logs.xml",
        )];
        s.nofile = Some(262_144);
        s.args = vec!["db".into(), "migrate".into()];
        validate_spec(&mut s, ROOT).expect("valid");
        let body = create_body(&s);
        let mounts = body["HostConfig"]["Mounts"].as_array().unwrap();
        let mounted = mounts
            .iter()
            .find(|m| m["Target"] == "/etc/clickhouse-server/config.d/logs.xml")
            .unwrap();
        assert_eq!(mounted["ReadOnly"], true);
        assert_eq!(mounted["Source"], format!("{ROOT}/{ID}/config/logs.xml"));
        assert_eq!(
            body["HostConfig"]["Ulimits"],
            serde_json::json!([{"Name": "nofile", "Soft": 262_144, "Hard": 262_144}])
        );
        assert_eq!(body["Cmd"], serde_json::json!(["db", "migrate"]));
        assert!(body.get("Entrypoint").is_none());
        assert_eq!(task_body(&s)["HostConfig"]["RestartPolicy"]["Name"], "no");

        for bad in [
            "../escape.xml",
            "/etc/passwd",
            "a/../../b",
            ".hidden/../x",
            "",
            "a//b",
            "a b",
        ] {
            rejects(|s| s.files = vec![file(bad, "/etc/x.xml")]);
        }
        rejects(|s| s.files = vec![file("ok.xml", "/")]);
        rejects(|s| s.files = vec![file("ok.xml", "/var/lib/ghost/content")]);
        rejects(|s| {
            let mut f = file("ok.xml", "/etc/x.xml");
            f.content = "x".repeat(70 * 1024);
            s.files = vec![f];
        });
    }

    #[test]
    fn tasks_publish_nothing_and_wait_a_bounded_time() {
        let mut s = spec();
        assert!(validate_task(&mut s, 60, ROOT).is_err(), "a task with a port");
        s.ports.clear();
        assert!(validate_task(&mut s.clone(), 60, ROOT).is_ok());
        assert!(validate_task(&mut s.clone(), 0, ROOT).is_err());
        assert!(validate_task(&mut s, 7200, ROOT).is_err());
    }

    #[test]
    fn raw_engine_fields_are_a_decode_error_not_a_silent_drop() {
        for extra in [
            serde_json::json!({"Privileged": true}),
            serde_json::json!({"HostConfig": {"Privileged": true}}),
            serde_json::json!({"cap_add": ["SYS_ADMIN"]}),
            serde_json::json!({"network_mode": "host"}),
            serde_json::json!({"devices": ["/dev/sda"]}),
            serde_json::json!({"cmd": ["sh", "-c", "id"]}),
        ] {
            let mut doc = serde_json::to_value(spec()).unwrap();
            for (k, v) in extra.as_object().unwrap() {
                doc[k] = v.clone();
            }
            assert!(
                serde_json::from_value::<ManagedContainerSpec>(doc).is_err(),
                "{extra}"
            );
        }
        let mut doc = serde_json::to_value(spec()).unwrap();
        doc["ports"][0]["host_ip"] = serde_json::json!("0.0.0.0");
        assert!(serde_json::from_value::<ManagedContainerSpec>(doc).is_err());
    }

    #[test]
    fn the_create_body_pins_every_widening_field_to_its_safe_value() {
        let mut s = spec();
        s.memory_bytes = Some(512 * 1024 * 1024);
        s.cpus = Some(1.5);
        validate_spec(&mut s, ROOT).unwrap();
        let body = create_body(&s);
        let host = &body["HostConfig"];
        assert_eq!(host["Privileged"], false);
        assert_eq!(host["CapAdd"], serde_json::json!([]));
        assert_eq!(host["Devices"], serde_json::json!([]));
        assert_eq!(host["PublishAllPorts"], false);
        assert_eq!(host["NetworkMode"], format!("kaname-{ID}"));
        assert_eq!(host["RestartPolicy"]["Name"], "unless-stopped");
        assert_eq!(host["IpcMode"], "private");
        assert_eq!(host["PidMode"], "");
        assert_eq!(host["SecurityOpt"], serde_json::json!(["no-new-privileges:true"]));
        assert_eq!(host["Memory"], 512 * 1024 * 1024);
        assert_eq!(host["NanoCpus"], 1_500_000_000i64);
        assert_eq!(
            host["PortBindings"]["2368/tcp"],
            serde_json::json!([{"HostIp": "127.0.0.1", "HostPort": "20001"}])
        );
        assert_eq!(host["Mounts"][0]["Type"], "bind");
        assert_eq!(host["Mounts"][0]["Source"], format!("{ROOT}/{ID}/content"));
        assert!(host.get("Binds").is_none());
        assert_eq!(body["Labels"][LABEL_MANAGED], "true");
        assert_eq!(body["Labels"][LABEL_INSTALL], ID);
        assert_eq!(body["Labels"][LABEL_ROLE], "app");
        assert!(body.get("Cmd").is_none() && body.get("Entrypoint").is_none());
        assert_eq!(
            body["NetworkingConfig"]["EndpointsConfig"][format!("kaname-{ID}")]["Aliases"],
            serde_json::json!(["app"])
        );
    }

    #[test]
    fn labels_identify_one_install_only() {
        let labels = container_labels(ID, "db");
        assert!(is_managed_by(&labels, ID));
        assert!(!is_managed_by(&labels, "another"));
        let mut forged = BTreeMap::new();
        forged.insert(LABEL_INSTALL.to_string(), ID.to_string());
        assert!(!is_managed_by(&forged, ID));
    }

    #[test]
    fn pulls_split_tags_but_keep_registry_ports_and_digests() {
        assert_eq!(pull_query("ghost:5"), ("ghost".into(), Some("5".into())));
        assert_eq!(
            pull_query("registry.example.com:5000/team/app:v1"),
            ("registry.example.com:5000/team/app".into(), Some("v1".into()))
        );
        let digest = format!("postgres@sha256:{}", "a".repeat(64));
        assert_eq!(pull_query(&digest), (digest.clone(), None));
    }
}
