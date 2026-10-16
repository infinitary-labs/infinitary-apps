import { describe, expect, it } from "vitest";
import type { AccountView } from "./accounts";
import {
  DEVICE_SETUP_ACTIONS,
  type DeviceSetupFacts,
  deviceForgeGateRef,
  deviceForgeSignInBody,
  deviceForgeSignInCardId,
  deviceForgeSignInTitle,
  deviceForgeWaitLine,
  deviceSetupActions,
  deviceSetupBody,
  deviceSetupCardId,
  deviceSetupDone,
  deviceSetupDoneLine,
  deviceSetupRows,
  deviceSetupTitle,
  noSignInsStartRefusal,
  noSignInsWaitLine,
} from "./deviceSetup";
import type { ComputerSignIns } from "./signIns";

const MINI = { label: "Mac mini", where: "on Mac mini", who: "Mac mini" };
const BUILDER = { label: "Running as Builder", where: "as Builder", who: "Builder" };

function account(id: string, providerId: string, extra: Partial<AccountView> = {}): AccountView {
  return {
    id,
    providerId,
    kind: "subscription_oauth",
    label: id,
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: 1,
    ...extra,
  };
}

function said(accounts: AccountView[], forges?: ComputerSignIns["forges"]): ComputerSignIns {
  return { providers: [], accounts, quota: null, ...(forges ? { forges } : {}) };
}

const GITHUB_OFFERED = { hosts: [{ host: "github.com", name: "GitHub" }], signIns: [] };
const GITHUB_SIGNED_IN: ComputerSignIns["forges"] = {
  hosts: [{ host: "github.com", name: "GitHub" }],
  signIns: [{ host: "github.com", name: "GitHub", login: "octo", state: "ok", since: 5 }],
};

function facts(overrides: Partial<DeviceSetupFacts> = {}): DeviceSetupFacts {
  return {
    deviceId: "d1",
    place: MINI,
    found: { git: true, claudeCode: true },
    signIns: null,
    runs: [],
    ...overrides,
  };
}

describe("the setup card's rows", () => {
  it("open every row for a computer that has just joined and said nothing yet", () => {
    const rows = deviceSetupRows(facts());
    expect(rows.map((row) => [row.id, row.done])).toEqual([
      ["subscription", false],
      ["github", false],
      ["project", false],
    ]);
    expect(deviceSetupDone(facts())).toBe(false);
  });

  it("count a subscription row done once the computer reports any account, whatever its allowance read", () => {
    // A Claude login whose allowance macOS there would not let Firstmate read.
    const unreadable = account("acct_claude", "anthropic-claude", { detail: "macOS asks first" });
    const rows = deviceSetupRows(facts({ signIns: said([unreadable]) }));
    expect(rows[0]).toMatchObject({ id: "subscription", done: true, state: "signed in to Claude" });
    const two = deviceSetupRows(
      facts({ signIns: said([account("a", "openai-codex"), account("b", "xai")]) }),
    );
    expect(two[0]?.state).toBe("signed in to Codex and Grok");
  });

  it("count the GitHub row done once the computer reports its sign-in there, naming who GitHub says it is", () => {
    const open = deviceSetupRows(facts({ signIns: said([], GITHUB_OFFERED) }));
    expect(open[1]).toMatchObject({ id: "github", done: false });
    const done = deviceSetupRows(facts({ signIns: said([], GITHUB_SIGNED_IN) }));
    expect(done[1]).toMatchObject({ id: "github", done: true, state: "signed in as octo" });
  });

  it("word the project row as optional while nothing runs there, and name the projects once something does", () => {
    const [, , none] = deviceSetupRows(facts());
    expect(none?.state).toContain("Optional");
    expect(none?.state).toContain("that is fine");
    const [, , some] = deviceSetupRows(facts({ runs: ["website", "api"] }));
    expect(some).toMatchObject({ done: true, state: "runs website and api" });
  });

  it("are all done, with the feed's one line, once every need is met", () => {
    const whole = facts({
      signIns: said([account("a", "openai-codex")], GITHUB_SIGNED_IN),
      runs: ["website"],
    });
    expect(deviceSetupDone(whole)).toBe(true);
    expect(deviceSetupDoneLine(whole)).toBe(
      "Mac mini is set up. It runs website with its own sign-ins.",
    );
  });
});

describe("the setup card", () => {
  it("is titled by the computer's label, one card per computer", () => {
    expect(deviceSetupTitle(MINI)).toBe("Finish setting up Mac mini");
    expect(deviceSetupTitle(BUILDER)).toBe("Finish setting up Running as Builder");
    expect(deviceSetupCardId("d1")).toBe("card-device-setup-d1");
  });

  it("opens with what the join found, marks each row by its id and whether it is done, and keeps the words as text", () => {
    const body = deviceSetupBody(
      facts({
        place: { label: "Mac <mini>", where: "on Mac <mini>", who: "Mac <mini>" },
        signIns: said([account("a", "openai-codex")]),
        runs: ["site & shop"],
      }),
    );
    expect(body).toContain(
      "Mac &lt;mini&gt; joined with git and Claude Code. It runs work once it has:",
    );
    expect(body).toContain('<li data-setup-row="subscription" data-done="true">');
    expect(body).toContain('<li data-setup-row="github" data-done="false">');
    expect(body).toContain('<li data-setup-row="project" data-done="true">');
    expect(body).toContain("runs site &amp; shop");
    expect(body).toContain("Nothing from this computer's sign-ins goes there.");
  });

  it("offers one button per open row, the first as the default, each opening its Settings step, and Not now", () => {
    const actions = deviceSetupActions(facts({ deviceId: "d1" }));
    expect(actions.map((action) => action.id)).toEqual([
      DEVICE_SETUP_ACTIONS.subscription,
      DEVICE_SETUP_ACTIONS.github,
      DEVICE_SETUP_ACTIONS.project,
      DEVICE_SETUP_ACTIONS.notNow,
    ]);
    expect(actions[0]).toMatchObject({
      default: true,
      label: "Add a subscription",
      effect: { kind: "open", target: "subscriptions" },
    });
    expect(actions[1]).toMatchObject({
      label: "Sign in to GitHub on Mac mini",
      effect: {
        kind: "open",
        target: "projects",
        forgeSignInOn: { deviceId: "d1", host: "github.com" },
      },
    });
    expect(actions[2]).toMatchObject({
      label: "Choose a project",
      effect: { kind: "open", target: "projects" },
    });
    expect(actions[3]).toMatchObject({ label: "Not now", variant: "ghost" });
    expect(actions[3]?.effect).toBeUndefined();
  });

  it("drops a done row's button and moves the default to the next open row", () => {
    const actions = deviceSetupActions(
      facts({ place: BUILDER, signIns: said([account("a", "openai-codex")]) }),
    );
    expect(actions.map((action) => action.id)).toEqual([
      DEVICE_SETUP_ACTIONS.github,
      DEVICE_SETUP_ACTIONS.project,
      DEVICE_SETUP_ACTIONS.notNow,
    ]);
    expect(actions[0]).toMatchObject({ default: true, label: "Sign in to GitHub as Builder" });
  });
});

describe("the backstop's words", () => {
  it("say a project's next task waits for a computer with no sign-ins, and refuse Start now the same way", () => {
    expect(noSignInsWaitLine("Running as Builder", "website's next task")).toBe(
      "Running as Builder has no sign-ins yet. website's next task waits until it has one.",
    );
    expect(noSignInsStartRefusal('FI-1 "Fix it"', "Builder")).toBe(
      'FI-1 "Fix it" waits for Builder, which has no sign-ins yet. Sign it in to one in Settings → Intelligence.',
    );
  });

  it("name the GitHub card, its gate and its feed line by the computer", () => {
    expect(deviceForgeSignInCardId("github.com", "d1")).toBe("card-forge-github.com-d1");
    expect(deviceForgeGateRef("github.com", "d1")).toBe("forge-sign-in:github.com@d1");
    expect(deviceForgeSignInTitle("on Mac mini")).toBe("Sign in to GitHub on Mac mini");
    expect(deviceForgeWaitLine("website's next task", "Mac mini")).toBe(
      "website's next task waits for Mac mini's own GitHub sign-in.",
    );
    expect(deviceForgeSignInBody("website", MINI)).toBe(
      "<p>website runs on Mac mini now. Mac mini needs its own GitHub sign-in to clone it and push.</p><p>Its next task waits for it. This computer's GitHub sign-in is not sent there.</p>",
    );
  });
});
