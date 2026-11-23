import type { CustomApiConnectResult, CustomApiView } from "@shared/customApi";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { CustomApiForm } from "../../src/renderer/src/accounts/CustomApiForm";
import { fakeBridge } from "./bridge";
import { button, shown } from "./devicesTab";

// INF-3307 audit: Cancel during a custom API save still saved the account.
// Save first reaches the server for a draft; a Cancel pressed while that
// answer is on its way had no draft to cancel, so the form's Save went on
// with the draft once it came - checked each model and saved the
// connection the person had just cancelled (docs/custom-api.md).

const SAVED: CustomApiView = {
  accountId: "lab-connection",
  label: "Lab server",
  baseUrl: "https://llm.lab.example/v1",
  mode: "private",
  protocol: "openai-completions",
  keyPresent: true,
  noKey: false,
  headers: [],
  enabled: true,
  allowStorageDefault: false,
  certificates: [],
  models: [{ id: "qwen3-32b", context: 32_768, output: 8_192, checked: true, state: "checked" }],
};
/** The draft the server's reach prepared, as the home answers it. */
const DRAFT: CustomApiView = { ...SAVED, accountId: undefined, draftId: "draft-lab-1" };

test("Cancel while Save reaches the server saves nothing, and lets the draft that answers later go (INF-3307 audit)", async () => {
  let reached!: (result: CustomApiConnectResult) => void;
  const bridge = fakeBridge({
    "inf:accounts:custom:profiles": [],
    "inf:accounts:custom:address": {
      destination: "https://llm.lab.example/v1",
      network: "private",
    },
    // The server's answer is on its way while the person presses Cancel.
    "inf:accounts:custom:connect": () =>
      new Promise<CustomApiConnectResult>((resolve) => {
        reached = resolve;
      }),
    "inf:accounts:custom:check": () => ({
      ...DRAFT,
      models: DRAFT.models.map((model) => ({ ...model, checked: true, state: "checked" })),
    }),
    "inf:accounts:custom:save": () => SAVED,
    "inf:accounts:custom:cancel": { ok: true },
  });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  // As Settings draws it: Cancel closes the dialog, which takes the form away.
  root.render(<CustomApiForm original={SAVED} onClose={() => root.render(null)} />);
  try {
    await shown(".fm-custom-body");
    await userEvent.click(button(mount, "Save"));
    await expect.poll(() => bridge.requests("inf:accounts:custom:connect").length).toBe(1);

    await userEvent.click(button(mount, "Cancel"));
    expect(mount.querySelector(".fm-custom-body")).toBeNull();
    reached({ view: DRAFT, listed: [{ id: "qwen3-32b", context: 32_768, output: 8_192 }] });

    await expect
      .poll(
        () =>
          bridge.requests("inf:accounts:custom:cancel").length +
          bridge.requests("inf:accounts:custom:save").length,
      )
      .toBeGreaterThan(0);
    expect(bridge.requests("inf:accounts:custom:save")).toEqual([]);
    expect(bridge.requests("inf:accounts:custom:cancel")).toEqual([[DRAFT.draftId]]);
    expect(bridge.requests("inf:accounts:custom:check")).toEqual([]);
  } finally {
    root.unmount();
    mount.remove();
  }
});
