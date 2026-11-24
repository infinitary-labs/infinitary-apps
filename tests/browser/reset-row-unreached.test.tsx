import * as m from "@shared/i18n/messages.generated";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { ResetRow } from "../../src/renderer/src/settings/ResetRow";
import { fakeBridge } from "./bridge";
import { button, shown } from "./devicesTab";

// docs/reset.md, "From a computer that controls the first mate": a first
// mate's computer that does not answer resets nothing on either computer,
// and the row says so and stays on its question, keyboard focus on it.

test("a first mate's computer that does not answer leaves the row on its question, focus kept", async () => {
  const bridge = fakeBridge({
    "inf:app:reset-scope": { tasks: 0 },
    "inf:app:reset": { outcome: "unreached" },
  });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  root.render(<ResetRow home="Mac mini" />);
  try {
    (await shown('[data-setting="reset-infinitary"] button')).focus();
    await userEvent.keyboard("{Enter}");
    await shown("[data-reset-question]");
    // Keep everything holds focus; the reset itself is one Tab away.
    await userEvent.keyboard("{Tab}");
    const reset = button(mount, m.settingsGeneralReset());
    expect(document.activeElement).toBe(reset);
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => mount.textContent)
      .toContain(m.settingsGeneralResetUnreached({ home: "Mac mini" }));
    expect(mount.querySelector("[data-reset-question]")).not.toBeNull();
    expect(document.activeElement).toBe(button(mount, m.settingsGeneralReset()));
    expect(bridge.requests("inf:app:reset")).toHaveLength(1);
  } finally {
    root.unmount();
    mount.remove();
  }
});
