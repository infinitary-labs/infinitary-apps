import { describe, expect, it, vi } from "vitest";
import { insertDirectPrTask, recordPr, setup } from "../../../tests/helpers/prCiHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { ForgePull } from "../forge";
import { approvableOffer } from "./mergeAuthorization";

// Real project fixtures use Git at the test run's priority.
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

describe("saved request authority at a project cutover", () => {
  it.each(["linked", "legacy"])(
    "refuses a saved request and explicitly reselects the same number on its own branch after a project move (%s)",
    async (style) => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      const task = tasks.get("ab12cd34");
      if (!task?.repoId) throw new Error("The fixture needs a managed project.");
      repos.configure(task.repoId, { origin: "https://github.com/x/y.git" });
      recordPr(tasks, 23);
      seedDelivery(tasks, task.id, {
        override: {
          words: "Pass the checks for the former request.",
          holds: ["checks"],
          until: "version",
          head: "feedbeef",
          prNumber: 23,
          ...(style === "linked" ? { prUrl: "https://github.com/x/y/pull/23" } : {}),
          at: 1,
        },
      });
      const current = repos.configure(task.repoId, { origin: "https://github.com/x/new-home.git" });
      const url = "https://github.com/x/new-home/pull/23";
      const pull = vi.fn(
        async (number: number): Promise<ForgePull> => ({
          number,
          state: "open",
          merged: false,
          headSha: "feedbeef",
          base: "main",
          branch: task.branch,
          headRepo: "x/new-home",
          title: "fix: ship the meter",
          url,
          readiness: "clean",
        }),
      );
      forge.change = { number: 23, url, branch: task.branch, headSha: "feedbeef", base: "main" };
      Object.assign(forge, { pull });
      expect(await service.checkTool.checkForCrew(task.id)).toContain("former address");
      expect(await service.merges.pullState(task.id, 23)).toBeUndefined();
      seedDelivery(tasks, task.id, { prUrl: undefined });
      expect(await service.merges.pullState(task.id, 23)).toBeUndefined();
      expect(pull).not.toHaveBeenCalled();
      expect(await service.checkTool.checkForCrew(task.id, { pull: 23 })).toContain("#23");
      expect(pull).toHaveBeenCalledWith(23);
      expect(tasks.get(task.id)?.delivery).toMatchObject({ prNumber: 23, prUrl: url });
      expect(await service.checkTool.checkForCrew(task.id)).not.toContain("former address");
      expect(await service.merges.pullState(task.id, 23)).toMatchObject({ url });
      const change = tasks.changeFor(task.id);
      const checks = tasks.get(task.id)?.delivery?.checks;
      if (!change || !checks) throw new Error("The fixture needs checks for the new request.");
      await service.checkTool.checkForCrew(task.id, {
        change: change.id,
        declaration: {
          verdict: "flake",
          headSha: "not-the-current-head",
          evidence: "Wrong version.",
        },
      });
      expect(tasks.get(task.id)?.delivery?.checks).toEqual(checks);
      forge.states = ["failure"];
      const held = await service.merges.merge(task.id);
      expect(held.ok).toBe(false);
      expect(held.text).toContain("the checks failed");
      expect(forge.calls.some((call) => call.startsWith("putIn "))).toBe(false);
      expect(
        tasks.changeFor(task.id)?.versions.find((version) => version.head === "feedbeef")?.consent
          ?.override,
      ).toBeUndefined();
      expect(current.origin).toContain("new-home");
    },
  );

  it("does not authorize a merge card issued at the former address when number and head are reused", async () => {
    const { tasks, repos } = setup();
    await insertDirectPrTask(tasks, repos);
    const task = tasks.get("ab12cd34");
    if (!task?.repoId) throw new Error("The fixture needs a managed project.");
    const former = repos.configure(task.repoId, { origin: "https://github.com/x/y.git" });
    if (!former.origin) throw new Error("The fixture needs an approved address.");
    const card = { cardId: "merge-card", offerId: "offer" };
    const shown = {
      ...card,
      headSha: "feedbeef",
      prNumber: 23,
      at: 1,
      destination: { repoId: task.repoId, branch: task.branch, origin: former.origin },
    };
    recordPr(tasks, 23);
    seedDelivery(tasks, task.id, { headSha: shown.headSha, completionOffers: [shown] });
    const original = tasks.get(task.id);
    if (!original) throw new Error("The fixture needs the saved offer.");
    expect(approvableOffer(original, former, "direct-pr", card)?.baseline).toEqual(shown);
    const current = repos.configure(task.repoId, { origin: "https://github.com/x/new-home.git" });
    seedDelivery(tasks, task.id, { prUrl: "https://github.com/x/new-home/pull/23" });
    const replacement = tasks.get(task.id);
    if (!replacement) throw new Error("The fixture needs the replacement request.");
    expect(
      approvableOffer(replacement, current, "direct-pr", card, tasks.changesFor(task.id)),
    ).toBeUndefined();
    expect(replacement.delivery?.mergeAuthorization).toBeUndefined();
  });
});
