import { KNOWLEDGE_GRAPH_LIMITS, type KnowledgeConnection } from "@shared/knowledge";
import { describe, expect, it } from "vitest";
import { chooseGraph, degreesOf, neighborhoodOf, pageOf, standingOf } from "./browse";

/**
 * The browser's bounds (docs/knowledge.md, "The browser"): a graph read
 * draws at most 75 concepts and 200 connections and says what it left out,
 * a neighborhood walks one or two hops and never twice round a cycle, and a
 * list answers a page that exists.
 */

const claim = (from: string, to: string, id = `claim:${from}-${to}`): KnowledgeConnection => ({
  kind: "claim",
  id,
  from,
  to,
  predicate: "leads to",
  finding: "f-aaaaaa",
  standing: "unchecked",
});
const context = (from: string, to: string): KnowledgeConnection => ({
  kind: "context",
  id: `context:${from}:${to}`,
  from,
  to,
  reason: "read together",
});

function conceptsFor(ids: string[], connections: KnowledgeConnection[]) {
  const degree = degreesOf(connections);
  return ids.map((id) => ({
    id,
    title: id,
    aliases: [],
    findings: 0,
    degree: degree.get(id) ?? 0,
  }));
}

describe("the browser's bounds", () => {
  it("draws at most 75 concepts and 200 connections, the most connected first, and counts the rest", () => {
    const ids = Array.from({ length: 140 }, (_, i) => `c-${String(i).padStart(6, "0")}`);
    // A hub joined to every other concept, then a ring among them all.
    const connections = [
      ...ids.slice(1).map((id) => claim(ids[0] as string, id)),
      ...ids.map((id, i) => context(id, ids[(i + 1) % ids.length] as string)),
    ];
    const chosen = chooseGraph(conceptsFor(ids, connections), connections);
    expect(chosen.shown.concepts).toBe(KNOWLEDGE_GRAPH_LIMITS.concepts);
    expect(chosen.total.concepts).toBe(140);
    expect(chosen.concepts[0]?.id).toBe(ids[0]);
    expect(chosen.shown.connections).toBeLessThanOrEqual(KNOWLEDGE_GRAPH_LIMITS.connections);
    expect(chosen.total.connections).toBe(connections.length);
    // Every connection drawn joins two drawn concepts; claims come before links.
    const drawn = new Set(chosen.concepts.map((concept) => concept.id));
    for (const line of chosen.connections) {
      expect(drawn.has(line.from) && drawn.has(line.to)).toBe(true);
    }
    const firstLink = chosen.connections.findIndex((line) => line.kind === "context");
    const lastClaim = chosen.connections.map((line) => line.kind).lastIndexOf("claim");
    expect(firstLink === -1 || lastClaim < firstLink).toBe(true);
  });

  it("caps the connections at 200 among concepts that have more", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c-${String(i).padStart(6, "0")}`);
    const connections = ids.flatMap((a, i) =>
      ids.slice(i + 1).map((b) => claim(a, b, `claim:${a}:${b}`)),
    );
    const chosen = chooseGraph(conceptsFor(ids, connections), connections);
    expect(chosen.shown).toEqual({ concepts: 30, connections: 200 });
    expect(chosen.total).toEqual({ concepts: 30, connections: 435 });
  });

  it("walks a neighborhood one or two hops out, nearest first, once round a cycle", () => {
    const connections = [claim("a", "b"), claim("b", "c"), claim("c", "a"), context("c", "d")];
    expect([...neighborhoodOf("a", connections, 1)]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
    ]);
    expect(neighborhoodOf("a", connections, 2).get("d")).toBe(2);
    const chosen = chooseGraph(
      conceptsFor(["a", "b", "c", "d", "e"], connections),
      connections,
      neighborhoodOf("d", connections, 1),
    );
    expect(chosen.concepts.map((concept) => concept.id)).toEqual(["d", "c"]);
    expect(chosen.total).toEqual({ concepts: 2, connections: 1 });
  });

  it("answers a page that exists", () => {
    const rows = Array.from({ length: 45 }, (_, i) => i);
    expect(pageOf(rows, 0)).toEqual({ rows: rows.slice(0, 20), page: 0 });
    expect(pageOf(rows, 2)).toEqual({ rows: rows.slice(40), page: 2 });
    expect(pageOf(rows, 7).page).toBe(2);
    expect(pageOf([], 3)).toEqual({ rows: [], page: 0 });
  });

  it("names a finding's standing: replaced and retired first, then differing, then rechecking", () => {
    expect(standingOf({ state: "retired", challenged: true }, true)).toBe("retired");
    expect(standingOf({ state: "superseded", challenged: false }, true)).toBe("superseded");
    expect(standingOf({ state: "disputed", challenged: false }, true)).toBe("differing");
    expect(standingOf({ state: "checked", challenged: true }, false)).toBe("differing");
    expect(standingOf({ state: "checked", challenged: false }, true)).toBe("recheck");
    expect(standingOf({ state: "checked", challenged: false }, false)).toBe("checked");
    expect(standingOf({ state: "unchecked", challenged: false }, false)).toBe("unchecked");
  });
});
