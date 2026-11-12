import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allCommandIds,
  COMMAND_IDS,
  catalogKeys,
  DEFAULT_BINDINGS,
  isCatalogCommand,
  type KeyBinding,
  keysOf,
  type PanelCommand,
  panelCommandId,
} from "./keyboard";
import { bindingProblem, presetKeymap, resolveBindings, sameBinding } from "./keymap";
import { PRESET_IDS, presetKeys, presetsOffered } from "./keyPresets";
import type { KeySystem } from "./platform";
import { parseSuggestedKey } from "./plugins/panelCards";

/**
 * INF-3547's accepted plan, piece 4: "Every preset key passes the same rules
 * as a person's key (Legacy's are grandfathered), and a test holds each
 * preset to 'no two commands that can work in the same place share a key'".
 */

/** The app's own Tasks panel's commands, read from its manifest as the window reads them. */
function tasksPanelCommands(): PanelCommand[] {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "../panels/now/manifest.json"), "utf8"),
  ) as {
    title: string;
    commands: { id: string; label: string; key?: string }[];
  };
  return manifest.commands.map((command) => {
    const chord = command.key === undefined ? null : parseSuggestedKey(command.key);
    return {
      id: panelCommandId("now", command.id),
      label: command.label,
      panel: manifest.title,
      keys: chord ? [chord as KeyBinding] : [],
      own: true as const,
    };
  });
}

const SYSTEMS: readonly KeySystem[] = ["mac", "ctrl"];

function catalogHas(id: string, binding: KeyBinding, system: KeySystem): boolean {
  return isCatalogCommand(id) && catalogKeys(id, system).some((old) => sameBinding(old, binding));
}

describe("each preset", () => {
  const panels = tasksPanelCommands();

  for (const system of SYSTEMS)
    for (const preset of PRESET_IDS) {
      it(`${preset} on ${system}: every key it gives works, and none is shared where both work`, () => {
        const bindings = resolveBindings(presetKeymap(preset), panels, system);
        for (const id of allCommandIds(panels)) {
          const own = presetKeys(preset, id, system);
          // A panel's command the preset leaves alone keeps its suggestion.
          if (own.length === 0) continue;
          const kept = keysOf(bindings, id);
          for (const binding of own) {
            expect(
              kept.some((key) => sameBinding(key, binding)),
              `${id} keeps ${JSON.stringify(binding)}`,
            ).toBe(true);
            // The catalog's own keys are Legacy's, kept as they always were.
            if (!catalogHas(id, binding, system))
              expect(bindingProblem(binding, id, panels, system), `${id}`).toBeNull();
          }
        }
      });
    }

  it("Legacy is the catalog's own keys", () => {
    for (const id of COMMAND_IDS) expect(presetKeys("legacy", id)).toEqual(DEFAULT_BINDINGS[id]);
  });

  it("keeps ⌘1 to ⌘4 as the answer keys in every preset", () => {
    for (const preset of PRESET_IDS)
      for (const id of [
        "cards.choice-1",
        "cards.choice-2",
        "cards.choice-3",
        "cards.choice-4",
      ] as const)
        expect(presetKeys(preset, id)).toEqual(DEFAULT_BINDINGS[id]);
  });

  it("offers Legacy only where the profile had it", () => {
    expect(presetsOffered(false)).toEqual(["vim", "emacs", "vscode"]);
    expect(presetsOffered(true)).toEqual(["vim", "emacs", "vscode", "legacy"]);
  });
});
