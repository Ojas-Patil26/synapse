import { InvalidOutputError, Type, asObject, clip, generateJson, str, type Schema } from "./client";

export interface SkillsResult {
  industrySkills: string[];
  skillsSummary: string;
}

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    industrySkills: { type: Type.ARRAY, items: { type: Type.STRING } },
    skillsSummary: { type: Type.STRING },
  },
  required: ["industrySkills", "skillsSummary"],
};

const SYSTEM = `You map a university course to skills employers actually hire for.
- industrySkills: 4 to 8 short skill names (1-4 words each) as they would appear on a job posting or resume, e.g. "Concurrent Programming", "SQL Query Optimization". Real, industry-usable skills only; no course titles, no vague traits like "Problem Solving".
- skillsSummary: 2-3 sentences on how this course's concepts translate to work in industry and which roles use them. Plain language, no bullet points.`;

/** Exported for unit tests. */
export function repairSkills(raw: unknown): SkillsResult {
  const root = asObject(raw, "skills");
  const seen = new Set<string>();
  const industrySkills: string[] = [];
  for (const item of Array.isArray(root.industrySkills) ? root.industrySkills : []) {
    const skill = clip(str(item), 48);
    const k = skill.toLowerCase();
    if (!skill || seen.has(k)) continue;
    seen.add(k);
    industrySkills.push(skill);
    if (industrySkills.length === 8) break;
  }
  const skillsSummary = clip(str(root.skillsSummary), 700);
  if (industrySkills.length < 4) throw new InvalidOutputError(`only ${industrySkills.length} skills`);
  if (!skillsSummary) throw new InvalidOutputError("missing skillsSummary");
  return { industrySkills, skillsSummary };
}

export async function tagSkills(courseName: string, conceptLabels: string[]): Promise<SkillsResult> {
  const labels = conceptLabels.slice(0, 60).join("; ");
  return generateJson({
    name: "tagSkills",
    system: SYSTEM,
    prompt: `Course: ${courseName}\nConcepts covered: ${labels || "(not listed)"}`,
    schema,
    validate: repairSkills,
    temperature: 0.3,
    maxOutputTokens: 1_024,
  });
}
