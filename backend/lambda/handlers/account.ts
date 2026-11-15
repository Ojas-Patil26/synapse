import { deleteCognitoUser } from "../lib/aws/cognito";
import { deleteUserUploads } from "../lib/aws/s3";
import { deleteAllUserData } from "../lib/data/service";
import { getUserId, handler, json } from "../lib/http";
import { deleteLearnerData } from "../lib/supermemory";

/**
 * DELETE /account. Removes everything stored about the caller, then the login itself. The login goes
 * last so a failure part-way leaves the account in place and the request can simply be repeated.
 */
export const deleteAccount = handler(async (event) => {
  const userId = getUserId(event);
  const data = await deleteAllUserData(userId);
  const uploads = await deleteUserUploads(userId);
  const profileRemoved = await deleteLearnerData(userId);
  await deleteCognitoUser(userId);
  return json(200, { deleted: true, documents: data.documents, reviewEvents: data.reviewEvents, uploads, profileRemoved });
});
