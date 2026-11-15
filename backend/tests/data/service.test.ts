// Offline run of the service scenario against in-memory fakes of Mongo and Tiger.
// The same scenario runs live in tests/data/integration.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lambda/lib/data/mongo", async () => (await import("./fakes")).fakeMongoModule);
vi.mock("../../lambda/lib/data/tiger", async () => (await import("./fakes")).fakeTigerModule);

import * as svc from "../../lambda/lib/data/service";
import { fakeMongoModule, fakeTigerState } from "./fakes";
import { runScenario } from "./scenario";

const DAY = 86_400_000;

describe("data service (in-memory Mongo + Tiger)", () => {
  beforeEach(async () => {
    fakeTigerState.events = [];
  });

  it("passes the full scenario and cleans up", async () => {
    const lines: string[] = [];
    const failures = await runScenario("itest-offline", (line) => lines.push(line));
    expect(failures).toEqual([]);
    expect(lines.filter((l) => l.startsWith("PASS")).length).toBeGreaterThan(60);
  });

  it("runDecayScan reports concepts that newly crossed R < 0.5, once", async () => {
    const userId = "itest-atrisk";
    const course = await svc.createCourse(userId, "Risky");
    const { nodes } = await svc.saveExtractedGraph(userId, course.id, {
      concepts: [
        { key: "a", label: "Alpha", summary: "a", parentKey: null },
        { key: "b", label: "Beta", summary: "b", parentKey: null },
      ],
      dependencies: [],
      sourceText: "",
    });
    await svc.setCourseStatus(userId, course.id, "ready");

    // Age "Alpha" by 10 days in both stores: S0 = 2 -> R = e^-5.
    const alpha = nodes.find((n) => n.label === "Alpha")!;
    const old = new Date(Date.now() - 10 * DAY);
    for (const e of fakeTigerState.events) if (e.conceptId === alpha.id) e.ts = old;
    const cols = await fakeMongoModule.collections();
    await cols.concepts.updateOne({ userId, id: alpha.id }, { $set: { lastReviewed: old.toISOString() } });

    const first = await svc.runDecayScan();
    expect(first.conceptsScanned).toBe(2);
    expect(first.newlyAtRisk.map((x) => x.label)).toEqual(["Alpha"]);
    expect(first.newlyAtRisk[0]).toMatchObject({ userId, conceptId: alpha.id, courseName: "Risky", zScore: null });
    expect(first.newlyAtRisk[0].retention).toBeCloseTo(Math.exp(-5), 3);
    expect(first.newlyAnomalous).toEqual([]);

    const second = await svc.runDecayScan();
    expect(second.newlyAtRisk).toEqual([]);

    const status = await svc.decayStatus(userId, course.id);
    expect(status?.summary.atRiskCount).toBe(1);
    expect(status?.scannedAt).not.toBeNull();

    // A review brings it back; the node comes back with R = 1 and S * 1.5.
    const node = await svc.applySelfReview(userId, alpha.id, "got-it");
    expect(node.retention).toBe(1);
    expect(node.stability).toBe(3);
    await fakeMongoModule.deleteUserData(userId);
  });

  it("a retried ingest replaces the previous graph", async () => {
    const userId = "itest-retry";
    const course = await svc.createCourse(userId, "Retry");
    const input = {
      concepts: [
        { key: "a", label: "Alpha", summary: "a", parentKey: "b" },
        { key: "b", label: "Beta", summary: "b", parentKey: "a" }, // parent cycle: second link dropped
      ],
      dependencies: [],
      sourceText: "x".repeat(70_000),
    };
    await svc.saveExtractedGraph(userId, course.id, input);
    const again = await svc.saveExtractedGraph(userId, course.id, input);
    await svc.setCourseStatus(userId, course.id, "ready");
    const graph = await svc.buildGraph(userId);
    expect(graph?.nodes.length).toBe(2);
    expect(graph?.edges).toEqual(again.edges);
    expect(again.edges.length).toBe(1);
    expect(again.edges[0].relationType).toBe("subconcept");
    expect(fakeTigerState.events.filter((e) => e.userId === userId).length).toBe(2);
    const cols = await fakeMongoModule.collections();
    const stored = await cols.courses.findOne({ userId, id: course.id });
    expect(stored?.sourceText.length).toBe(60_000);
    await fakeMongoModule.deleteUserData(userId);
  });
});
