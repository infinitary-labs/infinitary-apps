import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChangePresentationDraft } from "@shared/changePresentation";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it, vi } from "vitest";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import {
  adoptHere,
  api,
  commit,
  computerAccount,
  feed,
  gitProject,
  listed,
  MODEL,
  model,
  PROVIDER,
  placedWorldHooks,
  type Step,
  said,
  world,
} from "../../../tests/helpers/placedWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { pathsOf } from "../folderMove/due";
import { rewriteDatabases } from "../folderMove/rewrite";
import { PlacedTasks } from "../helper/placedTasks";
import { crewmateCardPicturesDir } from "../paths";
import { git } from "../workspace/git";
import { ProjectChanges } from "../workspace/projectChanges";
import { checkedOutRefFor, keptRefFor, WorkspaceService } from "../workspace/workspaceService";
import { NO_PLACED_TASK } from "./placedWork";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * its working copy there, its change and branch, moves, and the project's folder moving here.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

/**
 * The home's one-time move into Infinitary's folder (docs/saved-data-compatibility.md,
 * "The one-time move"), for a project's folder: with the home stopped, the
 * folder is copied to a new one, the older one staying as it was, and the
 * move's own rewrite re-points the home's records, including a task held on
 * another computer. Answers the new folder.
 */
async function moveProjectFolder(
  at: Awaited<ReturnType<typeof world>>,
  from: string,
): Promise<string> {
  const to = join(scratchDir("infinitary-placed-moved-"), "home");
  const { userData } = at.home().paths;
  await at.restartHome(() => {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rewriteDatabases(userData, pathsOf(from), to);
  });
  return to;
}

/** INF-1965: the publication fixtures describe their actual committed, unserved footer file. */
function footerStory(base: string, head: string): ChangePresentationDraft {
  return {
    title: "feat: a blue footer",
    publishable: true,
    base,
    head,
    why: ["The website needs the requested footer."],
    whatChanged: ["Added the blue footer file."],
    before: ["The project contained its README alone."],
    after: ["The committed project includes the footer file."],
    views: [],
    noPicture: "This fixture checks unserved branch content, not a running website.",
    checked: [{ check: "Commit", result: "Git recorded the footer in the task's branch." }],
    verification: ["Committed footer.html in the work computer's working copy."],
    risk: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        { level: "low", why: "Disposable footer content only." },
      ]),
    ) as RiskDeclaration,
    requiredActions: [],
    unfinished: [],
  };
}

describe("a task that runs on a computer that runs work", () => {
  it("prepares a story on the home after transferring the work computer's inspected pictures, without showing a card or uploading (INF-92)", async () => {
    const project = await gitProject();
    const upload = vi.fn(async () => {
      throw new Error("Preparation uploads nothing");
    });
    const destination = async () => ({
      host: "github.com",
      projectId: 1,
      fullName: "octo/website",
      visibility: "private" as const,
    });
    const at = await world(() =>
      Object.assign(project.forge(Buffer.alloc(0)), {
        kind: "github" as const,
        host: "github.com",
        storyDestination: destination,
        changeFor: async () => null,
        attachments: { destination, upload },
      }),
    );
    const home = at.home();
    expect(
      home.placed.takesChangePresentations(at.deviceId),
      JSON.stringify(home.devices.version(at.deviceId)),
    ).toBe(true);
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([{ text: "Ready to prepare." }]);
    await at.start("t-story", "Prepare the inspected change story.", repo.id);
    await expect.poll(() => home.tasks.get("t-story")?.activity).toBe("idle");
    const source = readFileSync("release-notes/pictures/action-reply-line-dark.webp");
    const evidence = at.folders("t-story").evidence;
    mkdirSync(evidence, { recursive: true });
    const picture = join(evidence, "reply.webp");
    writeFileSync(picture, source);
    const risk = Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        { level: "low", why: `The ${dimension} assessment for this fixture.` },
      ]),
    ) as RiskDeclaration;
    model([
      {
        tools: [
          {
            name: "prepare_change",
            args: {
              story: {
                title: "fix: show the selected evidence",
                publishable: true,
                base: project.main,
                head: project.main,
                why: ["The pull request and card should show the same evidence."],
                whatChanged: ["The task retains the selected picture."],
                before: ["The description had text alone."],
                after: ["The description has a picture."],
                views: [
                  {
                    id: "reply",
                    kind: "new",
                    caption: "The reply",
                    before: [],
                    after: [
                      {
                        path: picture,
                        alt: "The task reply in the dark appearance",
                        inspected: true,
                        captureHead: project.main,
                      },
                    ],
                  },
                ],
                checked: [{ check: "Selected picture", result: "The retained image is readable." }],
                verification: ["Opened the selected picture."],
                risk,
                requiredActions: [],
                unfinished: [],
              },
            },
          },
        ],
      },
      { text: "The story is prepared." },
    ]);
    await home.supervisor.steerCrewmate("t-story", "Prepare the selected story now.");
    await expect.poll(() => home.tasks.get("t-story")?.outcome).toBe("The story is prepared.");
    expect(
      home.tasks.changePresentation("t-story")?.revisions.length,
      said(api.requests.at(-1)),
    ).toBe(1);
    const story = home.tasks.changePresentation("t-story")?.revisions[0];
    const asset = story?.assets[0];
    if (!asset) throw new Error("No retained picture reached home");
    expect(readFileSync(join(crewmateCardPicturesDir(home.paths, "t-story"), asset.file))).toEqual(
      source,
    );
    expect(story?.head).toBe(project.main);
    expect(story?.version).toBe(2);
    expect(story?.checked).toHaveLength(1);
    // INF-169 F13: only the home retains prepared copies after transfer.
    expect(readdirSync(at.folders("t-story").cards)).toEqual([]);
    expect(readFileSync(picture)).toEqual(source);
    expect(home.tasks.changePresentation("t-story")?.receipts[0]?.state).toBe("prepared");
    expect(upload).not.toHaveBeenCalled();
    expect(home.cards()).toEqual([]);
  });

  it("works in a working copy cloned there, opens its change from here once its branch is home, and takes its kept work home before that computer deletes the copy", async () => {
    const project = await gitProject();
    // Files copied byte for byte from a real phone-logs artifact.
    const artifact = readFileSync("tests/fixtures/forge/phone-logs-sample.zip");
    const at = await world(() => project.forge(artifact));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([{ text: "Started on the footer." }]);
    const requests = api.requests.length;
    await at.start("t-copy", "Make the footer blue.", repo.id);

    // The computer cloned the project and made the task's working copy there.
    const work = at.folders("t-copy").work;
    await expect.poll(() => home.tasks.get("t-copy")?.activity).toBe("idle");
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(project.main);
    expect(await git(work, ["symbolic-ref", "--short", "HEAD"])).toBe("fm/task-t-copy");
    expect(home.tasks.get("t-copy")).toMatchObject({
      branch: "fm/task-t-copy",
      worktreeDir: "",
      workspaceState: "present",
    });
    expect(feed(home)).toContain("Mac mini cloned home.");
    expect(home.tasks.timeline("t-copy").map((event) => event.text)).toContain(
      "a new working copy was made on Mac mini, starting from the latest origin/main",
    );
    // Its first turn ran there, in that working copy.
    expect(JSON.stringify(api.requests[requests]?.body.system)).toContain(work);

    // The crewmate's work there: one commit, and an edit not yet committed.
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    writeFileSync(join(work, "notes.txt"), "still thinking\n");
    // INF-1965 adds the saved-story prerequisite without changing who sends the branch up.
    const publication: Step[] = [
      { tools: [{ name: "prepare_change", args: { story: footerStory(project.main, tip) } }] },
      { tools: [{ name: "open_change", args: { title: "feat: a blue footer", presentation: 1 } }] },
      {
        tools: [
          { name: "download_artifact", args: { runId: 41, artifactId: 9 } },
          // INF-1932: only the files it needs, saved beside the whole archive.
          { name: "download_artifact", args: { runId: 41, artifactId: 9, files: ["ipad/rest/"] } },
        ],
      },
      { text: "Opened, and read the artifact." },
    ];
    model(publication);
    const opening = api.requests.length;
    await home.supervisor.steerCrewmate("t-copy", "Open the change.");
    await expect.poll(() => api.requests.length - opening).toBe(publication.length);
    await expect.poll(() => home.tasks.get("t-copy")?.activity).toBe("idle");

    // open_change ran here: the branch came home over the connection, and
    // this Mac sent it up to where the project lives.
    expect(await git(project.home, ["rev-parse", "refs/heads/fm/task-t-copy"])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/fm/task-t-copy"])).toBe(tip);
    expect(said(api.requests.at(-2))).toContain("Opened the pushed branch fm/task-t-copy");
    expect(home.tasks.changePresentation("t-copy")?.completion).toMatchObject({
      revision: 1,
      head: tip,
    });
    // download_artifact downloaded here and wrote the file there, never here.
    const written = join(work, ".infinitary-artifacts", "run-41", "artifact-9.zip");
    expect(readFileSync(written).equals(artifact)).toBe(true);
    expect(said(api.requests.at(-1))).toContain(
      createHash("sha256").update(artifact).digest("hex"),
    );
    // The selection too: downloaded in parts here, written there beside it.
    const selected = readdirSync(join(work, ".infinitary-artifacts", "run-41")).find((name) =>
      /^artifact-9-[0-9a-f]{12}\.zip$/.test(name),
    );
    const part = readFileSync(join(work, ".infinitary-artifacts", "run-41", selected ?? "none"));
    expect(selected).toBe(
      `artifact-9-${createHash("sha256").update(part).digest("hex").slice(0, 12)}.zip`,
    );
    expect(part.length).toBeLessThan(artifact.length);
    expect(part.includes("ipad/rest/1-plutil.log")).toBe(true);
    expect(part.includes("12-xcrun.log")).toBe(false);
    expect(said(api.requests.at(-1))).toContain(`.infinitary-artifacts/run-41/${selected}`);
    expect(existsSync(join(project.home, ".infinitary-artifacts"))).toBe(false);

    // The task closes: its work is kept there, comes home, and only then is
    // the working copy deleted there.
    await home.supervisor.interruptCrewmate("t-copy", "cancel");
    await expect.poll(() => home.tasks.get("t-copy")?.workspaceState).toBe("removed");
    expect(existsSync(work)).toBe(false);
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-copy")]);
    expect(await git(project.home, ["show", `${kept}:notes.txt`])).toBe("still thinking");
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    expect(await git(project.home, ["branch", "--list", "fm/task-t-copy"])).toBe("");
    expect(home.tasks.timeline("t-copy").at(-1)?.text).toBe(
      "working copy on Mac mini removed - its 1 commit not in yet and uncommitted edits saved here first",
    );
  });

  // Review INF-2546 R2, under the captain's "Fix it in this change" for
  // delivering an independent story from a computer that runs work: a
  // crewmate there that checks out another branch prepares that branch's
  // story and opens it from here, as one on this Mac does. The branch comes
  // home to the task's own ref for it, so this Mac's branch of the same name
  // never moves, and the task's own story stays empty.
  it("prepares and opens the story of another branch the crewmate checked out there, bringing that branch home to the task's own ref for it", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.from("")));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    // This Mac's own branch of that name, at main, which nothing here may move.
    await git(project.home, ["branch", "reading-fix", project.main]);
    model([{ text: "Started on the reading fix." }]);
    await at.start("t-other", "Deliver the reading fix on its own branch.", repo.id);
    const work = at.folders("t-other").work;
    await expect.poll(() => home.tasks.get("t-other")?.activity).toBe("idle");
    // The crewmate checks out another branch there and commits the fix on it.
    await git(work, ["checkout", "--quiet", "-b", "reading-fix"]);
    writeFileSync(join(work, "reading.txt"), "on time\n");
    const tip = await commit(work, "fix: read the meter on time");
    const story = { ...footerStory(project.main, tip), title: "fix: read the meter on time" };
    const publication: Step[] = [
      { tools: [{ name: "prepare_change", args: { story } }] },
      {
        tools: [
          {
            name: "open_change",
            args: { title: "fix: read the meter on time", branch: "reading-fix", presentation: 1 },
          },
        ],
      },
      { text: "Opened the reading fix with its own story." },
    ];
    model(publication);
    const opening = api.requests.length;
    await home.supervisor.steerCrewmate("t-other", "Open the reading fix.");
    await expect.poll(() => api.requests.length - opening).toBe(publication.length);
    await expect.poll(() => home.tasks.get("t-other")?.activity).toBe("idle");

    // The story is that branch's, at the commit checked out there.
    expect(said(api.requests.at(-2))).toContain("Prepared presentation 1 for");
    expect(home.tasks.changePresentation("t-other", "reading-fix")?.revisions[0]?.head).toBe(tip);
    expect(
      home.tasks.changePresentation("t-other", home.tasks.get("t-other")?.branch),
    ).toBeUndefined();
    // open_change ran here from the task's own ref for the branch, and sent it up.
    expect(said(api.requests.at(-1))).toContain("for reading-fix");
    expect(await git(project.home, ["rev-parse", checkedOutRefFor("t-other")])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/reading-fix"])).toBe(tip);
    expect(await git(project.home, ["rev-parse", "refs/heads/reading-fix"])).toBe(project.main);
    expect(home.tasks.changePresentation("t-other", "reading-fix")?.completion).toMatchObject({
      revision: 1,
      head: tip,
    });
  });

  // INF-1713, and review INF-1772 R11: a move's copies are retired through
  // the real working copies on both sides, a computer the task ran on takes
  // it again, and what the copy it left asks after is refused here.
  it("moves a started task home and there again with its work, removing each copy it left, and refuses what a copy it left asks after", async () => {
    const project = await gitProject();
    // The computer is signed in to the account that serves the task's model, so it can take it back.
    const at = await world(() => project.forge(Buffer.from("")), {
      runsHere: true,
      signedInTo: [computerAccount("acct_placed_there", PROVIDER)],
      served: [{ accountId: "acct_placed_there", models: [{ provider: PROVIDER, id: MODEL }] }],
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started on the footer." }]);
    await at.start("t-move", "Make the footer blue.", repo.id);
    const there = at.folders("t-move").work;
    await expect.poll(() => home.tasks.get("t-move")?.activity).toBe("idle");
    writeFileSync(join(there, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(there, "feat: a blue footer");
    writeFileSync(join(there, "notes.txt"), "still thinking\n");
    const settled = async () => {
      await expect
        .poll(() => home.tasks.get("t-move")?.shape?.computer_move, { timeout: 15_000 })
        .toBeUndefined();
    };

    // Home: the work arrives in a working copy here, and the copy there goes.
    expect(
      await home.supervisor.requestComputerMove("t-move", RUNS_ON_THIS_MAC, "captain"),
    ).toMatchObject({ ok: true });
    await settled();
    const here = home.tasks.get("t-move")?.worktreeDir ?? "";
    expect(home.tasks.get("t-move")?.deviceId ?? null).toBeNull();
    expect(await git(here, ["rev-parse", "HEAD"])).toBe(tip);
    expect(readFileSync(join(here, "notes.txt"), "utf8")).toBe("still thinking\n");
    await expect.poll(() => existsSync(there)).toBe(false);
    expect(at.holds().workingCopies).not.toContain("t-move");
    // The conversation it left there is closed: what it asks after is not this Mac's to answer.
    await expect(
      home.placed.answer(at.deviceId, "inf:work:report", {
        task: "t-move",
        callId: "call-stale",
        text: "Done there.",
      }),
    ).rejects.toThrow(NO_PLACED_TASK);

    // There again: the computer it ran on takes it, from a bundle, since the
    // project's origin is a folder of this Mac; the copy here goes.
    writeFileSync(join(here, "notes.txt"), "thought it through\n");
    expect(
      await home.supervisor.requestComputerMove("t-move", at.deviceId, "captain"),
    ).toMatchObject({ ok: true });
    await settled();
    expect(home.tasks.get("t-move")?.deviceId).toBe(at.deviceId);
    const again = at.folders("t-move").work;
    expect(await git(again, ["rev-parse", "HEAD"])).toBe(tip);
    expect(readFileSync(join(again, "notes.txt"), "utf8")).toBe("thought it through\n");
    // Review INF-1772 round 2 R12: it never clones this Mac's folder there.
    expect(listed(join(at.dataDir, "repos"))).toContain(`local-${repo.id}`);
    await expect.poll(() => existsSync(here)).toBe(false);

    // Home once more: the copy there, in a repository that began empty, goes too.
    expect(
      await home.supervisor.requestComputerMove("t-move", RUNS_ON_THIS_MAC, "captain"),
    ).toMatchObject({ ok: true });
    await settled();
    expect(home.tasks.get("t-move")?.deviceId ?? null).toBeNull();
    const last = home.tasks.get("t-move")?.worktreeDir ?? "";
    expect(readFileSync(join(last, "notes.txt"), "utf8")).toBe("thought it through\n");
    await expect.poll(() => existsSync(again)).toBe(false);
    expect(at.holds().workingCopies).not.toContain("t-move");
    expect(home.tasks.timeline("t-move").at(-1)?.text).toBe(
      "the working copy it left on Mac mini was removed",
    );
  });

  it("INF-203 F1: the real home accepts a clean placed run and effect request, but refuses dirty placed work", async () => {
    const project = await gitProject();
    const at = await world((repo) => project.forge(Buffer.alloc(0), repo?.path));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr", rigor: "reviewed" });
    model([{ text: "The clean checkout will be validated." }]);
    await at.start(
      "t-validation",
      "Check this placed checkout's committed version and clean status.",
      repo.id,
    );
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    expect(home.tasks.get("t-validation")?.worktreeDir).toBe("");
    const work = at.folders("t-validation").work;
    const head = await git(work, ["rev-parse", "HEAD"]);
    const scenario = {
      id: "checkout",
      source: "Check the placed checkout's version and clean status.",
      importance: "required",
      action: "Read HEAD and git status on the work computer.",
      expected: "One committed version with no edits.",
      adverse: "Uncommitted work must be refused.",
      environment: "Disposable paired helper",
      signal: "Git's actual readings.",
      boundary:
        "The actual placed working copy and home report path, not a physical second computer.",
    };
    model([
      {
        tools: [
          {
            name: "report",
            args: {
              text: "Recorded the checkout scenario.",
              validation: {
                kind: "plan",
                previousRevision: 0,
                reason: scenario.source,
                scenarios: [scenario],
              },
            },
          },
        ],
      },
      { text: "The checkout scenario is recorded." },
    ]);
    await home.supervisor.steerCrewmate(
      "t-validation",
      "Record the scenario before reading its result.",
    );
    await expect
      .poll(() => home.tasks.get("t-validation")?.delivery?.liveValidation?.scenarioRevision)
      .toBe(1);
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    const observed = JSON.stringify({
      head: await git(work, ["rev-parse", "HEAD"]),
      status: await git(work, ["status", "--porcelain"]),
    });
    const file = join(at.folders("t-validation").evidence, "checkout.json");
    mkdirSync(at.folders("t-validation").evidence, { recursive: true });
    writeFileSync(file, observed);
    const run = {
      kind: "run",
      id: "checkout-clean",
      head,
      scenarioRevision: 1,
      completion: "complete",
      verdict: "go",
      reason: "The actual placed checkout was clean at this committed version.",
      observations: [
        {
          scenario: "checkout",
          result: "pass",
          live: true,
          actual: observed,
          evidence: ["checkout"],
          standIns: [],
          unproven: [],
          attempted: [],
        },
      ],
      evidence: [
        {
          id: "checkout",
          path: file,
          description: "HEAD and git status from the actual placed working copy.",
        },
      ],
    };
    const effect = {
      kind: "request",
      request: {
        kind: "effect",
        id: "clean-reproduction",
        head,
        scenario: "checkout",
        action: "Publish the exact pre-change reproduction.",
        destination: "Disposable fixture",
        audience: "Fixture collaborators",
        visibility: "others",
        persistent: true,
        purpose: "Reproduce the clean-checkout condition",
        lastingEffects: "A retained fixture record",
        cleanup: "Delete the fixture afterward",
        access: "Disposable fixture only",
        preChange: true,
        prerequisitePublication: false,
      },
    };
    model([
      {
        tools: [
          { name: "report", args: { text: "The placed checkout was exercised.", validation: run } },
        ],
      },
      {
        tools: [
          {
            name: "report",
            args: { text: "The pre-change reproduction needs an answer.", validation: effect },
          },
        ],
      },
      { text: "The home has the proof and unanswered request." },
    ]);
    await home.supervisor.steerCrewmate(
      "t-validation",
      "Record the observed run and request, not approval.",
    );
    await expect
      .poll(() => home.tasks.get("t-validation")?.delivery?.liveValidation?.permissions[0]?.state)
      .toBe("requested");
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    const kept = home.tasks.get("t-validation")?.delivery?.liveValidation?.runs[0];
    expect(kept).toMatchObject({ head, deviceId: at.deviceId, verdict: "go" });
    expect(
      readFileSync(
        join(crewmateCardPicturesDir(home.paths, "t-validation"), kept!.evidence[0]!.file),
        "utf8",
      ),
    ).toBe(observed);
    expect(kept!.evidence[0]!.text).toBeUndefined();
    writeFileSync(join(work, "uncommitted.txt"), "Not the approved version.");
    model([
      {
        tools: [
          {
            name: "report",
            args: {
              text: "Attempt the dirty checkout report.",
              validation: { ...run, id: "dirty" },
            },
          },
        ],
      },
      { text: "The dirty report was refused." },
    ]);
    await home.supervisor.steerCrewmate(
      "t-validation",
      "Check whether a dirty checkout can record the same proof.",
    );
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    expect(said(api.requests.at(-1))).toContain("Commit the current work before validation");
    expect(home.tasks.get("t-validation")?.delivery?.liveValidation?.runs).toHaveLength(1);
    console.log(
      "INF-203 placed home proof",
      JSON.stringify({ head, kept: kept!.evidence, observed, dirtyRefused: true }),
    );
  });

  // INF-97: INF-40 started on the Mac mini before its home moved Firstmate
  // 3000's folder into Infinitary's. A reviewed open_change read the branch
  // in the older folder's copy of the project, which never received it:
  // "git -C .../firstmate-3000/fleet/infinitary rev-parse fm/task-68b12f57
  // ... unknown revision". The move now rewrites the task's record of this
  // Mac's project folder, and the open still reads the project's folder now.
  it("opens a reviewed change from the project's folder once the home's folder has moved, never from the older copy (INF-97)", async () => {
    const project = await gitProject();
    const at = await world((repo) => project.forge(Buffer.alloc(0), repo?.path));
    const { repo } = await adoptHere(at.home().repos, project.home);
    at.home().repos.configure(repo.id, { delivery: "direct-pr", rigor: "reviewed" });
    model([{ text: "Started on the footer." }]);
    await at.start("t-moved", "Make the footer blue.", repo.id);
    await expect.poll(() => at.home().tasks.get("t-moved")?.activity).toBe("idle");
    const work = at.folders("t-moved").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    // INF-125 adds an explicit proof prerequisite; INF-97 still owns the real moved-folder/git boundary below.
    seedDelivery(at.home().tasks, "t-moved", {
      reviewVerdict: "pass",
      reviewSha: tip,
      validationHead: tip,
      liveValidation: noSurfaceProof(
        tip,
        "fixture-reviewer",
        "INF-97 is a git-publication fixture with no running application; footer.html is unserved branch content, not a claimed UI result.",
      ),
    });

    const moved = await moveProjectFolder(at, repo.path);
    const home = at.home();
    // The project and the task's record of it both name the new folder.
    expect(home.repos.get(repo.id)?.path).toBe(moved);
    expect(home.tasks.get("t-moved")?.repoDir).toBe(moved);
    // INF-1965: the moved project keeps the same saved-story prerequisite as any plain branch.
    const publication: Step[] = [
      { tools: [{ name: "prepare_change", args: { story: footerStory(project.main, tip) } }] },
      { tools: [{ name: "open_change", args: { title: "feat: a blue footer", presentation: 1 } }] },
      { text: "Opened." },
    ];
    model(publication);
    const requests = api.requests.length;
    await home.supervisor.steerCrewmate("t-moved", "Open the change.");
    await expect.poll(() => api.requests.length - requests).toBe(publication.length);
    await expect.poll(() => home.tasks.get("t-moved")?.activity).toBe("idle");

    expect(said(api.requests.at(-1))).toContain("Opened the pushed branch fm/task-t-moved");
    expect(home.tasks.changePresentation("t-moved")?.completion).toMatchObject({
      revision: 1,
      head: tip,
    });
    // The branch came home into the project's folder and went up from there.
    expect(await git(moved, ["rev-parse", "refs/heads/fm/task-t-moved"])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/fm/task-t-moved"])).toBe(tip);
    // The older copy stays as the move left it.
    expect(await git(repo.path, ["branch", "--list", "fm/task-t-moved"])).toBe("");
  });

  it("merges a task's branch from that computer into the project's folder once the home's folder has moved (INF-97)", async () => {
    const project = await gitProject();
    const at = await world();
    const { repo } = await adoptHere(at.home().repos, project.home);
    at.home().repos.configure(repo.id, { delivery: "local-only" });
    model([{ text: "Started on the footer." }]);
    await at.start("t-land", "Make the footer blue.", repo.id);
    await expect.poll(() => at.home().tasks.get("t-land")?.activity).toBe("idle");
    const work = at.folders("t-land").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");

    const moved = await moveProjectFolder(at, repo.path);
    const home = at.home();
    expect(home.tasks.get("t-land")?.repoDir).toBe(moved);
    await at.inReach("t-land");
    const landed = await home.supervisor.settleTaskDetailed(
      "t-land",
      "land",
      undefined,
      undefined,
      "captain",
    );

    expect(landed.text).toBe('Merged "website" into main.');
    expect(await git(moved, ["rev-parse", "main"])).toBe(tip);
    expect(await git(repo.path, ["rev-parse", "main"])).toBe(project.main);
  });

  // INF-572, the captain's approved plan: a project's folder deleted on this
  // Mac does not stop a task bound for the computer that runs work, which
  // clones its own; its branch cannot come home into the missing folder, so
  // its merge is refused naming the folder, and the folder's repair is filed.
  it("starts a task there while this Mac's folder is missing, and refuses its branch coming home into it (INF-572)", async () => {
    const project = await gitProject();
    const at = await world();
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "local-only" });
    // Every start reads the folder's address first, as the app wires it.
    const changes = new ProjectChanges({
      repos: home.repos,
      devices: () => [],
      raiseCard: () => {},
      tell: () => {},
    });
    home.supervisor.setProjectChange({
      apply: () => {},
      decline: () => {},
      inspect: (repoId) => changes.inspect(repoId),
    });
    rmSync(project.home, { recursive: true, force: true });

    model([{ text: "Started on the footer." }]);
    await at.start("t-gone", "Make the footer blue.", repo.id);
    await expect.poll(() => home.tasks.get("t-gone")?.activity).toBe("idle");
    const work = at.folders("t-gone").work;
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(project.main);
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    await commit(work, "feat: a blue footer");

    const landed = await home.supervisor.settleTaskDetailed(
      "t-gone",
      "land",
      undefined,
      undefined,
      "captain",
    );
    const repair = home.tasks
      .list()
      .find((row) => row.repoId === repo.id && row.shape?.in_place !== undefined);
    if (!repair) throw new Error("no repair task was filed");
    expect(repair.shape?.in_place).toMatchObject({ cause: "missing", noticed: "branch-home" });
    expect(landed.text).toContain(
      `Your project's folder ${project.home} is missing, so nothing can be merged into it.`,
    );
    expect(home.tasks.get("t-gone")?.status).toBe("active");
    expect(existsSync(project.home)).toBe(false);
  });

  // INF-45: read_workflow's description promises a short read and a run
  // watch for runId alone, and the release crewmate on the Mac mini was
  // refused it ("Rejected inf:work:read-workflow: malformed request").
  it("reads a run there by its number alone, watches it here, and wakes the crewmate there when it ends (INF-45)", async () => {
    const project = await gitProject();
    // Infinitary's first alpha release run and two of its jobs, as GitHub
    // listed them while its checks still ran and once it passed.
    const runId = 38849548350;
    let finished = false;
    const release = {
      run: async (id: number) => ({
        id,
        name: "release",
        headSha: project.main,
        branch: "main",
        attempt: 1,
        status: finished ? "completed" : "in_progress",
        conclusion: finished ? "success" : null,
        url: `https://github.com/infinitary-labs/infinitary/actions/runs/${id}`,
      }),
      jobs: async () => ({
        jobs: [
          {
            id: 116807503003,
            name: "Resolve the source commit and version",
            status: "completed",
            conclusion: "success",
            failedAt: null,
          },
          {
            id: 116807634269,
            name: "verify / linux-checks",
            status: finished ? "completed" : "in_progress",
            conclusion: finished ? "success" : null,
            failedAt: null,
          },
        ],
        total: 2,
        complete: true,
      }),
      jobLog: async () => {
        throw new Error("No job log was asked for.");
      },
      download: async () => {
        throw new Error("No artifact was asked for.");
      },
    };
    const at = await world(() =>
      Object.assign(project.forge(Buffer.alloc(0)), { workflows: release }),
    );
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([
      { tools: [{ name: "read_workflow", args: { runId } }] },
      { text: "Waiting for the release run." },
      { text: "The release passed." },
    ]);
    const requests = api.requests.length;
    await at.start("t-run", "Watch the release.", repo.id);
    await expect.poll(() => api.requests.length - requests).toBe(2);
    await expect.poll(() => home.tasks.get("t-run")?.activity).toBe("idle");

    // The home read the run with its own forge, and its short read reached the crewmate there.
    const read = said(api.requests.at(-1));
    expect(read).toContain("state: in_progress");
    expect(read).toContain("116807634269 verify / linux-checks — in_progress");
    expect(read).toContain("The app watches this run every minute");
    expect(home.tasks.get("t-run")?.delivery?.runWatches).toEqual([
      expect.objectContaining({ runId, name: "release", failureSeen: false }),
    ]);

    // The run ends; the home's next minute reads it and wakes the crewmate there once.
    finished = true;
    await home.supervisor.pollCheckWatches(now() + 61_000);
    await expect.poll(() => api.requests.length - requests).toBe(3);
    expect(said(api.requests.at(-1))).toContain("release (run 38849548350, attempt 1) passed.");
    await expect.poll(() => home.tasks.get("t-run")?.activity).toBe("idle");
    expect(home.tasks.get("t-run")?.delivery?.runWatches).toEqual([]);
  });

  it("keeps a closed task's working copy there while that computer is out of reach, and brings its work home once it is back", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started." }]);
    await at.start("t-away", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-away")?.activity).toBe("idle");
    const work = at.folders("t-away").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");

    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.supervisor.interruptCrewmate("t-away", "cancel");
    expect(home.tasks.get("t-away")?.status).toBe("dropped");
    // Nothing is deleted there, and nothing is counted as gone here.
    expect(existsSync(work)).toBe(true);
    expect(home.tasks.get("t-away")?.workspaceState).toBe("present");

    await home.listen();
    await expect.poll(() => home.tasks.get("t-away")?.workspaceState).toBe("removed");
    expect(existsSync(work)).toBe(false);
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-away")]);
    expect(await git(project.home, ["show", `${kept}:footer.html`])).toBe("<footer></footer>");
  });

  // DOP-121: on Kun's Mac mini 34 closed tasks' working copies stayed for
  // good. Each checkout had left its task's branch, as a reviewer's does,
  // and a version that read no branch for such a checkout had kept it.
  it("retires a closed task's working copy there that an earlier version kept without its branch's commits, keeping them here first", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started." }]);
    await at.start("t-review", "Review the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-review")?.activity).toBe("idle");
    const work = at.folders("t-review").work;
    // A commit on its branch, then the version it reviews checked out, with a note of its own.
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    const onBranch = await commit(work, "feat: add the footer");
    await git(work, ["checkout", "--quiet", "--detach", project.main]);
    writeFileSync(join(work, "notes.txt"), "what the review found\n");
    const checkedOut = await commit(work, "docs: note what the review found");

    // It closes while that computer is out of reach, which then stops.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.supervisor.interruptCrewmate("t-review", "cancel");
    await at.stopComputer();
    // The keep that version answered: the checkout alone, saved there and remembered.
    const clone = await git(work, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const older = await new WorkspaceService(
      {
        worktreesDir: join(at.dataDir, "worktrees"),
        worktreeTrashDir: join(at.dataDir, "worktree-trash"),
        worktreePoolDir: join(at.dataDir, "worktree-pool"),
        defaultWorkspaceDir: join(at.dataDir, "default-workspace"),
      },
      { pool: false },
    ).keepUnlandedWork({ taskId: "t-review", cwd: work, branch: "", repoDir: clone });
    if (!older) throw new Error("expected the older kept work");
    new PlacedTasks(at.dataDir, join(at.dataDir, "worktrees")).applied(
      "t-review",
      "keep:t-review",
      { kept: older },
    );

    await at.restartComputer();
    await home.listen();
    await expect.poll(() => home.tasks.get("t-review")?.workspaceState).toBe("removed");
    expect(existsSync(work)).toBe(false);
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-review")]);
    for (const commit of [onBranch, checkedOut, older.sha])
      await git(project.home, ["merge-base", "--is-ancestor", commit, kept]);
    await expect(
      git(clone, ["rev-parse", "--verify", "--quiet", "refs/heads/fm/task-t-review"]),
    ).rejects.toThrow();
  });

  it("asks that computer what a task's working copy holds before discarding it, and holds the discard while nobody can tell", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started." }]);
    await at.start("t-discard", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-discard")?.activity).toBe("idle");
    const work = at.folders("t-discard").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    await commit(work, "feat: add the footer");

    const refused = await home.supervisor.settleTaskDetailed("t-discard", "discard");
    expect(refused.refusal?.refused).toBe("unlanded-work");
    expect(refused.text).toContain("1 commit that were never merged");

    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const held = await home.supervisor.settleTaskDetailed("t-discard", "discard");
    expect(held.refusal?.refused).toBe("unlanded-work");
    expect(held.text).toContain("out of reach, so nobody can tell");
    expect(home.tasks.get("t-discard")?.status).toBe("active");
  });
});
