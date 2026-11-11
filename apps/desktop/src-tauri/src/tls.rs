//! One rustls configuration per connection, shared by its HTTP client and
//! its terminal sockets, so "accept invalid certificates" means the same
//! thing for both.

use std::sync::{Arc, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

use crate::error::DesktopError;

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The OS trust store plus the Mozilla roots, loaded once. The OS store
/// is what makes an internal CA installed by IT work; the bundled roots
/// keep public certificates working where the OS store is empty.
fn roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut store = RootCertStore::empty();
            store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let native = rustls_native_certs::load_native_certs();
            for cert in native.certs {
                // Unparseable entries in the OS store are skipped, as browsers do.
                let _ = store.add(cert);
            }
            Arc::new(store)
        })
        .clone()
}

pub fn client_config(accept_invalid_certs: bool) -> Arc<ClientConfig> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions");
    let mut config = if accept_invalid_certs {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert {
                algorithms: provider.signature_verification_algorithms,
            }))
            .with_no_client_auth()
    } else {
        builder
            .with_root_certificates(roots())
            .with_no_client_auth()
    };
    // HTTP/1.1 only: the same config dials WebSockets, which need it.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

/// Skips chain and name validation, for a self-signed panel reached by IP
/// that the operator has explicitly marked as such. Handshake signatures
/// are still verified, so the peer must hold the key for the certificate
/// it presents.
#[derive(Debug)]
struct AcceptAnyCert {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// Finds a rustls error anywhere in an error's chain. `io::Error` hides
/// its payload from `source()`, so it is unwrapped by hand.
pub fn find_tls_error<'a>(err: &'a (dyn std::error::Error + 'static)) -> Option<&'a rustls::Error> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(tls) = e.downcast_ref::<rustls::Error>() {
            return Some(tls);
        }
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            if let Some(inner) = io.get_ref() {
                if let Some(tls) = inner.downcast_ref::<rustls::Error>() {
                    return Some(tls);
                }
                cur = Some(inner as &(dyn std::error::Error + 'static));
                continue;
            }
        }
        cur = e.source();
    }
    None
}

pub fn tls_error(err: &rustls::Error) -> DesktopError {
    use rustls::CertificateError as C;
    let detail = match err {
        rustls::Error::InvalidCertificate(C::UnknownIssuer) => {
            "its certificate is not signed by an authority this computer trusts".to_string()
        }
        rustls::Error::InvalidCertificate(C::Expired) => "its certificate has expired".to_string(),
        rustls::Error::InvalidCertificate(C::NotValidForName) => {
            "its certificate is for a different address".to_string()
        }
        rustls::Error::InvalidCertificate(other) => {
            format!("its certificate is invalid ({other:?})")
        }
        other => other.to_string(),
    };
    let mut e = DesktopError::new(
        "tls",
        format!("Could not open a secure connection to the panel: {detail}."),
    );
    e.remediation = Some(Box::new(crate::error::Remediation {
        summary: "If this panel uses a self-signed certificate (for example while it is reached \
                  by IP before a domain is set), turn on \"Accept invalid certificates\" for \
                  this connection. Otherwise, fix the panel's certificate."
            .into(),
        actions: Vec::new(),
    }));
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_rustls_errors_inside_io_errors() {
        let inner = rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer);
        let io = std::io::Error::other(inner);
        let found = find_tls_error(&io).unwrap();
        assert!(matches!(found, rustls::Error::InvalidCertificate(_)));
        assert_eq!(tls_error(found).code, "tls");
    }

    #[test]
    fn builds_both_configs() {
        assert_eq!(
            client_config(false).alpn_protocols,
            vec![b"http/1.1".to_vec()]
        );
        let _ = client_config(true);
    }
}
