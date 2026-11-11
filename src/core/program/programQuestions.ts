import { mkdir } from "node:fs/promises";
import type { AppPaths } from "../paths";
import type { AccountVault } from "../pi/accountVault";
import type { ModelRuntime } from "../pi/types";
import {
  QuestionTurns,
  type QuestionTurnsOptions,
  type QuestionUsage,
} from "../session/questionTurns";
import type { SettingsStore } from "../storage/settingsStore";

/**
 * A program's ask() (docs/programs.md): one JSON answer from the person's
 * own cheapest slotted chat model, through the one-question walk
 * (`src/core/session/questionTurns.ts`). It has nothing to do with decision
 * models: a decision model answers from a closed set of options, and the
 * JSON a program asks for is in a shape the program chooses, so neither the
 * Decisions pick nor Jev nor OpenRouter is asked, and it is not a use in
 * Settings' list. Never throws; a failure says why, and the burn lands under
 * the program's task.
 */
export class ProgramQuestions {
  constructor(
    private readonly options: {
      turns: Pick<QuestionTurns, "turn">;
      recordUsage?: (input: { taskId: string } & QuestionUsage) => void;
    },
  ) {}

  async answerJson(
    caller: { purpose: string; taskId?: string },
    instruction: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ text: string } | { failed: string }> {
    const attribution = caller.taskId ?? caller.purpose;
    let turn: Awaited<ReturnType<QuestionTurns["turn"]>>;
    try {
      turn = await this.options.turns.turn({ attribution, instruction, text, signal, json: true });
    } catch {
      turn = { failed: "error" };
    }
    if (turn.usage)
      this.options.recordUsage?.({
        taskId: attribution,
        ...(turn.usage.accountId ? { accountId: turn.usage.accountId } : {}),
        ...(turn.usage.model ? { model: turn.usage.model } : {}),
        usage: turn.usage.usage,
      });
    return "failed" in turn ? { failed: turn.failed } : { text: turn.text };
  }
}

/** The home's program questions, on the same pool and sessions as every bounded question. */
export function startProgramQuestions(options: {
  paths: Pick<AppPaths, "firstmateHomeDir">;
  settings: Pick<SettingsStore, "getFirstmateAccount">;
  vault: Pick<AccountVault, "runtimeFor">;
  baseRuntime: ModelRuntime;
  models: Pick<
    QuestionTurnsOptions,
    "availableModels" | "capabilityFor" | "quotaModels" | "sessions" | "noteCutOff"
  >;
  selectAccount: QuestionTurnsOptions["selectAccount"];
  recordUsage: (input: { taskId: string } & QuestionUsage) => void;
}): ProgramQuestions {
  const { paths, settings, vault } = options;
  return new ProgramQuestions({
    turns: new QuestionTurns({
      homeDir: paths.firstmateHomeDir,
      ...options.models,
      selectAccount: options.selectAccount,
      flagshipAccountId: () => settings.getFirstmateAccount(),
      runtimeFor: (accountId) => vault.runtimeFor(accountId),
      baseRuntime: options.baseRuntime,
      prepareHome: async () => {
        await mkdir(paths.firstmateHomeDir, { recursive: true });
      },
    }),
    recordUsage: options.recordUsage,
  });
}
