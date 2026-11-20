// A local fixture bridge for an ordinary crewmate, never a provider/session launcher.
import { parseArgs } from "node:util";
import { openModuleRunner } from "../moduleRunner.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    prepare: { type: "boolean" },
    family: { type: "string" },
    case: { type: "string" },
    input: { type: "string" },
    inspect: { type: "boolean" },
  },
});
if (!values.out) throw new Error("Name an output folder outside the working copy.");
const runner = await openModuleRunner();
try {
  const bridge = await runner.import<typeof import("./carefulLiveHarness.ts")>(
    "scripts/evals/carefulLiveHarness.ts",
  );
  if (values.prepare) {
    if (values.family !== "claude" && values.family !== "codex")
      throw new Error(
        "Name claude or codex; this only labels the packet and opens no model session.",
      );
    console.log(await bridge.prepareCarefulRun(values.out, values.family));
  } else {
    if (!values.case) throw new Error("Name a case from the prepared packet.");
    console.log(
      await bridge.callCarefulRun(
        values.out,
        values.case,
        values.inspect ? undefined : values.input,
      ),
    );
  }
} finally {
  await runner.close();
}
