//! Capability detection.
//!
//! The hello frame's capability list is what the panel greys modules out
//! on, and what the RPC registry gates verbs on. Advertising something the
//! host cannot serve turns a greyed-out button into a failing job; missing
//! something it can serve hides a module the operator paid for. Detection
//! is therefore a pure function of what the host reports, so it can be
//! pinned by tests against a fake probe.

use crate::providers::cap;

/// Everything capability detection is allowed to ask about the machine.
pub struct HostProbe<'a> {
    pub has_binary: &'a dyn Fn(&str) -> bool,
    pub file_exists: &'a dyn Fn(&str) -> bool,
    pub dir_exists: &'a dyn Fn(&str) -> bool,
    /// The capability name of the container runtime whose socket answered
    /// at startup: `docker`, `podman`, or `None` when neither did.
    pub container_runtime: Option<&'static str>,
}

/// Where Yunori Mail Server installs its binary. The capability is the
/// binary, not the service: a half-finished install is still Yunori's to
/// finish, and `mail.status` says exactly how far it got.
pub const YUNORI_BIN: &str = "/usr/local/bin/yunori-mail";

/// Decides what this host can serve, sorted so the hello frame is stable
/// across restarts.
pub fn detect_capabilities(probe: &HostProbe<'_>) -> Vec<String> {
    let mut caps: Vec<&str> = Vec::new();
    let mut add = |c: &'static str| {
        if !caps.contains(&c) {
            caps.push(c);
        }
    };

    // systemd announces itself with /run/systemd/system; the private socket
    // confirms the manager is actually up rather than merely installed.
    if ((probe.dir_exists)("/run/systemd/system")
        || (probe.file_exists)("/run/systemd/private")
        || (probe.file_exists)("/run/dbus/system_bus_socket"))
        && (probe.has_binary)("systemctl")
    {
        add(cap::SYSTEMD);
    }

    match probe.container_runtime {
        Some(cap::PODMAN) => add(cap::PODMAN),
        Some(_) => add(cap::DOCKER),
        None => {}
    }

    if (probe.has_binary)("nginx") {
        add(cap::NGINX);
    }
    if (probe.has_binary)("apache2") || (probe.has_binary)("httpd") {
        add(cap::APACHE);
    }
    if (probe.has_binary)("caddy") {
        add(cap::CADDY);
    }
    if (probe.has_binary)("php") || (probe.has_binary)("php-fpm") {
        add(cap::PHP);
    }
    if (probe.has_binary)("node") {
        add(cap::NODEJS);
    }
    if (probe.has_binary)("python3") || (probe.has_binary)("python") {
        add(cap::PYTHON);
    }

    if (probe.has_binary)("mysql") {
        add(cap::MYSQL);
    }
    if (probe.has_binary)("mariadb") {
        add(cap::MARIADB);
    }
    if (probe.has_binary)("psql") {
        add(cap::POSTGRES);
    }

    if (probe.file_exists)(YUNORI_BIN) || (probe.has_binary)("yunori-mail") {
        add(cap::YUNORI);
    }

    if (probe.has_binary)("nft") {
        add(cap::NFTABLES);
    }
    if (probe.has_binary)("iptables") {
        add(cap::IPTABLES);
    }
    if (probe.has_binary)("ufw") {
        add(cap::UFW);
    }
    if (probe.has_binary)("fail2ban-client") {
        add(cap::FAIL2BAN);
    }
    if (probe.has_binary)("certbot") {
        add(cap::CERTBOT);
    }
    if (probe.has_binary)("restic") {
        add(cap::RESTIC);
    }

    let mut list: Vec<String> = caps.into_iter().map(String::from).collect();
    list.sort();
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn detect(runtime: Option<&'static str>, present: &[&str]) -> Vec<String> {
        let set: HashSet<&str> = present.iter().copied().collect();
        let answer = |name: &str| set.contains(name);
        detect_capabilities(&HostProbe {
            has_binary: &answer,
            file_exists: &answer,
            dir_exists: &answer,
            container_runtime: runtime,
        })
    }

    #[test]
    fn a_bare_host_advertises_nothing() {
        // Every verb behind a capability would otherwise be offered and then fail.
        assert!(detect(None, &[]).is_empty());
    }

    #[test]
    fn systemd_needs_both_a_run_marker_and_the_client() {
        assert_eq!(detect(None, &["/run/systemd/system", "systemctl"]), vec!["systemd"]);
        assert!(detect(None, &["/run/systemd/system"]).is_empty());
        assert!(detect(None, &["systemctl"]).is_empty());
        assert_eq!(detect(None, &["/run/systemd/private", "systemctl"]), vec!["systemd"]);
        assert_eq!(detect(None, &["/run/dbus/system_bus_socket", "systemctl"]), vec!["systemd"]);
    }

    #[test]
    fn the_container_runtime_is_whichever_socket_answered() {
        assert_eq!(detect(Some("docker"), &[]), vec!["docker"]);
        assert_eq!(detect(Some("podman"), &[]), vec!["podman"]);
    }

    #[test]
    fn yunori_is_the_binary_not_the_service() {
        assert_eq!(detect(None, &[YUNORI_BIN]), vec!["yunori"]);
        assert_eq!(detect(None, &["yunori-mail"]), vec!["yunori"]);
        // Postfix and Dovecot no longer mean anything to Kaname.
        assert!(detect(None, &["postconf", "postqueue", "doveadm"]).is_empty());
    }

    #[test]
    fn the_list_is_sorted_and_deduplicated() {
        let got = detect(Some("docker"), &["psql", "nginx", "nft", "/run/systemd/system", "systemctl", "restic"]);
        let mut sorted = got.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(got, sorted);
        assert_eq!(got, vec!["docker", "nftables", "nginx", "postgres", "restic", "systemd"]);
    }
}
