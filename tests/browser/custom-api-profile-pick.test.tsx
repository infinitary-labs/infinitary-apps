import type { CustomApiView, CustomCapabilityProfile } from "@shared/customApi";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { CustomApiForm } from "../../src/renderer/src/accounts/CustomApiForm";
import { fakeBridge } from "./bridge";
import { button, shown } from "./devicesTab";

// A user's report: a custom Anthropic connection's claude-fable-5-2 line sat
// at Off, its Reasoning list had no Fable 5.2, and nothing pointed at the
// profile that fits it. A line nobody chose a profile for now takes the one
// whose model ID is exactly its own; a choice a person made, or a line saved
// before, is never replaced (docs/custom-api.md).

/** The profiles the home lists once pi.dev's catalog holds Fable 5.2, as `customCapabilityProfiles` labels them. */
const PROFILES: CustomCapabilityProfile[] = [
  {
    id: "anthropic/claude-fable-5-1",
    label: "Claude Fable 5.1 · anthropic",
    protocol: "anthropic-messages",
    cacheRetentions: ["none", "short", "long"],
  },
  {
    id: "anthropic/claude-fable-5-2",
    label: "Claude Fable 5.2 · anthropic",
    protocol: "anthropic-messages",
    cacheRetentions: ["none", "short", "long"],
  },
  {
    id: "openrouter/anthropic/claude-fable-5-2",
    label: "Claude Fable 5.2 · openrouter",
    protocol: "openai-completions",
    cacheRetentions: ["none", "short"],
  },
];

/** The reporter's connection as an older release saved it: Fable 5.2 with no profile. */
const SAVED: CustomApiView = {
  accountId: "anthropic-api",
  label: "Anthropic API",
  baseUrl: "https://api.anthropic.com/v1",
  mode: "public",
  protocol: "anthropic-messages",
  keyPresent: true,
  noKey: false,
  headers: [],
  enabled: true,
  allowStorageDefault: false,
  certificates: [],
  models: [
    {
      id: "claude-fable-5-2",
      context: 1_000_000,
      output: 128_000,
      checked: true,
      state: "checked",
      cacheRetention: "short",
    },
  ],
};

function reasoningFor(within: Element, name: string): HTMLSelectElement {
  const found = within.querySelector<HTMLSelectElement>(
    `select[aria-label="Reasoning profile for ${name}"]`,
  );
  if (!found) throw new Error(`No Reasoning profile for ${name}`);
  return found;
}

function modelIds(within: Element): HTMLInputElement[] {
  return [...within.querySelectorAll<HTMLInputElement>('input[aria-label="Model ID"]')];
}

test("a new line takes its exact profile, and keeps the one a person or a saved line chose", async () => {
  const bridge = fakeBridge({ "inf:accounts:custom:profiles": PROFILES });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  root.render(<CustomApiForm original={SAVED} onClose={() => root.render(null)} />);
  try {
    await shown(".fm-custom-body");
    await expect.poll(() => bridge.requests("inf:accounts:custom:profiles").length).toBe(1);

    // The saved line keeps its own setting, Not set, with Fable 5.2 now listed.
    const saved = reasoningFor(mount, "claude-fable-5-2");
    await expect
      .poll(() => [...saved.options].map((option) => option.text))
      .toEqual([
        "Not set (model's default)",
        "Claude Fable 5.1 · anthropic",
        "Claude Fable 5.2 · anthropic",
      ]);
    expect(saved.value).toBe("");

    // A new line typed by hand takes the profile that lists its exact ID.
    await userEvent.click(button(mount, "+ Add by hand"));
    const added = modelIds(mount)[1] as HTMLInputElement;
    await userEvent.fill(added, "claude-fable-5-1");
    await expect
      .poll(() => reasoningFor(mount, "claude-fable-5-1").value)
      .toBe("anthropic/claude-fable-5-1");

    // A person's own choice stays when the ID changes after it.
    await userEvent.selectOptions(reasoningFor(mount, "claude-fable-5-1"), "");
    await userEvent.fill(added, "claude-fable-5-2-preview");
    await expect.poll(() => modelIds(mount)[1]?.value).toBe("claude-fable-5-2-preview");
    expect(reasoningFor(mount, "claude-fable-5-2-preview").value).toBe("");
  } finally {
    root.unmount();
    mount.remove();
  }
});
