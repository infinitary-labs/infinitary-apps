import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import {
  FakeForge,
  insertDirectPrTask,
  insertTask,
  setup,
} from "../../../tests/helpers/prCiHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  AttachmentUploadError,
  type ForgeChange,
  ForgeError,
  ForgeWriteError,
  GITLAB_PRIVATE_MEDIA_REFUSAL,
} from "../forge";
import type { MergeAuthorization } from "../storage/taskStore";
import { git } from "../workspace/git";
import { readChangeReading } from "../workspace/workspaceService";
import { reviewCoversHead } from "./reviewCarry";

// Integration budget (docs/test-cohorts.md): real git plus the product's
// own put-in backoff, the slowest test 1.3 s at its fastest measured run.
vi.setConfig({ testTimeout: 10_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

describe("ChangePublication", () => {
  it.each([
    { kind: "github", readiness: "applied", carried: false },
    { kind: "github", readiness: "not-applied", carried: false },
    { kind: "github", readiness: "manual-hold", carried: false },
    { kind: "gitlab", readiness: "applied", carried: false },
    { kind: "git", readiness: "applied", carried: false },
    { kind: "github", readiness: "applied", carried: true },
    { kind: "gitlab", readiness: "applied", carried: true },
  ] as const)(
    "INF-125 / INF-203 N1–N2: $kind prerequisite publication survives a newer head and $readiness readiness (carried code review: $carried)",
    async ({ kind, readiness, carried }) => {
      const { tasks, repos, service, forge } = setup({ forge: new FakeForge({ kind }) });
      const publication = kind === "git" ? "branch" : "draft";
      forge.change = null;
      await insertDirectPrTask(tasks, repos, {
        shape: { kind: "fix", rigor: "reviewed", rigor_ask: "reviewed" },
      });
      const task = tasks.get("ab12cd34")!;
      await git(task.repoDir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "chore: initialize validation fixture",
      ]);
      await git(task.repoDir, ["branch", task.branch!]);
      const head = await git(task.repoDir, ["rev-parse", task.branch!]);
      forge.opened =
        kind === "git" ? { headSha: head, url: null } : { ...forge.opened, headSha: head };
      seedDelivery(tasks, task.id, { reviewVerdict: "pass", reviewSha: head });
      const input = {
        title: "fix: validate the isolated fixture",
        body: "The branch has no running product.",
      };
      // Since INF-1876 the host holds no pull request on live proof: whether
      // to open one before the proof is the care guidance's. The prerequisite
      // publication below is still the way a draft opens for the proof.
      expect(forge.drafts).toEqual([]);
      const scenario = {
        id: "draft",
        source: `Validate the isolated environment obtained by a ${publication}.`,
        importance: "required" as const,
        action: `Publish the prerequisite ${publication}`,
        expected: "The isolated validation environment becomes available.",
        adverse: "A lost response is not sent twice.",
        environment: "Disposable project",
        signal: `The host confirms the ${publication}.`,
        boundary: "Actual forge publication",
      };
      tasks.delivery.recordLiveValidation(
        task.id,
        {
          kind: "plan",
          previousRevision: 0,
          reason: `This scenario needs an approved ${publication}.`,
          scenarios: [scenario],
        },
        { head },
      );
      tasks.delivery.recordLiveValidation(
        task.id,
        {
          kind: "request",
          request: {
            kind: "effect",
            id: "draft-once",
            head,
            scenario: scenario.id,
            action: scenario.action,
            destination: "Disposable project",
            audience: "Project collaborators",
            visibility: "others",
            persistent: true,
            purpose: "Obtain the isolated environment",
            lastingEffects: `One ${publication} and its history`,
            cleanup: `Remove the ${publication}; history remains`,
            access: "Disposable account",
            preChange: false,
            prerequisitePublication: true,
            publication: { repoId: task.repoId!, branch: task.branch! },
          },
        },
        { head },
      );
      tasks.delivery.recordLiveValidation(
        task.id,
        {
          kind: "review",
          head,
          revision: 0,
          code: "clear",
          coverage: "complete",
          coverageReason: "The requested publication is the necessary boundary.",
          effects: ["draft-once"],
          omitted: [],
          verdict: "inconclusive",
          reason: "Code cleared; the live environment is still unavailable.",
        },
        {
          head,
          reviewer: "reviewer",
          assignment: { head, revision: 0, scenarioRevision: 1, effects: ["draft-once"] },
        },
      );
      tasks.delivery.recordLiveValidation(
        task.id,
        { kind: "decision", request: "draft-once", card: "approve-draft", action: "approve" },
        { head, decision: { offer: "shown" } },
      );
      tasks.delivery.decideLiveValidation(task.id, {
        card: "approve-draft",
        offer: "shown",
        action: "approve",
        label: `Approve the ${publication}`,
        head,
      });
      forge.fail.openChange = new Error("The connection ended before the host's answer.");
      expect(await service.publication.open(task.id, input)).toContain("connection ended");
      expect(forge.drafts).toEqual([kind !== "git"]);
      const uncertain = tasks.get(task.id)?.delivery?.liveValidation?.permissions ?? [];
      expect(uncertain[0]?.state).toBe("unknown");
      // Even complete final proof cannot convert that unknown attempt into permission to repeat it.
      const proof = noSurfaceProof(head);
      seedDelivery(tasks, task.id, {
        reviewVerdict: "blocked",
        liveValidation: { ...proof, permissions: uncertain },
      });
      delete forge.fail.openChange;
      expect(await service.publication.open(task.id, input)).toContain("unknown outcome");
      expect(forge.drafts).toEqual([kind !== "git"]);
      forge.change = {
        ...forge.opened,
        branch: task.branch!,
        draft: kind !== "git",
        title: kind === "gitlab" ? `Draft: ${input.title}` : input.title,
      };
      expect(await service.publication.open(task.id, input)).toContain("already open");
      expect(forge.drafts).toEqual([kind !== "git"]);
      expect(tasks.get(task.id)?.delivery?.liveValidation?.permissions[0]?.state).toBe("succeeded");
      expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(0);
      // N1: publication authority identifies the draft, not every later commit on its branch.
      await git(task.repoDir, ["checkout", task.branch!]);
      await git(task.repoDir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "fix: update the prerequisite candidate",
      ]);
      const currentHead = await git(task.repoDir, ["rev-parse", task.branch!]);
      expect(currentHead).not.toBe(head);
      forge.change = { ...forge.change!, headSha: currentHead };
      seedDelivery(tasks, task.id, { reviewVerdict: "pass", reviewSha: head });
      expect(await service.checks.readWatched(task.id)).toMatchObject({
        kind: "finished",
        head: currentHead,
      });
      expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(0);
      seedDelivery(tasks, task.id, { reviewSha: currentHead });
      expect(await service.checks.readWatched(task.id)).toMatchObject({
        kind: "finished",
        head: currentHead,
      });
      expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(0);
      const published = tasks.get(task.id)!.delivery!.liveValidation!.permissions;
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ state: "succeeded", request: { head } });
      seedDelivery(tasks, task.id, {
        liveValidation: { ...noSurfaceProof(currentHead), permissions: published },
      });
      if (carried) {
        // INF-148's code clearance carries across this actual empty commit;
        // INF-125 still requires the new version's proof and its own judgment.
        const reading = await readChangeReading(task.repoDir, head);
        const currentReading = await readChangeReading(task.repoDir, currentHead);
        if (!reading || currentReading !== reading)
          throw new Error("The fixture's unchanged patch must have the same real change reading.");
        seedDelivery(tasks, task.id, {
          reviewSha: head,
          reviewChange: reading,
          versionReadings: { [currentHead]: currentReading },
        });
      }
      if (kind !== "git") {
        const markReady = forge.markReady.bind(forge);
        forge.markReady = async (change, beforeSend) => {
          seedDelivery(tasks, task.id, { reviewVerdict: "blocked" });
          return markReady(change, beforeSend);
        };
        expect(await service.checkTool.checkForCrew(task.id)).toContain("Validation changed");
        expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(0);
        expect(tasks.get(task.id)?.delivery?.validationReadiness?.state).toBe("not-applied");
        forge.markReady = markReady;
        seedDelivery(tasks, task.id, {
          reviewVerdict: "pass",
          reviewSha: carried ? head : currentHead,
        });
      }
      if (kind === "gitlab") {
        // A watch still reads checks while another readiness request is in flight.
        const markReady = forge.markReady.bind(forge);
        let start!: () => void;
        let finish!: () => void;
        const started = new Promise<void>((resolve) => {
          start = resolve;
        });
        const release = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const pendingReady = vi.fn(async (change: ForgeChange, beforeSend: () => void) => {
          beforeSend();
          start();
          await release;
          return markReady(change, () => {});
        });
        forge.markReady = pendingReady;
        const active = service.checkTool.checkForCrew(task.id);
        await started;
        try {
          expect(await service.checks.readWatched(task.id)).toMatchObject({
            kind: "finished",
          });
          expect(pendingReady).toHaveBeenCalledTimes(1);
        } finally {
          finish();
          await active;
          forge.markReady = markReady;
        }
      }
      if (kind === "github") {
        forge.failReady = new Error("Readiness response lost");
        const reading = await service.checkTool.checkForCrew(task.id);
        expect(reading).toContain("Readiness response lost");
        expect(reading).toContain("facts: ");
        expect(reading).not.toContain("crew verdict:");
        expect(tasks.get(task.id)?.delivery?.validationReadiness?.state).toBe("unknown");
        if (readiness === "not-applied") {
          // N2: failed readiness never wedges any of the three ordinary entry points.
          expect(await service.checks.readWatched(task.id)).toMatchObject({
            kind: "finished",
          });
          const reopened = await service.publication.open(task.id, input);
          expect(reopened).toContain("already open");
          expect(reopened).toContain("Readiness response lost");
          expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(3);
          expect(tasks.timeline(task.id)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                data: expect.objectContaining({
                  validationReadiness: expect.objectContaining({ state: "not-applied" }),
                }),
              }),
            ]),
          );
          // Only the later still-draft reading permits another idempotent readiness request.
        } else {
          // A later ready reading reconciles success without another write.
          forge.change = { ...forge.change!, draft: false };
        }
        forge.failReady = undefined;
      }
      await service.checkTool.checkForCrew(task.id);
      expect(service.checks.reading(task.id)?.overall).toBe("green");
      expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(
        kind === "git" ? 0 : readiness === "not-applied" ? 4 : 1,
      );
      if (kind !== "git")
        expect(tasks.get(task.id)?.delivery?.validationReadiness).toMatchObject({
          head: currentHead,
          state: "ready",
        });
      expect(forge.change?.draft).toBe(false);
      if (readiness === "manual-hold") {
        // INF-203 P2: the captain chose to preserve a person's restored draft at this head.
        forge.change = { ...forge.change!, draft: true };
        expect(await service.checks.readWatched(task.id)).toMatchObject({
          kind: "finished",
        });
        await service.checkTool.checkForCrew(task.id);
        expect(service.checks.reading(task.id)?.overall).toBe("green");
        expect(await service.publication.open(task.id, input)).toContain("already open");
        expect(forge.change.draft).toBe(true);
        expect(forge.calls.filter((call) => call.startsWith("markReady"))).toEqual([
          `markReady ${currentHead}`,
        ]);
        expect(tasks.get(task.id)?.delivery?.validationReadiness).toMatchObject({
          head: currentHead,
          number: forge.change.number,
          state: "ready",
        });
        // N1 still permits a newer commit, but not on the older commit's proof or review.
        await git(task.repoDir, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "commit",
          "--allow-empty",
          "-m",
          "fix: revise the held candidate",
        ]);
        const nextHead = await git(task.repoDir, ["rev-parse", task.branch!]);
        expect(nextHead).not.toBe(currentHead);
        forge.change = { ...forge.change, headSha: nextHead };
        await service.checkTool.checkForCrew(task.id);
        expect(service.checks.reading(task.id)?.overall).toBe("green");
        expect(forge.change.draft).toBe(true);
        expect(forge.calls.filter((call) => call.startsWith("markReady"))).toHaveLength(1);
        seedDelivery(tasks, task.id, {
          reviewSha: nextHead,
          liveValidation: { ...noSurfaceProof(nextHead), permissions: published },
        });
        await service.checkTool.checkForCrew(task.id);
        expect(service.checks.reading(task.id)?.overall).toBe("green");
        expect(forge.change.draft).toBe(false);
        expect(forge.calls.filter((call) => call.startsWith("markReady"))).toEqual([
          `markReady ${currentHead}`,
          `markReady ${nextHead}`,
        ]);
        console.log(
          "INF-203 P2 restored draft",
          JSON.stringify({ heldHead: currentHead, nextHead, calls: forge.calls }),
        );
      }
      expect((await service.merges.merge(task.id)).ok).toBe(true);
      expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(true);
      console.log(
        "INF-203 prerequisite through merge",
        JSON.stringify({ kind, readiness, publishedHead: head, currentHead, calls: forge.calls }),
      );
    },
  );

  // INF-2184, folded into INF-2490 (the captain's q7): the captain asked to
  // open the change from a branch someone already pushed. It opens from that
  // branch as it is, never moving its head, and becomes the task's current
  // change beside its own; check_change names either by its id.
  it("opens a change from an existing branch the crewmate names, at that branch's head, as the task's current change (INF-2184, INF-2490)", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    repos.configure(tasks.get("ab12cd34")!.repoId!, { origin: "https://github.com/x/y.git" });
    expect(
      await service.publication.open("ab12cd34", { title: "fix: ship it", body: "b" }),
    ).toContain("Opened pull request #42");
    const ownChange = forge.change;
    const release = "release-please--branches--main";
    forge.change = null;
    forge.opened = {
      number: 57,
      url: "https://github.com/x/y/pull/57",
      headSha: "beef0057",
      title: "chore(main): release 0.1.8",
    };
    const opened = await service.publication.open("ab12cd34", {
      title: "chore(main): release 0.1.8",
      body: "The release the captain asked to open.",
      branch: release,
    });
    expect(opened).toContain(
      `Opened pull request #57 https://github.com/x/y/pull/57 for ${release}.`,
    );
    // The one write where the project lives is the opening itself, on the named branch.
    expect(forge.calls.filter((call) => call.startsWith("openChange"))).toEqual([
      "openChange fm/task-ab12cd34 fix: ship it",
      `openChange ${release} chore(main): release 0.1.8`,
    ]);
    expect(tasks.get("ab12cd34")?.delivery?.checkTarget).toMatchObject({
      number: 57,
      branch: release,
      headSha: "beef0057",
    });
    expect(
      tasks
        .changesFor("ab12cd34")
        .map((change) => change.handle?.number)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([42, 57]);
    // Naming the task's own change by its id makes it current again.
    forge.change = ownChange;
    const own = tasks.changeFor("ab12cd34");
    expect(own?.handle?.number).toBe(42);
    expect(await service.checkTool.checkForCrew("ab12cd34", { change: own?.id })).toContain(
      "facts: ",
    );
    expect(tasks.get("ab12cd34")?.delivery?.checkTarget).toBeUndefined();
  });

  // INF-2510, the captain's INF-1868 answer 2: a change may open in any
  // project the app manages, "for example dotfiles-private while working on
  // INF". It opens there from the branch pushed there, becomes the task's
  // current change, and every read and the merge go to that project's host.
  it("opens, reads and merges a change in another project the app manages through that project's host (INF-2510)", async () => {
    const own = new FakeForge();
    const dotfiles = new FakeForge();
    const { tasks, repos, service } = setup({
      forge: own,
      forgeFor: (repo) => (repo?.origin?.includes("octo/dotfiles") ? dotfiles : own),
    });
    await insertDirectPrTask(tasks, repos);
    const taskRepo = tasks.get("ab12cd34")!.repoId!;
    repos.configure(taskRepo, { origin: "https://github.com/x/y.git" });
    const { repo: other } = await repos.setup({ kind: "init", name: "dotfiles-private" });
    repos.configure(other.id, { origin: "https://github.com/octo/dotfiles.git" });
    dotfiles.change = null;
    dotfiles.opened = {
      number: 7,
      url: "https://github.com/octo/dotfiles/pull/7",
      headSha: "d07f11e5",
      title: "fix: keep the shell aliases",
    };
    const branch = "fm/dotfiles-aliases";
    Object.assign(dotfiles, {
      pull: async (number: number) => ({
        number,
        state: "open",
        merged: false,
        headSha: "d07f11e5",
        base: "main",
        branch,
        headRepo: "octo/dotfiles",
        title: "fix: keep the shell aliases",
        readiness: "clean",
      }),
    });

    const opened = await service.publication.open("ab12cd34", {
      title: "fix: keep the shell aliases",
      body: "The aliases the captain asked for.",
      repository: "octo/dotfiles",
      branch,
    });
    expect(opened).toContain(
      `Opened pull request #7 https://github.com/octo/dotfiles/pull/7 in dotfiles-private for ${branch}.`,
    );
    expect(dotfiles.calls).toContain(`openChange ${branch} fix: keep the shell aliases`);
    expect(own.calls.filter((call) => call.startsWith("openChange"))).toEqual([]);
    expect(tasks.get("ab12cd34")?.delivery?.checkTarget).toMatchObject({
      repoId: other.id,
      owner: "octo",
      name: "dotfiles",
      number: 7,
      branch,
    });
    const change = tasks.changesFor("ab12cd34").find((item) => item.handle?.number === 7);
    expect(change).toMatchObject({ repoId: other.id, head: { branch } });

    // Its checks are read where it lives.
    own.calls.length = 0;
    const reading = await service.checkTool.checkForCrew("ab12cd34");
    expect(reading).toContain(
      "pull request #7 https://github.com/octo/dotfiles/pull/7 head d07f11e5",
    );
    expect(dotfiles.calls).toContain("checks d07f11e5");
    expect(own.calls).toEqual([]);
    expect(service.checks.reading("ab12cd34")?.overall).toBe("green");
    expect(await service.merges.pullState("ab12cd34", 7)).toMatchObject({
      headRepo: "octo/dotfiles",
    });

    // check_change pull of that number reviews it in that project.
    expect(await service.checkTool.checkForCrew("ab12cd34", { pull: 7 })).toContain(
      "Merge review mr",
    );
    expect(tasks.get("ab12cd34")?.delivery?.mergeReviews?.[0]).toMatchObject({
      repoId: other.id,
      owner: "octo",
      name: "dotfiles",
      number: 7,
    });

    // The completion card's merge goes there; discarding the task closes
    // only its own change.
    expect((await service.merges.merge("ab12cd34")).ok).toBe(true);
    expect(dotfiles.calls).toContain(`putIn ${branch} d07f11e5`);
    expect(own.calls.filter((call) => call.startsWith("putIn"))).toEqual([]);
    await service.merges.close("ab12cd34");
    expect(dotfiles.calls.filter((call) => call.startsWith("close"))).toEqual([]);
  });

  it("opens a change in another project only from a branch of its own pushed there, with a description rather than a saved story (INF-2510)", async () => {
    const own = new FakeForge();
    const plain = new FakeForge({ kind: "git", place: null });
    const dotfiles = new FakeForge();
    const { tasks, repos, service } = setup({
      forge: own,
      forgeFor: (repo) =>
        repo?.origin?.includes("octo/dotfiles")
          ? dotfiles
          : repo?.origin?.includes("git.example.com")
            ? plain
            : own,
    });
    await insertDirectPrTask(tasks, repos);
    const { repo: other } = await repos.setup({ kind: "init", name: "dotfiles-private" });
    repos.configure(other.id, { origin: "https://github.com/octo/dotfiles.git" });
    const { repo: kept } = await repos.setup({ kind: "init", name: "notes" });
    repos.configure(kept.id, { origin: "ssh://git.example.com/notes.git" });
    const ask = { title: "fix: keep the shell aliases", body: "b", repository: "dotfiles-private" };
    expect(await service.publication.open("ab12cd34", ask)).toBe(
      "Name the branch you pushed to dotfiles-private with branch: a change in another project opens from its own pushed branch.",
    );
    expect(await service.publication.open("ab12cd34", { ...ask, branch: "fm/task-ab12cd34" })).toBe(
      "Cannot open the change in dotfiles-private from fm/task-ab12cd34: that name is this task's own branch. Push the work there under another branch name, then name it with branch.",
    );
    expect(
      await service.publication.open("ab12cd34", {
        title: ask.title,
        repository: ask.repository,
        branch: "fm/aliases",
        presentation: 1,
      }),
    ).toBe(
      "A change in another project carries no saved story: pass body as its description, without presentation, around or recovery.",
    );
    expect(
      await service.publication.open("ab12cd34", {
        ...ask,
        repository: "notes",
        branch: "fm/notes",
      }),
    ).toContain("Cannot open the change in notes:");
    expect([...own.calls, ...dotfiles.calls, ...plain.calls]).toEqual([]);
  });
});

describe("the commit-name check measures only the branch's own commits", () => {
  it("ignores merged commits a stale local main lacks, and merge commits that take in newer work", async () => {
    // FI3-755: the Mac's main sat behind the fetched origin/main, so commits
    // already merged where the project lives were judged as the branch's own.
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge, realRange: true });
    await insertDirectPrTask(tasks, repos);
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const commit = (file: string, subject: string) => {
      writeFileSync(join(dir, file), `${subject}\n`);
      run("add", file);
      run("commit", "-m", subject);
      return run("rev-parse", "HEAD");
    };
    const stale = run("rev-parse", "main");
    commit("digest.ts", "ESP-5497: Migrate the Linear daily digest to Soapbox (#3097)");
    // A fetch moves origin/main; the local main stays where it was.
    run("update-ref", "refs/remotes/origin/main", "HEAD");
    run("reset", "--hard", stale);
    run("checkout", "-b", "fm/task-ab12cd34", "origin/main");
    commit("ask.ts", "feat: highlight and ask");

    expect(
      await service.publication.open("ab12cd34", { title: "feat: highlight and ask", body: "b" }),
    ).toContain("Opened pull request #42");

    // Taking newer main in with a merge commit is not a commit to name.
    run("checkout", "--detach", "origin/main");
    run("update-ref", "refs/remotes/origin/main", commit("other.ts", "docs: newer main"));
    run("checkout", "fm/task-ab12cd34");
    run("merge", "--no-ff", "origin/main", "-m", "Merge branch 'main' into fm/task-ab12cd34");
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: run("rev-parse", "HEAD"),
    };
    await service.checks.checkOverall("ab12cd34");
    const merged = await service.merges.merge("ab12cd34");
    expect(merged).toMatchObject({ ok: true });

    // The branch's own badly named commit is still refused.
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: commit("wip.ts", "wip"),
    };
    await service.checks.checkOverall("ab12cd34");
    const refused = await service.merges.merge("ab12cd34");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('Received: "wip"');
  });
});

/**
 * The crewmate's pair where the project lives and the app's own sign-in
 * (git integration PR 1.2): open_change offers the branch as a proposed
 * change and records it; check_change reads the same checks check_pr_ci
 * does, in the crewmate's words; a missing sign-in is a typed fact every
 * caller turns into its own words, never a raw 401.
 */
describe("the change delivery and the sign-in where the project lives", () => {
  const notSignedIn = () => new ForgeError("sign-in", "Not signed in to GitHub (github.com)");

  it("refuses a renamed plain GitHub title at put-in after successful checks", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    forge.change = { ...(forge.change as ForgeChange), title: "Plain renamed title" };
    const result = await service.merges.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("conventional name");
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("refuses a plain proposed title before opening it", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    expect(
      await service.publication.open("ab12cd34", { title: "Fix it", body: "## Intent" }),
    ).toContain("conventional name");
    expect(forge.calls).not.toContain("openChange fm/task-ab12cd34 Fix it");
  });

  // INF-290 F4: an evidence upload refusal is answered in its own words; the branch is pushed.
  it.each([
    new AttachmentUploadError("failed", "refused", GITLAB_PRIVATE_MEDIA_REFUSAL),
    new AttachmentUploadError(
      "uncertain",
      "refused",
      "GitLab may have kept the attachment, but no confirmed receipt returned.",
    ),
  ])("answers an evidence upload that stopped with its own words: $outcome", async (error) => {
    const forge = new FakeForge({ kind: "gitlab", place: "GitLab" });
    forge.change = null;
    Object.assign(forge, {
      attachments: {
        destination: async () => {
          throw new Error("No destination read expected");
        },
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
    });
    const { tasks, repos, service, presentations } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    vi.spyOn(presentations, "publish").mockRejectedValue(error);
    const text = await service.publication.open("ab12cd34", {
      title: "fix: carry the evidence",
      presentation: 1,
    });
    expect(text).toBe(error.message);
  });

  // INF-290 G1: an upload the host refused for permission still asks for write access as a blocker.
  it("keeps the write-access note and blocker words for an evidence upload refused for permission", async () => {
    const forge = new FakeForge({ kind: "gitlab", place: "GitLab" });
    forge.change = null;
    Object.assign(forge, {
      attachments: {
        destination: async () => {
          throw new Error("No destination read expected");
        },
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
    });
    const onNote = vi.fn();
    const { tasks, repos, service, presentations } = setup({ forge, onNote });
    await insertDirectPrTask(tasks, repos);
    const refused = new AttachmentUploadError(
      "failed",
      "permission",
      "GitLab refused the evidence upload (403). No merge request was opened; there is no fallback.",
    );
    vi.spyOn(presentations, "publish").mockRejectedValue(refused);
    const text = await service.publication.open("ab12cd34", {
      title: "fix: carry the evidence",
      presentation: 1,
    });
    expect(text).toBe(
      `GitLab did not allow opening the change: ${refused.message}. Report this as a blocker: the captain needs write access to the project there.`,
    );
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(String(onNote.mock.calls[0]?.[0])).toContain("ask its owner for write access");
  });

  it("opens the branch as a proposed change and records it once", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const text = await service.publication.open("ab12cd34", {
      title: "fix: correct it",
      body: "## Intent",
    });
    expect(text).toBe(
      "Opened pull request #42 https://github.com/x/y/pull/42 for fm/task-ab12cd34. Read its checks with check_change. If the rest of your work needs this merged first, list it in the story's afterMerge and end this task with the completion decision after the checks pass.",
    );
    expect(forge.calls).toEqual([
      "changeFor fm/task-ab12cd34",
      "openChange fm/task-ab12cd34 fix: correct it",
    ]);
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      changeLabel: "#42",
      prNumber: 42,
      prUrl: "https://github.com/x/y/pull/42",
    });
    const events = tasks.timeline("ab12cd34").filter((event) => event.kind === "pr_opened");
    expect(events).toHaveLength(1);
  });

  it("answers a change already open for the branch rather than opening a second", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    const text = await service.publication.open("ab12cd34", {
      title: "fix: correct it",
      body: "b",
    });
    expect(text).toContain("A pull request for fm/task-ab12cd34 is already open: pull request #23");
    expect(text).toContain("list it in the story's afterMerge");
    expect(forge.calls).not.toContain("openChange fm/task-ab12cd34 fix: correct it");
  });

  /**
   * INF-291, from INF-87's PR #39: a corrected body passed to open_change on a
   * pull request opened before saved stories was answered "already open"
   * while GitHub kept the stale description. A body now replaces such a
   * description, and the answer says what the host shows when read back.
   */
  describe("a body on a pull request that is open without a saved story (INF-291)", () => {
    const STALE = "## Verified\nCurrent head: `46e20da`.";
    const CORRECTED = "## Verified\nCurrent head: `4c771ba`; approved pieces start Queued.";

    it("replaces the description, reads it back, and answers what GitHub shows", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      const replaced = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        body: CORRECTED,
      });
      expect(replaced).toContain(
        `Replaced its description: GitHub now shows the ${CORRECTED.length}-character body you passed, at version feedbee.`,
      );
      expect(replaced).toContain("Read its checks with check_change.");
      expect(forge.change?.body).toBe(CORRECTED);
      // One write, made only after reading the change, and read back before answering.
      expect(forge.calls).toEqual([
        "changeFor fm/task-ab12cd34",
        "updateChangeBody #23",
        "changeFor fm/task-ab12cd34",
      ]);

      // Asking again with the same words sends nothing more.
      const again = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        body: CORRECTED,
      });
      expect(again).toContain("GitHub already shows this description; nothing was sent.");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toHaveLength(1);
    });

    it("refuses to keep a story that is not there when around is passed (INF-497)", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      const text = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        around: { from: STALE, to: CORRECTED },
      });
      expect(text).toContain("does not carry a saved story");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toEqual([]);
      expect(forge.change?.body).toBe(STALE);
    });

    it("leaves the description unchanged without a body, and says so", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      const text = await service.publication.open("ab12cd34", { title: "fix: ship it" });
      expect(text).toContain("Its description is unchanged; pass body to replace it.");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toEqual([]);
      expect(forge.change?.body).toBe(STALE);
    });

    it("says the title stays, since open_change never renames one", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      const text = await service.publication.open("ab12cd34", {
        title: "fix: a new name",
        body: CORRECTED,
      });
      expect(text).toContain('Its title stays "fix: ship it".');
      expect(forge.change?.title).toBe("fix: ship it");
    });

    it("never claims words the host does not show after the write", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      forge.heldAfterWrite = `${CORRECTED}\n\nA person's words.`;
      const text = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        body: CORRECTED,
      });
      expect(text).toContain("Sent the new description, but GitHub shows different words");
      expect(text).toContain("Read it with github_read before calling open_change again.");
      expect(text).not.toContain("Replaced its description");
    });

    it("says a refused replacement was not made, without sending the crewmate to push", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.fail.updateChangeBody = new ForgeWriteError(
        "failed",
        "refused",
        "The pull request changed after it was read, so its description was not replaced. Read it again before updating.",
      );
      const text = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        body: CORRECTED,
      });
      expect(text).toContain(
        "Its description was not replaced: The pull request changed after it was read",
      );
      expect(text).not.toContain("Push your branch first");
    });

    it("says an uncertain write may or may not have replaced it, and is not resent", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.fail.updateChangeBody = new ForgeWriteError(
        "uncertain",
        "transient",
        "GitHub answered 502 when replacing the description; read it back before any retry.",
      );
      const text = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        body: CORRECTED,
      });
      expect(text).toContain(
        "Its description may or may not have been replaced: GitHub answered 502",
      );
      expect(text).toContain("Read it with github_read before calling open_change again.");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toHaveLength(1);
    });

    it("says a plain Git host keeps no description for the pushed branch", async () => {
      const forge = new FakeForge({ kind: "git", place: "git.example.com" });
      forge.change = { url: null, branch: "fm/task-ab12cd34", headSha: "feedbeef" };
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const text = await service.publication.open("ab12cd34", {
        title: "fix: ship it",
        body: CORRECTED,
      });
      expect(text).toContain(
        "git.example.com keeps no description for a pushed branch, so body was not published.",
      );
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toEqual([]);
    });
  });

  it("tells the crewmate a missing sign-in is the captain's blocker, never its own", async () => {
    const forge = new FakeForge();
    forge.fail.changeFor = notSignedIn();
    forge.failChangeForTimes = 2;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    for (const text of [
      await service.publication.open("ab12cd34", { title: "fix: correct title", body: "b" }),
      await service.checkTool.checkForCrew("ab12cd34"),
    ]) {
      expect(text).toBe(
        "Not signed in to GitHub (github.com). Report this as a blocker: the captain signs in to GitHub in the app's Settings. Do not sign in yourself, and do not look for another way in.",
      );
    }
  });

  it("carries the sign-in fact on a refused put-in, for the settle's refusal", async () => {
    const forge = new FakeForge();
    forge.fail.putIn = new ForgeError(
      "sign-in",
      "GitHub answered 401 to PUT /repos/x/y/pulls/23/merge",
    );
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const outcome = await service.merges.merge("ab12cd34");
    expect(outcome.ok).toBe(false);
    expect(outcome.signIn).toEqual({
      host: "github.com",
      name: "GitHub",
      repoId: tasks.get("ab12cd34")?.repoId,
    });
  });

  it("says in the feed that the host refused the change, and asks for write access", async () => {
    const forge = new FakeForge();
    forge.change = null;
    forge.fail.openChange = new ForgeError(
      "permission",
      "GitHub answered 403 to POST /repos/x/y/pulls",
    );
    const notes: string[] = [];
    const { tasks, repos, service } = setup({ forge, onNote: (text) => notes.push(text) });
    await insertDirectPrTask(tasks, repos);
    const text = await service.publication.open("ab12cd34", {
      title: "fix: correct title",
      body: "b",
    });
    expect(text).toContain("Report this as a blocker");
    expect(notes).toEqual([
      "GitHub did not allow the change on pr-ab12cd34 - ask its owner for write access.",
    ]);
  });

  it("opens nothing for a task whose work goes straight into the project", async () => {
    const { tasks, repos, service, forge } = setup();
    const { repo } = await repos.setup({ kind: "init", name: "kept-here" });
    insertTask(tasks, { repoId: repo.id, repoDir: repo.path });
    const text = await service.publication.open("ab12cd34", {
      title: "fix: correct title",
      body: "b",
    });
    expect(text).toContain("its work merges locally");
    expect(forge.calls).toEqual([]);
  });
});

/**
 * INF-148, the captain's words: a passed review should not start over only
 * because main moved. The three gates read a typed carry; these cover
 * open_change and the merge that runs before its boundary.
 */
describe("a passed review covers the same change", () => {
  it("opens at the exact reviewed head without reading git", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    repos.configure(tasks.get("ab12cd34")?.repoId as string, { rigor: "reviewed" });
    seedDelivery(tasks, "ab12cd34", {
      reviewVerdict: "pass",
      reviewSha: "feedbeef",
      liveValidation: noSurfaceProof("feedbeef"),
    });
    const opened = await service.publication.open("ab12cd34", {
      title: "fix: ship it",
      body: "Why",
    });
    expect(opened).toContain("already open");
    expect(opened).not.toContain("needs an independent review");
  });

  it("opens a different head the app cannot read, carrying no review to it (INF-1876)", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    repos.configure(tasks.get("ab12cd34")?.repoId as string, { rigor: "reviewed" });
    seedDelivery(tasks, "ab12cd34", { reviewVerdict: "pass", reviewSha: "older" });
    // The host holds no pull request on a review; the care guidance does.
    const opened = await service.publication.open("ab12cd34", {
      title: "fix: ship it",
      body: "Why",
    });
    expect(opened).not.toContain("needs an independent review");
    expect(tasks.get("ab12cd34")?.delivery?.reviewCarrySha).toBeUndefined();
  });

  it("opens and merges a pure update, and refuses an edited line", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge, realRange: true });
    await insertDirectPrTask(tasks, repos);
    const repoId = tasks.get("ab12cd34")?.repoId as string;
    repos.configure(repoId, { rigor: "reviewed" });
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const commit = (file: string, body: string, subject: string) => {
      writeFileSync(join(dir, file), body);
      run("add", file);
      run("commit", "-m", subject);
      return run("rev-parse", "HEAD");
    };
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const base = `${lines.join("\n")}\n`;
    commit("a.txt", base, "chore: base lines");
    run("checkout", "-b", "fm/task-ab12cd34");
    const reviewed = commit(
      "a.txt",
      `${lines.map((line) => (line === "line 20" ? "line 20 changed" : line)).join("\n")}\n`,
      "feat: change line 20",
    );
    const reading = await readChangeReading(dir, reviewed);
    if (!reading) throw new Error("the reviewed commit has no change reading");
    seedDelivery(tasks, "ab12cd34", {
      reviewVerdict: "pass",
      reviewSha: reviewed,
      reviewChange: reading,
    });
    run("checkout", "main");
    commit("a.txt", base.replace("line 1\n", "line 1 main\n"), "chore: main edits a nearby line");
    run("checkout", "fm/task-ab12cd34");
    run("rebase", "main");
    const updated = run("rev-parse", "HEAD");
    // INF-125: proof still names this version; the code-review assertion below
    // independently proves that an unchanged patch keeps its earlier review.
    seedDelivery(tasks, "ab12cd34", {
      liveValidation: noSurfaceProof(
        updated,
        "fixture-reviewer",
        "This fixture changes only the lines of a plain text file.",
      ),
    });
    expect(
      await service.publication.open("ab12cd34", { title: "feat: change line 20", body: "Why" }),
    ).toContain("Opened pull request #42");
    const openedDelivery = tasks.get("ab12cd34")?.delivery;
    expect(openedDelivery?.reviewSha).toBe(reviewed);
    expect(openedDelivery?.reviewCarrySha).toBeUndefined();
    expect(openedDelivery?.versionReadings?.[updated]).toBe(reading);
    expect(reviewCoversHead(openedDelivery, updated)).toBe(true);
    expect(tasks.timeline("ab12cd34").some((event) => event.text.includes("the same change"))).toBe(
      true,
    );

    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: updated,
      title: "feat: change line 20",
    };
    const merged = await service.merges.merge("ab12cd34", undefined, {
      unattended: false,
      beforeDispatch: (head) => {
        expect(reviewCoversHead(tasks.get("ab12cd34")?.delivery, head)).toBe(true);
        expect(tasks.get("ab12cd34")?.delivery?.reviewCarrySha).toBeUndefined();
        return undefined;
      },
    });
    expect(merged.ok).toBe(true);

    const edited = commit(
      "a.txt",
      base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "  line 20 changed\n"),
      "fix: indent the changed line",
    );
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: edited,
      title: "feat: change line 20",
    };
    seedDelivery(tasks, "ab12cd34", {
      liveValidation: noSurfaceProof(
        edited,
        "fixture-reviewer",
        "The edited fixture still contains only a plain text file, not a running product.",
      ),
    });
    const refused = await service.merges.merge("ab12cd34", undefined, {
      unattended: false,
      beforeDispatch: () => {
        expect(reviewCoversHead(tasks.get("ab12cd34")?.delivery, edited)).toBe(false);
        expect(tasks.get("ab12cd34")?.delivery?.reviewCarrySha).toBeUndefined();
        return "the current version needs an independent review";
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("needs an independent review");
    expect(forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
  });

  // INF-493: a version that moved past the approved one may be any repair,
  // such as a reworded commit title, so only a conflict asks for an update.
  it("asks for an update only when the kept merge waits on a conflict, and for the repair's declaration on a moved version", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    const authorization: MergeAuthorization = {
      version: 1,
      id: "auth-1",
      generation: 1,
      issuer: "captain",
      at: 1,
      card: { id: "card-1", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: tasks.get("ab12cd34")?.repoId as string,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-ab12cd34",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: "feedbeef",
      lineage: [],
      proceedWithOpen: false,
      status: "standing",
    };
    const reading = async (on?: "checks" | "conflict" | "repair") => {
      seedDelivery(tasks, "ab12cd34", {
        mergeAuthorization: {
          ...authorization,
          ...(on ? { waiting: { on, head: "feedbeef", at: 1 } } : { waiting: undefined }),
        },
      });
      return service.checkTool.checkForCrew("ab12cd34");
    };
    expect(await reading("checks")).not.toContain("Declare a repair");
    expect(await reading()).not.toContain("Declare a repair");
    expect(await reading("conflict")).toContain(
      "Declare a repair that brings the change up to date with conflictRepair from that head.",
    );
    const moved = await reading("repair");
    expect(moved).toContain("Declare the repair with conflictRepair from that head.");
    expect(moved).not.toContain("brings the change up to date");
  });
});
