import { expect, test } from "@playwright/test";
import type { DeviceGrant } from "../../src/shared/devices";
import { connectClient } from "../helpers/connectionClient";
import { clusterFixture } from "./clusterFixture";
import { crewSummary } from "./crew";
import { launchApp } from "./launch";
import { expectClearOf, intersects, type Rect, resizeWindow, within } from "./layout";
import { promptInput } from "./prompt";
import { hideRecord, recordCard } from "./rails";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

/** Every crew glyph target on the page, with the computer it belongs to and its box. */
function crewTargets(page: import("@playwright/test").Page) {
  return page
    .locator("[data-crew-model-name]")
    .filter({ visible: true })
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return {
          computer: node.getAttribute("data-crew-computer") ?? "home",
          box: { x, y, width, height },
        };
      }),
    );
}

/** The box around a set of boxes. */
function union(boxes: Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

test("actual task placement groups work computers, and keyboard inspection opens the same records behind the stage", async () => {
  const peers: DeviceGrant[] = [];
  const app = await launchApp({
    userDataDir: clusterFixture([4, 6, 2], peers),
    withMockProvider: true,
  });
  try {
    const { page } = app;
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const devices = await page.evaluate(() => window.infinitary.devices.list());
    expect(board.tasks.filter((task) => task.status === "active")).toHaveLength(12);
    await expect(page.locator("[data-computer-cluster]")).toHaveCount(3);
    // Another computer's crew sit beyond the home formation, never inside it
    // or on a home crewmate.
    await expect
      .poll(async () => {
        const targets = await crewTargets(page);
        const home = targets.filter((t) => t.computer === "home");
        const remote = targets.filter((t) => t.computer !== "home");
        if (home.length === 0 || remote.length === 0) return ["not painted yet"];
        const formation = union(home.map((t) => t.box));
        return remote
          .filter((r) => intersects(r.box, formation) || home.some((h) => intersects(h.box, r.box)))
          .map((r) => `${r.computer} at ${Math.round(r.box.x)},${Math.round(r.box.y)}`);
      })
      .toEqual([]);
    for (const device of devices) {
      const cluster = page.locator(`[data-computer-cluster="${device.id}"]`);
      await expect(cluster).toBeVisible();
      await expect(cluster).toContainText(device.name);
      const tasks = board.tasks.filter((task) => task.executionDeviceId === device.id);
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        const target = page.locator(`[data-crew-model-name="${task.id}"]`);
        await expect(target).toHaveAttribute("data-crew-computer", device.id);
        await focusOn(target);
        await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", task.id);
        await pressKey(target, "Escape");
      }
    }
    const peer = peers[0];
    if (!peer) throw new Error("No reachable peer fixture");
    const port = await app.app.evaluate(() => process.env.INFINITARY_CONNECTION_LOOPBACK_PORT);
    const connection = await connectClient({ ...peer, at: `127.0.0.1:${port}` });
    try {
      await expect(page.locator(`[data-computer-cluster="${peer.deviceId}"]`)).toHaveAttribute(
        "data-computer-reachable",
        "true",
      );
    } finally {
      await connection.close();
    }
    await expect(page.locator(`[data-computer-cluster="${peer.deviceId}"]`)).toHaveAttribute(
      "data-computer-reachable",
      "false",
    );
    const task = board.tasks.find((task) => task.executionDeviceId !== null);
    if (!task) throw new Error("Remote task fixture missing");
    const target = page.locator(`[data-crew-model-name="${task.id}"]`);
    await pressKey(target, "Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
    await expect(page.locator("[data-computer-cluster]").filter({ visible: true })).toHaveCount(0);
    await expect(crewSummary(page)).toHaveCount(0);
    await hideRecord(page).click();
    await expect(page.locator("[data-computer-cluster]").filter({ visible: true })).toHaveCount(3);
    await resizeWindow(app.app, page, { width: 960, height: 700 });
    await focusOn(target);
    await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", task.id);
    await expectClearOf(page, crewSummary(page), promptInput(page));
  } finally {
    await app.close();
  }
});

test("computer paging keeps every task reachable by keyboard without limiting the roster", async () => {
  const app = await launchApp({
    userDataDir: clusterFixture([2, 1, 1, 1, 1, 1, 1, 1]),
    withMockProvider: true,
  });
  try {
    const { page } = app;
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const seen = new Set<string>();
    for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
      await expect(page.locator("[data-computer-cluster]")).toHaveCount(pageIndex === 0 ? 6 : 3);
      const computerIds = await page
        .locator("[data-computer-cluster]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-computer-cluster")));
      const pageTasks = board.tasks.filter(
        (task) =>
          task.status === "active" && computerIds.includes(task.executionDeviceId ?? "home"),
      );
      const targets = page.locator("[data-crew-model-name]").filter({ visible: true });
      await expect(targets).toHaveCount(pageTasks.length);
      for (const task of pageTasks) {
        const target = page.locator(`[data-crew-model-name="${task.id}"]`);
        seen.add(task.id);
        await focusOn(target);
        await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", task.id);
        await pressKey(target, "Escape");
      }
      if (pageIndex === 0) await runFromSearch(app.app, page, "computers.next");
    }
    expect(seen).toEqual(
      new Set(board.tasks.filter((task) => task.status === "active").map((task) => task.id)),
    );
    await runFromSearch(app.app, page, "computers.previous");
    await expect(page.locator("[data-computer-cluster]")).toHaveCount(6);
  } finally {
    await app.close();
  }
});

test("a crowded last-known fleet retains all 64 inspectable crew at minimum width", async () => {
  const app = await launchApp({
    userDataDir: clusterFixture([24, 16, 12, 8, 4, 0]),
    withMockProvider: true,
  });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 960, height: 700 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const active = board.tasks.filter((task) => task.status === "active");
    expect(active).toHaveLength(64);
    await expect(page.locator("[data-crew-model-name]").filter({ visible: true })).toHaveCount(64);
    // The whole scene shrinks to the narrow window: every crewmate stays inside it.
    const viewport = await page.evaluate(() => ({
      x: 0,
      y: 0,
      width: innerWidth,
      height: innerHeight,
    }));
    await expect
      .poll(async () =>
        (await crewTargets(page)).flatMap((t) =>
          within(t.box, viewport).map((edge) => `${t.computer}: ${edge}`),
        ),
      )
      .toEqual([]);
    for (const task of active.filter((task) => task.id.endsWith("-0"))) {
      const target = page.locator(`[data-crew-model-name="${task.id}"]`);
      await expect(target).toHaveAttribute("data-crew-computer", task.executionDeviceId ?? "home");
      await focusOn(target);
      await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", task.id);
      await pressKey(target, "Escape");
    }
  } finally {
    await app.close();
  }
});
