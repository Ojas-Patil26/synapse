// Semester helpers: an optional label on each course ("Fall 2026") used to group and filter the map.
import type { Course, GraphResponse } from "../contracts";

export const ALL_SEMESTERS = "all";

const TERM_ORDER: Record<string, number> = { spring: 1, summer: 2, fall: 3, winter: 0 };

/** Newest first: "Fall 2026" > "Summer 2026" > "Spring 2026"; labels that do not parse sort last, alphabetically. */
function termRank(label: string): number {
  const m = /^(spring|summer|fall|winter)\s+(\d{4})$/i.exec(label.trim());
  return m ? Number(m[2]) * 10 + TERM_ORDER[m[1].toLowerCase()] : -1;
}

export function semestersOf(courses: Pick<Course, "semester">[]): string[] {
  const set = new Set<string>();
  for (const c of courses) if (c.semester) set.add(c.semester);
  return [...set].sort((a, b) => termRank(b) - termRank(a) || a.localeCompare(b));
}

/** The current and the next term, for one-tap suggestions on the upload form. */
export function suggestSemesters(now = new Date()): string[] {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0 = January
  if (m <= 4) return [`Spring ${y}`, `Fall ${y}`];
  if (m <= 6) return [`Summer ${y}`, `Fall ${y}`];
  return [`Fall ${y}`, `Spring ${y + 1}`];
}

export function semesterOptions(courses: Pick<Course, "semester">[]): string[] {
  return [...new Set([...semestersOf(courses), ...suggestSemesters()])];
}

/** Keeps only the courses of one semester, with their concepts and the edges and links between them. */
export function filterGraphBySemester(graph: GraphResponse, semester: string): GraphResponse {
  if (semester === ALL_SEMESTERS) return graph;
  const courses = graph.courses.filter((c) => c.semester === semester);
  const ids = new Set(courses.map((c) => c.id));
  const nodes = graph.nodes.filter((n) => ids.has(n.courseId));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    courses,
    nodes: nodes.map((n) => ({ ...n, connectionCount: degree.get(n.id) ?? 0 })),
    edges,
    crossCourseLinks: graph.crossCourseLinks.filter((l) => ids.has(l.sourceCourseId) && ids.has(l.targetCourseId)),
  };
}
