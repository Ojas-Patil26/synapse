import type { Rating, ReviewResponse } from "../lib/contracts";
import { applySelfReview, getConceptContext } from "../lib/data/service";
import { badRequest, getUserId, handler, json, notFound, parseBody, requireString } from "../lib/http";
import { logLearningEvent } from "../lib/supermemory";

const RATINGS: Rating[] = ["got-it", "still-shaky"];

/** POST /review */
export const postReview = handler(async (event) => {
  const userId = getUserId(event);
  const body = parseBody(event);
  const conceptId = requireString(body, "conceptId");
  const rating = RATINGS.find((r) => r === body.rating);
  if (!rating) throw badRequest('"rating" must be "got-it" or "still-shaky".');

  const ctx = await getConceptContext(userId, conceptId);
  if (!ctx) throw notFound("That concept does not exist.");

  const node = await applySelfReview(userId, conceptId, rating);
  await logLearningEvent(userId, {
    type: "self-review",
    courseName: ctx.courseName,
    conceptLabel: ctx.node.label,
    rating,
    confidence: node.confidence,
    retention: ctx.node.retention, // retention just before this review
    timestamp: new Date().toISOString(),
  });

  const response: ReviewResponse = { node };
  return json(200, response);
});
