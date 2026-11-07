//! DNS from this host's vantage point.
//!
//! What makes a mail-authentication check meaningful is that the answers
//! come from the mail server's own resolver, not the panel's. The zone
//! served here agrees with what `mail.domain.dns` reports: records a
//! domain has published resolve, records it has not do not, and the PTR
//! for the mail address still points at the host's generic name.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use super::mail::{MAIL_IP, expected_records};
use super::state::Sim;
use crate::providers::{
    Ctx, Dns, DnsPublishParams, DnsResolveParams, MailCheckStatus, PResult, ResolvedRecord,
};

type Zone = HashMap<String, HashMap<String, Vec<String>>>;

fn reverse_name(ip: &str) -> String {
    let mut parts: Vec<&str> = ip.split('.').collect();
    parts.reverse();
    format!("{}.in-addr.arpa", parts.join("."))
}

/// What this host's resolver believes.
pub fn zone(sim: &Sim) -> Zone {
    let domain = &sim.id.domain;
    let ip = &sim.id.public_ip;
    let mut zone: Zone = HashMap::new();

    let mut add = |name: &str, rtype: &str, values: Vec<String>| {
        zone.entry(name.to_string())
            .or_default()
            .entry(rtype.to_string())
            .or_default()
            .extend(values);
    };

    add(domain, "A", vec![ip.clone()]);
    add(
        domain,
        "NS",
        vec!["ns1.example-dns.net.".into(), "ns2.example-dns.net.".into()],
    );
    add(
        domain,
        "TXT",
        vec!["google-site-verification=kAn4mE_5imUl4t3d".into()],
    );
    add(domain, "CAA", vec!["0 issue \"letsencrypt.org\"".into()]);
    add(
        domain,
        "SOA",
        vec![format!(
            "ns1.example-dns.net. hostmaster.{domain}. 2026082601 7200 3600 1209600 3600"
        )],
    );
    add(&format!("www.{domain}"), "CNAME", vec![format!("{domain}.")]);
    add(&format!("www.{domain}"), "A", vec![ip.clone()]);
    for sub in ["api", "blog", "app", "staging"] {
        add(&format!("{sub}.{domain}"), "A", vec![ip.clone()]);
    }

    // The mail zone follows the Yunori world: published records resolve,
    // missing ones do not.
    let w = sim.world.lock();
    let hostname = w.mail.hostname.clone();
    if w.mail.installed {
        add(&hostname, "A", vec![MAIL_IP.into()]);
        add(&hostname, "TXT", vec!["v=spf1 a -all".into()]);
        for d in &w.mail.domains {
            for record in expected_records(d, &hostname) {
                if matches!(
                    record.status,
                    MailCheckStatus::Pass | MailCheckStatus::Warn | MailCheckStatus::Info
                ) {
                    add(&record.name, &record.rtype, record.actual.clone());
                }
            }
            add(&d.name, "A", vec![MAIL_IP.into()]);
            add(
                &d.name,
                "NS",
                vec!["ns1.example-dns.net.".into(), "ns2.example-dns.net.".into()],
            );
            add(&d.name, "CAA", vec!["0 issue \"letsencrypt.org\"".into()]);
        }
    }
    // Deliberately wrong: the operator has not set the PTR yet, which is
    // the install step the sim pauses on.
    add(
        &reverse_name(MAIL_IP),
        "PTR",
        vec![format!("{}.", sim.id.hostname)],
    );
    add(&reverse_name(ip), "PTR", vec![format!("{}.", sim.id.hostname)]);

    // What the control plane published wins over the fixed zone for each
    // name and type it covers: it is the record set the world would serve.
    let mut published: Zone = HashMap::new();
    for records in w.published_zones.values() {
        for r in records {
            published
                .entry(normalize(&r.name))
                .or_default()
                .entry(r.r#type.to_uppercase())
                .or_default()
                .push(r.content.clone());
        }
    }
    for (name, types) in published {
        let entry = zone.entry(name).or_default();
        for (rtype, values) in types {
            entry.insert(rtype, values);
        }
    }
    zone
}

fn normalize(name: &str) -> String {
    name.trim().trim_end_matches('.').to_lowercase()
}

pub struct SimDns(pub Arc<Sim>);

#[async_trait]
impl Dns for SimDns {
    async fn resolve(&self, _ctx: &Ctx, p: DnsResolveParams) -> PResult<Vec<ResolvedRecord>> {
        let resolver = p
            .resolver
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "127.0.0.1".into());
        let name = p.name.to_lowercase().trim_end_matches('.').to_string();
        let rtype = p.r#type.to_uppercase();

        let values = zone(&self.0)
            .get(&name)
            .and_then(|r| r.get(&rtype))
            .cloned()
            .unwrap_or_default();
        if values.is_empty() {
            // An empty answer is not an error: "the record is missing" is
            // exactly what a mail-authentication check needs to be told.
            return Ok(vec![]);
        }

        let ttl = match rtype.as_str() {
            "NS" | "SOA" => 86400,
            "MX" | "TXT" => 3600,
            _ => 300,
        };
        Ok(vec![ResolvedRecord {
            name,
            r#type: rtype,
            values,
            ttl: Some(ttl),
            resolver,
        }])
    }

    /// Replaces the zone wholesale, so a record deleted in Kaname stops
    /// resolving here too; an empty set withdraws the zone.
    async fn publish(&self, _ctx: &Ctx, p: DnsPublishParams) -> PResult<()> {
        let zone = normalize(&p.zone);
        let mut w = self.0.world.lock();
        if p.records.is_empty() {
            w.published_zones.remove(&zone);
        } else {
            w.published_zones.insert(zone, p.records);
        }
        Ok(())
    }
}
