import type { ConceptBrief, CrossCourseLink } from "../contracts";
import { Type, asObject, clip, generateJson, str, type Schema } from "./client";

export interface CourseForComparison {
  id: string;
  name: string;
  concepts: ConceptBrief[];
}

export const MAX_LINKS = 4;
const MAX_CONCEPTS_IN_PROMPT = 60;
/** Each link becomes |A| x |B| cross-course edges, so keep each side small. */
const MAX_CONCEPTS_PER_SIDE = 2;

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    links: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING, description: "One sentence on what connects them" },
          conceptsA: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Refs from course A, e.g. A3" },
          conceptsB: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Refs from course B, e.g. B7" },
        },
        required: ["description", "conceptsA", "conceptsB"],
      },
    },
  },
  required: ["links"],
};

const SYSTEM = `You compare the concept lists of two courses a student is taking and find genuine shared themes: the same idea, a direct application of one in the other, or a shared underlying principle.
- Return 0 to ${MAX_LINKS} links, strongest first. Return an empty list when nothing genuinely connects; never force a link.
- Each link names 1-${MAX_CONCEPTS_PER_SIDE} concept refs from course A (A1, A2, ...) and 1-${MAX_CONCEPTS_PER_SIDE} from course B (B1, B2, ...), using only refs from the lists.
- description: one specific sentence a student would find useful, naming what the concepts have in common.
- Do not reuse the same pair of concepts in two links.`;

function listing(prefix: string, course: CourseForComparison): string {
  const lines = course.concepts
    .slice(0, MAX_CONCEPTS_IN_PROMPT)
    .map((c, i) => `${prefix}${i + 1}. ${c.label}: ${clip(c.summary, 160)}`);
  return `Course ${prefix}: ${course.name}\n${lines.join("\n")}`;
}

/**
 * Maps the model's short refs back to real concept ids and drops anything that does not
 * resolve. Also accepts a real id in place of a ref. Exported for unit tests.
 */
export function repairLinks(raw: unknown, courseA: CourseForComparison, courseB: CourseForComparison): CrossCourseLink[] {
  const root = asObject(raw, "comparison");
  const resolver = (prefix: string, course: CourseForComparison) => {
    const byRef = new Map<string, string>();
    course.concepts.slice(0, MAX_CONCEPTS_IN_PROMPT).forEach((c, i) => byRef.set(`${prefix}${i + 1}`, c.id));
    const ids = new Set(course.concepts.map((c) => c.id));
    return (values: unknown): string[] => {
      const out: string[] = [];
      for (const v of Array.isArray(values) ? values : []) {
        const ref = str(v);
        const id = byRef.get(ref.toUpperCase().replace(/[^A-Z0-9]/g, "")) ?? (ids.has(ref) ? ref : undefined);
        if (id && !out.includes(id) && out.length < MAX_CONCEPTS_PER_SIDE) out.push(id);
      }
      return out;
    };
  };
  const resolveA = resolver("A", courseA);
  const resolveB = resolver("B", courseB);

  const links: CrossCourseLink[] = [];
  const usedPairs = new Set<string>();
  for (const item of Array.isArray(root.links) ? root.links : []) {
    if (typeof item !== "object" || item === null || links.length >= MAX_LINKS) continue;
    const l = item as Record<string, unknown>;
    const description = clip(str(l.description), 300);
    const a = resolveA(l.conceptsA);
    const b = resolveB(l.conceptsB);
    if (!description || a.length === 0 || b.length === 0) continue;
    const pairs = a.flatMap((x) => b.map((y) => `${x}|${y}`));
    if (pairs.every((p) => usedPairs.has(p))) continue;
    pairs.forEach((p) => usedPairs.add(p));
    links.push({
      sourceCourseId: courseA.id,
      targetCourseId: courseB.id,
      sharedConceptIds: [...a, ...b],
      description,
    });
  }
  return links;
}

export async function compareCourses(
  courseA: CourseForComparison,
  courseB: CourseForComparison,
): Promise<CrossCourseLink[]> {
  if (courseA.concepts.length === 0 || courseB.concepts.length === 0) return [];
  return generateJson({
    name: "compareCourses",
    system: SYSTEM,
    prompt: `${listing("A", courseA)}\n\n${listing("B", courseB)}`,
    schema,
    validate: (raw) => repairLinks(raw, courseA, courseB),
    temperature: 0.2,
    maxOutputTokens: 2_048,
  });
}
