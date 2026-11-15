import type { ExtractedConcept, ExtractedDependency } from "../contracts";
import { InvalidOutputError, Type, asArray, asObject, clip, generateJson, str, type Schema } from "./client";

export const MAX_NODES = 40;
export const MAX_SUBCONCEPTS_PER_PARENT = 3;
const MIN_CONCEPTS = 3;
const MAX_SOURCE_CHARS = 60_000;

export interface ExtractionResult {
  concepts: ExtractedConcept[];
  dependencies: ExtractedDependency[];
}

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    concepts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING, description: "Short unique lowercase slug, e.g. round-robin" },
          label: { type: Type.STRING, description: "Concept name, 1-5 words" },
          summary: { type: Type.STRING, description: "1-2 sentences" },
          parentKey: { type: Type.STRING, nullable: true, description: "Key of the parent concept, or null" },
        },
        required: ["key", "label", "summary"],
      },
    },
    dependencies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          from: { type: Type.STRING },
          to: { type: Type.STRING },
          type: { type: Type.STRING, enum: ["prerequisite", "related"] },
        },
        required: ["from", "to", "type"],
      },
    },
  },
  required: ["concepts", "dependencies"],
};

const SYSTEM = `You turn a student's course notes into a concept map.
Rules:
- Use only what the notes cover. Do not invent topics the notes do not mention.
- Produce 8 to 20 top-level concepts (fewer only if the notes are very short).
- Where the notes clearly break a concept into parts, add 0 to 3 sub-concepts under it by setting parentKey to the parent's key. Sub-concepts never have their own sub-concepts. Top-level concepts have parentKey null.
- At most ${MAX_NODES} concepts in total.
- key: short unique lowercase slug with hyphens. label: 1-5 words, title case. summary: 1-2 plain sentences explaining the concept as the notes present it.
- dependencies connect concept keys. "prerequisite": "from" must be learned before "to". "related": the two are closely linked without an order. Give every top-level concept at least one dependency where the notes support it. Do not repeat a parent/sub-concept pair as a dependency.`;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Validates and repairs raw model output. Exported for unit tests. */
export function repairExtraction(raw: unknown): ExtractionResult {
  const root = asObject(raw, "extraction");
  const rawConcepts = asArray(root.concepts, "concepts");
  const rawDeps = Array.isArray(root.dependencies) ? root.dependencies : [];

  // Pass 1: clean concepts, make keys unique. `alias` maps the model's key to ours.
  const alias = new Map<string, string>();
  const seenLabels = new Set<string>();
  const cleaned: (ExtractedConcept & { rawParent: string })[] = [];
  for (const item of rawConcepts) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const label = clip(str(c.label), 60);
    if (!label) continue;
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) continue;
    seenLabels.add(labelKey);

    const rawKey = str(c.key);
    const base = slugify(rawKey) || slugify(label) || `concept-${cleaned.length + 1}`;
    let key = base;
    for (let n = 2; cleaned.some((x) => x.key === key); n++) key = `${base}-${n}`;
    if (rawKey && !alias.has(rawKey)) alias.set(rawKey, key);
    if (!alias.has(key)) alias.set(key, key);

    cleaned.push({
      key,
      label,
      summary: clip(str(c.summary) || label, 400),
      parentKey: null,
      rawParent: str(c.parentKey),
    });
  }

  // Pass 2: resolve parents. A parent must exist, be someone else, and be top-level.
  const byKey = new Map(cleaned.map((c) => [c.key, c]));
  for (const c of cleaned) {
    const parent = c.rawParent ? alias.get(c.rawParent) ?? alias.get(slugify(c.rawParent)) : undefined;
    if (parent && parent !== c.key && byKey.has(parent)) c.parentKey = parent;
  }
  for (const c of cleaned) {
    if (c.parentKey && byKey.get(c.parentKey)?.parentKey) c.parentKey = null; // no grandchildren
  }

  // Pass 3: cap sub-concepts per parent, then cap the total (top-level concepts win).
  const subCount = new Map<string, number>();
  const topLevel = cleaned.filter((c) => !c.parentKey);
  const subs = cleaned.filter((c) => {
    if (!c.parentKey) return false;
    const n = subCount.get(c.parentKey) ?? 0;
    if (n >= MAX_SUBCONCEPTS_PER_PARENT) return false;
    subCount.set(c.parentKey, n + 1);
    return true;
  });
  const keptTop = topLevel.slice(0, MAX_NODES);
  const keptTopKeys = new Set(keptTop.map((c) => c.key));
  const keptSubs = subs.filter((c) => keptTopKeys.has(c.parentKey!)).slice(0, MAX_NODES - keptTop.length);
  const kept = [...keptTop, ...keptSubs];
  if (kept.length < MIN_CONCEPTS) {
    throw new InvalidOutputError(`only ${kept.length} usable concepts`);
  }
  const keptKeys = new Set(kept.map((c) => c.key));
  const concepts: ExtractedConcept[] = kept.map(({ key, label, summary, parentKey }) => ({
    key,
    label,
    summary,
    parentKey,
  }));

  // Dependencies: both ends must survive, no self loops, no duplicates, no parent/child repeats.
  const parentPairs = new Set(concepts.filter((c) => c.parentKey).map((c) => pairKey(c.key, c.parentKey!)));
  const seenPairs = new Set<string>();
  const dependencies: ExtractedDependency[] = [];
  for (const item of rawDeps) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as Record<string, unknown>;
    const from = alias.get(str(d.from)) ?? alias.get(slugify(str(d.from)));
    const to = alias.get(str(d.to)) ?? alias.get(slugify(str(d.to)));
    if (!from || !to || from === to || !keptKeys.has(from) || !keptKeys.has(to)) continue;
    const pair = pairKey(from, to);
    if (seenPairs.has(pair) || parentPairs.has(pair)) continue;
    seenPairs.add(pair);
    dependencies.push({ from, to, type: d.type === "prerequisite" ? "prerequisite" : "related" });
  }

  return { concepts, dependencies };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Runs inside the 5-minute ingest Lambda, so it gets a longer time budget than the
 * API-route calls: a 40-node map is a few thousand output tokens.
 */
export async function extractConcepts(sourceText: string, courseName: string): Promise<ExtractionResult> {
  const notes = sourceText.length > MAX_SOURCE_CHARS ? sourceText.slice(0, MAX_SOURCE_CHARS) : sourceText;
  return generateJson({
    name: "extractConcepts",
    system: SYSTEM,
    prompt: `Course name: ${courseName}\n\nNotes:\n"""\n${notes}\n"""`,
    schema,
    validate: repairExtraction,
    budgetMs: 150_000,
    attemptTimeoutMs: 80_000,
    temperature: 0.2,
    maxOutputTokens: 12_000,
  });
}
