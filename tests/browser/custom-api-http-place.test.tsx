import type { CustomApiAddress } from "@shared/customApi";
import type { CustomFileDefinition } from "@shared/customApiFile";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { CustomApiForm } from "../../src/renderer/src/accounts/CustomApiForm";
import { fakeBridge } from "./bridge";
import { afterNextFrame, shown } from "./devicesTab";

// INF-6937, from merge batch #112's failed journey (custom-api.spec.ts, a
// connection file's approval): a press on the HTTP approval was lost. The
// line under the address, saying where Save sends, is answered by the app a
// moment after the address is there; drawn only then, it pushed the
// approval down between the press and its release, so the release landed
// beside it and no click reached it. The approval stays where it was while
// that answer is on its way (docs/custom-api.md).

/** A connection file's plain-HTTP server on this computer, as the journey's file defines it. */
const DEFINITION: CustomFileDefinition = {
  label: "local-server",
  baseUrl: "http://127.0.0.1:4123/operator/path",
  protocol: "openai-completions",
  headers: [],
  models: [{ id: "operator-model", context: 0, output: 4096 }],
};
const TYPED = "http://127.0.0.1:4124/v1";

/** The HTTP approval's checkbox, found by its words as a person reads them. */
function httpApproval(within: Element): HTMLInputElement {
  const found = [...within.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (box) => box.closest("label")?.textContent?.startsWith("Send over unencrypted HTTP"),
  );
  if (!found) throw new Error("No HTTP approval in the form");
  return found;
}

/** Where the approval is drawn, read once the window drew what came before. */
async function approvalTop(within: Element): Promise<number> {
  await afterNextFrame();
  return httpApproval(within).getBoundingClientRect().top;
}

test("the HTTP approval stays where it is when the line saying where Save sends arrives", async () => {
  const answers: ((answer: CustomApiAddress) => void)[] = [];
  const bridge = fakeBridge({
    "inf:accounts:custom:profiles": [],
    "inf:accounts:custom:address": () =>
      new Promise<CustomApiAddress>((resolve) => {
        answers.push(resolve);
      }),
  });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    // Section: a connection file's approval, which opens with its address filled in.
    root.render(
      <CustomApiForm
        key="file"
        fromFile={{ name: "local-server", definition: DEFINITION }}
        onClose={() => root.render(null)}
      />,
    );
    await shown(".fm-custom-body");
    await expect
      .poll(() => bridge.requests("inf:accounts:custom:address"))
      .toEqual([[DEFINITION.baseUrl]]);
    const asked = await approvalTop(mount);
    // While the answer is on its way the line says nothing yet.
    expect(mount.querySelector("[data-custom-sends-to]")).toBeNull();
    answers[0]?.({ destination: DEFINITION.baseUrl, network: "local" });
    await expect
      .poll(() => mount.querySelector("[data-custom-sends-to]")?.textContent)
      .toContain(DEFINITION.baseUrl);
    expect(await approvalTop(mount)).toBe(asked);

    // Section: an address a person types into Add, whose approval appears with it.
    root.render(<CustomApiForm key="add" onClose={() => root.render(null)} />);
    const address = await shown("[data-custom-api-form] input[id$='-address']");
    await userEvent.fill(address, TYPED);
    await expect.poll(() => bridge.requests("inf:accounts:custom:address").at(-1)).toEqual([TYPED]);
    const typed = await approvalTop(mount);
    expect(mount.querySelector("[data-custom-sends-to]")).toBeNull();
    answers.at(-1)?.({ destination: TYPED, network: "local" });
    await expect
      .poll(() => mount.querySelector("[data-custom-sends-to]")?.textContent)
      .toContain(TYPED);
    expect(await approvalTop(mount)).toBe(typed);
  } finally {
    root.unmount();
    mount.remove();
  }
});
