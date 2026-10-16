import {
  type ContractStamp,
  LOCAL_MACHINE_ID,
  type SessionBinding,
  type SessionResume,
  type SessionSpec,
  type TaskShell,
  type ThinkingLevel,
} from "../../src/core/session/session";
import type { BoundTool } from "../../src/core/session/tools";
import { scratchDir } from "./scratchDirs";

/**
 * A session spec with the backend's coding set, for the backends' own tests:
 * the crewmate preset's shape (`crewmateSessionSpec`) with the instruction,
 * the tools and the record a test chooses - a throwaway folder of its own
 * when it chooses none, since every backend now writes the record there.
 */
export function codingSpec(input: {
  binding: SessionBinding;
  cwd: string;
  owner?: string;
  instructions?: string;
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
  quick?: boolean;
  tools?: BoundTool[];
  recordDir?: string;
  resume?: SessionResume;
  stamp?: ContractStamp;
  shell?: TaskShell;
}): SessionSpec {
  return {
    machine: LOCAL_MACHINE_ID,
    owner: input.owner ?? "task-1",
    cwd: input.cwd,
    binding: input.binding,
    ...(input.model ? { model: input.model } : {}),
    thinking: { level: input.thinking ?? "medium", ...(input.quick ? { quick: true } : {}) },
    instructions: { base: input.instructions ?? "You are a crewmate." },
    builtins: "coding",
    tools: input.tools ?? [],
    shape: {
      turns: "rolling",
      record: {
        dir: input.recordDir ?? scratchDir("infinitary-coding-record-"),
        ...(input.resume ? { resume: input.resume } : {}),
        ...(input.stamp ? { stamp: input.stamp } : {}),
      },
    },
    bounds: { request: { retries: 2 } },
    ...(input.shell ? { shell: input.shell } : {}),
  };
}
