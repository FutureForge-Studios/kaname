import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { eq, type Database } from "@kaname/db";
import { secrets } from "@kaname/db/schema";
import { open, seal } from "../lib/crypto.js";
import type { Config } from "../config.js";

/* ------------------------------------------------------------------ *
 * Kaname's internal certificate authority.
 *
 * Signs one client certificate per enrolled server, with CN = server id.
 * The agent generates its own keypair and sends only a CSR, so the
 * private key never leaves the managed host (PLAN.md 2.3).
 *
 * This CA exists solely to authenticate agents to the control plane.
 * It is deliberately not a general-purpose PKI: no intermediates, no
 * server certs, no key usages beyond client authentication.
 * ------------------------------------------------------------------ */

const CA_SECRET_REF = "agent-ca";
const CA_VALIDITY_YEARS = 10;

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

interface StoredCa {
  certificatePem: string;
  privateKeyPkcs8: string;
  createdAt: string;
}

export interface IssuedCertificate {
  certificatePem: string;
  caPem: string;
  serialNumber: string;
  fingerprint: string;
  notAfter: Date;
}

export class AgentCa {
  private cached: { cert: x509.X509Certificate; key: CryptoKey; pem: string } | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {}

  /** Loads the CA, creating it on first boot. */
  async load(): Promise<{ pem: string }> {
    if (this.cached) return { pem: this.cached.pem };

    const rows = await this.db
      .select()
      .from(secrets)
      .where(eq(secrets.ref, CA_SECRET_REF))
      .limit(1);
    const row = rows[0];

    if (row) {
      const stored = JSON.parse(
        open(
          {
            wrappedKey: row.wrappedKey,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            keyVersion: row.keyVersion,
          },
          this.config.masterKey,
        ),
      ) as StoredCa;
      await this.hydrate(stored);
      return { pem: this.cached!.pem };
    }

    const created = await this.create();
    const sealed = seal(JSON.stringify(created), this.config.masterKey);
    await this.db.insert(secrets).values({
      ref: CA_SECRET_REF,
      ownerType: "system",
      ownerId: null,
      wrappedKey: sealed.wrappedKey,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    });
    await this.hydrate(created);
    return { pem: this.cached!.pem };
  }

  private async create(): Promise<StoredCa> {
    const alg: EcKeyGenParams & { hash: string } = {
      name: "ECDSA",
      namedCurve: "P-256",
      hash: "SHA-256",
    };
    const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);

    const notBefore = new Date();
    const notAfter = new Date(notBefore);
    notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerial(),
      name: "CN=Kaname Agent CA, O=Kaname",
      notBefore,
      notAfter,
      signingAlgorithm: alg,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });

    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    return {
      certificatePem: cert.toString("pem"),
      privateKeyPkcs8: Buffer.from(pkcs8).toString("base64"),
      createdAt: new Date().toISOString(),
    };
  }

  private async hydrate(stored: StoredCa): Promise<void> {
    const cert = new x509.X509Certificate(stored.certificatePem);
    const key = await webcrypto.subtle.importKey(
      "pkcs8",
      Buffer.from(stored.privateKeyPkcs8, "base64"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    this.cached = { cert, key, pem: stored.certificatePem };
  }

  /**
   * Signs an agent CSR. The subject is forced to CN=<serverId> regardless
   * of what the CSR asked for — the agent does not get to choose its own
   * identity, the control plane assigns it.
   */
  async signCsr(csrPem: string, serverId: string, hostname: string): Promise<IssuedCertificate> {
    await this.load();
    const ca = this.cached!;

    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    if (!(await csr.verify())) {
      throw new Error("CSR signature is not valid");
    }

    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + this.config.AGENT_CERT_DAYS * 86_400_000);

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${serverId}, O=Kaname Agents`,
      issuer: ca.cert.subject,
      notBefore,
      notAfter,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: csr.publicKey,
      signingKey: ca.key,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
          true,
        ),
        // Client auth only. This certificate can never be used to serve TLS.
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
        await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(ca.cert),
        new x509.SubjectAlternativeNameExtension([{ type: "dns", value: hostname }]),
      ],
    });

    return {
      certificatePem: cert.toString("pem"),
      caPem: ca.pem,
      serialNumber: cert.serialNumber,
      fingerprint: await fingerprint(cert),
      notAfter,
    };
  }

  /**
   * Verifies a presented client certificate: signed by us, in date, and
   * bearing a server-id CN. Revocation is checked by the caller against
   * the servers table, which is authoritative and instant.
   */
  async verifyClientCertificate(
    pem: string,
  ): Promise<{ serverId: string; serialNumber: string; fingerprint: string } | null> {
    await this.load();
    const ca = this.cached!;

    let cert: x509.X509Certificate;
    try {
      cert = new x509.X509Certificate(pem);
    } catch {
      return null;
    }

    const now = new Date();
    if (cert.notBefore > now || cert.notAfter < now) return null;
    if (!(await cert.verify({ publicKey: ca.cert.publicKey, signatureOnly: true }))) return null;

    const cn = cert.subjectName.getField("CN")[0];
    if (!cn || !/^[0-9a-f-]{36}$/i.test(cn)) return null;

    return { serverId: cn, serialNumber: cert.serialNumber, fingerprint: await fingerprint(cert) };
  }
}

function randomSerial(): string {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

async function fingerprint(cert: x509.X509Certificate): Promise<string> {
  const digest = await cert.getThumbprint("SHA-256");
  return Buffer.from(digest).toString("hex");
}
