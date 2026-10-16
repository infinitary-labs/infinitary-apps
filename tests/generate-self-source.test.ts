import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CARD_PRESENTATIONS } from "@shared/cards";
import { fmEventSchema } from "@shared/events";
import { invokeContract, pushContract } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCrewmateTools, claudeToolsOf } from "../src/core/claude/claudeTaskTools";
import { createCrewmateTools } from "../src/core/pi/crewmateTools";
import { EMOTE_TOOL_NAME } from "../src/core/pi/emoteTool";
import { buildCrewmateSystemPrompt, buildFirstmateSystemPrompt } from "../src/core/pi/piResources";
import { piToolsOf } from "../src/core/pi/toolSpec";
import { FIRSTMATE_TOOLS } from "../src/core/session/tools";
import { crewmateToolDelegate } from "./helpers/crewmateToolDelegate";
import { firstmateTools } from "./helpers/firstmateTools";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The self-source generator is the packaging contract for P1: run the real
 * script, then assert the archive and self-map against live app modules -
 * not against the script's source text.
 */

const repoRoot = join(__dirname, "..");
const scriptPath = join(repoRoot, "scripts", "generate-self-source.mjs");

describe("generate-self-source", () => {
  let outDir: string;

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("archives the tracked tree and indexes live behavior onto source", async () => {
    outDir = scratchDir("infinitary-self-source-");
    const result = spawnSync(process.execPath, [scriptPath, "--out", outDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const selfSource = join(outDir, "self-source");
    expect(existsSync(join(selfSource, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(selfSource, "package.json"))).toBe(true);
    expect(existsSync(join(selfSource, "src/main/index.ts"))).toBe(true);
    expect(existsSync(join(selfSource, "src/core/orchestrator/firstmateAgent.ts"))).toBe(true);
    expect(existsSync(join(selfSource, "docs/architecture.md"))).toBe(true);
    expect(existsSync(join(selfSource, "tests/release-contract.test.ts"))).toBe(true);
    expect(existsSync(join(selfSource, "electron-builder.yml"))).toBe(true);
    expect(existsSync(join(selfSource, ".github/workflows/release.yml"))).toBe(true);
    expect(existsSync(join(selfSource, ".claude/skills/infinitary-design/SKILL.md"))).toBe(true);
    expect(existsSync(join(selfSource, "node_modules"))).toBe(false);

    const map = JSON.parse(readFileSync(join(outDir, "self-map.json"), "utf8")) as {
      version: string;
      commit: string;
      modules: Record<string, string | string[]>;
      ipc: { invoke: string[]; push: string[] };
      tools: { name: string; module: string }[];
      crewmateTools: { name: string; module: string }[];
      prompts: Record<string, { builder: string; module: string }>;
      cardPresentations: string[];
      events: string[];
    };
    expect(readFileSync(join(selfSource, "self-map.json"), "utf8")).toBe(
      readFileSync(join(outDir, "self-map.json"), "utf8"),
    );

    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(map.version).toBe(pkg.version);
    expect(map.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(map.modules["src/main/index.ts"]).toBe("out/main");
    expect(map.modules["src/preload/index.ts"]).toBe("out/preload");
    expect(map.modules["src/renderer/src/app/store.ts"]).toBe("out/renderer");
    expect(map.modules["src/shared/ipc.ts"]).toEqual(["out/main", "out/preload", "out/renderer"]);
    expect(map.ipc.invoke).toEqual(Object.keys(invokeContract));
    expect(map.ipc.push).toEqual(Object.keys(pushContract));
    expect(map.cardPresentations).toEqual([...CARD_PRESENTATIONS]);
    expect(map.events).toEqual(
      fmEventSchema.def.options.map((schema) => {
        const type = (schema as { shape: { type: { value: string } } }).shape.type.value;
        return type;
      }),
    );

    // The Firstmate's tools, read off the live agent (the one spec list
    // both seats serve). The map indexes every one but the host's own
    // emote; the canonical inventory owns the count.
    const bound = await firstmateTools();
    const firstmate = bound.map((tool) => tool.name);
    expect(map.tools).toHaveLength(FIRSTMATE_TOOLS.length);
    expect(map.tools.map((tool) => tool.name)).toEqual(
      firstmate.filter((name) => name !== EMOTE_TOOL_NAME),
    );
    expect(firstmate).toHaveLength(FIRSTMATE_TOOLS.length + 1);
    expect(firstmate).toContain(EMOTE_TOOL_NAME);
    // Both runtimes generate that same set, in order: the pinned list plus
    // emote, on the Pi seat and the Claude seat alike.
    expect(piToolsOf(bound).map((tool) => tool.name)).toEqual(firstmate);
    expect(claudeToolsOf(bound).map((tool) => tool.name)).toEqual(firstmate);
    for (const tool of map.tools) {
      expect(existsSync(join(repoRoot, tool.module)), tool.module).toBe(true);
    }

    // The crewmate tool set is the spec both runtimes generate from (P7):
    // the map lists what a crewmate with every callback is served, on Pi
    // and on Claude alike.
    const everyCallback = crewmateToolDelegate();
    const crewmateNames = map.crewmateTools.map((tool) => tool.name);
    expect(crewmateNames).toEqual(createCrewmateTools(everyCallback).map((tool) => tool.name));
    expect(crewmateNames).toEqual(claudeCrewmateTools(everyCallback).map((tool) => tool.name));
    for (const tool of map.crewmateTools) {
      expect(existsSync(join(repoRoot, tool.module)), tool.module).toBe(true);
    }

    expect(map.prompts.firstmate?.builder).toBe("buildFirstmateSystemPrompt");
    expect(map.prompts.crewmate?.builder).toBe("buildCrewmateSystemPrompt");
    expect(map.prompts.sequences?.builder).toBe("SEQUENCES_SEED");
    expect(typeof buildFirstmateSystemPrompt()).toBe("string");
    expect(typeof buildCrewmateSystemPrompt()).toBe("string");
    expect(existsSync(join(repoRoot, map.prompts.firstmate?.module as string))).toBe(true);
    // The real script archives the whole tracked tree: seconds of real I/O
    // that ran past the 5s default under a full parallel run (5.9s).
  }, 60_000);
});
