import { buildGraph } from "../lib/data/service";
import { getUserId, handler, json, notFound } from "../lib/http";

/** GET /graph and GET /graph/{courseId} */
export const getGraph = handler(async (event) => {
  const userId = getUserId(event);
  const courseId = event.pathParameters?.courseId || undefined;
  const graph = await buildGraph(userId, courseId);
  if (!graph) throw notFound("That course does not exist or is not ready yet.");
  return json(200, graph);
});
