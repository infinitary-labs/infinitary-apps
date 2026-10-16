import { hostname } from "node:os";
import type { ServerModule } from "@firstmate/contracts";

export const actions: NonNullable<ServerModule["actions"]> = {
  fill: (input, context) => {
    const items = Array.isArray(input) ? input.map((item) => String(item)) : ["one", "two"];
    context.db.set("items", items);
    return { filled: items.length, host: typeof hostname() };
  },
  clear: (_input, context) => {
    context.db.set("items", []);
    return { filled: 0 };
  },
};

export const background: NonNullable<ServerModule["background"]> = {
  // Declared far under the floor: the host clamps it to 60 s.
  sample: { everyMs: 1_000, run: (context) => context.db.set("sampled", Date.now()) },
};
