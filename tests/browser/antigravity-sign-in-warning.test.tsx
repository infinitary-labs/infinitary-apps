import {
  ANTIGRAVITY_FORUM_REPLY_URL,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_SIGN_IN_WORDS,
  ANTIGRAVITY_TERMS_URL,
} from "@shared/antigravity";
import type { ProviderView } from "@shared/providers";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthMethodChoice, asksFirst } from "../../src/renderer/src/accounts/ConnectChips";
import { fakeBridge } from "./bridge";
import { button, shown } from "./devicesTab";

// Intent: INF-3776's approved plan - before an Antigravity sign-in starts,
// the person reads what Google's terms and forum say, in five sentences
// with two links, and chooses "Sign in with Google" or "Not now"; nothing
// starts until the first. Every control is reached from the keyboard
// (docs/keyboard.md, "A new feature").

const ANTIGRAVITY: ProviderView = {
  id: ANTIGRAVITY_PROVIDER_ID,
  name: "Antigravity",
  tier: "subscription",
  authTypes: ["oauth"],
  connected: false,
  billedPerToken: false,
};

test("an Antigravity chip shows Google's terms first, and only Sign in with Google starts the sign-in", async () => {
  const bridge = fakeBridge({ "inf:app:open-external": undefined });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const picks: string[] = [];
  let cancelled = 0;
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  expect(asksFirst(ANTIGRAVITY)).toBe(true);
  root.render(
    <AuthMethodChoice
      provider={ANTIGRAVITY}
      onPick={(type) => picks.push(type)}
      onCancel={() => {
        cancelled += 1;
      }}
    />,
  );
  try {
    const step = await shown(`[data-sign-in-warning="${ANTIGRAVITY_PROVIDER_ID}"]`);
    expect(step.innerText).toContain(ANTIGRAVITY_SIGN_IN_WORDS.title);
    for (const sentence of ANTIGRAVITY_SIGN_IN_WORDS.sentences) {
      expect(step.innerText).toContain(sentence);
    }
    const links = [...step.querySelectorAll("a")].map((link) => [link.innerText, link.href]);
    expect(links).toEqual([
      [ANTIGRAVITY_SIGN_IN_WORDS.terms, ANTIGRAVITY_TERMS_URL],
      [ANTIGRAVITY_SIGN_IN_WORDS.forum, ANTIGRAVITY_FORUM_REPLY_URL],
    ]);

    // The links open in the browser, from the keyboard too, and start nothing.
    (step.querySelector("a") as HTMLAnchorElement).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(step.querySelectorAll("a")[1] as HTMLAnchorElement);
    await expect
      .poll(() => bridge.requests("inf:app:open-external"))
      .toEqual([[ANTIGRAVITY_TERMS_URL], [ANTIGRAVITY_FORUM_REPLY_URL]]);
    expect(picks).toEqual([]);

    // Tab reaches the two buttons in order after the links.
    await userEvent.tab();
    expect(document.activeElement).toBe(button(step, ANTIGRAVITY_SIGN_IN_WORDS.go));
    await userEvent.tab();
    expect(document.activeElement).toBe(button(step, ANTIGRAVITY_SIGN_IN_WORDS.notNow));
    await userEvent.keyboard("{Enter}");
    expect(cancelled).toBe(1);
    expect(picks).toEqual([]);

    await userEvent.click(button(step, ANTIGRAVITY_SIGN_IN_WORDS.go));
    expect(picks).toEqual(["oauth"]);
  } finally {
    root.unmount();
    mount.remove();
  }
});
