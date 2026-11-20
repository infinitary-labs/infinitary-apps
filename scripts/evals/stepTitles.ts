import type { ApprovalCase, EvalRun, EvalTask } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";

/**
 * The step-title evaluation (INF-19): when the captain accepts a plan that breaks
 * the work into steps, does a live first mate file each step under a title saying
 * what that step does, never a bare step number like "Rename step 5 of 16". The
 * captain asked for it beside a Tasks list reading "Rename step 1 of 16" through
 * "Rename step 16 of 16", filed from FI3-1780's plan, which named every step; the
 * same tasks' goals read "Step N of the 16-step ... plan", pointing at the plan.
 * The steps case is shaped like that report: sixteen steps in six phases, with
 * long step bodies, the captain's answers and his words.
 *
 * The trace score reads the executed calls: the filed graph, and titles or goals
 * that differ from a sibling's only by their numbers. Whether each title names
 * its step's work is an independent reviewer's judgment, with the titles quoted,
 * never a pattern match on the words.
 */
export type StepTitleCase = ApprovalCase & {
  /** `steps`: file every step and start none; `pieces`: reuse BUILD as the first piece. */
  filing: "steps" | "pieces";
  /** The plan's own name for each step, in its order. */
  steps: string[];
};
/** The reviewer's judgment, written after reading the recorded run. */
export type StepTitleReview = {
  /** Every title the first mate gave a step names that step's own work. */
  titlesSayWhatEachStepDoes: boolean;
  /** Each title as the host stored it (its first 64 characters), beside the step it files. */
  quotations: string[];
};

const record = (key: string, title: string, status: EvalTask["status"]): EvalTask => ({
  task_id: key,
  key,
  title,
  status,
  autonomy: false,
  blocked_by: [],
});

const renameSteps = [
  "Read both names",
  "Paired computers, background work and saved panels",
  "The one-time move, built but asleep",
  "Pick a task key when adding a project",
  "Bridge alpha",
  "Bridge stable",
  "Release tooling for a fresh history",
  "Code names",
  "Words a person sees",
  "Become Oakline",
  "Archive and start fresh",
  "First Oakline alpha, new installs only",
  "Move alpha users",
  "Oakline stable, and move stable users",
  "Site",
  "The captain's setup and the final audit",
];
const step = (n: number) => `${n}. ${renameSteps[n - 1]}.`;
const renamePlan = `Answer: yes. Split the rename into ${renameSteps.length} steps in six phases. Each step becomes its own task under P that waits for the captain's Start and is blocked by the steps it needs. These tasks replace the single rename task, which is already closed. Acorn ships the migration support as an alpha (step 5) and then as stable (step 6). No Oakline step starts before both. The card's default action is "File these steps, start none".

PHASE A - Acorn learns the new names (code; merges to today's main and ships in step 5; nothing a person sees changes)
${step(1)} Delivers: Acorn accepts Oakline's names wherever a paired computer or a rollback could show them, and keeps its own names and defaults. This covers OAKLINE_* settings beside ACORN_* ones (the new value wins), oakline:// pairing links, either SSH key comment (ownKey.ts:33 requires acorn today), a moved-folder ("retired profile") marker it refuses to open, a move lock kept outside the data folder (the single-instance lock lives inside it, app.ts:196), and tolerance for the channel file's new "came through the old cask" field. Needs: nothing. Checked by: the typecheck, check and adherence lint, the journeys user-data-folder, older-profile, saved-data-refusal and devices, and focused retained tests for the refusal and the lock.
${step(2)} Delivers: protocol negotiation, so an Oakline home and an Acorn computer work together in either order of updating. It keeps the /acorn download route and the acorn:update order. It moves the background work service from com.example.acorn.work to the new label in one transaction. Saved panels and card scripts keep working, with aliases only where question 2 renames. Needs: 1. Checked by: the devices, view, runs-on and personal-panel journeys, plus a mixed-version pairing rehearsal on throwaway homes.
${step(3)} Delivers the move engine:
- preflight, lock and staged copy;
- rewriting of app-owned paths, and repair of git worktree links (the app's working copies live inside the data folder);
- session mapping for the coding client, which files sessions under the old working-copy path;
- count and hash checks, an atomic commit, a kept recovery copy, the retired marker, and the both-folders question;
- a disk-space check, and Linux paths;
- the hand-over screen a person sees;
- Acorn starts recording Open at login, so Oakline can turn it back on.
The engine wakes only when an app with a new identity finds an old folder. Oakline moves any supported old folder itself, so nobody is refused for skipping the bridge. Needs: 1 and 2. Checked by: a rehearsal on a throwaway home (an interrupted copy, a full disk, two full folders, a marker-only destination, a repeated launch, WAL recovery), and a demo recording of the hand-over screen.
${step(4)} Delivers: Add project, in Settings and through the first mate's project setup, takes an optional task key. This is a generic primitive. Today the app derives OAKL from "oakline", not the OAK the captain chose. It must ship in the bridge, because the captain adds the Oakline project in that app in step 11. Needs: nothing. Checked by: the project journeys and a refusal for a key already in use.

PHASE B - Acorn ships (the usual release process, run by a release crewmate)
${step(5)} Delivers: steps 1 to 4 to alpha users, through the alpha guide's "Cutting an alpha". Needs: 1 to 4 merged. Checked by: every release check passes, and the captain updates with the usual alpha command and works as normal.
${step(6)} Delivers: the same code to stable users, through "Promoting an alpha". The captain picks three highlights first. Needs: 5, plus whatever wait the captain wants. Checked by: the stable cask names the new version, and a stable install shows the update.

PHASE C - Build Oakline (code on main; ships nothing until step 12; 7, 8 and 9 can go in any order, recommended 7, 8, 9)
${step(7)} Delivers: a typed, checked record of past releases, so the release scripts and workflow work in a repository with one commit. Version numbers continue above every published version on both channels. Needs: 6. Checked by: a rehearsal on a throwaway parentless copy passes the release and notes checks, and main's checks still pass.
${step(8)} Delivers: every name with acorn in it becomes Oakline's, with the old names still readable. That covers ACORN_* to OAKLINE_*, acorn paths, acorn ids and refs/acorn. The generated self-map, the published contract and personal types are regenerated. Question 2 settles the short code names. Needs: 6. Checked by: the gate, the affected journeys, and a ledger that classifies every remaining old name as renamed, a migration reader, an outside identity or history.
${step(9)} Delivers: the app says Oakline, and the agent is "your first mate" ("Welcome to Oakline, captain. I'm your first mate."). Menus, welcome, Settings, notices, prompts, the design skill and its wordmark, docs and README follow. Past release notes and changelog stay as written. Needs: 6. Checked by: the replay gate, before-and-after pictures of each changed view, and a release note with its hero picture.
${step(10)} Delivers:
- app id com.oakline.app, with .dev for development; Oakline.app; the oakline and oakline-dev data folders, with the move switched on;
- Linux deb and rpm packages that replace, conflict with and provide acorn, and leave a link at the old program path;
- dev signer names;
- release names: oakline-v and oakline-alpha-v tags, Oakline-<v>-universal.zip, the oakline-labs/homebrew-tap feeds;
- the publisher for the old-cask switch.
The old-cask switch publishes Oakline's download under the old tap's release pattern, because installed apps accept only that. It also writes the "came through the old cask" channel field. Captain's part: run the local signing setup once before his next development launch; his old signing folder stays. Needs: 7, 8 and 9. Checked by: a hermetic launch moves a throwaway old profile; the verify mac lane builds and signs Oakline.app; Linux packages build; a stable dry-run rehearsal publishes nothing.

PHASE D - New repository (mostly the captain's clicks on GitHub, with a crewmate checking each one)
${step(11)} Delivers: acorn-labs/acorn is transferred to oakline-labs/acorn-archive. oakline-labs/oakline starts with one parentless commit of main's verified tree. The captain's app keeps the old project row, renamed to acorn-archive with the archive address; its key stays ACO, because a rename keeps the key. The app adds Oakline with its key. Captain's part: approve this app's GitHub access for the organization, transfer and create the repositories, enter the six secret values, and register the Mac mini runner. Needs: 10, and no other planned or running work in this project. Checked by: the new repository has exactly one commit with no parent, and no old tags or branches; ACO tasks still open their pull requests in the archive; a first pull request passes every check.

PHASE E - Ship Oakline
${step(12)} Delivers: oakline-labs/homebrew-tap and oakline@alpha. Existing users see nothing yet. Captain's part: create the tap and its publishing token (fine-grained tokens cannot span owners, so the old tap keeps its own). Needs: 11. Checked by: every release check in the new repository, the public download fetched back without a token and checked, and a throwaway Mac account that moves a copy of an old profile.
${step(13)} Delivers: the usual acorn@alpha update installs Oakline. From then on, every Oakline alpha also updates the old alpha cask and the frozen-schema old feeds. Needs: 12. Checked by: on a throwaway Mac account, the usual alpha upgrade lands on Oakline with work intact, and a Linux deb/rpm upgrade runs in a container.
${step(14)} Delivers: the Oakline stable, and the usual acorn update installs it. The captain picks its highlights first. Needs: 13, plus a wait he chooses. Checked by: the switch from the bridge stable, and from an older stable that skipped the bridge.

PHASE F - Finish
${step(15)} Delivers: a GitHub Pages site from oakline-labs/oakline. The casks' homepage and the GitHub sign-in app's page link to it. Needs: 11, and question 4. Checked by: the site opens for a visitor who is not signed in.
${step(16)} Delivers: his development setup checked end to end (two dev launches, the oakline-dev profile moved, old task links opening) and every remaining old name classified. Captain's part: rename the GitHub sign-in app, and update editor scripts and the Dock. Needs: 14. Checked by: the inventory command leaves only classified names.

Questions on the card, numbered, with my proposed answers:
1. Task key: OAK, as the captain chose, which keeps step 4 (proposed). The alternative is OAKL, the key the app derives today, which drops step 4.
2. Code names in step 8: rename every name with acorn in it, and keep the short code names built on ac, which no person sees (proposed). The alternative is to rename them all with aliases.
3. Alpha users switch one step after Oakline's first alpha, once the captain has tried it, as steps 12 and 13 (proposed). The alternative is the same step, merging 12 and 13.
4. Site: start it when the repository goes public, with the casks linking to the new tap's page until then (proposed). The alternative is now, after moving oakline-labs to a paid plan. There is also a site address field.

Assumptions:
- Steps 7 to 10 wait for step 6, because a stable promotion runs main's own release workflow.
- No app release goes out from step 7 until step 12. An urgent Acorn fix in that window waits for Oakline's first alpha.
- Code steps go through pull requests the captain merges. Autonomy stays off.
- The icon and design stay. The wordmark becomes the word Oakline in the current type.

Nothing in the project changed: I committed nothing, pushed nothing and filed nothing. When the captain picks "File these steps, start none", the first mate files the ${renameSteps.length} tasks under P with start on request. Their blockers follow each step's "Needs", with the captain's question answers applied.`;

const costPieces = [
  "Record each task's cost",
  "Show each task's cost on its tile",
  "Add the week's total to the board header",
];
const costPlan = `Spec: the task board shows what each task cost. Three pieces, merged apart so the stored numbers can be checked before anything shows them.

1. ${costPieces[0]}. Outcome: every finished turn stores its token count and estimated cost on its task. Checks: unit tests on the usage ledger. Needs: nothing.
2. ${costPieces[1]}. Outcome: each tile on the board shows its task's cost under the title, "unknown" when nothing was recorded. Checks: a before and after picture of the board. Needs: 1.
3. ${costPieces[2]}. Outcome: the board header shows the total cost of the tasks closed this week. Checks: a picture of the header with three closed tasks. Needs: 1.

Leaves alone: Settings and Usage. Out of scope: budgets and alerts.`;

export const stepTitleCases: StepTitleCase[] = [
  {
    id: "step-titles-sixteen-steps",
    role: "firstmate",
    expected: "wait",
    filing: "steps",
    steps: renameSteps,
    context: `The captain's words on the plan: "should the rename be broken down into several tasks reflecting the steps we planned? i want to precisely control when to do each step, not just the whole thing at once"
The captain chose "File these steps, start none" on PLAN's card, with the answers in its record. Process that choice. To fit this evaluation's request limit, file the steps in parallel: every create_task call in one response, then every blocks link in one response. No merge, discard, start or model change is authorized. These are isolated fictional records, not real backlog tasks.`,
    tasks: {
      P: { ...record("P", "Rename Acorn to Oakline", "open"), start_policy: "on-request" },
      PLAN: {
        ...record("PLAN", "Plan: break the Oakline rename into ordered steps", "done"),
        parent: "P",
        outcome: renamePlan,
        resolution: {
          action: "file",
          answers: [
            { name: "task-key", values: ["oak"], changed: false },
            { name: "code-names", values: ["rename-all"], changed: true },
            { name: "alpha-switch", values: ["after-trial"], changed: false },
            { name: "site", values: ["when-public"], changed: false },
            { name: "site-address", values: ["oakline.app"], changed: true },
          ],
          offer: {
            body: `Split the rename into ${renameSteps.length} steps in six phases, each its own task under the rename that waits for your Start and is blocked by the steps it needs.`,
            actions: [
              { id: "file", label: "File these steps, start none", default: true },
              { id: "abandon", label: "Abandon" },
            ],
          },
        },
      },
    },
  },
  {
    id: "step-titles-plan-pieces",
    role: "firstmate",
    expected: "start",
    filing: "pieces",
    steps: costPieces,
    context: `Original ask: "show what each task cost on the task board".
The captain chose "Approve and build" on PLAN's card, which records three separate pieces. BUILD is the build filed on request when the plan started and has never started. Process that choice. No merge, discard or model change is authorized. These are isolated fictional records, not real backlog tasks.`,
    tasks: {
      P: { ...record("P", "Show task cost on the board", "open"), start_policy: "on-request" },
      PLAN: {
        ...record("PLAN", "Plan: task cost on the board", "done"),
        parent: "P",
        outcome: costPlan,
        resolution: {
          action: "approve",
          answers: [],
          offer: {
            body: "Approve and build accepts the three-piece specification for showing task cost on the board; Save and defer keeps it for later.",
            actions: [
              { id: "approve", label: "Approve and build", default: true },
              { id: "save-and-defer", label: "Save and defer" },
              { id: "abandon", label: "Abandon" },
            ],
          },
        },
      },
      BUILD: {
        ...record("BUILD", "Build the accepted plan", "open"),
        parent: "P",
        basis: "PLAN",
        start_policy: "on-request",
      },
    },
  },
];
export const evaluation = { name: "step-titles", cases: stepTitleCases, host: approvalHost };

/** Each step the first mate filed or retitled, as it passed it: the raw words a reviewer reads. */
export function filedSteps(run: EvalRun): { task: string; title: string; goal?: string }[] {
  return (run?.calls ?? []).flatMap((call) => {
    if (call.name === "create_task")
      return [{ task: "new", title: String(call.args.title), goal: String(call.args.goal) }];
    if (call.name === "update_task" && call.args.title !== undefined)
      return [{ task: String(call.args.task), title: String(call.args.title) }];
    return [];
  });
}

/**
 * The texts that read the same as another once their numbers are taken out: "Rename
 * step 5 of 16" beside "Rename step 6 of 16", or a goal "Step 5 of the 16-step ...
 * plan" beside "Step 6 of the 16-step ... plan". Such a text names its step only by
 * its number; a text that also says what its step does differs from its siblings.
 */
export function numberedOnly(texts: readonly string[]): string[] {
  const shape = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(shape(text), (counts.get(shape(text)) ?? 0) + 1);
  return texts.filter((text) => (counts.get(shape(text)) ?? 0) > 1);
}

/** What the executed calls show, with no reviewer: the filed graph and numbered-only words. */
export function scoreStepTitleTrace(test: StepTitleCase, run: EvalRun): string[] {
  const failures: string[] = [];
  if (!run?.endedNormally) failures.push("The turn did not end normally");
  const calls = run?.calls ?? [];
  if (calls.some((call) => call.result !== "success"))
    failures.push("Refused, invalid or unobserved calls are not successful effects");
  if (calls.some((call) => ["settle_task", "interrupt_crewmate"].includes(call.name)))
    failures.push("Nothing here authorizes settling or interrupting");
  const filed = calls.filter((call) => call.name === "create_task");
  if (filed.some((call) => call.args.parent !== "P"))
    failures.push("File every step under the plan's parent");
  const starts = calls.filter(
    (call) =>
      call.name === "spawn_crewmate" ||
      (call.name === "update_task" && call.args.start_now === true),
  );
  if (test.filing === "steps") {
    if (filed.length !== test.steps.length)
      failures.push(`File exactly the plan's ${test.steps.length} steps`);
    if (starts.length) failures.push("File these steps, start none: start nothing");
  } else {
    if (filed.length !== test.steps.length - 1)
      failures.push("Reuse BUILD as the first piece and file each other piece once");
    if (filed.some((call) => call.args.basis !== "PLAN"))
      failures.push("Ground every piece on the plan");
    if (starts.length !== 1 || starts[0]?.args.task !== "BUILD")
      failures.push("Start exactly BUILD: pieces 2 and 3 need piece 1, so only it is ready");
    if (
      !calls.some(
        (call) => call.name === "update_task" && call.args.task === "BUILD" && call.args.title,
      )
    )
      failures.push("Title the reused BUILD as its piece");
  }
  const steps = filedSteps(run);
  const titles = numberedOnly(steps.map((filed) => filed.title));
  if (titles.length) failures.push(`Titles that differ only by a number: ${titles.join(" | ")}`);
  const goals = numberedOnly(steps.flatMap((filed) => (filed.goal ? [filed.goal] : [])));
  if (goals.length) failures.push(`Goals that differ only by a number: ${goals.join(" | ")}`);
  return failures;
}

export function scoreStepTitleRun(
  test: StepTitleCase,
  run: EvalRun,
  review: StepTitleReview,
): string[] {
  const failures = scoreStepTitleTrace(test, run);
  if (review?.titlesSayWhatEachStepDoes !== true)
    failures.push("A title does not say what its step does");
  if (!review?.quotations?.length) failures.push("Quote every title the review judged");
  return failures;
}
