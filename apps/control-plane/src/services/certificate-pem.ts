import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { ApiException } from "../lib/errors.js";

/* ------------------------------------------------------------------ *
 * Checking an externally issued certificate before it reaches a host.
 *
 * Everything that can be known from the PEM alone is checked here, on
 * the control plane, so the operator is told which field is wrong and
 * why while the dialog is still open — rather than installing a pair
 * nginx then refuses to load, which takes every site on the host down
 * with it at the next reload. The private key is only ever parsed in
 * memory; nothing here logs, stores or returns it.
 * ------------------------------------------------------------------ */

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface CheckedCertificate {
  /** The chain as it will be written: leaf first, normalised PEM blocks. */
  chainPem: string;
  /** DNS names on the leaf, in order. */
  sans: string[];
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  keyType: "ecdsa" | "rsa";
}

/**
 * Validates a pasted chain and key for `domain`, at `now`. Throws a
 * `validation_failed` naming `certificate_pem` or `key_pem` with the
 * exact reason; every message says what to do about it.
 */
export function checkCertificatePair(
  certificatePem: string,
  keyPem: string,
  domain: string,
  now = new Date(),
): CheckedCertificate {
  const blocks = certificatePem.match(CERT_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw invalidField(
      "certificate_pem",
      "No certificate found. Paste the PEM that starts with -----BEGIN CERTIFICATE-----.",
    );
  }

  const chain: X509Certificate[] = [];
  for (const [index, block] of blocks.entries()) {
    try {
      chain.push(new X509Certificate(block));
    } catch {
      throw invalidField(
        "certificate_pem",
        index === 0
          ? "The first certificate is not valid PEM. Copy it again from your certificate authority, including the BEGIN and END lines."
          : `Certificate ${index + 1} in the chain is not valid PEM. Copy the chain again from your certificate authority.`,
      );
    }
  }
  const leaf = chain[0]!;

  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type: 4,ENCRYPTED/.test(keyPem)) {
    throw invalidField(
      "key_pem",
      "This private key is protected by a passphrase, which nginx cannot enter at reload. Remove it first (openssl pkey -in key.pem -out plain.pem) and paste the result.",
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw invalidField(
      "key_pem",
      "Not a PEM private key. Paste the key that starts with -----BEGIN PRIVATE KEY----- (or BEGIN EC / RSA PRIVATE KEY).",
    );
  }
  const keyType =
    key.asymmetricKeyType === "ec" ? "ecdsa" : key.asymmetricKeyType === "rsa" ? "rsa" : null;
  if (!keyType) {
    throw invalidField(
      "key_pem",
      `A ${key.asymmetricKeyType ?? "key of this"} type cannot be served here. Use an RSA or ECDSA certificate.`,
    );
  }
  // A chain pasted CA-first is the most common ordering mistake; say so
  // instead of reporting a key mismatch against the wrong certificate.
  if (leaf.ca && chain.slice(1).some((cert) => cert.checkPrivateKey(key))) {
    throw invalidField(
      "certificate_pem",
      `The chain is out of order: it starts with a CA certificate. Put the certificate for ${domain} first, then each intermediate in turn.`,
    );
  }
  if (!leaf.checkPrivateKey(key)) {
    throw invalidField(
      "key_pem",
      "This private key does not belong to the certificate: their public keys differ. Paste the key that was generated with the certificate's request.",
    );
  }

  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (notAfter.getTime() <= now.getTime()) {
    throw invalidField(
      "certificate_pem",
      `This certificate expired on ${notAfter.toISOString().slice(0, 10)}. Renew it with your certificate authority and paste the new one.`,
    );
  }
  if (notBefore.getTime() > now.getTime()) {
    throw invalidField(
      "certificate_pem",
      `This certificate is not valid until ${notBefore.toISOString().slice(0, 10)}. Clients would reject it until then.`,
    );
  }

  const sans = dnsNames(leaf);
  // checkHost applies RFC 6125, so a wildcard covers exactly one label.
  if (leaf.checkHost(domain) === undefined) {
    const covers = sans.length > 0 ? sans.join(", ") : subjectCn(leaf) || "no names";
    throw invalidField(
      "certificate_pem",
      `This certificate does not cover ${domain}; it is for ${covers}. Issue one that names ${domain}, or install it on the domain it was issued for.`,
    );
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    if (!chain[i]!.checkIssued(chain[i + 1]!)) {
      throw invalidField(
        "certificate_pem",
        `The chain is out of order: certificate ${i + 2} did not issue certificate ${i + 1}. Put the certificate for ${domain} first, then each intermediate in turn.`,
      );
    }
  }

  return {
    chainPem: `${blocks.join("\n")}\n`,
    sans,
    issuer: issuerName(leaf),
    notBefore,
    notAfter,
    keyType,
  };
}

function invalidField(field: "certificate_pem" | "key_pem", message: string): ApiException {
  return new ApiException("validation_failed", message, { fields: { [field]: message } });
}

function dnsNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4).toLowerCase());
}

function subjectCn(cert: X509Certificate): string {
  return /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1] ?? "";
}

/** "R11 (Let's Encrypt)" reads better in a table than a whole DN. */
function issuerName(cert: X509Certificate): string {
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.issuer)?.[1];
  const org = /(?:^|\n)O=([^\n]+)/.exec(cert.issuer)?.[1];
  if (cn && org) return `${cn} (${org})`;
  return cn ?? org ?? cert.issuer.replace(/\n/g, ", ");
}
