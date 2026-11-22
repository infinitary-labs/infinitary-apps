import type { AccountView } from "@shared/accounts";
import * as m from "@shared/i18n/messages.generated";
import type { InvokeChannel } from "@shared/ipc";
import { parseOfferingKey, providerLabel, STARTER_SLOTS } from "@shared/modelSlots";
import type { PiModelRefView, QuotaSnapshotView } from "@shared/quota";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { type Answers, type FakeBridge, fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * A refused Settings save keeps what is saved and says why beside the
 * choice (docs/subscriptions-tab.md, "Action failures"): each saved view has
 * one ordered writer, a control shows the confirmed value until the core's
 * answer, and a refusal re-reads the saved view; Your panels, the sharing
 * switches, the first mate model and account edits each use that boundary.
 * The same choice made again saves, and reopening Settings reads what is
 * saved. The refusals are the story's own: the window hears each as Electron
 * hands it a handler's thrown error, wrapped in the remote method's name,
 * and the preload's reader keeps only the reason
 * (src/preload/readableRequest.ts). One window, as the captain keeps one:
 * General first, then Intelligence.
 */

/** The reason a refused Settings write gives in this story. */
const REFUSAL = "The saved settings are locked. Try again.";

/** What Electron hands the window for a handler that threw `TypeError(reason)`. */
function refusedAs(channel: InvokeChannel, reason: string): Error {
  return new Error(
    `Error invoking remote method '${channel}': TypeError${reason ? `: ${reason}` : ""}`,
  );
}

/** Words that belong to the transport, never to a refusal a person reads. */
const TRANSPORT = /Error invoking remote method|\bfm:|(?:Type|Zod)?Error:|\[object Object\]/;

/**
 * The refusals the story has set up, one per channel: the next save on that
 * channel is refused, at once or once the test lets it answer.
 */
function refusals() {
  const next = new Map<InvokeChannel, { reason: string; held: Promise<void> }>();
  let release = () => {};
  return {
    /** Refuses the next save on `channel`; `hold` keeps it unanswered until `release`. */
    refuseNext(channel: InvokeChannel, reason = REFUSAL, hold = false) {
      const held = hold
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
      next.set(channel, { reason, held });
    },
    /** Lets the held refusal answer. */
    release: () => release(),
    /** Refuses this save when one is set up for its channel. */
    async check(channel: InvokeChannel) {
      const refusal = next.get(channel);
      if (!refusal) return;
      next.delete(channel);
      await refusal.held;
      throw refusedAs(channel, refusal.reason);
    },
  };
}

type Refusals = ReturnType<typeof refusals>;

/** A row's feedback, read as a person reads it. */
async function expectRefusal(feedback: () => HTMLElement | null, reason = REFUSAL) {
  await expect.poll(() => feedback()?.textContent ?? null).not.toBeNull();
  const element = feedback() as HTMLElement;
  await expect.element(element).toBeVisible();
  await expect.element(element).toBeInViewport();
  expect(element.textContent).toContain(reason);
  expect(element.textContent).not.toBe("");
  expect(element.textContent).not.toMatch(TRANSPORT);
}

/** One Settings row, by its id. */
const row = (id: string) => document.querySelector<HTMLElement>(`[data-setting="${id}"]`);
/** A row's switch. */
const switchOf = (id: string) =>
  row(id)?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null;
/** A row's refusal. */
const alertOf = (id: string) => row(id)?.querySelector<HTMLElement>('[role="alert"]') ?? null;
const checked = (id: string) => switchOf(id)?.getAttribute("aria-checked");

async function openSettings(tab?: string) {
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  if (tab) await userEvent.click(page.getByRole("tab", { name: tab, exact: true }));
}

async function closeSettings() {
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
}

/** The panels switch and Diagnostics, as the core keeps them. */
function answerGeneral(bridge: FakeBridge, home: Answers, refuse: Refusals) {
  const preferences = home["inf:shell:preferences"];
  const sharingRead = home["inf:settings:sharing:get"];
  if (!preferences || typeof preferences === "function") throw new Error("No preferences");
  if (!sharingRead || typeof sharingRead === "function") throw new Error("No sharing");
  let saved = preferences;
  let sharing = sharingRead;
  bridge.answer("inf:shell:preferences", () => saved);
  bridge.answer("inf:settings:panels:set", async (enabled) => {
    await refuse.check("inf:settings:panels:set");
    saved = { ...saved, panels: { enabled, offReason: enabled ? null : "captain" } };
    return saved.panels;
  });
  bridge.answer("inf:settings:sharing:get", () => sharing);
  bridge.answer("inf:settings:sharing:set", async (channel, enabled) => {
    await refuse.check("inf:settings:sharing:set");
    sharing =
      channel === "diagnostics"
        ? { ...sharing, diagnostics: { ...sharing.diagnostics, enabled } }
        : { ...sharing, contribution: { ...sharing.contribution, enabled } };
    return sharing;
  });
}

/** The one Codex account the Intelligence story holds, and its name. */
const ACCOUNT_ID = "acct_save_feedback";
const ACCOUNT_LABEL = "Personal";
const CODEX = "openai-codex";

/**
 * A home whose person signed in to one Codex account, as the core lists it:
 * the account, its allowance reading with no window, and the models the
 * account serves, each in the levels Codex's starter map gives it. A seeded
 * home cannot hold an account yet: its core would read the account's
 * allowance from the provider over the network.
 */
function answerIntelligence(bridge: FakeBridge, refuse: Refusals) {
  const starters = STARTER_SLOTS[CODEX];
  if (!starters) throw new Error("The Codex starter map is missing");
  let accounts: AccountView[] = [
    {
      id: ACCOUNT_ID,
      providerId: CODEX,
      kind: "subscription_oauth",
      label: ACCOUNT_LABEL,
      enabled: true,
      connected: true,
      pinned: false,
      createdAt: 1,
    },
  ];
  const now = Date.now();
  const snapshot: QuotaSnapshotView = {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: ACCOUNT_ID,
        accountLabel: ACCOUNT_LABEL,
        status: "ok",
        stale: false,
        windows: [],
      },
    ],
  };
  const pool: PiModelRefView[] = Object.keys(starters).map((id) => ({ provider: CODEX, id }));
  bridge.answer("inf:accounts:list", () => accounts);
  bridge.answer("inf:quota:snapshot", snapshot);
  bridge.answer("inf:models:available", pool);
  bridge.answer("inf:models:slots", {
    models: pool.map(({ provider, id }) => ({
      provider,
      providerLabel: providerLabel(provider),
      id,
      label: id,
      slots: [...(starters[id] ?? [])],
    })),
    byName: [],
    usingDefaults: true,
  });
  let seat: PiModelRefView | null = null;
  bridge.answer("inf:settings:firstmate-model:get", () => seat);
  bridge.answer("inf:settings:firstmate-model:set", async (model) => {
    await refuse.check("inf:settings:firstmate-model:set");
    seat = model;
    return seat;
  });
  const edit = (id: string, change: (account: AccountView) => AccountView | null) => {
    accounts = accounts.flatMap((account) => {
      if (account.id !== id) return [account];
      const changed = change(account);
      return changed ? [changed] : [];
    });
    return { ok: true as const };
  };
  bridge.answer("inf:accounts:set-enabled", async (id, enabled) => {
    await refuse.check("inf:accounts:set-enabled");
    return edit(id, (account) => ({ ...account, enabled }));
  });
  bridge.answer("inf:accounts:rename", async (id, label) => {
    await refuse.check("inf:accounts:rename");
    return edit(id, (account) => ({ ...account, label }));
  });
  bridge.answer("inf:accounts:pin", async (providerId, id) => {
    await refuse.check("inf:accounts:pin");
    accounts = accounts.map((account) =>
      account.providerId === providerId ? { ...account, pinned: account.id === id } : account,
    );
    return { ok: true };
  });
  bridge.answer("inf:accounts:remove", async (id) => {
    await refuse.check("inf:accounts:remove");
    return edit(id, () => null);
  });
}

test("a refused Settings save keeps what is saved, says why, and saves when tried again", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  const refuse = refusals();
  answerGeneral(bridge, home, refuse);
  answerIntelligence(bridge, refuse);
  const unhandled: string[] = [];
  window.addEventListener("error", (event) => unhandled.push(event.message));
  window.addEventListener("unhandledrejection", (event) => unhandled.push(String(event.reason)));
  await openSize();
  await openWindow(bridge);

  // Section: panels and sharing refusals keep the saved switch and say why.
  {
    await openSettings();
    await expect.poll(() => checked("your-panels")).toBe("true");
    refuse.refuseNext("inf:settings:panels:set", REFUSAL, true);
    await userEvent.click(switchOf("your-panels") as HTMLElement);
    await expect.poll(() => switchOf("your-panels")?.disabled).toBe(true);
    refuse.release();
    await expectRefusal(() => alertOf("your-panels"));
    expect(checked("your-panels")).toBe("true");
    expect(bridge.requests("inf:settings:panels:set")).toEqual([[false]]);
    await userEvent.click(switchOf("your-panels") as HTMLElement);
    await expect.poll(() => checked("your-panels")).toBe("false");
    await expect.poll(() => alertOf("your-panels")).toBeNull();
    expect(bridge.requests("inf:settings:panels:set")).toEqual([[false], [false]]);

    const before = (await bridge.api.settings.getSharing()).diagnostics.enabled;
    await expect.poll(() => checked("diagnostics")).toBe(String(before));
    refuse.refuseNext("inf:settings:sharing:set");
    await userEvent.click(switchOf("diagnostics") as HTMLElement);
    await expectRefusal(() => alertOf("diagnostics"));
    expect(checked("diagnostics")).toBe(String(before));
    await userEvent.click(switchOf("diagnostics") as HTMLElement);
    await expect.poll(() => checked("diagnostics")).toBe(String(!before));
    await expect.poll(() => alertOf("diagnostics")).toBeNull();
    expect(bridge.requests("inf:settings:sharing:set")).toEqual([
      ["diagnostics", !before],
      ["diagnostics", !before],
    ]);

    // Reopening reads what is saved.
    await closeSettings();
    await openSettings();
    await expect.poll(() => checked("your-panels")).toBe("false");
    await expect.poll(() => checked("diagnostics")).toBe(String(!before));
    await closeSettings();
  }

  // Section: Firstmate model and account edit refusals keep what is saved and say why.
  {
    await openSettings("Intelligence");
    const picker = () =>
      row("firstmate-model")?.querySelector<HTMLSelectElement>(
        'select[aria-label="First mate model"]',
      ) ?? null;
    await expect.poll(() => picker()?.disabled).toBe(false);
    await expect.poll(() => picker()?.options.length ?? 0).toBeGreaterThan(1);
    const pick = [...(picker()?.options ?? [])].find(
      (option) => option.value && !option.value.startsWith("\u0000"),
    )?.value;
    if (!pick) throw new Error("The account offers no first mate model");
    expect(picker()?.value).toBe("");
    refuse.refuseNext("inf:settings:firstmate-model:set", REFUSAL, true);
    await userEvent.selectOptions(picker() as HTMLSelectElement, pick);
    await expect.poll(() => picker()?.disabled).toBe(true);
    refuse.release();
    await expectRefusal(() => alertOf("firstmate-model"));
    await expect.poll(() => picker()?.value).toBe("");
    await userEvent.selectOptions(picker() as HTMLSelectElement, pick);
    await expect.poll(() => picker()?.value).toBe(pick);
    await expect.poll(() => alertOf("firstmate-model")).toBeNull();
    const chosen = parseOfferingKey(pick);
    expect(bridge.requests("inf:settings:firstmate-model:set")).toEqual([[chosen], [chosen]]);

    const accountRow = () =>
      document.querySelector<HTMLElement>(`[data-account-row="${ACCOUNT_ID}"]`);
    const feedback = () =>
      document.querySelector<HTMLElement>(`[data-account-error="${ACCOUNT_ID}"]`);
    // A setting is a switch that leaves the menu open when picked; an action closes it.
    const choose = async (item: string | RegExp, role: "menuitem" | "menuitemcheckbox") => {
      const kebab = page
        .elementLocator(accountRow() as HTMLElement)
        .getByRole("button", { name: /actions$/ });
      if (kebab.element().getAttribute("aria-expanded") !== "true") await userEvent.click(kebab);
      await userEvent.click(page.getByRole("menu").getByRole(role, { name: item }));
    };
    const edits: {
      channel: InvokeChannel;
      act: () => Promise<void>;
      unchanged: () => Promise<void>;
      changed: () => Promise<void>;
    }[] = [
      {
        channel: "inf:accounts:set-enabled",
        act: () => choose(m.settingsMenuPaused(), "menuitemcheckbox"),
        unchanged: async () => {
          expect(accountRow()?.hasAttribute("data-paused")).toBe(false);
        },
        changed: async () => {
          await expect.poll(() => accountRow()?.getAttribute("data-paused")).toBe("true");
        },
      },
      {
        channel: "inf:accounts:rename",
        act: async () => {
          await choose("Rename", "menuitem");
          const name = page
            .elementLocator(accountRow() as HTMLElement)
            .getByPlaceholder("Account name");
          await userEvent.fill(name, "Work");
          await userEvent.click(
            page
              .elementLocator(accountRow() as HTMLElement)
              .getByRole("button", { name: "Save", exact: true }),
          );
        },
        unchanged: async () => {
          await expect
            .poll(() => accountRow()?.querySelector("[data-account-name]")?.textContent)
            .toContain(ACCOUNT_LABEL);
        },
        changed: async () => {
          await expect
            .poll(() => accountRow()?.querySelector("[data-account-name]")?.textContent)
            .toContain("Work");
        },
      },
      {
        channel: "inf:accounts:pin",
        act: () => choose(/^Prefer for crew work/, "menuitemcheckbox"),
        unchanged: async () => {
          expect(accountRow()?.querySelectorAll("[data-crew-preferred]")).toHaveLength(0);
        },
        changed: async () => {
          await expect
            .poll(() => accountRow()?.querySelectorAll("[data-crew-preferred]").length)
            .toBe(1);
        },
      },
      {
        channel: "inf:accounts:remove",
        act: () => choose("Disconnect", "menuitem"),
        unchanged: async () => {
          await expect.element(accountRow() as HTMLElement).toBeVisible();
        },
        changed: async () => {
          await expect.poll(accountRow).toBeNull();
        },
      },
    ];
    for (const edit of edits) {
      refuse.refuseNext(edit.channel);
      await edit.act();
      await expectRefusal(feedback);
      await edit.unchanged();
      await edit.act();
      await expect.poll(feedback).toBeNull();
      await edit.changed();
      expect(bridge.requests(edit.channel), edit.channel).toHaveLength(2);
    }
  }

  expect(unhandled).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
