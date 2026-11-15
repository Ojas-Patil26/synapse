import { decayStatus } from "../lib/data/service";
import { getUserId, handler, json, notFound, pathParam, queryFlag } from "../lib/http";

/** GET /decay-status/{courseId}?recalculate=true */
export const getDecayStatus = handler(async (event) => {
  const userId = getUserId(event);
  const courseId = pathParam(event, "courseId");
  const status = await decayStatus(userId, courseId, { recalculate: queryFlag(event, "recalculate") });
  if (!status) throw notFound("That course does not exist or is not ready yet.");
  return json(200, status);
});
