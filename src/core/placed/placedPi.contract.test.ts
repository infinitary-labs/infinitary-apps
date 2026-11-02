import { afterAll, beforeAll } from "vitest";
import type { StubApi } from "../../../tests/helpers/anthropicDialect";
import { PI_CONTRACT_MODEL, piContractWorld } from "../../../tests/helpers/piContractWorld";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import {
  placedContractCleanup,
  placedContractWorld,
} from "../../../tests/helpers/placedContractWorld";
import { describeSessionContract, startContractApi } from "../../../tests/helpers/sessionContract";

/**
 * The session contract for a crewmate's conversation held on a computer that
 * runs work (`placedContractWorld`): real Pi against a local stub API, held
 * by the computer's `SessionHost` and driven from the home's `PlacedSessions`
 * over the real connection. A placed conversation is only ever a
 * crewmate's, so the crewmate's cases are the ones it passes.
 */

let api: StubApi;

beforeAll(async () => {
  api = await startContractApi();
});

afterAll(async () => {
  await api.close();
});

describeSessionContract({
  name: "Pi, real, held on a computer that runs work",
  backend: "pi",
  roles: ["crewmate"],
  stopsSafely: false,
  world: async () =>
    placedContractWorld(
      await piContractWorld(api, await piStubRuntime(api.url, PI_CONTRACT_MODEL)),
    ),
  cleanup: placedContractCleanup,
});
