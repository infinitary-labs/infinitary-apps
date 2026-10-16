import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll } from "vitest";
import type { StubApi } from "../../../tests/helpers/anthropicDialect";
import { piContractModels, piContractWorld } from "../../../tests/helpers/piContractWorld";
import { describeSessionContract, startContractApi } from "../../../tests/helpers/sessionContract";

/**
 * Pi's harness for the session contract (`tests/helpers/sessionContract.ts`):
 * real Pi, in process, with its own runtime on its own store, served by a
 * local stub API in the Anthropic dialect (`piContractWorld`). Nothing is
 * mocked inside Pi, and nothing reaches the network.
 */

let api: StubApi;

beforeAll(async () => {
  api = await startContractApi();
});

afterAll(async () => {
  await api.close();
});

describeSessionContract({
  name: "Pi, real, against a stub API",
  backend: "pi",
  world: async () => {
    const modelsPath = piContractModels(api);
    const runtime = await ModelRuntime.create({
      authPath: join(modelsPath, "..", "auth.json"),
      modelsPath,
      allowModelNetwork: false,
    });
    return piContractWorld(api, runtime);
  },
});
