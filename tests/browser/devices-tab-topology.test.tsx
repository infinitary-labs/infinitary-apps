import type { DeviceView } from "@shared/devices";
import { setCurrentLanguage } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import recoveryFont from "../../src/renderer/src/design/assets/fonts/spacegrotesk-latin.woff2?url";
import { fakeBridge } from "./bridge";
import { ADDRESSES, AIR, gone, MINI, openDevices, STUDIO, shown } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openWindow } from "./window";

// INF-4938: the same physical device and confirmation are selected in each
// layout; live contact is not work readiness, and saved addresses aren't live.
test("pages known peers and keeps their details and questions when switching layouts", async () => {
  const peers: DeviceView[] = [
    AIR,
    { ...MINI, otherVersion: { than: "older", takesWork: false, updateBy: "command" } },
    { ...STUDIO, ssh: { state: "reconnecting" } },
    ...Array.from({ length: 9 }, (_, index) => ({
      ...AIR,
      id: `fleet-${index}`,
      name: index === 0 ? "Pocket phone" : `Paired laptop ${index + 1}`,
      ...(index === 0 ? { system: "ios" as const } : {}),
      ...(index === 1
        ? { kind: "mac" as const, controlling: true, workSetup: { state: "starting" as const } }
        : { controlling: false }),
      inReach: false,
    })),
  ];
  const bridge = fakeBridge(await freshHome());
  bridge.answer("inf:devices:list", () => peers);
  bridge.answer("inf:devices:addresses", () => ({
    ...ADDRESSES,
    addresses: [...ADDRESSES.addresses, { address: "100.101.8.7", network: "private" }],
  }));
  const copy = { deviceId: MINI.id, state: "away", copyAt: 1 } as const;
  bridge.answer("inf:standby:list", () => ({ standbys: [copy] }));
  bridge.answer("inf:standby:saved-addresses", (id) =>
    id === MINI.id
      ? [
          { address: "192.168.1.51:47623", network: "local" },
          { address: "100.101.8.29:47623", network: "private" },
        ]
      : [],
  );
  await page.viewport(1330, 940);
  await openWindow(bridge);
  // Exercise the fit cache when fallback font metrics are taller than the final ones.
  const fallbackMetrics = document.createElement("style");
  fallbackMetrics.textContent =
    '[data-layout="map"] [data-device-select="studio"] { min-height: 200px }';
  document.head.append(fallbackMetrics);
  try {
    await openDevices();
    await expect
      .element(page.getByRole("button", { name: m.settingsDevicesMapMode(), exact: true }))
      .toBeDisabled();
    await document.fonts.ready;
    const offPage = await shown('[data-layout="list"] [data-device-select="fleet-8"]');
    const list = page.getByRole("button", { name: m.settingsDevicesListMode(), exact: true });
    const loadFont = async (name: string) => {
      const face = new FontFace(name, `url(${recoveryFont})`);
      document.fonts.add(face);
      try {
        await face.load();
      } finally {
        document.fonts.delete(face);
      }
    };
    offPage.focus();
    await loadFont("Devices rejected retry fixture");
    await expect.element(list).toHaveFocus();
    expect(
      (await shown('[data-layout="list"] [data-device-select="this-mac"]')).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    (await shown('[data-layout="list"] [data-device-select="fleet-8"]')).focus();
    fallbackMetrics.remove();
    await loadFont("Devices recovery fixture");
    await shown('[data-layout="map"]');
    await expect.element(list).toHaveFocus();
    expect(
      (await shown('[data-layout="map"] [data-device-select="this-mac"]')).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");

    // In explicit List, font completion must only invalidate the old fit result.
    document.head.append(fallbackMetrics);
    const mapControl = page.getByRole("button", { name: m.settingsDevicesMapMode(), exact: true });
    await expect.element(mapControl).toBeDisabled();
    await userEvent.click(list);
    const focusedRow = await shown('[data-layout="list"] [data-device-select="fleet-8"]');
    focusedRow.focus();
    fallbackMetrics.remove();
    await loadFont("Devices explicit List fixture");
    await expect.element(mapControl).toBeEnabled();
    expect(document.activeElement).toBe(focusedRow);
    expect(
      (await shown('[data-layout="list"] [data-device-select="this-mac"]')).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    await userEvent.click(mapControl);
    await shown('[data-layout="map"]');
  } finally {
    fallbackMetrics.remove();
  }
  const map = await shown('[data-layout="map"]');
  await expect.poll(() => map.querySelectorAll("[data-device-select]").length).toBe(9);
  // A reported iPhone gets a handset in both layouts; a generic view does not.
  await shown('[data-device-select="fleet-0"] [data-device-glyph="handset"]');
  await shown('[data-device-select="air"] [data-device-glyph="computer"]');
  expect(map.getBoundingClientRect().height).toBe(380);
  expect(map.querySelectorAll('path[data-contact="live"]')).toHaveLength(3);
  expect(map.querySelectorAll('path[data-contact="trying"]')).toHaveLength(1);
  for (const [id, contact, text] of [
    [MINI.id, "live", m.settingsDevicesMapNoNewWork()],
    [STUDIO.id, "trying", m.settingsDevicesMapReconnectingSsh()],
    ["fleet-0", "away", m.settingsDevicesMapAway()],
    ["fleet-1", "live", m.settingsDevicesMapWorkNotReady()],
  ]) {
    expect(
      (await shown(`[data-device-select="${id}"] [data-contact="${contact}"]`)).textContent,
    ).toContain(text);
  }
  expect((await shown('[data-device-select="fleet-1"] .fm-topology-progress')).textContent).toBe(
    m.settingsDevicesSettingUp(),
  );
  expect((await shown('[data-device-select="studio"] .fm-topology-progress')).textContent).toBe(
    m.settingsDevicesMapWaitingForWork(),
  );
  const home = await shown('[data-device-select="this-mac"]');
  expect(home.getAttribute("aria-pressed")).toBe("true");
  const ways = await shown("[data-device-ways]");
  expect(ways.querySelector("[data-device-way]")?.getAttribute("data-device-way")).toBe("private");
  expect(bridge.requests("inf:standby:saved-addresses")).toEqual([]);
  await userEvent.click(page.getByRole("button", { name: "Next", exact: true }));
  await expect.poll(() => map.querySelectorAll("[data-device-select]").length).toBe(5);
  await userEvent.click(page.getByRole("button", { name: "Previous", exact: true }));
  home.focus();
  await userEvent.keyboard("{ArrowRight}{ArrowRight}{Enter}");
  const miniRow = await shown('[data-device-row="mini"]');
  expect(miniRow.textContent?.split(MINI.remoteLogin ?? "")).toHaveLength(2);
  const saved = await shown("[data-device-saved-addresses]");
  expect(saved.textContent).toContain("Last reported for takeover");
  expect(saved.querySelector("dd")?.textContent).toBe("100.101.8.29:47623");
  await userEvent.click(page.getByRole("button", { name: "List", exact: true }));
  await shown('[data-layout="list"] [data-device-select="fleet-0"] [data-device-glyph="handset"]');
  expect((await shown('[data-device-select="mini"]')).getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector("[data-device-saved-addresses]")).toBe(saved);
  await userEvent.click(page.getByRole("button", { name: /^Remove Mac mini/ }));
  await shown('[data-device-removing="mini"]');
  await userEvent.click(page.getByRole("button", { name: "Map", exact: true }));
  const keep = page.getByRole("button", { name: "Keep it", exact: true });
  await keep.click();
  await gone("[data-device-removing]");
  expect(bridge.requests("inf:devices:remove")).toEqual([]);
  bridge.push("inf:standby:views", { standbys: [] });
  await gone("[data-device-saved-addresses]");
  await page.viewport(730, 940);
  await expect.poll(() => map.querySelectorAll("[data-device-select]").length).toBeLessThan(9);
  await userEvent.click(page.getByRole("button", { name: /^Remove Mac mini/ }));
  await shown('[data-device-removing="mini"]');
  bridge.push(
    "inf:devices",
    peers.filter((peer) => peer.id !== MINI.id),
  );
  await expect.poll(() => home.getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(await shown('[data-device-select="air"]'));
  await shown('[data-device-row="air"]');
  const local: DeviceView = {
    id: MINI.id,
    name: MINI.name,
    kind: MINI.kind,
    pairedAt: MINI.pairedAt,
    heldOnLocalNetwork: true,
    inReach: false,
  };
  const withMini = (device: DeviceView) =>
    peers.map((peer) => (peer.id === device.id ? device : peer));
  bridge.push("inf:devices", withMini(local));
  const mini = await shown('[data-device-select="mini"]');
  expect(mini.getAttribute("aria-pressed")).toBe("false");
  await gone('[data-device-removing="mini"]');
  await userEvent.click(mini);
  await userEvent.click(
    page.getByRole("button", {
      name: m.settingsDevicesAddByAddressNamed({ device: local.name }),
    }),
  );
  await shown('[data-device-address-change="mini"]');
  bridge.push("inf:devices", withMini({ ...local, heldOnLocalNetwork: false }));
  await gone('[data-device-address-change="mini"]');
  await userEvent.click(await shown('[data-device-select="air"]'));
  const restored = { ...local, name: "Workshop" };
  bridge.push("inf:devices", withMini(restored));
  await expect.poll(() => mini.title).toBe(restored.name);
  expect(document.querySelector('[data-device-select="air"]')?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  await gone('[data-device-address-change="mini"]');
  expect(bridge.requests("inf:devices:remove")).toEqual([]);

  // Use the same mounted window: this browser fixture installs a single bridge.
  const retry: DeviceView = {
    ...STUDIO,
    ssh: { state: "reconnecting" },
    workSetup: { state: "starting" },
  };
  const localized = [...Array.from({ length: 9 }, (_, i) => ({ ...AIR, id: `peer-${i}` })), retry];
  await page.viewport(1330, 940);
  try {
    bridge.answer("inf:devices:list", () => localized);
    setCurrentLanguage("de");
    await userEvent.click(await shown('[data-settings-tab="devices"]'));
    const next = page.getByRole("button", { name: m.settingsDevicesMapNext(), exact: true });
    await expect.element(next).toBeVisible();
    await userEvent.click(await shown('[data-device-select="peer-0"]'));
    (await next.element()).focus();
    await userEvent.keyboard("{Enter}");
    await shown('[data-layout="list"]');
    const list = page.getByRole("button", { name: m.settingsDevicesListMode(), exact: true });
    await expect.element(list).toHaveFocus();
    expect((await shown('[data-device-select="peer-0"]')).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const retryTile = await shown('[data-device-select="studio"]');
    expect(retryTile.textContent).toContain(m.settingsDevicesMapReconnectingSsh());
    expect(retryTile.textContent).toContain(m.settingsDevicesMapWaitingForWork());
    expect(retryTile.textContent).toContain(m.settingsDevicesSettingUp());

    // Revisit exactly the rejected status with Map focused, not the pager.
    bridge.push("inf:devices", [...localized.slice(0, -1), { ...STUDIO, inReach: true }]);
    await shown('[data-layout="map"] [data-device-select="studio"]');
    const mapControl = page.getByRole("button", { name: m.settingsDevicesMapMode(), exact: true });
    (await mapControl.element()).focus();
    await expect.element(mapControl).toHaveFocus();
    bridge.push("inf:devices", localized);
    await shown('[data-layout="list"]');
    await expect.element(list).toHaveFocus();
    expect((await shown('[data-device-select="peer-0"]')).getAttribute("aria-pressed")).toBe(
      "true",
    );
  } finally {
    setCurrentLanguage("en");
  }
});
