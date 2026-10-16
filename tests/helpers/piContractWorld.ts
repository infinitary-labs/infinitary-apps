import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIRSTMATE_CONTRACT_ENTRY } from "../../src/core/pi/session";
import { createPiSessionFactory } from "../../src/core/pi/sessionFactory";
import type { ModelRuntime } from "../../src/core/pi/types";
import { BoundsWatcher } from "../../src/core/session/bounds";
import type { StubApi } from "./anthropicDialect";
import { manualClock } from "./manualClock";
import { scratchDir } from "./scratchDirs";
import { type ContractWorld, servedByStub, stubReply } from "./sessionContract";

/**
 * Pi's world for the session contract (`tests/helpers/sessionContract.ts`):
 * real Pi, in process, with its own runtime on its own store, served by a
 * local stub API in the Anthropic dialect - the same stub and the same
 * replies the real Claude client's harness answers with. Nothing is mocked
 * inside Pi, and nothing reaches the network. The stub model offers more
 * output than any role's cap, so a cap the request carries is the role's.
 * Its harness is `src/core/pi/piSession.contract.test.ts`; a conversation
 * held on another computer runs it there (`placedContractWorld.ts`).
 */

const PROVIDER = "fm-contract";
const MODEL = "stub-1";

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
}

/** The contract stamps in the rolling files Pi wrote under a directory. */
function contractEntries(dir: string): Record<string, unknown>[] {
  return filesUnder(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })
    .filter((entry) => entry.type === "custom" && entry.customType === FIRSTMATE_CONTRACT_ENTRY)
    .map((entry) => entry.data as Record<string, unknown>);
}

/** The stub's provider and model, which a runtime for the world serves. */
export const PI_CONTRACT_MODEL = { provider: "fm-contract", id: "stub-1" } as const;

/** The stub's one provider, as a Pi models file names it, for a runtime the caller builds. */
export function piContractModels(api: StubApi): string {
  const store = join(scratchDir("infinitary-pi-contract-store-"), "store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const modelsPath = join(store, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          name: "Contract stub",
          baseUrl: api.url,
          api: "anthropic-messages",
          apiKey: "stub-key",
          models: [{ id: MODEL, name: "Stub", input: ["text"], maxTokens: 32_000 }],
        },
      },
    }),
  );
  return modelsPath;
}

/** One case's world on a runtime the caller built over `piContractModels`. */
export async function piContractWorld(api: StubApi, runtime: ModelRuntime): Promise<ContractWorld> {
  const root = scratchDir("infinitary-pi-contract-");
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  const sessionsDir = join(root, "sessions");
  const first = api.requests.length;
  const clock = manualClock();
  return {
    factory: new BoundsWatcher(clock).factory(
      createPiSessionFactory({ agentDir: join(root, "pi-agent") }),
    ),
    advance: clock.advance,
    binding: { backend: "pi", runtime },
    foreignBinding: { backend: "claude", accountId: "acct_claude" },
    model: { provider: PROVIDER, id: MODEL },
    homeDir,
    paths: {
      firstmateHomeDir: homeDir,
      firstmateSessionsDir: sessionsDir,
      firstmateClaudeDir: join(root, "claude"),
    },
    answer: (reply) => api.answer(stubReply(reply)),
    reached: async () => {
      if (api.requests.length === first) await api.nextRequest();
    },
    // Pi queues a steer in process, as it is handed over.
    holds: async () => {},
    served: () => api.requests.slice(first).map(servedByStub),
    records: () => filesUnder(root).filter((name) => name.endsWith(".jsonl")),
    stamps: async () => contractEntries(sessionsDir),
    released: () => api.openRequests() === 0,
  };
}
