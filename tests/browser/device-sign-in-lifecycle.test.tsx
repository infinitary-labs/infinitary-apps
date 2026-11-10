import {
  type DeviceSignInFlow,
  type DeviceSignIns,
  REMOTE_SIGN_IN_UPDATE_NOTE,
} from "@shared/signIns";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { useShellStore } from "../../src/renderer/src/app/store";
import { DeviceForgeRows } from "../../src/renderer/src/settings/DeviceForgeRows";
import { DeviceSignInGroups } from "../../src/renderer/src/settings/DeviceSignIns";
import { AccountRow } from "../../src/renderer/src/settings/SubscriptionsTab";
import { fakeBridge } from "./bridge";
import { afterNextFrame, button, gone, shown } from "./devicesTab";

// Remote Settings must recover current prompts, codes and Cancel after a
// remount, and an older home must keep management rows without starting sign-ins.
const DEVICE: DeviceSignIns = {
  deviceId: "work",
  name: "Work computer",
  onThisMac: false,
  reach: "in-reach",
  flows: [],
  signIns: {
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        tier: "key",
        authTypes: ["api_key"],
        connected: false,
        billedPerToken: false,
      },
    ],
    accounts: [],
    quota: null,
    forges: { signIns: [], hosts: [{ host: "github.com", name: "GitHub" }] },
  },
};
const PROMPT = {
  promptId: "api-key",
  providerId: "openrouter",
  kind: "secret",
  message: "API key",
} as const;
const NOTICE = {
  providerId: "github.com",
  kind: "device_code",
  message: "Enter the code",
  userCode: "WDJB-MJHT",
  url: "https://github.com/login/device",
} as const;

test("remote Settings send a prompt answer once, draw a forge code and cancel the named sign-in", async () => {
  const bridge = fakeBridge({
    "inf:devices:shown": { shown: true },
    "inf:devices:sign-ins": [DEVICE],
    "inf:devices:sign-in": () => ({ signInId: "key-sign-in" }),
    "inf:devices:sign-in:answer": { ok: true },
    "inf:devices:sign-in:cancel": { ok: true },
    "inf:devices:forge-sign-in": () => ({ signInId: "forge-sign-in" }),
  });
  const publish = (flows: DeviceSignInFlow[]) => {
    const devices = [{ ...DEVICE, flows }];
    bridge.answer("inf:devices:sign-ins", devices);
    bridge.push("inf:devices:sign-ins", devices);
  };
  bridge.answer("inf:devices:sign-in:answer", () => {
    publish([
      {
        signInId: "key-sign-in",
        deviceId: "work",
        providerId: "openrouter",
        target: "account",
        phase: "running",
      },
    ]);
    return { ok: true };
  });
  bridge.answer("inf:devices:sign-in:cancel", () => {
    publish([]);
    return { ok: true };
  });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const render = (key: number) =>
    root.render(
      <div key={key}>
        <DeviceSignInGroups providerName={() => "OpenRouter"} renderRow={() => null} />
        <DeviceForgeRows />
      </div>,
    );
  render(0);
  try {
    let group = await shown('[data-device-sign-ins="work"]');
    await userEvent.click(
      group.querySelector('[data-connect-provider="openrouter"]') as HTMLElement,
    );
    await expect
      .poll(() => bridge.requests("inf:devices:sign-in"))
      .toEqual([["work", "openrouter", "api_key", undefined]]);
    publish([
      {
        signInId: "key-sign-in",
        deviceId: "work",
        providerId: "openrouter",
        target: "account",
        phase: "running",
        prompt: PROMPT,
      },
    ]);
    await shown('input[aria-label="The key for Work computer"]');
    root.render(null);
    await gone('[data-device-sign-ins="work"]');
    render(1);
    const input = await shown('input[aria-label="The key for Work computer"]');
    group = await shown('[data-device-sign-ins="work"]');
    await userEvent.fill(input, "sk-or-v1-disposable-key");
    await userEvent.click(button(group, "Send to Work computer"));
    expect(bridge.requests("inf:devices:sign-in:answer")).toEqual([
      ["key-sign-in", PROMPT.promptId, "sk-or-v1-disposable-key"],
    ]);
    await gone('input[aria-label="The key for Work computer"]');
    await userEvent.click(button(group, "Cancel"));
    expect(bridge.requests("inf:devices:sign-in:cancel")).toEqual([["key-sign-in"]]);
    const forge = await shown('[data-device-forge-row="work"]');
    await userEvent.click(button(forge, "Sign in"));
    await expect
      .poll(() => bridge.requests("inf:devices:forge-sign-in"))
      .toEqual([["work", "github.com"]]);
    publish([
      {
        signInId: "forge-sign-in",
        deviceId: "work",
        providerId: "github.com",
        target: "forge",
        phase: "running",
        notice: NOTICE,
        link: NOTICE.url,
      },
    ]);
    await expect
      .poll(
        () =>
          document.querySelector('[data-device-sign-in-provider="github.com"]')?.textContent ?? "",
      )
      .toContain(NOTICE.userCode);
    root.render(null);
    await gone('[data-device-sign-in-provider="github.com"]');
    render(2);
    const aside = await shown('[data-device-sign-in-provider="github.com"]');
    await expect.poll(() => aside.textContent).toContain(NOTICE.userCode);
    await userEvent.click(button(aside, "Cancel"));
    expect(bridge.requests("inf:devices:sign-in:cancel")).toEqual([
      ["key-sign-in"],
      ["forge-sign-in"],
    ]);
    // No compatibility reducer: an older home cannot start a flow this view cannot recover.
    const { flows: _flows, ...older } = DEVICE;
    bridge.push("inf:devices:sign-ins", [older]);
    await expect
      .poll(() =>
        mount.querySelector('[data-connect-provider="openrouter"]')?.getAttribute("aria-disabled"),
      )
      .toBe("true");
    await expect.poll(() => mount.textContent).toContain(REMOTE_SIGN_IN_UPDATE_NOTE);
    const olderForge = await shown('[data-device-forge-row="work"]');
    expect(button(olderForge, "Sign in").getAttribute("aria-disabled")).toBe("true");
    useShellStore.setState({
      pendingDeviceSignIn: { deviceId: "work", providerId: "openrouter" },
      pendingDeviceForgeSignIn: { deviceId: "work", host: "github.com" },
    });
    await afterNextFrame();
    expect(bridge.requests("inf:devices:sign-in")).toHaveLength(1);
    expect(bridge.requests("inf:devices:forge-sign-in")).toHaveLength(1);
    // Once the view supports flows, the still-pending card requests can start normally.
    publish([]);
    await expect.poll(() => bridge.requests("inf:devices:sign-in").length).toBe(2);
    await expect.poll(() => bridge.requests("inf:devices:forge-sign-in").length).toBe(2);
    expect(bridge.unanswered).toEqual([]);
  } finally {
    root.unmount();
    mount.remove();
    useShellStore.setState({ pendingDeviceSignIn: null, pendingDeviceForgeSignIn: null });
  }
});

test("an older home keeps accounts, allowance, custom connections and forge management while only sign-in starts are off", async () => {
  const now = Date.now();
  const account = {
    id: "work-account",
    providerId: "openai-codex",
    kind: "subscription_oauth",
    label: "Work",
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: now,
  } as const;
  const expired = { ...account, id: "expired-account", label: "Expired", connected: false };
  const { flows: _flows, ...older } = DEVICE;
  const listed: DeviceSignIns[] = [
    {
      ...older,
      customApi: true,
      signIns: {
        ...DEVICE.signIns,
        providers: DEVICE.signIns?.providers ?? [],
        accounts: [account, expired],
        quota: {
          generatedAt: new Date(now).toISOString(),
          fetchedAt: now,
          providers: [
            {
              provider: "codex",
              label: "Codex",
              accountId: account.id,
              status: "ok",
              stale: false,
              windows: [{ id: "session", label: "5h", percentRemaining: 88 }],
            },
          ],
        },
        custom: [
          {
            accountId: "custom-work",
            label: "Local gateway",
            baseUrl: "http://localhost:1234/v1",
            mode: "local",
            protocol: "openai-completions",
            keyPresent: false,
            noKey: true,
            headers: [],
            enabled: true,
            allowStorageDefault: false,
            certificates: [],
            models: [
              {
                id: "qwen/qwen3-32b",
                context: 32768,
                output: 4096,
                checked: true,
                state: "checked",
              },
            ],
          },
        ],
        forges: {
          hosts: [{ host: "github.com", name: "GitHub" }],
          signIns: [
            { host: "github.com", name: "GitHub", login: "octocat", state: "ok", since: now },
          ],
        },
      },
    },
    { ...older, deviceId: "unsigned", name: "Unsigned computer" },
  ];
  const bridge = fakeBridge({
    "inf:devices:shown": { shown: true },
    "inf:devices:sign-ins": listed,
    "inf:devices:sign-out": { ok: true },
    "inf:devices:forge-sign-out": { ok: true },
    "inf:devices:sign-in": () => ({ signInId: "must-not-start" }),
    "inf:devices:forge-sign-in": () => ({ signInId: "must-not-start" }),
  });
  Object.defineProperty(window, "infinitary", { configurable: true, value: bridge.api });
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const noop = () => {};
  root.render(
    <>
      <DeviceSignInGroups
        providerName={() => "Codex"}
        renderRow={(row) => (
          <AccountRow
            {...row}
            isFlagship={false}
            hasModels={false}
            renaming={false}
            refreshing={false}
            onStartRename={noop}
            onRename={noop}
            onCancelRename={noop}
            onTogglePin={noop}
            onSetEnabled={noop}
            onDisconnect={noop}
            onShowModels={noop}
            onResetSlots={noop}
          />
        )}
      />
      <DeviceForgeRows />
    </>,
  );
  try {
    const group = await shown('[data-device-sign-ins="work"]');
    expect(group.querySelectorAll("[data-account-row]")).toHaveLength(2);
    const allowance = listed[0]?.signIns?.quota?.providers[0]?.windows[0]?.percentRemaining;
    if (allowance === undefined) throw new Error("The fixture has no allowance reading");
    expect(group.textContent).toContain(`${allowance}%`);
    const expiredRow = group.querySelector('[data-account-row="expired-account"]') as HTMLElement;
    expect(button(expiredRow, "Sign in").getAttribute("aria-disabled")).toBe("true");
    button(expiredRow, "Sign in").focus();
    await userEvent.keyboard("{Enter}");
    const chip = group.querySelector('[data-connect-provider="openrouter"]') as HTMLElement;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    chip.focus();
    await userEvent.keyboard("{Enter}");
    const custom = group.querySelector('[data-custom-account="custom-work"]') as HTMLElement;
    const model = listed[0]?.signIns?.custom?.[0]?.models[0]?.id;
    if (!model) throw new Error("The fixture has no saved custom model");
    expect(custom.textContent).toContain(model);
    expect(button(custom, "Edit").disabled).toBe(false);
    expect((group.querySelector("[data-connect-custom-api]") as HTMLButtonElement).disabled).toBe(
      false,
    );
    await userEvent.click(button(custom, "Disconnect"));
    const confirm = await shown('[data-custom-account="custom-work"] .fm-custom-disconnect');
    await userEvent.click(button(confirm, "Disconnect"));
    expect(bridge.requests("inf:devices:sign-out")).toEqual([["work", "custom-work"]]);
    await userEvent.click(button(group, "Work actions"));
    await userEvent.click(await shown('[role="menuitem"]'));
    expect(bridge.requests("inf:devices:sign-out")).toEqual([
      ["work", "custom-work"],
      ["work", account.id],
    ]);
    const signedIn = await shown('[data-device-forge-row="work"]');
    expect(signedIn.dataset.forgeState).toBe("ok");
    expect(signedIn.textContent).toContain("octocat");
    await userEvent.click(button(signedIn, "GitHub on Work computer actions"));
    await userEvent.click(await shown('[role="menuitem"]'));
    expect(bridge.requests("inf:devices:forge-sign-out")).toEqual([["work", "github.com"]]);
    const unsigned = await shown('[data-device-forge-row="unsigned"]');
    expect(button(unsigned, "Sign in").getAttribute("aria-disabled")).toBe("true");
    button(unsigned, "Sign in").focus();
    await userEvent.keyboard("{Enter}");
    await afterNextFrame();
    expect(bridge.requests("inf:devices:sign-in")).toEqual([]);
    expect(bridge.requests("inf:devices:forge-sign-in")).toEqual([]);
    expect(group.textContent).toContain(REMOTE_SIGN_IN_UPDATE_NOTE);
    expect(bridge.unanswered).toEqual([]);
  } finally {
    root.unmount();
    mount.remove();
  }
});
