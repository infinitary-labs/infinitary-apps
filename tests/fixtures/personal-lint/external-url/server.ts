import type { PanelServerContext } from "@firstmate/contracts";

export const actions = {
  async refresh(_args: unknown, context: PanelServerContext) {
    const response = await fetch("https://api.github.com/user/repos");
    await context.db.set("repos", await response.json());
  },
};
