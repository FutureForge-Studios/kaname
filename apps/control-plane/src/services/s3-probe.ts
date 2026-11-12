import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  s3BaseUrl,
  s3SigningRegion,
  type BackupDestinationTarget,
  type DestinationProbeCheck,
  type DestinationProbeFailure,
} from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * S3 destination probe.
 *
 * "The endpoint answered" proves very little: a typo in the secret, a
 * bucket in another region or a clock five minutes out all answer too,
 * and the first backup run is where the operator used to find out. So
 * "Test connection" does what a backup does, on one tiny object: write
 * it, read it back, delete it — signed with AWS Signature Version 4 from
 * the control plane, which is where the credentials already are (they
 * never leave it). No SDK: SigV4 is a page of HMACs, and pulling an
 * AWS client into the control plane for three requests is not worth it.
 *
 * Every failure is mapped onto something an operator can act on:
 * credentials, a missing bucket, the wrong region, a skewed clock, a
 * key that may read but not write, or the network.
 * ------------------------------------------------------------------ */

type S3Target = Extract<BackupDestinationTarget, { kind: "s3" }>;

export interface ProbeOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** The probe object's key suffix; random by default. */
  nonce?: string;
}

export interface S3ProbeResult {
  ok: boolean;
  writable: boolean;
  failure: DestinationProbeFailure | null;
  checks: DestinationProbeCheck[];
  error: string | null;
  hint: string | null;
  url: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding, as SigV4 wants it: everything but unreserved characters. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDate(now: Date): { stamp: string; day: string } {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { stamp, day: stamp.slice(0, 8) };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Signs one request with SigV4. Exported for the tests, which pin it
 * against AWS's published example.
 */
export function signS3Request(input: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  payloadHash?: string;
  extraHeaders?: Record<string, string>;
}): SignedRequest {
  const { stamp, day } = amzDate(input.now);
  const payloadHash = input.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
    ...Object.fromEntries(Object.entries(input.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri =
    input.url.pathname
      .split("/")
      .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
      .join("/") || "/";
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [input.method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    url: input.url.toString(),
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** The object URL for a key, path-style or virtual-hosted. */
export function objectUrl(target: S3Target, key: string): string | null {
  const base = s3BaseUrl({
    provider: target.provider,
    region: target.region,
    endpoint: target.endpoint ?? null,
    account_id: target.account_id ?? null,
  });
  if (!base) return null;
  const url = new URL(base);
  const encodedKey = key.split("/").map(encodeRfc3986).join("/");
  if (pathStyle(target)) {
    url.pathname = `/${target.bucket}/${encodedKey}`;
  } else {
    url.hostname = `${target.bucket}.${url.hostname}`;
    url.pathname = `/${encodedKey}`;
  }
  return url.toString();
}

/** Path-style when asked, when the preset prefers it, or when a dotted bucket would break TLS. */
export function pathStyle(target: S3Target): boolean {
  if (typeof target.path_style === "boolean") return target.path_style;
  if (target.provider === "minio" || target.provider === "r2") return true;
  return target.bucket.includes(".");
}

/** What an S3 error body says, from its XML. */
export function parseS3Error(body: string): { code: string | null; message: string | null; region: string | null } {
  const pick = (tag: string) => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? null;
  return { code: pick("Code"), message: pick("Message"), region: pick("Region") };
}

/**
 * Maps a failed response onto the failure an operator can act on, with
 * one sentence saying what to do about it.
 */
export function classifyS3Failure(
  status: number,
  body: string,
  context: { target: S3Target; serverDate: string | null; now: Date },
): { failure: DestinationProbeFailure; error: string; hint: string } {
  const { code, message, region } = parseS3Error(body);
  const said = message ? `${code ?? `HTTP ${status}`}: ${message}` : (code ?? `HTTP ${status}`);
  const regionInBody = region ?? message?.match(/expecting '([^']+)'/)?.[1] ?? null;

  if (code === "RequestTimeTooSkewed" || code === "RequestExpired") {
    const skew = context.serverDate
      ? Math.round((context.now.getTime() - new Date(context.serverDate).getTime()) / 1000)
      : null;
    return {
      failure: "clock_skew",
      error: said,
      hint: `The control plane's clock is ${skew !== null ? `${Math.abs(skew)} s ${skew > 0 ? "ahead of" : "behind"}` : "out of step with"} the storage service. S3 refuses signatures more than 15 minutes off: fix the host's time sync (NTP).`,
    };
  }
  if (code === "NoSuchBucket") {
    return {
      failure: "bucket_missing",
      error: said,
      hint: `There is no bucket "${context.target.bucket}" at this endpoint. Create it in the provider's console, or check its name and region.`,
    };
  }
  if (
    status === 301 ||
    code === "PermanentRedirect" ||
    code === "AuthorizationHeaderMalformed" ||
    code === "IllegalLocationConstraintException" ||
    code === "InvalidRegion" ||
    (code === "AuthorizationQueryParametersError" && /region/i.test(message ?? ""))
  ) {
    return {
      failure: "region_mismatch",
      error: said,
      hint: regionInBody
        ? `The bucket lives in ${regionInBody}, not ${context.target.region}. Pick ${regionInBody} as the region.`
        : `The bucket is not in ${context.target.region}. Pick the region the bucket was created in.`,
    };
  }
  if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch" || code === "InvalidToken" || status === 401) {
    return {
      failure: "auth",
      error: said,
      hint:
        code === "SignatureDoesNotMatch"
          ? "The access key exists but the secret does not match it. Paste the secret again; trailing spaces are a common cause."
          : "The access key id is not known to this provider. Check it was created for this account (and, for R2, this account id).",
    };
  }
  if (code === "AccessDenied" || status === 403) {
    return {
      failure: "permission",
      error: said,
      hint: "The credentials are valid but may not write, read or delete objects in this bucket. Grant the key read, write and delete on it.",
    };
  }
  return {
    failure: "other",
    error: said,
    hint: "The storage service refused the probe. The message above is its own.",
  };
}

const PROBE_BODY = "kaname destination probe\n";

/**
 * Write, read back and delete one small object. Stops at the first step
 * that fails; a failed read or delete still tries to clean up.
 */
export async function probeS3(target: S3Target, opts: ProbeOptions = {}): Promise<S3ProbeResult> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 8000;
  const prefix = target.prefix.replace(/^\/+|\/+$/g, "");
  const key = `${prefix ? `${prefix}/` : ""}.kaname-probe-${opts.nonce ?? randomBytes(6).toString("hex")}`;
  const url = objectUrl(target, key);
  const checks: DestinationProbeCheck[] = [];
  const result = (partial: Partial<S3ProbeResult>): S3ProbeResult => ({
    ok: false,
    writable: false,
    failure: null,
    error: null,
    hint: null,
    url: url ?? "",
    ...partial,
    checks,
  });

  if (!url) {
    return result({
      failure: "other",
      error: "No endpoint: this provider needs one (or, for R2, the account id).",
      hint: "Fill in the endpoint, then test again.",
    });
  }

  const signingRegion = s3SigningRegion(target.provider, target.region);
  const send = async (method: "PUT" | "GET" | "DELETE") => {
    const body = method === "PUT" ? PROBE_BODY : undefined;
    const signed = signS3Request({
      method,
      url: new URL(url),
      region: signingRegion,
      accessKeyId: target.access_key_id,
      secretAccessKey: target.secret_access_key,
      now: now(),
      payloadHash: body ? sha256Hex(body) : EMPTY_SHA256,
      extraHeaders: body ? { "content-type": "text/plain" } : {},
    });
    const started = Date.now();
    const response = await doFetch(signed.url, {
      method,
      headers: signed.headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    return { response, text, latency: Date.now() - started };
  };

  const steps: { step: "write" | "read" | "delete"; method: "PUT" | "GET" | "DELETE" }[] = [
    { step: "write", method: "PUT" },
    { step: "read", method: "GET" },
    { step: "delete", method: "DELETE" },
  ];
  let wrote = false;
  for (const { step, method } of steps) {
    let outcome: Awaited<ReturnType<typeof send>>;
    try {
      outcome = await send(method);
    } catch (err) {
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      checks.push({ step: step === "write" ? "connect" : step, ok: false, detail: reason, latency_ms: null });
      if (wrote && step !== "delete") await send("DELETE").catch(() => undefined);
      return result({
        writable: wrote,
        failure: "network",
        error: `${new URL(url).host} could not be reached: ${reason}`,
        hint: "Check the endpoint, the region in its host name, and that the control plane may make outbound HTTPS requests to it.",
      });
    }
    const { response, text, latency } = outcome;
    const good = step === "delete" ? response.status === 204 || response.status === 200 : response.ok;
    const readBack = step === "read" ? text === PROBE_BODY : true;
    if (!good || !readBack) {
      const classified = !good
        ? classifyS3Failure(response.status, text, {
            target,
            serverDate: response.headers.get("date"),
            now: now(),
          })
        : {
            failure: "other" as const,
            error: "The object read back is not the one written.",
            hint: "Something between the control plane and the bucket is rewriting objects.",
          };
      checks.push({ step, ok: false, detail: classified.error, latency_ms: latency });
      if (wrote && step === "read") await send("DELETE").catch(() => undefined);
      return result({ writable: wrote, ...classified });
    }
    if (step === "write") wrote = true;
    checks.push({ step, ok: true, detail: `HTTP ${response.status}`, latency_ms: latency });
  }
  return result({ ok: true, writable: true });
}
