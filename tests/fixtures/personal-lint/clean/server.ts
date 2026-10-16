import type { PanelServerContext } from "@firstmate/contracts";

export const actions = {
  async refresh(_args: unknown, context: PanelServerContext) {
    await context.db.set("checks", []);
  },
};
