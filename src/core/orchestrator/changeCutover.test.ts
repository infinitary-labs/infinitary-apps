import { join } from "node:path";
import type { StagedChangePresentation } from "@shared/changePresentation";
import type { HostedPresentationDestination } from "@shared/presentationDestination";
import { describe, expect, it, vi } from "vitest";
import { fakeCrewmate, setup as setupCrew } from "../../../tests/helpers/crewHarness";
import {
  FakeForge,
  insertDirectPrTask,
  insertTask,
  recordPr,
  setup,
} from "../../../tests/helpers/prCiHarness";
import { original, repaired, storyFixture } from "../../../tests/helpers/savedStory";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { ForgePull } from "../forge";
import { git } from "../workspace/git";
import { seedProject } from "../workspace/seedProject";
import { createChangeDelivery } from "./changeDelivery";
import { ChangePresentations } from "./changePresentations";
import { BATCH_OPEN_WORDS } from "./changePublication";
import { approvableOffer } from "./mergeAuthorization";

// Real project fixtures use Git at the test run's priority.
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** Keep observed service responses for the cutover proof without adding routine CI output. */
function observe<T>(action: string, result: T): T {
  if (process.env.INFINITARY_CUTOVER_PROOF === "1")
    console.info(JSON.stringify({ action, result }));
  return result;
}

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
    const approval = approvableOffer(
      replacement,
      current,
      "direct-pr",
      card,
      tasks.changesFor(task.id),
    );
    observe("former merge offer still approvable", approval !== undefined);
    expect(approval).toBeUndefined();
    expect(replacement.delivery?.mergeAuthorization).toBeUndefined();
  });
});

const formerAddress = "https://github.com/example-studio/evidence-sample.git";
const newAddress = "https://github.com/example-studio/evidence-sample-next.git";
const formerDestination: HostedPresentationDestination = {
  host: "github.com",
  projectId: 1422452335,
  fullName: "example-studio/evidence-sample",
  visibility: "private",
};
const nextDestination: HostedPresentationDestination = {
  ...formerDestination,
  projectId: 1422452336,
  fullName: "example-studio/evidence-sample-next",
};

function staged(base: string, head = base): StagedChangePresentation {
  const { taskId, revision, destination, ...story } = storyFixture();
  return { ...story, title: "fix: keep the change story", base, head };
}

function storyForge() {
  let destination = formerDestination;
  let pushed = "";
  const forge = Object.assign(new FakeForge(), {
    change: null,
    storyDestination: async () => destination,
    branchHead: async () => pushed,
  });
  return {
    forge,
    destination: (next: HostedPresentationDestination) => {
      destination = next;
    },
    pushed: (head: string) => {
      pushed = head;
    },
  };
}

describe("saved stories at the approved cutover (INF-5135 and INF-5411)", () => {
  it.each(["approved now", "already approved before upgrade"])(
    "prepares revision 1 at the new destination and base (%s)",
    async (when) => {
      const where = storyForge();
      const { tasks, repos, service, readHead } = setup({ forge: where.forge });
      await insertDirectPrTask(tasks, repos);
      const task = tasks.get("ab12cd34");
      if (!task?.repoId) throw new Error("The fixture needs a managed project.");
      const { id } = task;
      const moved = when === "already approved before upgrade";
      repos.configure(task.repoId, { origin: moved ? newAddress : formerAddress });
      readHead.mockResolvedValue(original);
      if (moved) {
        // The old app had already moved the address without retiring the saved ledger.
        tasks.delivery.updateChangePresentation(id, () => ({
          revisions: [{ ...storyFixture(), destination: formerDestination }],
          receipts: [],
        }));
      } else {
        expect(await service.publication.prepareStory(id, staged(original))).toMatchObject({
          revision: 1,
        });
        expect(
          await service.publication.prepareStory(id, staged(repaired, original)),
        ).toMatchObject({
          said: expect.stringContaining("Keep the original Before base and destination"),
        });
        where.destination({ ...formerDestination, visibility: "public" });
        expect(await service.publication.prepareStory(id, staged(original))).toMatchObject({
          said: expect.stringContaining("Keep the original Before base and destination"),
        });
        const oldStory = { ...storyFixture(), destination: formerDestination };
        tasks.delivery.updateChangePresentation(
          id,
          () => ({ revisions: [oldStory], receipts: [] }),
          "fm/another-change",
        );
        const unrelated = { ...oldStory, destination: nextDestination };
        tasks.delivery.updateChangePresentation(
          id,
          () => ({ revisions: [unrelated], receipts: [] }),
          "fm/unrelated-change",
        );
        repos.configure(task.repoId, { origin: newAddress });
        expect(tasks.delivery.changePresentation(id, task.branch)).toBeUndefined();
        expect(tasks.delivery.changePresentation(id, "fm/another-change")).toBeUndefined();
        expect(tasks.delivery.changePresentation(id, "fm/unrelated-change")?.revisions).toEqual([
          unrelated,
        ]);
      }
      where.destination(nextDestination);
      readHead.mockResolvedValue(repaired);
      expect(
        observe(when, await service.publication.prepareStory(id, staged(repaired))),
      ).toMatchObject({
        revision: 1,
      });
      const binding = tasks.delivery
        .changePresentation(id, task.branch)
        ?.revisions.map(({ revision, destination, base, head }) => ({
          revision,
          destination,
          base,
          head,
        }));
      expect(observe("new story binding", binding)).toEqual([
        { revision: 1, destination: nextDestination, base: repaired, head: repaired },
      ]);
    },
  );

  it("keeps a story pinned to its unchanged publication address", async () => {
    const where = storyForge();
    const { tasks, repos, service, readHead } = setup({ forge: where.forge });
    await insertDirectPrTask(tasks, repos);
    const task = tasks.get("ab12cd34");
    if (!task?.repoId) throw new Error("The fixture needs a managed project.");
    repos.configure(task.repoId, { origin: formerAddress });
    seedDelivery(tasks, task.id, { publicationOrigin: formerAddress });
    readHead.mockResolvedValue(original);
    expect(await service.publication.prepareStory(task.id, staged(original))).toMatchObject({
      revision: 1,
    });
    repos.configure(task.repoId, { origin: newAddress });
    expect(tasks.delivery.changePresentation(task.id)?.revisions.at(-1)?.destination).toEqual(
      formerDestination,
    );
    expect(
      observe(
        "prepare again at the unchanged pinned destination",
        await service.publication.prepareStory(task.id, staged(original)),
      ),
    ).toMatchObject({ revision: 2 });
  });

  it.each(["address-bound", "legacy unbound"])(
    "refuses the former plain Git card and sends only a fresh click (%s)",
    async (offerStyle) => {
      let runMerge: ReturnType<typeof createChangeDelivery>["settleHooks"]["mergePullRequest"];
      const merge = vi.fn<typeof runMerge>((...args) => runMerge(...args));
      const { db, tasks, repos, supervisor } = setupCrew(fakeCrewmate(), {
        mergePullRequest: merge,
      });
      const from = "https://git.example.com/library/field-notes.git";
      const to = "https://git.example.com/library/field-notes-next.git";
      let checkoutOrigin = from;
      const repo = seedProject(db, {
        id: "plain-cutover",
        path: scratchDir("plain-cutover-"),
        name: "field-notes",
        delivery: "direct-pr",
        origin: from,
      });
      const id = "ab12cd34";
      const branch = "fm/keep-field-notes";
      insertTask(tasks, { id, repoId: repo.id, repoDir: repo.path, branch });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      const forge = Object.assign(new FakeForge({ kind: "git", place: null }), {
        change: { branch, headSha: original, url: null },
        branchHead: async () => original,
        storyDestination: async () => ({
          kind: "branch" as const,
          origin: checkoutOrigin,
        }),
      });
      const presentations = new ChangePresentations({
        tasks,
        mediaDir: () => repo.path,
        head: async () => original,
      });
      const { publication, settleHooks } = createChangeDelivery({
        tasks,
        repos,
        presentations,
        forgeFor: () => forge,
        validateRange: async () => {},
      });
      runMerge = settleHooks.mergePullRequest;
      const putIn = vi.spyOn(forge, "putIn");
      const prepare = async () => {
        const story = staged(original);
        expect(await publication.prepareStory(id, story)).toMatchObject({ revision: 1 });
        expect(await publication.open(id, { title: story.title, presentation: 1 })).toContain(
          branch,
        );
        expect(tasks.delivery.changePresentation(id)?.completion).toMatchObject({
          revision: 1,
          head: original,
        });
      };
      const show = (card: string) =>
        supervisor.addFirstmateCard({
          id: card,
          taskId: id,
          title: "Merge the pushed branch",
          body: "<p>Merge the saved change.</p>",
          actions: [
            {
              id: "merge",
              label: "Merge",
              default: true,
              effect: { kind: "merge", after: "continue" },
            },
          ],
        });
      await prepare();
      const former = show("former-plain-merge");
      const offers = tasks.get(id)?.delivery?.completionOffers;
      expect(offers?.at(-1)?.destination?.origin).toBe(from);
      if (offerStyle === "legacy unbound") {
        seedDelivery(tasks, id, {
          completionOffers: offers?.map(({ destination, ...offer }) => offer),
        });
      }
      repos.configure(repo.id, { origin: to });
      const lagged = await publication.prepareStory(id, staged(original));
      expect(observe("prepare with former checkout after address approval", lagged.said)).toContain(
        "checkout does not use the approved project address",
      );
      expect(lagged.revision).toBeUndefined();
      expect(tasks.delivery.changePresentation(id)).toBeUndefined();
      // A former ledger left by an earlier build cannot be confirmed merely because it still matches checkout.
      tasks.delivery.updateChangePresentation(id, () => ({
        revisions: [
          {
            ...staged(original),
            taskId: id,
            revision: 1,
            destination: { kind: "branch", origin: from },
          },
        ],
        receipts: [],
      }));
      const refused = await publication.open(id, {
        title: staged(original).title,
        presentation: 1,
      });
      expect(observe("publish former plain story at the lagging checkout", refused)).toContain(
        "checkout does not use the approved project address",
      );
      expect(tasks.delivery.changePresentation(id)?.completion).toBeUndefined();
      checkoutOrigin = to;
      await prepare();
      const refuseFormer = (step: string) => {
        expect(() => {
          try {
            supervisor.cardActions.act(former, "merge");
          } catch (error) {
            observe(`${step}: former ${offerStyle} plain merge click`, (error as Error).message);
            throw error;
          }
        }).toThrow("so I did not merge");
        expect(merge).not.toHaveBeenCalled();
        expect(putIn).not.toHaveBeenCalled();
        expect(tasks.get(id)?.delivery?.mergeClick).toBeUndefined();
      };
      refuseFormer("after the move");
      repos.configure(repo.id, { origin: from });
      checkoutOrigin = from;
      await prepare();
      refuseFormer("after return to the original address");
      const fresh = show("fresh-plain-merge");
      checkoutOrigin = to;
      supervisor.cardActions.act(fresh, "merge");
      await vi.waitFor(() => expect(merge).toHaveBeenCalledTimes(1));
      const blocked = await merge.mock.results[0]?.value;
      expect(observe("merge dispatch from a lagging checkout", blocked)).toMatchObject({
        ok: false,
        text: expect.stringMatching(/destination|approved/),
      });
      expect(putIn).not.toHaveBeenCalled();
      checkoutOrigin = from;
      const valid = show("valid-plain-merge");
      supervisor.cardActions.act(valid, "merge");
      await vi.waitFor(() => expect(putIn).toHaveBeenCalledTimes(1));
      await merge.mock.results[1]?.value;
      const click = tasks.get(id)?.delivery?.mergeClick;
      expect(
        observe("fresh plain merge click", {
          cardId: click?.cardId,
          dispatches: putIn.mock.calls.length,
        }),
      ).toEqual({ cardId: valid, dispatches: 1 });
    },
  );

  it.each(["unrelated", "shared history", "absent"])(
    "confirms the pushed story after verifying the approved default ref (%s)",
    async (cached) => {
      const where = storyForge();
      const { db, tasks, repos, service, readHead, paths } = setup({
        forge: where.forge,
        realRange: true,
      });
      const home = join(paths, "home");
      const next = join(paths, "next");
      await git(paths, ["init", "-q", "-b", "main", home]);
      await git(paths, ["init", "-q", "-b", "main", next]);
      const commit = (dir: string, title: string) =>
        git(dir, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          title,
        ]);
      await commit(home, "chore: start original project");
      const oldBase = await git(home, ["rev-parse", "HEAD"]);
      if (cached !== "absent") await git(home, ["update-ref", "refs/remotes/origin/main", oldBase]);
      if (cached === "shared history") {
        await git(next, ["fetch", "-q", home, "refs/heads/main"]);
        await git(next, ["reset", "--hard", "FETCH_HEAD"]);
      }
      if (cached === "absent") {
        await git(home, ["switch", "--detach", oldBase]);
        await git(home, ["branch", "-D", "main"]);
      }
      await commit(next, "chore: start moved project");
      const base = await git(next, ["rev-parse", "HEAD"]);
      const branch = "fm/cutover-change";
      await git(next, ["switch", "-q", "-c", branch]);
      const story = staged(base);
      await commit(next, story.title);
      const head = await git(next, ["rev-parse", "HEAD"]);
      await git(home, ["fetch", "-q", next, `refs/heads/${branch}:refs/heads/${branch}`]);
      // Only a disposable URL: its user info must not be copied into a failure response.
      const credentialed = newAddress.replace("https://", "https://fixture:placeholder@");
      const missing = `url.${join(paths, "not-a-repo")}.insteadOf`;
      await git(home, ["config", missing, credentialed]);
      await git(home, ["remote", "add", "origin", formerAddress]);
      const repoId = "cutover-project";
      seedProject(db, {
        id: repoId,
        name: "cutover",
        path: home,
        origin: formerAddress,
        delivery: "queue-pr",
      });
      insertTask(tasks, { repoId, repoDir: home, branch });
      const id = "ab12cd34";
      readHead.mockResolvedValue(oldBase);
      expect(await service.publication.prepareStory(id, staged(oldBase))).toMatchObject({
        revision: 1,
      });
      repos.configure(repoId, { origin: credentialed });
      where.destination(nextDestination);
      where.pushed(head);
      readHead.mockResolvedValue(head);
      expect(await service.publication.prepareStory(id, staged(base, head))).toMatchObject({
        revision: 1,
      });
      const readCache = () =>
        git(home, ["rev-parse", "--verify", "refs/remotes/origin/main"]).catch(() => "");
      if (cached === "unrelated")
        await expect(
          git(home, ["merge-base", head, "refs/remotes/origin/main"]),
        ).rejects.toMatchObject({ code: 1 });
      if (cached === "shared history")
        expect(await git(home, ["merge-base", head, "refs/remotes/origin/main"])).toBe(oldBase);
      expect(observe(`${cached} home default before publication`, await readCache())).toBe(
        cached === "absent" ? "" : oldBase,
      );
      const open = () => service.publication.open(id, { title: story.title, presentation: 1 });
      // An approved move does not itself change the checkout's remote.
      expect(observe("publication with former checkout origin", await open())).not.toBe(
        BATCH_OPEN_WORDS.confirmed(branch),
      );
      expect(await readCache()).toBe(cached === "absent" ? "" : oldBase);
      await git(home, ["remote", "set-url", "origin", credentialed]);
      const failure = await open();
      expect(observe("failed fetch diagnostic", failure)).toContain(
        "Could not refresh the approved project's default branch from origin.",
      );
      expect(failure).not.toContain("placeholder");
      expect(failure).not.toContain("not-a-repo");
      await git(home, ["config", "--unset", missing]);
      await git(home, ["config", `url.${next}.insteadOf`, credentialed]);
      expect(observe("publication from home", await open())).toBe(
        BATCH_OPEN_WORDS.confirmed(branch),
      );
      expect(
        observe(
          "home default after publication",
          await git(home, ["rev-parse", "refs/remotes/origin/main"]),
        ),
      ).toBe(base);
      expect(tasks.delivery.changePresentation(id, branch)?.completion).toMatchObject({
        revision: 1,
        head,
      });
      // A confirmed tracking ref does not fetch again: the existing FETCH_HEAD is left intact.
      await git(home, ["fetch", "-q", next, `refs/heads/${branch}`]);
      expect(await git(home, ["rev-parse", "FETCH_HEAD"])).toBe(head);
      expect(observe("publication with matching tracking ref", await open())).toBe(
        BATCH_OPEN_WORDS.confirmed(branch),
      );
      expect(await git(home, ["rev-parse", "FETCH_HEAD"])).toBe(head);
      expect(where.forge.calls.filter((call) => call.startsWith("openChange"))).toEqual([]);
    },
  );
});
