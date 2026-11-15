import type { GuideEntryResponse, GuideListResponse } from "../lib/contracts";
import { buildGuide, getConceptContext, getGuideEntry, saveGuideContent } from "../lib/data/service";
import { generateTutoring } from "../lib/gemini";
import { getUserId, handler, json, notFound, pathParam, queryFlag } from "../lib/http";
import { getLearnerProfile, logLearningEvent } from "../lib/supermemory";
import { consume } from "../lib/usage";

/** GET /guide. No Gemini calls. */
export const list = handler(async (event) => {
  const userId = getUserId(event);
  const response: GuideListResponse = { entries: await buildGuide(userId) };
  return json(200, response);
});

/** GET /guide/{conceptId}?refresh=true. Generates and caches the explanation on first call. */
export const get = handler(async (event) => {
  const userId = getUserId(event);
  const conceptId = pathParam(event, "conceptId");

  const ctx = await getConceptContext(userId, conceptId);
  if (!ctx) throw notFound("That concept does not exist.");

  if (ctx.explanation !== null && !queryFlag(event, "refresh")) {
    const cached = await getGuideEntry(userId, conceptId);
    if (!cached) throw notFound("That concept does not exist.");
    const response: GuideEntryResponse = { entry: cached };
    return json(200, response);
  }

  await consume(userId, "ai");
  // The learner profile is always read before Gemini is called.
  const profile = await getLearnerProfile(userId, {
    conceptLabel: ctx.node.label,
    courseName: ctx.courseName,
  });
  const content = await generateTutoring(ctx, profile);
  const entry = await saveGuideContent(userId, conceptId, content);
  await logLearningEvent(userId, {
    type: "explanation-viewed",
    courseName: ctx.courseName,
    conceptLabel: ctx.node.label,
    confidence: ctx.node.confidence,
    retention: ctx.node.retention,
    timestamp: new Date().toISOString(),
  });

  const response: GuideEntryResponse = { entry };
  return json(200, response);
});
