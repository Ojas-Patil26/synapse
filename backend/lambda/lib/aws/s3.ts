// S3 helpers for the uploads bucket. NOT yet verified against a live bucket.

import { randomUUID } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_UPLOAD_BYTES, type UploadPurpose } from "../contracts";
import { HttpError, badRequest } from "../http";

export const PRESIGN_EXPIRES_SECONDS = 900;

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      // Without this the SDK adds a CRC32 checksum to presigned PUT URLs, which a plain
      // browser `fetch(url, { method: "PUT", body: file })` cannot satisfy.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

export function uploadsBucket(): string {
  const bucket = process.env.UPLOADS_BUCKET;
  if (!bucket) throw new Error("UPLOADS_BUCKET is not set");
  return bucket;
}

export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-80);
  return clean || "file";
}

/** `uploads/<userId>/<purpose>/<uuid>-<sanitized file name>` */
export function buildUploadKey(userId: string, purpose: UploadPurpose, fileName: string): string {
  return `uploads/${userId}/${purpose}/${randomUUID()}-${sanitizeFileName(fileName)}`;
}

/** Every route that receives an s3Key calls this. 400 unless the key belongs to the caller. */
export function assertOwnsKey(userId: string, s3Key: unknown): asserts s3Key is string {
  if (
    typeof s3Key !== "string" ||
    !s3Key.startsWith(`uploads/${userId}/`) ||
    s3Key.includes("..") ||
    s3Key.length > 512
  ) {
    throw badRequest("That file reference is not valid for this account.");
  }
}

/** Presigned PUT. The client must send the same Content-Type header it asked for. */
export async function presignUpload(s3Key: string, contentType: string): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: uploadsBucket(), Key: s3Key, ContentType: contentType }), {
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  });
}

function isMissing(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

const missingFile = () =>
  new HttpError(400, "file_not_found", "An uploaded file could not be found. Please upload it again.");

/** Throws a 400 HttpError when the object is missing or larger than the 10 MB limit. */
export async function assertUploadUsable(s3Key: string): Promise<void> {
  let size: number | undefined;
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: uploadsBucket(), Key: s3Key }));
    size = head.ContentLength;
  } catch (err) {
    if (isMissing(err)) throw missingFile();
    throw err;
  }
  if (typeof size === "number" && size > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, "file_too_large", "A file is larger than the 10 MB limit.");
  }
}

export async function getObjectBuffer(s3Key: string): Promise<Buffer> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: uploadsBucket(), Key: s3Key }));
    if (!res.Body) return Buffer.alloc(0);
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    if (isMissing(err)) throw missingFile();
    throw err;
  }
}

export async function getObjectText(s3Key: string): Promise<string> {
  return (await getObjectBuffer(s3Key)).toString("utf8");
}

/** Deletes every file a user uploaded (notes and quizzes). Returns how many were removed. */
export async function deleteUserUploads(userId: string): Promise<number> {
  const Bucket = uploadsBucket();
  const Prefix = `uploads/${userId}/`;
  let deleted = 0;
  let ContinuationToken: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length > 0) {
      await s3().send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return deleted;
}
