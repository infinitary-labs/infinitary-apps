import { hostname } from "node:os";
import type { ServerModule } from "@firstmate/contracts";

export const actions: NonNullable<ServerModule["actions"]> = {
  fill: async (input, context) => {
    const items = Array.isArray(input) ? input.map((item) => String(item)) : ["one", "two"];
    await context.db.set("items", items);
    return { filled: items.length, host: typeof hostname() };
  },
  clear: async (_input, context) => {
    await context.db.set("items", []);
    return { filled: 0 };
  },
};

export const background: NonNullable<ServerModule["background"]> = {
  // Declared far under the floor: the host clamps it to 60 s.
  sample: { everyMs: 1_000, run: (context) => context.db.set("sampled", Date.now()) },
};
