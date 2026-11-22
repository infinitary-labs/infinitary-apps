import type { AccountView } from "@shared/accounts";
import * as m from "@shared/i18n/messages.generated";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { RowMenu } from "../../src/renderer/src/design/core/RowMenu";
import { accountMenu, accountSettingItems } from "../../src/renderer/src/settings/SubscriptionsTab";

// INF-5970, from the captain's "some of the items are buttons, some of them
// are toggles, and it's not clear enough": an account menu's on/off settings
// are switches that say their state, and a pick by keys flips one with the
// menu left open, while an action still closes it. The account is a Codex
// sign-in as the Subscriptions tab lists it, with its own settings and Rename.

const CODEX: AccountView = {
  id: "acct_codex_work",
  providerId: "openai-codex",
  kind: "subscription_oauth",
  label: "Work",
  enabled: true,
  connected: true,
  pinned: false,
  createdAt: 1,
};

function AccountMenu({ onRename }: { onRename: () => void }) {
  const [account, setAccount] = useState(CODEX);
  const own = accountSettingItems(account, {
    onTogglePin: () => setAccount((now) => ({ ...now, pinned: !now.pinned })),
    onStartRename: onRename,
    onSetEnabled: (enabled) => setAccount((now) => ({ ...now, enabled })),
  });
  return (
    <RowMenu
      label="Codex Work actions"
      items={accountMenu([own.prefer, own.paused], [own.rename], [])}
    />
  );
}

test("an account menu's settings say their state and flip by keys with the menu left open, while an action closes it", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  let renames = 0;
  const menu = () => document.querySelector('[role="menu"]');
  // The menu fades out as it closes, so whether it is open is the kebab's word.
  const open = () =>
    mount.querySelector('[aria-label="Codex Work actions"]')?.getAttribute("aria-expanded");
  const item = (id: string) => document.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);
  try {
    flushSync(() => root.render(<AccountMenu onRename={() => renames++} />));
    mount.querySelector<HTMLElement>('[aria-label="Codex Work actions"]')?.click();
    await expect
      .poll(() => item("prefer") !== null && document.activeElement === item("prefer"))
      .toBe(true);

    // Settings come first, as switches that say they are off.
    const roles = [...(menu()?.querySelectorAll("[data-menu-item]") ?? [])].map((node) => [
      node.getAttribute("data-menu-item"),
      node.getAttribute("role"),
      node.getAttribute("aria-checked"),
    ]);
    expect(roles).toEqual([
      ["prefer", "menuitemcheckbox", "false"],
      ["pause", "menuitemcheckbox", "false"],
      ["rename", "menuitem", null],
    ]);
    expect(item("pause")?.textContent).toBe(m.settingsMenuPaused());

    // Enter turns Paused on and Space turns it off; the menu stays open on it.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("pause"));
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => item("pause")?.getAttribute("aria-checked")).toBe("true");
    expect(open()).toBe("true");
    expect(document.activeElement).toBe(item("pause"));
    await userEvent.keyboard(" ");
    await expect.poll(() => item("pause")?.getAttribute("aria-checked")).toBe("false");
    expect(open()).toBe("true");

    // An action runs and closes the menu.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("rename"));
    await userEvent.keyboard("{Enter}");
    await expect.poll(open).toBe("false");
    expect(renames).toBe(1);
  } finally {
    root.unmount();
    mount.remove();
  }
});
