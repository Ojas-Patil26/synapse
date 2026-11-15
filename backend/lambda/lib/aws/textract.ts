// Text extraction for uploaded files. NOT yet verified against live Textract.
//   text/plain, text/markdown -> read straight from S3
//   image/png, image/jpeg     -> synchronous DetectDocumentText
//   application/pdf           -> StartDocumentTextDetection + polling

import {
  DetectDocumentTextCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";
import { HttpError, describeError } from "../http";
import { assertUploadUsable, getObjectText, uploadsBucket } from "./s3";

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

const POLL_INTERVAL_MS = 1_000;

let client: TextractClient | null = null;
const textract = () => (client ??= new TextractClient({}));

export function inferContentType(s3Key: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(s3Key)?.[1]?.toLowerCase();
  return (ext && EXTENSION_TYPES[ext]) || null;
}

function linesOf(blocks: Block[] | undefined): string[] {
  return (blocks ?? []).filter((b) => b.BlockType === "LINE" && b.Text).map((b) => b.Text as string);
}

const ocrFailed = (message = "That file could not be read. Try a clearer PDF, PNG, JPEG or a text file.") =>
  new HttpError(502, "ocr_failed", message);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function detectImage(s3Key: string, deadline: number): Promise<string> {
  const res = await textract().send(
    new DetectDocumentTextCommand({ Document: { S3Object: { Bucket: uploadsBucket(), Name: s3Key } } }),
    { abortSignal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1_000)) },
  );
  return linesOf(res.Blocks).join("\n");
}

async function detectPdf(s3Key: string, deadline: number): Promise<string> {
  const start = await textract().send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: { S3Object: { Bucket: uploadsBucket(), Name: s3Key } },
    }),
  );
  const jobId = start.JobId;
  if (!jobId) throw ocrFailed();

  const lines: string[] = [];
  let nextToken: string | undefined;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new HttpError(502, "ocr_timeout", "Reading that file took too long. Try a shorter document.");
    }
    const page = await textract().send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
    if (page.JobStatus === "IN_PROGRESS") {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
      continue;
    }
    if (page.JobStatus === "FAILED") throw ocrFailed();
    // SUCCEEDED or PARTIAL_SUCCESS: collect this page of results and follow NextToken.
    lines.push(...linesOf(page.Blocks));
    nextToken = page.NextToken;
    if (!nextToken) break;
  }
  return lines.join("\n");
}

/**
 * Returns the text of an uploaded file.
 * @param contentType  the uploaded Content-Type; inferred from the key's extension when omitted
 * @param opts.deadlineMs  how long this call may take, in milliseconds from now
 * Throws HttpError (user-safe message) on any failure.
 */
export async function extractText(
  s3Key: string,
  contentType: string | undefined | null,
  opts: { deadlineMs: number },
): Promise<string> {
  const deadline = Date.now() + opts.deadlineMs;
  const type = (contentType || inferContentType(s3Key) || "").toLowerCase().split(";")[0].trim();

  try {
    await assertUploadUsable(s3Key);
    switch (type) {
      case "text/plain":
      case "text/markdown":
        return await getObjectText(s3Key);
      case "image/png":
      case "image/jpeg":
        return await detectImage(s3Key, deadline);
      case "application/pdf":
        return await detectPdf(s3Key, deadline);
      default:
        throw new HttpError(400, "unsupported_file", "That file type is not supported.");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`[textract] ${type || "unknown type"} failed: ${describeError(err)}`);
    throw ocrFailed();
  }
}
