import { ALLOWED_UPLOAD_TYPES, type PresignResponse, type UploadPurpose } from "../lib/contracts";
import { PRESIGN_EXPIRES_SECONDS, buildUploadKey, presignUpload } from "../lib/aws/s3";
import { badRequest, getUserId, handler, json, parseBody, requireString } from "../lib/http";

const PURPOSES = Object.keys(ALLOWED_UPLOAD_TYPES) as UploadPurpose[];

/** POST /uploads/presign */
export const presign = handler(async (event) => {
  const userId = getUserId(event);
  const body = parseBody(event);
  const fileName = requireString(body, "fileName");
  const contentType = requireString(body, "contentType").toLowerCase().split(";")[0].trim();
  const purpose = PURPOSES.find((p) => p === body.purpose);
  if (!purpose) throw badRequest('"purpose" must be "notes" or "quiz".');
  if (!ALLOWED_UPLOAD_TYPES[purpose].includes(contentType)) {
    throw badRequest(`Files of type "${contentType}" are not supported here. Allowed: ${ALLOWED_UPLOAD_TYPES[purpose].join(", ")}.`);
  }

  const s3Key = buildUploadKey(userId, purpose, fileName);
  const uploadUrl = await presignUpload(s3Key, contentType);
  const response: PresignResponse = { uploadUrl, s3Key, expiresIn: PRESIGN_EXPIRES_SECONDS };
  return json(200, response);
});
