import type { FmEvent } from "@shared/events";
import { englishOf, saidLine } from "@shared/i18n/said";
import { PULL_REQUEST_COMMENTS_WAKE } from "@shared/pullComments";
import { noChecksSaid, repoConfiguredEvent } from "@shared/repos";
import { pushBatch } from "../batches/combine";
import type { StandingDirections } from "../knowledge/directions";
import {
  type AppPaths,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateTempDir,
} from "../paths";
import type { PlacedSessions } from "../placed/placedSessions";
import type { Runbooks } from "../runbooks/runbooks";
import type { InboxStore } from "../storage/inboxStore";
import type { TaskService } from "../tasks/taskService";
import type { ProjectContributions } from "../workspace/projectContributions";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { type ChangeDelivery, createChangeDelivery } from "./changeDelivery";
import { ChangePresentations } from "./changePresentations";
import type { CrewSupervisor } from "./crewSupervisor";
import type { FirstmateAgent } from "./firstmateAgent";
import { GithubGatewayService } from "./githubGateway";
import { createOwnBatches } from "./ownBatches";
import type { Ticker } from "./ticker";
import { WorkflowEvidenceService } from "./workflowEvidence";

/**
 * Home wiring for delivering a change (docs/forge.md): the evidence reader, the
 * saved stories, the project's own batches, the delivery tools and the GitHub
 * gateway a crewmate's tools reach, built together because each reads the others.
 */
export function startHomeChangeDelivery({
  tasks,
  repos,
  forgeFor,
  accountForge,
  directions,
  placed,
  paths,
  namingRule,
  runbooks,
  ticker,
  inbox,
  broadcastEvent,
  beforeAct,
  later,
}: {
  tasks: TaskService;
  repos: RepoRegistry;
  forgeFor: ConstructorParameters<typeof WorkflowEvidenceService>[0]["forgeFor"];
  accountForge: ConstructorParameters<typeof GithubGatewayService>[0]["accountForge"];
  /** The standing directions, whose heard captain-origin rows a kept write may name as its yes. */
  directions: Pick<StandingDirections, "standing">;
  placed: Pick<PlacedSessions, "copies" | "bringBranchHome" | "checkedOut">;
  paths: AppPaths;
  namingRule: () => ReturnType<Runbooks["naming"]>;
  runbooks: Pick<Runbooks, "mapPart" | "wakes" | "subscribe">;
  ticker: Pick<Ticker, "now" | "register">;
  inbox: InboxStore;
  broadcastEvent: (event: FmEvent) => void;
  beforeAct: () => Promise<void>;
  /** Owners built after this one, read when a callback runs. */
  later: {
    supervisor: () => Pick<CrewSupervisor, "settling" | "reportIntake">;
    firstmate: () => FirstmateAgent | undefined;
    projectContributions: () => Pick<ProjectContributions, "prepareTask">;
  };
}) {
  const workflowEvidence = new WorkflowEvidenceService({
    tasks,
    repos,
    forgeFor,
    writeElsewhere: (taskId, deviceId, artifact) =>
      placed.copies.writeArtifact(taskId, deviceId, artifact),
    partsElsewhere: (deviceId) => placed.copies.writesArtifactParts(deviceId),
    evidenceDir: (taskId) => crewmateEvidenceDir(paths, taskId),
    tempDir: (taskId) => crewmateTempDir(paths, taskId),
    filesElsewhere: (deviceId) => placed.copies.writesEvidenceFiles(deviceId),
    fileElsewhere: (taskId, deviceId, name, file) =>
      placed.copies.writeEvidenceFile(taskId, deviceId, name, file),
  });
  const presentations: ChangePresentations = new ChangePresentations({
    namingRule,
    tasks,
    mediaDir: (taskId) => crewmateCardPicturesDir(paths, taskId),
    head: (taskId) => changeDelivery.publication.presentationHead(taskId),
    branch: (taskId) => changeDelivery.publication.presentationBranch(taskId),
    mapPart: () => runbooks.mapPart(),
  });
  const prepareContribution = (taskId: string) =>
    later.projectContributions().prepareTask(taskId, tasks);
  const batches = createOwnBatches({
    repos,
    forgeFor,
    ticker,
    tasks,
    presentations,
    inbox,
    late: () => ({
      checks: changeDelivery.checks,
      comments: changeDelivery.comments,
      settling: later.supervisor().settling,
    }),
    firstmate: () => later.firstmate(),
    note: (fact) => broadcastEvent({ type: "firstmate_note", ...saidLine(fact) }),
    // The Batches panel reads the project again (docs/forge.md, "The Batches panel").
    checksRead: (repoId) => broadcastEvent({ type: "batch_checks", repoId }),
    namingRule,
    git: {
      push: async (input) => {
        await beforeAct();
        return pushBatch(input);
      },
    },
  });
  const changeDelivery: ChangeDelivery = createChangeDelivery({
    namingRule,
    tasks,
    repos,
    presentations,
    prepareContribution,
    // The forge seam (git integration PR 1.1): GitHub is the REST forge with
    // the app's own GitHub sign-in (PR 1.2), read at each request. A 401
    // asks the sign-in service to look again; its health read is the proof.
    forgeFor,
    batches: () => batches,
    onNote: (text, taskId) => broadcastEvent({ type: "firstmate_note", text, taskId }),
    steer: (taskId, wake) => {
      if (wake.once === undefined) inbox.enqueue(taskId, wake);
      else if (!inbox.woken(taskId, wake.once))
        inbox.enqueueSteerOnce(taskId, { ...wake, once: wake.once });
    },
    commentsWatched: () => runbooks.wakes().has(PULL_REQUEST_COMMENTS_WAKE),
    bringBranchHome: (taskId, strict, branch) => placed.bringBranchHome(taskId, strict, branch),
    checkedOut: (taskId) => placed.checkedOut(taskId),
    verifyValidationEvidence: (taskId) =>
      later.supervisor().reportIntake.verifyValidationEvidence(taskId),
    proofDir: (taskId) => crewmateCardPicturesDir(paths, taskId),
    now: ticker.now,
  });
  // A project's batch changed (docs/forge.md, "Batches of your own"): Settings reads it again.
  repos.onBatch((repo) => broadcastEvent({ type: "repo_batch", repoId: repo.id }));
  // Which runbooks are on may have changed: a window reads them again for the
  // panels a built-in runbook shows (docs/runbooks.md, "Panels").
  runbooks.subscribe(() => broadcastEvent({ type: "runbooks_changed" }));
  // The app started or ended a project's no-checks record (docs/forge.md, "A
  // project with no checks"): one Activity line, and Settings reads it again.
  repos.onNoChecks((repo, change) => {
    const line = noChecksSaid(repo.name, change);
    broadcastEvent({ ...repoConfiguredEvent(repo), description: englishOf(line), said: line });
  });
  const githubGateway = new GithubGatewayService({
    tasks,
    repos,
    forgeFor,
    accountForge: accountForge,
    readChecks: (taskId) => changeDelivery.checkTool.checkForCrew(taskId),
    beforeValidationWrite: (taskId, request, write): Promise<void> =>
      later.supervisor().reportIntake.consumeValidationEffect(taskId, request, write),
    watchRun: (taskId, runId) => workflowEvidence.watchStarted(taskId, runId),
    now: ticker.now,
    directions,
  });
  return { workflowEvidence, batches, changeDelivery, githubGateway };
}
