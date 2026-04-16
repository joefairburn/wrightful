import { AwsClient } from "aws4fetch";

/**
 * Credentials + bucket identity for signing R2 presigned URLs.
 *
 * R2's S3-compatible endpoint requires the Cloudflare account id as a
 * subdomain, and an R2 access key pair (created from the R2 dashboard's
 * "Manage API Tokens" flow). region is hard-coded to "auto" per R2 convention.
 */
export interface R2PresignConfig {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Validated config read from env; throws with a clear error when incomplete. */
export function readR2Config(env: Record<string, unknown>): R2PresignConfig {
  const accountId = asString(env.R2_ACCOUNT_ID);
  const bucketName = asString(env.R2_BUCKET_NAME);
  const accessKeyId = asString(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = asString(env.R2_SECRET_ACCESS_KEY);

  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!bucketName) missing.push("R2_BUCKET_NAME");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing R2 credentials: ${missing.join(", ")}. See docs/worklog for setup steps.`,
    );
  }

  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function endpoint(cfg: R2PresignConfig, key: string): string {
  // Path-style URL. R2 accepts both virtual-hosted and path-style.
  const encodedKey = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucketName}/${encodedKey}`;
}

/**
 * Create a presigned PUT URL. The CLI uses this to stream a file directly to R2.
 * We do NOT sign Content-Type — the client is free to send any content type;
 * we record what we expect in the DB row.
 */
export async function presignPut(
  cfg: R2PresignConfig,
  key: string,
  expiresSeconds: number,
  client: AwsClient = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  }),
): Promise<string> {
  const url = new URL(endpoint(cfg, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));

  const signed = await client.sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}

/** Create a presigned GET URL for downloads (trace viewer, inline previews). */
export async function presignGet(
  cfg: R2PresignConfig,
  key: string,
  expiresSeconds: number,
  client: AwsClient = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  }),
): Promise<string> {
  const url = new URL(endpoint(cfg, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));

  const signed = await client.sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}
