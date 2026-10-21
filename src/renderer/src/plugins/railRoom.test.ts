import { describe, expect, it } from "vitest";
import { type RailRoomPanel, railRoom } from "./railRoom";

// INF-609's accepted middle-first ladder: real header and four-row body readings.
const panels: RailRoomPanel[] = [
  "Computers",
  "Subscriptions",
  "Mac CI",
  "Open changes",
  "Tasks",
].map((id, index) => ({
  id,
  end: index === 4 ? "bottom" : "top",
  header: 40,
  body: 140,
  collapsed: false,
  pinned: false,
}));

describe("the accepted rail fold ladder", () => {
  it("folds the panels nearest the middle and restores them when height returns", () => {
    const short = railRoom(panels, 600, 12, 40);
    expect([...short.folded]).toEqual(["Open changes", "Mac CI", "Subscriptions"]);
    expect(short.hidden.size).toBe(0);
    expect(railRoom(panels, 1000, 12, 40).folded.size).toBe(0);
  });
  it("keeps an explicitly expanded middle panel until the unpinned panels have folded", () => {
    const pinned = panels.map((panel) => ({ ...panel, pinned: panel.id === "Open changes" }));
    expect([...railRoom(pinned, 600, 12, 40).folded]).toEqual([
      "Mac CI",
      "Subscriptions",
      "Computers",
    ]);
  });
  it("reserves the More header and hides at least two when one header no longer fits", () => {
    const result = railRoom(panels, 240, 12, 40);
    expect([...result.hidden]).toEqual(["Open changes", "Mac CI"]);
    expect(panels.filter((panel) => !result.hidden.has(panel.id)).map((panel) => panel.id)).toEqual(
      ["Computers", "Subscriptions", "Tasks"],
    );
  });
  it("folds the highest bottom panel first and honors personal collapse without writing it", () => {
    const bottom = panels.map((panel) => ({ ...panel, end: "bottom" as const }));
    expect([...railRoom(bottom, 800, 12, 40).folded]).toEqual(["Computers", "Subscriptions"]);
    const collapsed = panels.map((panel) => ({ ...panel, collapsed: true }));
    expect(railRoom(collapsed, 300, 12, 40).folded.size).toBe(0);
    expect(collapsed.every((panel) => panel.collapsed)).toBe(true);
  });
  it("keeps every panel reachable through More when even one panel cannot fit", () => {
    const result = railRoom(panels, 40, 12, 40);
    expect(result.hidden.size).toBe(panels.length);
  });
});

it("INF-609 write-move: a More choice returns even when the other panels were expanded explicitly", () => {
  const pinned = panels.map((panel) => ({ ...panel, pinned: panel.id !== "Open changes" }));
  const result = railRoom(pinned, 144, 12, 40, "Open changes");
  expect(result.hidden.has("Open changes")).toBe(false);
  expect(result.hidden.size).toBe(3);
});
