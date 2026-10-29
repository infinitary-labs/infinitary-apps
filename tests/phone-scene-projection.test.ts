import { expect, test, vi } from "vitest";
import { startPhoneHome } from "./helpers/phoneHome";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1066: the native renderer consumes actual published task/computer observations,
// including a running program's graph, all model tiers and an unreachable helper.
// Budget: one local TLS home and client, measured below one second; the default five seconds suffices.
// This integration owns only that projection; native tests own drawing and interaction.
test("a disposable home publishes the scene facts without device-management data", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  for (const name of ["INFINITARY_CONNECTION_LOOPBACK_PORT", "INFINITARY_DNS_SD"])
    vi.stubEnv(name, process.env[name]);
  const home = await startPhoneHome(scratchDir("infinitary-phone-scene-"));
  try {
    const response = await fetch(`${home.url}/scene-fixture`, { method: "POST" });
    const scene = await response.json();
    expect(response.ok, JSON.stringify(scene)).toBe(true);
    expect(scene.conversation).toEqual({ busy: false });
    expect(scene.computers).toEqual([{ id: scene.computer, name: "Scene Mac", inReach: false }]);
    expect(
      new Set(
        scene.board.tasks
          .filter((task: { tier?: string }) => task.tier)
          .map((task: { tier: string }) => task.tier),
      ),
    ).toEqual(new Set(["low", "medium", "high", "premium"]));
    expect(
      scene.board.tasks.find((task: { id: string }) => task.id === scene.program),
    ).toMatchObject({ program: true });
    expect(
      scene.board.tasks.find((task: { id: string }) => task.id === scene.remote),
    ).toMatchObject({ executionDeviceId: scene.computer });
    expect(
      scene.board.tasks.find((task: { id: string }) => task.id === scene.review),
    ).toMatchObject({ reviewOf: scene.first });
    expect(scene.board.links).toContainEqual(
      expect.objectContaining({ fromId: scene.first, toId: scene.second, type: "blocks" }),
    );
    // INF-1777: the scene's background waits are the host's own postures, not invented on the phone.
    const posture = (id: string) =>
      scene.board.tasks.find((task: { id: string }) => task.id === id)?.workPosture;
    expect(posture(scene.job)).toEqual({ state: "active", reason: "job" });
    expect(posture(scene.checks)).toEqual({ state: "active", reason: "checks" });
    const phone = await home.checkPublishedClient();
    expect(phone.conversation.value).toEqual(scene.conversation);
    expect(phone.computers.value).toEqual(scene.computers);
    expect(phone.cards.value).not.toContainEqual(
      expect.objectContaining({ id: scene.deferredSetup }),
    );
    const cleanup = await fetch(`${home.url}/scene-cleanup`, { method: "POST" });
    expect(cleanup.ok).toBe(true);
  } finally {
    await home.close();
    vi.unstubAllEnvs();
  }
});
