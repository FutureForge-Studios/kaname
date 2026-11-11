import { z } from "zod";

/* ------------------------------------------------------------------ *
 * S3-compatible providers.
 *
 * Every provider below speaks the S3 API, but each spells its endpoint,
 * region and preferred addressing a little differently, and getting one
 * of the three wrong is the usual reason a first backup fails. A preset
 * is the provider's own documented answer, so the form fills what the
 * operator would otherwise have to look up:
 *
 *   aws      s3.<region>.amazonaws.com             (AWS general reference, S3 endpoints)
 *   r2       <account_id>.r2.cloudflarestorage.com, region "auto"   (Cloudflare R2 S3 API docs)
 *   b2       s3.<region>.backblazeb2.com           (Backblaze "Call the S3-compatible API")
 *   wasabi   s3.<region>.wasabisys.com             (Wasabi service URLs by region)
 *   spaces   <region>.digitaloceanspaces.com, SDK region "us-east-1" (DigitalOcean Spaces AWS SDK docs)
 *   hetzner  <location>.your-objectstorage.com, region = location     (Hetzner Object Storage docs)
 *   minio    whatever the operator runs; path-style, as MinIO serves it by default
 *
 * Endpoints are host names without a scheme; the scheme is https unless
 * the operator types one (a MinIO on a LAN may well be http://).
 * ------------------------------------------------------------------ */

export const s3Provider = z.enum(["aws", "r2", "b2", "wasabi", "spaces", "hetzner", "minio"]);
export type S3Provider = z.infer<typeof s3Provider>;

export interface S3ProviderPreset {
  id: S3Provider;
  label: string;
  /** Region choices the provider documents. Empty means free text. */
  regions: readonly { value: string; label: string }[];
  default_region: string;
  /** The endpoint is derived from the region (and account id); the operator does not type it. */
  derived_endpoint: boolean;
  /** R2 puts the account id in the host name. */
  needs_account_id: boolean;
  /** Path-style (`host/bucket`) rather than virtual-hosted (`bucket.host`) by default. */
  path_style: boolean;
  /** Where the preset's values come from. */
  docs_url: string;
  /** One line shown under the provider picker. */
  note: string;
}

const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "sa-east-1",
] as const;

const WASABI_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-central-1",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
] as const;

const asOptions = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

export const S3_PROVIDER_PRESETS: Record<S3Provider, S3ProviderPreset> = {
  aws: {
    id: "aws",
    label: "Amazon S3",
    regions: asOptions(AWS_REGIONS),
    default_region: "us-east-1",
    derived_endpoint: true,
    needs_account_id: false,
    path_style: false,
    docs_url: "https://docs.aws.amazon.com/general/latest/gr/s3.html",
    note: "The bucket's own region: a request signed for another one is refused.",
  },
  r2: {
    id: "r2",
    label: "Cloudflare R2",
    regions: [{ value: "auto", label: "auto" }],
    default_region: "auto",
    derived_endpoint: true,
    needs_account_id: true,
    path_style: true,
    docs_url: "https://developers.cloudflare.com/r2/api/s3/api/",
    note: "Region is always auto. The account id is on the R2 overview page of the dashboard.",
  },
  b2: {
    id: "b2",
    label: "Backblaze B2 (S3 API)",
    regions: [],
    default_region: "us-west-004",
    derived_endpoint: true,
    needs_account_id: false,
    path_style: false,
    docs_url: "https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api",
    note: "The region is the middle of the bucket's endpoint, e.g. us-west-004 or eu-central-003.",
  },
  wasabi: {
    id: "wasabi",
    label: "Wasabi",
    regions: asOptions(WASABI_REGIONS),
    default_region: "us-east-1",
    derived_endpoint: true,
    needs_account_id: false,
    path_style: false,
    docs_url:
      "https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions",
    note: "Use the region the bucket was created in; each region has its own service URL.",
  },
  spaces: {
    id: "spaces",
    label: "DigitalOcean Spaces",
    regions: asOptions(["nyc3", "sfo2", "sfo3", "ams3", "fra1", "sgp1", "syd1", "blr1", "tor1", "lon1", "atl1"]),
    default_region: "nyc3",
    derived_endpoint: true,
    needs_account_id: false,
    path_style: false,
    docs_url: "https://docs.digitalocean.com/products/spaces/how-to/use-aws-sdks/",
    note: "The datacenter picks the endpoint; requests are signed for us-east-1, as DigitalOcean documents.",
  },
  hetzner: {
    id: "hetzner",
    label: "Hetzner Object Storage",
    regions: asOptions(["fsn1", "nbg1", "hel1"]),
    default_region: "fsn1",
    derived_endpoint: true,
    needs_account_id: false,
    path_style: false,
    docs_url: "https://docs.hetzner.com/storage/object-storage/getting-started/using-s3-api-tools/",
    note: "The endpoint must include the bucket's location.",
  },
  minio: {
    id: "minio",
    label: "MinIO / other",
    regions: [],
    default_region: "us-east-1",
    derived_endpoint: false,
    needs_account_id: false,
    path_style: true,
    docs_url: "https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html",
    note: "Any S3-compatible service. Type its endpoint; include http:// if it is not served over TLS.",
  },
};

/** R2 account ids are 32 hex characters. */
export const r2AccountId = z.string().regex(/^[a-f0-9]{32}$/, "must be the 32-character account id");

/** A bare region or location code: what goes into a host name. */
export const s3Region = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a region code such as eu-central-1");

/**
 * The endpoint host for a provider, or null when the operator must type
 * one. Never carries a scheme.
 */
export function s3EndpointFor(
  provider: S3Provider,
  region: string,
  accountId?: string | null,
): string | null {
  switch (provider) {
    case "aws":
      return `s3.${region}.amazonaws.com`;
    case "r2":
      return accountId ? `${accountId}.r2.cloudflarestorage.com` : null;
    case "b2":
      return `s3.${region}.backblazeb2.com`;
    case "wasabi":
      return `s3.${region}.wasabisys.com`;
    case "spaces":
      return `${region}.digitaloceanspaces.com`;
    case "hetzner":
      return `${region}.your-objectstorage.com`;
    case "minio":
      return null;
  }
}

/** The region a request is signed for, which is not always the one in the host name. */
export function s3SigningRegion(provider: S3Provider, region: string): string {
  if (provider === "r2") return "auto";
  if (provider === "spaces") return "us-east-1";
  return region;
}

/**
 * The scheme-qualified base URL a client should talk to, and whether the
 * bucket goes in the path. `endpoint` overrides the preset (MinIO, or a
 * provider's endpoint the preset does not list).
 */
export function s3BaseUrl(input: {
  provider: S3Provider;
  region: string;
  endpoint?: string | null;
  account_id?: string | null;
}): string | null {
  const host = input.endpoint?.trim() || s3EndpointFor(input.provider, input.region, input.account_id);
  if (!host) return null;
  return /^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : `https://${host.replace(/\/+$/, "")}`;
}
