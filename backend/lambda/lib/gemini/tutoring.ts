import type { ConceptContext, Resource } from "../contracts";
import { InvalidOutputError, Type, asObject, clip, generateJson, str, type Schema } from "./client";

export interface TutoringResult {
  summary: string;
  explanation: string;
  resources: Resource[];
}

type ResourceType = Resource["type"];
const RESOURCE_TYPES: ResourceType[] = ["video", "article", "practice"];
const MIN_RESOURCES = 3;
const MAX_RESOURCES = 5;

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "1-2 sentences" },
    explanation: { type: Type.STRING, description: "Markdown tutoring explanation" },
    resources: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          type: { type: Type.STRING, enum: RESOURCE_TYPES },
          searchQuery: { type: Type.STRING, description: "Search-engine query, no URL" },
        },
        required: ["title", "type", "searchQuery"],
      },
    },
  },
  required: ["summary", "explanation", "resources"],
};

const SYSTEM = `You are a patient one-on-one tutor writing a study-guide entry for one concept.
Write for THIS learner: use the learner profile, their current retention and their confidence to decide what to emphasise.
- Low retention (they are forgetting it): start with a quick refresher of the core idea before going deeper.
- Low confidence or missed quiz questions in the profile: slow down on the parts they got wrong and address likely misconceptions directly.
- High retention and confidence: go past the basics into edge cases, trade-offs and connections to other topics.
- Never mention the profile, scores or percentages; just teach accordingly.
Output:
- summary: 1-2 sentences capturing the concept, phrased for this learner. Plain text, no LaTeX.
- explanation: 250-450 words of markdown. Use short "##" headings, a concrete worked example, and one "Common mistake" note. Ground it in the notes excerpt when one is given. No top-level title, no links. Never use LaTeX or dollar-sign math: write formulas with ordinary characters or inline code, for example \`f(n) = g(n) + h(n)\`, s0, O(b^d), a -> b.
- resources: 3 to 5 items mixing "video", "article" and "practice". Give a specific title and a search query that would find it. Never output URLs.`;

export function resourceUrl(type: ResourceType, query: string): string {
  const q = encodeURIComponent(query);
  return type === "video"
    ? `https://www.youtube.com/results?search_query=${q}`
    : `https://www.google.com/search?q=${q}`;
}

function fallbackResources(label: string, courseName: string): { title: string; type: ResourceType; query: string }[] {
  return [
    { title: `${label} explained`, type: "video", query: `${label} explained ${courseName}` },
    { title: `${label}: a written walkthrough`, type: "article", query: `${label} tutorial ${courseName}` },
    { title: `Practice problems on ${label}`, type: "practice", query: `${label} practice problems with solutions` },
  ];
}

/** Validates and repairs raw model output; URLs are always built here. Exported for unit tests. */
export function repairTutoring(raw: unknown, ctx: ConceptContext): TutoringResult {
  const root = asObject(raw, "tutoring");
  const explanation = str(root.explanation);
  if (explanation.length < 200) throw new InvalidOutputError("explanation too short");
  const summary = clip(str(root.summary) || ctx.summary, 500);

  const resources: Resource[] = [];
  const seen = new Set<string>();
  const add = (title: string, type: ResourceType, query: string) => {
    const cleanTitle = clip(title.trim(), 120);
    // Gemini must never supply a URL; a query that looks like one is rejected.
    const cleanQuery = /https?:\/\/|www\./i.test(query) ? "" : clip(query.trim(), 150);
    const k = `${type}|${cleanTitle.toLowerCase()}`;
    if (!cleanTitle || !cleanQuery || seen.has(k) || resources.length >= MAX_RESOURCES) return;
    seen.add(k);
    resources.push({ title: cleanTitle, type, url: resourceUrl(type, cleanQuery) });
  };

  for (const item of Array.isArray(root.resources) ? root.resources : []) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const type = RESOURCE_TYPES.find((t) => t === r.type);
    if (!type) continue;
    const title = str(r.title);
    add(title, type, str(r.searchQuery) || title);
  }
  for (const f of fallbackResources(ctx.node.label, ctx.courseName)) {
    if (resources.length >= MIN_RESOURCES) break;
    add(f.title, f.type, f.query);
  }

  return { summary, explanation, resources };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function learnerSection(ctx: ConceptContext, learnerProfile: string): string {
  const confidence = ctx.node.confidence === null ? "never assessed" : pct(ctx.node.confidence);
  return [
    `Estimated retention right now: ${pct(ctx.node.retention)} (memory stability ${ctx.node.stability.toFixed(1)} days)`,
    `Quiz-based confidence: ${confidence}`,
    `Learner profile:\n${learnerProfile.trim() ? clip(learnerProfile.trim(), 3_000) : "(no history yet; assume a first-time learner)"}`,
  ].join("\n");
}

export function conceptSection(ctx: ConceptContext): string {
  const excerpt = ctx.sourceExcerpt.trim();
  return [
    `Course: ${ctx.courseName}`,
    `Concept: ${ctx.node.label}`,
    `Summary from the notes: ${ctx.summary}`,
    excerpt ? `Excerpt from the learner's notes:\n"""\n${clip(excerpt, 6_000)}\n"""` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateTutoring(ctx: ConceptContext, learnerProfile: string): Promise<TutoringResult> {
  return generateJson({
    name: "generateTutoring",
    system: SYSTEM,
    prompt: `${conceptSection(ctx)}\n\n${learnerSection(ctx, learnerProfile)}`,
    schema,
    validate: (raw) => repairTutoring(raw, ctx),
    temperature: 0.5,
    maxOutputTokens: 4_096,
  });
}
