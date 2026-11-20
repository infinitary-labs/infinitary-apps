import { statSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PanelAsks } from "./panelAsks";

/**
 * INF-2334 piece 1, the captain's "one ask per panel and action at a time":
 * a panel's background code may call on a timer, so its open or turned-down
 * ask is held until the captain answers or the panel's line asks again, and
 * what is held outlives a restart.
 */

function ask(id: string, action = "count_items"): IntegrationAsk {
  return {
    id,
    kind: "integration",
    by: "panel",
    panel: { key: "workspace:items", title: "Items" },
    integration: "stand-in",
    connection: "stand-in:1",
    place: "Stand-in",
    action,
    label: "Count the stand-in's items",
    reason: "Shows how many items the stand-in holds.",
    input: "{}",
    at: 1,
  };
}

describe("PanelAsks", () => {
  it("holds one ask per panel and action, keeps Not now, and lets Always allow take it away", () => {
    const dir = scratchDir("infinitary-panel-asks-");
    const asks = new PanelAsks(dir);
    const heard = vi.fn();
    asks.subscribe(heard);
    asks.asking(ask("ia1"), "card-1");
    expect(asks.held("workspace:items", "stand-in", "count_items")?.state).toBe("asking");
    expect(asks.held("workspace:items", "stand-in", "other")).toBeUndefined();
    expect(asks.of("workspace:items")).toEqual([
      {
        integration: "stand-in",
        place: "Stand-in",
        action: "count_items",
        label: "Count the stand-in's items",
        state: "asking",
      },
    ]);

    asks.answered("ia1", true);
    // A restart reads what was held, turned down.
    const reopened = new PanelAsks(dir);
    expect(reopened.of("workspace:items").map((line) => line.state)).toEqual(["declined"]);
    expect((statSync(join(dir, "panel-asks.json")).mode & 0o777).toString(8)).toBe("600");

    // Ask again forgets the line, and the next ask raised replaces nothing else.
    reopened.forget("workspace:items", "stand-in", "count_items");
    reopened.asking(ask("ia2"), "card-2");
    reopened.answered("ia2", false);
    expect(reopened.of("workspace:items")).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer to an ask it never held and an ask with no panel", () => {
    const asks = new PanelAsks(scratchDir("infinitary-panel-asks-none-"));
    const { panel: _panel, ...unowned } = ask("ia3");
    asks.asking(unowned, "card-3");
    asks.answered("ia-unknown", true);
    expect(asks.of("workspace:items")).toEqual([]);
  });
});
