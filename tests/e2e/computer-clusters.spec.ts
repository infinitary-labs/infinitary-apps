import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { seedTask } from "../../src/core/tasks/seedTask";
import type { DeviceGrant } from "../../src/shared/devices";
import { connectClient } from "../helpers/connectionClient";
import { scratchDir } from "../helpers/scratchDirs";
import { clusterFixture } from "./clusterFixture";
import { crewSummary } from "./crew";
import { launchApp } from "./launch";
import { expectClearOf, intersects, type Rect, resizeWindow, within } from "./layout";
import { promptInput } from "./prompt";
import { expectRecordBody, hideRecord, recordCard } from "./rails";
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
    await expectRecordBody(page);
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

/** The near crew layer's lit pixels, sorted by hue: the gray of a wait and the ember of a review. */
function arrowInk(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-crew-layer="near"]');
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("crew near layer missing");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let gray = 0;
    let ember = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r = 0, g = 0, b = 0, a = 0] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a === 0) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) < 40) gray++;
      else if (r > g && g > b && r - b > 60) ember++;
    }
    return { gray, ember };
  });
}

// Captain (INF-556): "i do think drawing a wait between computers may be helpful",
// chosen as "Solid gray, like every other wait"; "for a reviewer relationship, it
// should use the orange color that we use as active", with "the same reach as waits".
test("a wait and a review between computers draw their arrows across the stage", async () => {
  const app = await launchApp({
    userDataDir: clusterFixture([2, 2], undefined, (tasks, ids) => {
      // This Mac's first task waits on both of the other computer's tasks.
      tasks.graph.link("sample-1-0", "sample-0-0", "blocks", "host");
      tasks.graph.link("sample-1-1", "sample-0-0", "blocks", "host");
      // The other computer reviews this Mac's second task.
      const worktreeDir = join(scratchDir("fm-cluster-review-"), "review");
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, {
        id: "review",
        title: "Review the work on computer 0, task 1",
        parentId: "sample-0-1",
        shape: { kind: "review", kind_source: "host:review" },
        status: "idle",
        worktreeDir,
        deviceId: ids[1],
        sessionFile: "placed-review.jsonl",
      });
    }),
    withMockProvider: true,
  });
  try {
    const { page } = app;
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const byId = new Map(board.tasks.map((task) => [task.id, task]));
    expect(byId.get("sample-0-0")?.blockedBy.sort()).toEqual(
      [byId.get("sample-1-0")?.key, byId.get("sample-1-1")?.key].sort(),
    );
    expect(byId.get("review")?.reviewOf).toBe("sample-0-1");
    await expect(page.locator("[data-computer-cluster]")).toHaveCount(2);
    const other = byId.get("review")?.executionDeviceId;
    if (!other) throw new Error("The review fixture is not on the other computer");
    for (const id of ["sample-1-0", "sample-1-1", "review"])
      await expect(page.locator(`[data-crew-model-name="${id}"]`)).toHaveAttribute(
        "data-crew-computer",
        other,
      );
    // Every crewmate is idle, so its glyph is the cool cyan: the only gray
    // ink is a wait's arrow and the only ember ink is a review's.
    await expect
      .poll(async () => {
        const ink = await arrowInk(page);
        return { gray: ink.gray > 40, ember: ink.ember > 40 };
      })
      .toEqual({ gray: true, ember: true });
  } finally {
    await app.close();
  }
});
