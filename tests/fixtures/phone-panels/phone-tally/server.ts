import type { ServerModule } from "@infinitary/contracts";

export const actions: NonNullable<ServerModule["actions"]> = {
  /** One press, one more: the tally counts every call that reached the computer. */
  add: async (_input, context) => {
    const tally = await context.db.get("tally");
    const next = (typeof tally === "number" ? tally : 0) + 1;
    await context.db.set("tally", next);
    return { tally: next };
  },
  /** The panel's background work ends on its own, which the app records as a stop. */
  quit: async () => {
    setTimeout(() => process.exit(0), 50);
    return { ending: true };
  },
};
