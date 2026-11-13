import { mkdir } from "node:fs/promises";
import type { AppPaths } from "../paths";
import type { AccountVault } from "../pi/accountVault";
import { openRouterDecisionModels } from "../pi/decisionModels";
import type { ModelRuntime } from "../pi/types";
import type { StandIns } from "../standIns";
import type { SettingsStore } from "../storage/settingsStore";
import {
  AdaptedDecisionModel,
  type AdaptedDecisionModelOptions,
  DecisionModels,
  type DecisionModelsOptions,
} from "./decisionModel";
// This file is the ONE place a native decision model's client and key store
// are constructed (Biome fences every other file in src/core/ outside
// `decisions/` out of `decisions/jev/`), the way the composition root is the
// one place the Pi and Claude seams are assembled.
import { JevDecisionModel } from "./jev/jevClient";
import { DecisionKeyStore } from "./jev/jevKeyStore";
import { OpenRouterDecisionModel } from "./openRouterDecisionModel";

/**
 * The home's decision models (S7): one core-wide service any module may ask
 * a typed, bounded question of. Its default answerer is the ADAPTER - one
 * bounded call on the cheapest slotted model, with the same
 * non-flagship-first account walk S3 shipped - served by Pi in process or,
 * since W1 S10, by the machine's own Claude client on its default login.
 */
export function startHomeDecisions(options: {
  paths: Pick<AppPaths, "firstmateHomeDir" | "userData">;
  standIns: Pick<StandIns, "jevUrl" | "openRouterDecisionsBaseUrl">;
  settings: Pick<
    SettingsStore,
    "getFirstmateAccount" | "getDecisions" | "setDecisions" | "getDecisionUses" | "setDecisionUses"
  >;
  vault: Pick<AccountVault, "runtimeFor" | "list" | "connectedSync" | "piModelRuntimes" | "renew">;
  baseRuntime: ModelRuntime;
  /** The adapter's pools, its model lookup, its quota and its sessions. */
  adapted: Pick<
    AdaptedDecisionModelOptions,
    "availableModels" | "namedModels" | "capabilityFor" | "quotaModels" | "sessions" | "noteCutOff"
  >;
  /** AccountSelector.selectForSpawn, so the burn is attributable. */
  selectAccount: (
    taskId: string,
    piProviderId: string,
  ) => string | undefined | Promise<string | undefined>;
  recordUsage: NonNullable<DecisionModelsOptions["recordUsage"]>;
  onNote: (text: string) => void;
}): DecisionModels {
  const { paths, standIns, settings, vault, baseRuntime, selectAccount } = options;
  const adaptedDecisionModel = new AdaptedDecisionModel({
    homeDir: paths.firstmateHomeDir,
    ...options.adapted,
    selectAccount,
    flagshipAccountId: () => settings.getFirstmateAccount(),
    runtimeFor: (accountId) => vault.runtimeFor(accountId),
    baseRuntime,
    offering: () => {
      const answerer = settings.getDecisions().answerer;
      return answerer.kind === "adapted" ? answerer.offering : "auto";
    },
    prepareHome: async () => {
      await mkdir(paths.firstmateHomeDir, { recursive: true });
    },
  });
  // The native option (S7b): OFF by default and off by construction. The
  // factory is what a decision would need to reach a second endpoint, and
  // it only ever builds a client from the user's OWN key, stored in its own
  // 0700 directory - never from an environment variable, never from any
  // ambient config, the same rule that keeps the app out of ~/.pi.
  const decisionKeys = new DecisionKeyStore(paths.userData);
  return new DecisionModels({
    settings,
    keys: decisionKeys,
    adapted: adaptedDecisionModel,
    pinState: (offering) => adaptedDecisionModel.pinState(offering),
    openrouter: {
      signedIn: () =>
        vault
          .list("openrouter")
          .some((account) => account.enabled && vault.connectedSync(account.id) === true),
      models: () => [
        ...new Map(
          [baseRuntime, ...vault.piModelRuntimes()]
            .flatMap((runtime) => openRouterDecisionModels(runtime))
            .map((model) => [model.id, model]),
        ).values(),
      ],
      create: (model) =>
        new OpenRouterDecisionModel({
          model,
          selectAccount: (taskId) => selectAccount(taskId, "openrouter"),
          runtimeFor: (accountId) => vault.runtimeFor(accountId),
          onUnauthorized: (accountId) => vault.renew(accountId, "vendor_rejected"),
          ...(standIns.openRouterDecisionsBaseUrl
            ? { baseUrl: standIns.openRouterDecisionsBaseUrl }
            : {}),
        }),
    },
    createNative: (row, key) =>
      new JevDecisionModel({
        row,
        key: () => key,
        // Dev/e2e only, exactly like the quota sensor's overrides: a
        // packaged app never reads it, so the real endpoint cannot be
        // redirected in a build anyone runs.
        ...(standIns.jevUrl ? { endpoint: standIns.jevUrl } : {}),
      }),
    recordUsage: options.recordUsage,
    onNote: options.onNote,
  });
}

// The decision models' readers the composition root wires (docs/automation.md, "The event
// screen"; docs/card-authoring.md, "The reader check"), each asking only while its use is on.
export { cardReader } from "./cardReader";
export { eventScreen } from "./eventScreen";
