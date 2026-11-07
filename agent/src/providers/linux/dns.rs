//! DNS, resolved from the managed host's own vantage point: what the panel's
//! resolver sees is not what the mail server sees, and half the
//! mail-authentication checks are only meaningful when resolved from the
//! machine that sends the mail.
//!
//! Lookups go through hickory rather than libc, so a requested resolver is
//! really the one asked instead of `/etc/resolv.conf` being quietly
//! consulted, and so a TTL comes back with the answer.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use hickory_resolver::TokioAsyncResolver;
use hickory_resolver::config::{NameServerConfigGroup, ResolverConfig, ResolverOpts};
use hickory_resolver::error::ResolveErrorKind;
use hickory_resolver::proto::rr::{Name, RData, RecordType};

use super::Shared;
use super::certs::check_domain;
use super::common::invalid;
use crate::providers::*;

/// How long one query may take before the resolver is judged unreachable.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolution needs nothing from the shared state, but every sub-operation
/// carries it so the provider wires them all the same way.
#[allow(dead_code)]
pub struct DnsOps(pub Arc<Shared>);

#[async_trait]
impl Dns for DnsOps {
    async fn resolve(&self, ctx: &Ctx, p: DnsResolveParams) -> PResult<Vec<ResolvedRecord>> {
        let name = p.name.strip_suffix('.').unwrap_or(&p.name).to_string();
        check_domain(&name)?;

        let record_type = p.r#type.to_uppercase();
        let kind = record_type_named(&record_type)?;
        let (resolver, label) = build_resolver(p.resolver.as_deref().unwrap_or(""))?;

        let query_name = match kind {
            // The caller asks the way DNS does, by the in-addr.arpa or
            // ip6.arpa name; a bare address is turned into that name for them.
            RecordType::PTR => ptr_name(&name),
            _ => Name::from_utf8(format!("{name}.")).map_err(|e| invalid(format!("{name:?}: {e}")))?,
        };

        let lookup = match ctx.run(resolver.lookup(query_name, kind)).await? {
            Ok(lookup) => lookup,
            // A name that simply does not exist is an answer, not a failure:
            // half the mail-authentication checks are "is this record absent".
            Err(err) if matches!(err.kind(), ResolveErrorKind::NoRecordsFound { .. }) => {
                return Ok(Vec::new());
            }
            Err(err) => {
                return Err(ProviderError::internal(format!(
                    "resolve {record_type} {name}: {err}"
                )));
            }
        };

        let mut values = Vec::new();
        let mut ttl: Option<u32> = None;
        for record in lookup.record_iter() {
            let Some(data) = record.data() else { continue };
            if let Some(value) = render_rdata(data) {
                values.push(value);
                ttl = Some(ttl.map_or(record.ttl(), |t| t.min(record.ttl())));
            }
        }
        if values.is_empty() {
            return Ok(Vec::new());
        }

        Ok(vec![ResolvedRecord {
            name,
            r#type: record_type,
            values,
            ttl: ttl.map(i64::from),
            resolver: label,
        }])
    }
}

/// The record types the contract exposes; anything else never reaches the
/// resolver.
pub fn record_type_named(record_type: &str) -> PResult<RecordType> {
    Ok(match record_type {
        "A" => RecordType::A,
        "AAAA" => RecordType::AAAA,
        "CNAME" => RecordType::CNAME,
        "MX" => RecordType::MX,
        "TXT" => RecordType::TXT,
        "NS" => RecordType::NS,
        "SRV" => RecordType::SRV,
        "PTR" => RecordType::PTR,
        "CAA" => RecordType::CAA,
        other => return Err(invalid(format!("record type {other:?} is not supported"))),
    })
}

/// One record's value in the spelling the panel shows: the same text
/// `dig +short` would print, without trailing dots on names.
pub fn render_rdata(data: &RData) -> Option<String> {
    Some(match data {
        RData::A(a) => a.to_string(),
        RData::AAAA(aaaa) => aaaa.to_string(),
        RData::CNAME(name) => undotted(&name.0),
        RData::NS(name) => undotted(&name.0),
        RData::PTR(name) => undotted(&name.0),
        RData::MX(mx) => format!("{} {}", mx.preference(), undotted(mx.exchange())),
        RData::SRV(srv) => format!(
            "{} {} {} {}",
            srv.priority(),
            srv.weight(),
            srv.port(),
            undotted(srv.target())
        ),
        // The character-strings of one TXT record are one value, which is
        // how a long DKIM key is meant to be read.
        RData::TXT(txt) => txt
            .txt_data()
            .iter()
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            .collect::<Vec<_>>()
            .join(""),
        RData::CAA(caa) => caa.to_string(),
        _ => return None,
    })
}

fn undotted(name: &Name) -> String {
    let text = name.to_utf8();
    text.strip_suffix('.').unwrap_or(&text).to_string()
}

/// The system resolver, or the one server the caller named. The label is
/// what the record reports as `resolver`, so a mismatch can be explained.
fn build_resolver(address: &str) -> PResult<(TokioAsyncResolver, String)> {
    let mut opts = ResolverOpts::default();
    opts.timeout = QUERY_TIMEOUT;

    if address.is_empty() {
        let resolver = TokioAsyncResolver::tokio_from_system_conf()
            .map_err(|e| ProviderError::internal(format!("read resolver configuration: {e}")))?;
        return Ok((resolver, "system".to_string()));
    }

    let target = check_resolver(address)?;
    // The query stays on the requested server: no hosts file and no
    // search list, which is the whole point of naming a resolver.
    opts.use_hosts_file = false;
    opts.ndots = 0;
    let servers = NameServerConfigGroup::from_ips_clear(&[target.ip()], target.port(), true);
    let config = ResolverConfig::from_parts(None, Vec::new(), servers);
    Ok((TokioAsyncResolver::tokio(config, opts), address.to_string()))
}

/// Accepts an IP address with an optional port and nothing else: a
/// hostname here would need the very resolver being bypassed.
pub fn check_resolver(address: &str) -> PResult<SocketAddr> {
    if let Ok(socket) = address.parse::<SocketAddr>() {
        return Ok(socket);
    }
    if let Ok(ip) = address.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, 53));
    }
    Err(invalid("resolver must be an IP address"))
}

/// The reverse-zone name for a PTR query: a bare address becomes its
/// in-addr.arpa or ip6.arpa name, and an arpa name is used as given.
pub fn ptr_name(name: &str) -> Name {
    if let Ok(ip) = name.parse::<IpAddr>() {
        return Name::from(ip);
    }
    Name::from_utf8(format!("{name}.")).unwrap_or_else(|_| Name::root())
}

/// Turns a reverse-zone name back into the address it stands for, and
/// leaves anything else (a bare address) alone. Kept from the Go original,
/// where the standard library wanted the address rather than the name.
#[allow(dead_code)]
pub fn ptr_target(name: &str) -> String {
    let name = name.to_lowercase();
    let name = name.strip_suffix('.').unwrap_or(&name);
    if let Some(v4) = name.strip_suffix(".in-addr.arpa") {
        let parts: Vec<&str> = v4.split('.').collect();
        if parts.len() != 4 {
            return name.to_string();
        }
        return parts.iter().rev().copied().collect::<Vec<_>>().join(".");
    }
    if let Some(v6) = name.strip_suffix(".ip6.arpa") {
        let nibbles: Vec<&str> = v6.split('.').collect();
        if nibbles.len() != 32 {
            return name.to_string();
        }
        let mut text = String::new();
        for (count, nibble) in nibbles.iter().rev().enumerate() {
            if count > 0 && count % 4 == 0 {
                text.push(':');
            }
            text.push_str(nibble);
        }
        if let Ok(ip) = text.parse::<IpAddr>() {
            return ip.to_string();
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_resolver::proto::rr::rdata;
    use std::str::FromStr;

    #[test]
    fn record_types_are_the_contracts_set() {
        assert_eq!(record_type_named("MX").unwrap(), RecordType::MX);
        assert_eq!(record_type_named("CAA").unwrap(), RecordType::CAA);
        assert!(record_type_named("ANY").is_err());
        assert!(record_type_named("SOA").is_err());
    }

    #[test]
    fn resolvers_must_be_addresses() {
        assert_eq!(check_resolver("1.1.1.1").unwrap(), "1.1.1.1:53".parse().unwrap());
        assert_eq!(
            check_resolver("1.1.1.1:5353").unwrap(),
            "1.1.1.1:5353".parse().unwrap()
        );
        assert_eq!(check_resolver("[2606:4700::1111]:53").unwrap().port(), 53);
        assert!(check_resolver("dns.google").is_err());
        assert!(check_resolver("").is_err());
    }

    #[test]
    fn rdata_renders_like_dig_short() {
        let mx = RData::MX(rdata::MX::new(10, Name::from_str("mail.example.com.").unwrap()));
        assert_eq!(render_rdata(&mx).unwrap(), "10 mail.example.com");
        let srv = RData::SRV(rdata::SRV::new(
            5,
            0,
            5060,
            Name::from_str("sip.example.com.").unwrap(),
        ));
        assert_eq!(render_rdata(&srv).unwrap(), "5 0 5060 sip.example.com");
        let txt = RData::TXT(rdata::TXT::new(vec![
            "v=DKIM1; k=rsa; ".to_string(),
            "p=MIGf".to_string(),
        ]));
        assert_eq!(render_rdata(&txt).unwrap(), "v=DKIM1; k=rsa; p=MIGf");
        let cname = RData::CNAME(rdata::CNAME(Name::from_str("target.example.com.").unwrap()));
        assert_eq!(render_rdata(&cname).unwrap(), "target.example.com");
        let a = RData::A(rdata::A::new(192, 0, 2, 1));
        assert_eq!(render_rdata(&a).unwrap(), "192.0.2.1");
        let caa = RData::CAA(rdata::CAA::new_issue(
            false,
            Some(Name::from_str("letsencrypt.org").unwrap()),
            vec![],
        ));
        assert_eq!(render_rdata(&caa).unwrap(), "0 issue \"letsencrypt.org\"");
    }

    #[test]
    fn ptr_names_round_trip() {
        assert_eq!(ptr_target("4.3.2.1.in-addr.arpa."), "1.2.3.4");
        assert_eq!(ptr_target("1.2.3.4"), "1.2.3.4");
        assert_eq!(
            ptr_target("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa"),
            "2001:db8::1"
        );
        assert_eq!(ptr_target("short.in-addr.arpa"), "short.in-addr.arpa");
        assert_eq!(ptr_name("1.2.3.4").to_utf8(), "4.3.2.1.in-addr.arpa.");
        assert_eq!(
            ptr_name("4.3.2.1.in-addr.arpa").to_utf8(),
            "4.3.2.1.in-addr.arpa."
        );
    }
}
