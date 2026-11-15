// Seeds the two-course demo data set for one user. Invoked by hand with the AWS CLI; it has no HTTP
// route, so only someone with IAM access to the function can run it. Payload: {"userId": "<sub>", "reset": true}.

import { seedUser } from "../../../scripts/seed-data";

export const seed = async (event: { userId?: string; reset?: boolean }) => {
  const userId = typeof event?.userId === "string" ? event.userId.trim() : "";
  if (!userId) throw new Error('payload must include "userId"');
  return seedUser(userId, { reset: event.reset === true });
};
