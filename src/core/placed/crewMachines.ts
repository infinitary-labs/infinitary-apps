import type { CutOffClass } from "@shared/authFailure";
import type { InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { ComputerSignIns, signInPlace } from "@shared/signIns";
import type { placedTaskFolders, WorkingCopyBase, WorkOrderResponse } from "@shared/work";
import { type ContractChangeName, contractChange } from "../connection/contractChanges";
import type { JobExit } from "../jobs/jobManager";
import type { ComputerPool } from "../routing/computerPool";
import type { PersonalVersion } from "../session/personalSet";
import type { ModelSession, SessionFactories } from "../session/session";
import type { DependencyInstall } from "../workspace/workspaceService";
import type { PlacedCopy } from "./placedCopies";

/**
 * What the crew and the home's other parts read of the computers that run
 * work, and what they hand the home's side of those conversations
 * (`PlacedSessions`, docs/helper.md "The home's side"): the supervisor's
 * view of placed work, what it does for a placed task, and where a task's
 * browser there is heard.
 */

/**
 * A computer that keeps only the conversation it holds when asked to
 * reattach, and otherwise opens nothing until the home routes a new one
 * (`reattach-only-open.md`).
 */
export const REATTACH_ONLY_OPEN = contractChange("reattach-only-open");

/**
 * A reattach-only open found no conversation to keep there: nothing opened,
 * and the home routes the new conversation and asks for it
 * (`reattach-only-open.md`).
 */
export class NeedsNewConversation extends Error {
  constructor(taskId: string) {
    // i18n-exempt: an internal signal the home catches; no person reads it.
    super(`Task ${taskId} holds no conversation to reattach to there, so a new one opens.`);
    this.name = "NeedsNewConversation";
  }
}

/** What the supervisor does for the placed tasks (`CrewSupervisor`). */
export type PlacedHost = {
  /**
   * Opens the task's conversation on this Mac when no crewmate here holds it
   * - a restart left it, or its computer asks first - and resolves once it
   * is open.
   */
  adopt(taskId: string): Promise<void>;
  /** These tasks' computer is in reach and caught up: their lanes go on, and a waiting start may start. */
  caughtUp(taskIds: readonly string[]): void;
  /** A background job the crewmate's shell started there ended. */
  jobExit(taskId: string, exit: JobExit): void;
  /**
   * The task's conversation opened there again after that computer
   * restarted, in the session the crewmate here holds: one that started
   * over there is carried into its new conversation as at its open.
   */
  reopened(taskId: string): void;
  /**
   * The tool names this task's crewmate binds now, for the contract its
   * computer speaks. A reopen sends these when they differ from the names
   * it opened with, so a computer that restarted on a newer contract gets
   * a version-gated tool without this Mac restarting.
   */
  toolsNow?(taskId: string): readonly string[] | undefined;
  /**
   * The model a conversation that opens on `machine` again - after that
   * computer restarted, or a turn ended that an open found running there -
   * asks for, when the one it had left every level (docs/routing.md, "A
   * model that left every level"): another that computer serves, with its
   * own account there and the effort it opens at, and `commit`, which
   * records the move once that computer answers a conversation opened on
   * it. "wait" when none can take it, so it does not open on the one that
   * left; "stale" when a stop, a close or a move took the task meanwhile,
   * so nothing is sent. Undefined, answered at once when nothing can have
   * left, keeps the model it opened with. With `attach`, the conversation
   * is open there and the open may reattach to it, so no wait holds it and
   * it keeps its model when none can take it.
   */
  reopenModel?(
    taskId: string,
    machine: string,
    attach: boolean,
  ):
    | Promise<
        | {
            model: { provider: string; id: string };
            accountId?: string;
            thinking: { level: "low" | "medium" | "high" | "xhigh" | "off"; quick?: boolean };
            commit(): boolean;
          }
        | "wait"
        | "stale"
        | undefined
      >
    | undefined;
  /**
   * The conversation this crewmate holds did not open there again - no
   * model there can take it, or the one that can runs on the other backend
   * - so the crewmate here lets go of it: the task's next turn opens a new
   * one through the ordinary resume, which routes it again.
   */
  letGo?(taskId: string): void;
  /**
   * A computer the task moved off while it was out of reach is back and its
   * copy is kept (docs/helper.md, "Moving a task off a computer that is out
   * of reach"): the task's crewmate is told where, once.
   */
  awayCopyKept?(taskId: string): void;
};

/** A read a computer that runs work answered "ask again", and how long it had waited. */
export type AnsweredWait = { tool: string; waitedMs: number };

/** What the crew reads of the computers that run work (`CrewSupervisorOptions.machines`). */
export type CrewMachines = {
  /** The factories that open a conversation there; undefined when no computer can. */
  factories(machine: string): SessionFactories | undefined;
  /** The task's folders there, by the layout its roster named; undefined until it is read. */
  folders(machine: string, taskId: string): ReturnType<typeof placedTaskFolders> | undefined;
  /**
   * That computer keeps its tasks' own browsers, as its roster says
   * (docs/task-browser.md, "On another computer"); false until it is read.
   */
  keepsBrowsers?(machine: string): boolean;
  /** The task's computer is in reach and caught up, so its lane may go on. */
  ready(machine: string, taskId: string): boolean;
  /**
   * Whether the task's conversation is open there, as that computer's
   * roster says: an open reattaches to it rather than starting a new one.
   * True while the roster is unread, since nothing new can open then.
   */
  conversationOpen?(machine: string, taskId: string): boolean;
  /**
   * Whether that computer opens only the conversation it holds when asked to
   * reattach, and answers that a new one is needed otherwise
   * (`reattach-only-open.md`), so the home routes before anything new opens.
   */
  reattachOnly?(machine: string): boolean;
  /**
   * What that computer last said it serves, for a wait for a model to
   * compare (`TaskMoves.waitsForModel`); a sign-in it adds or an allowance
   * it reads again changes it.
   */
  servedState?(machine: string): string;
  /**
   * Since when the task's computer, in reach, has been catching up with it:
   * from the contact that brought the computer back, or from when its
   * conversation began opening on this Mac, whichever is later. Undefined
   * while the computer is out of reach or the task is caught up.
   */
  catchingUpSince?(machine: string, taskId: string): number | undefined;
  /**
   * Asks the task's computer, while in reach, whether its conversation is
   * working, and ends a turn the home still holds as running there once that
   * computer says it is not and every event it counted is in (INF-2332).
   * Answers whether that answer ended the turn here; false when it says the
   * turn works, ends nothing here, or never comes.
   */
  confirm?(taskId: string): Promise<boolean>;
  /**
   * Asks the task's computer, while in reach, to answer "ask again" each of
   * the app's own reads its conversation began by the newest event the home
   * has taken (INF-2603, major 15): asked after a quiet
   * stretch, each such read has waited at least that long. Answers the
   * reads it answered, each with how long it waited; none from a computer
   * without the change, or out of reach.
   */
  answerReads?(taskId: string): Promise<AnsweredWait[]>;
  /**
   * Whether the computer's crewmates can report a typed result
   * (`report-result.md`); false while the home cannot tell.
   */
  takesResults?(machine: string): boolean;
  /**
   * Whether the computer, connected now, listed the change in its hello;
   * false while it is not connected (`ComputerBehindError`).
   */
  listsChange?(machine: string, change: ContractChangeName): boolean;
  /** Individually correlated responses, saved immediately at home. */
  takesResponses?(machine: string): boolean;
  /**
   * Whether the computer's crewmates read a shared-card write's typed result
   * (the current work major, docs/card-threads.md "Shared cards"); false while the
   * home cannot tell.
   */
  takesSharedCards?(machine: string): boolean;
  /** The computer understands current check declarations and offer-based readiness. */
  takesCheckDeclarations?(machine: string): boolean;
  /**
   * Whether the computer tells the home each time a conversation it holds
   * folds its context (the current work major), so a crewmate there is sent
   * its directions only again after a fold or a change; false while the
   * home cannot tell.
   */
  reportsFolds?(machine: string): boolean;
  /**
   * The task's working copy there, made now or found as it was: its
   * project cloned there once, then a working copy on the task's branch,
   * `branch` when its record saved none yet (docs/helper.md, "Its working
   * copies").
   */
  prepare(
    machine: string,
    taskId: string,
    repoId: string | null,
    base?: WorkingCopyBase,
    branch?: string,
  ): Promise<PlacedCopy>;
  /**
   * Copy a source file to the task folder, returning its verified path
   * there; `handover` keeps it in the task's hand-over folder instead.
   */
  sourceFile?(
    machine: string,
    taskId: string,
    name: string,
    file: string,
    into?: "handover",
  ): Promise<string>;
  /**
   * Whether the computer takes files one task hands another
   * (`handover-files.md`); false while the home cannot tell.
   */
  takesHandover?(machine: string): boolean;
  /**
   * Whether the computer removes files from outside from a task's
   * hand-over folder when they are due; false while the home cannot tell.
   */
  takesOutsideFiles?(machine: string): boolean;
  /** Carry a home ref into the destination repository before naming it in the brief. */
  sourceRef?(
    machine: string,
    taskId: string,
    repoId: string | null,
    sourceId: string,
    ref: string,
  ): Promise<string>;
  /** A committed revision and its changed-file list, read on that computer. */
  revision(
    machine: string,
    taskId: string,
    headSha?: string,
    /** The approved version the task started on, read from there while its head builds on it. */
    builtOn?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:revision">>;
  /**
   * Whether the computer takes a task with no project (`speaksSeed`); absent
   * where the home cannot tell.
   */
  takesRepoless?(machine: string): boolean;
  /**
   * Whether the computer gives its crewmates the home's knowledge
   * (`speaksKnowledge`, docs/knowledge.md "Who has it"); false while the
   * home cannot tell.
   */
  takesKnowledge?(machine: string): boolean;
  /**
   * Whether the computer gives its crewmates the home's integrations
   * through `infinitary-integrations-axi` (docs/integrations.md, "On a
   * computer that runs work"); false while the home cannot tell.
   */
  takesIntegrations?(machine: string): boolean;
  /** Metadata-only Secrets catalog through the authenticated task channel. */
  takesSecrets?(machine: string): boolean;
  /**
   * Whether the computer's Secrets command asks the home for uses, whose
   * programs run there (docs/secrets.md, "On a computer that runs work").
   */
  takesSecretUses?(machine: string): boolean;
  /**
   * Whether the computer's Secrets command asks the home to keep a secret,
   * raised on the home's own card (docs/secrets.md, "Asking to keep a secret").
   */
  takesSecretAsks?(machine: string): boolean;
  /**
   * Whether the computer gives its crewmates `infinitary-files-axi`, each
   * list and copy asked of the home (docs/files.md); false while the home
   * cannot tell.
   */
  takesFiles?(machine: string): boolean;
  /**
   * Whether the computer gives its crewmates `infinitary-stops-axi` and runs
   * their stops at the close (docs/leftover-programs.md); false while the home
   * cannot tell.
   */
  takesStops?(machine: string): boolean;
  /**
   * Whether that computer serves show_merge_card (INF-3717 piece 2): every
   * one admitted to work on this contract major does. One on another major
   * keeps prepare_change, open_change and emit_card.
   */
  takesMergeCardCall?(machine: string): boolean;
  /**
   * Whether the computer's crewmates put files on their cards
   * (docs/card-authoring.md "Files for the captain"); false while the home
   * cannot tell.
   */
  takesCardFiles?(machine: string): boolean;
  takesChangePresentations?(machine: string): boolean;
  /** The working copy's dependencies, installed there; a failure is an outcome. */
  install(machine: string, taskId: string): Promise<DependencyInstall>;
  /**
   * Whether the computer takes a started task's move to or from it
   * (docs/helper.md, "Moving a started task"); false while the
   * home cannot tell.
   */
  takesMoves?(machine: string): boolean;
  /** Packs a task's work there to move it, into `pack` here (`PlacedCopies.moveOut`). */
  moveOut?(
    machine: string,
    taskId: string,
    attempt: string,
    pack: string,
    keep?: readonly string[],
  ): Promise<{ head: string; branch: string; repoDir: string }>;
  /** Makes a moving task's working copy there from the work packed here (`PlacedCopies.moveIn`). */
  moveIn?(
    machine: string,
    taskId: string,
    attempt: string,
    input: { repoId: string | null; head: string; branch: string; pack: string },
  ): Promise<PlacedCopy>;
  /** Removes the copy a move off that computer left there while it was out of reach (`PlacedCopies.removeAwayCopy`). */
  removeAwayCopy?(machine: string, taskId: string): Promise<void>;
  /** Removes a working copy a move left there (`PlacedCopies.retireMoved`). */
  retireMoved?(machine: string, taskId: string): Promise<void>;
  /**
   * A moved task's conversation starts over where it runs now: what this Mac
   * kept of its conversation on the computer it left - the newest event, the
   * callbacks answered - is set aside, so the new one's numbers start fresh.
   */
  forgetExecution?(taskId: string): void;
  /** What the task's working copy there holds unmerged; null while nobody can tell. */
  workStatus(taskId: string): Promise<{ dirty: boolean; unlandedCommits: number } | null>;
  /**
   * The task's branch, brought here from there before this Mac's own git
   * reads it; answers the repository here it reads it in. `branch` names
   * another branch the crewmate checked out there (INF-2490).
   */
  bringBranchHome(taskId: string, strict?: boolean, branch?: string): Promise<string | undefined>;
  /**
   * What this Mac holds of the task's branch, read without its computer
   * (`PlacedCopies.homeCopy`): the commit, when it was brought here when
   * known, the branch and the repository here. Undefined when this Mac
   * holds none of its commits.
   */
  homeCopy?(
    taskId: string,
  ): Promise<{ head: string; at?: number; branch: string; repoDir: string } | undefined>;
  /** The branch the task's working copy there has checked out, and its commit (INF-2490). */
  checkedOut(taskId: string): Promise<{ branch: string | null; head: string } | null>;
  /** The computers that run work on the list, by device id. */
  computers(): readonly string[];
  /** The computer's name, as Devices lists it. */
  nameOf(machine: string): string;
  /** How the home's words place the computer (`signInPlace`): "Mac mini", "Running as Builder". */
  placeOf(machine: string): ReturnType<typeof signInPlace>;
  /**
   * What the computer's own sign-ins serve, as it last said of them: the
   * models a task that runs there is routed among, and the account there
   * for each model and each provider (docs/helper.md, "Its own sign-ins").
   * Never this Mac's sign-ins.
   */
  served(machine: string): Promise<ComputerPool>;
  /**
   * What the computer last said of its own sign-ins, asked now when it has
   * said nothing yet and is in reach; null when it cannot say. A task about
   * to start there reads whether it has any sign-in at all, and one for the
   * host its project lives on, before anything is tried there.
   */
  signInsOf(machine: string): Promise<ComputerSignIns | null>;
  /**
   * The computer's own account a conversation held there is bound to, as
   * that computer last said (`PlacedState.accountId`): the one its usage is
   * booked on. Never one of this Mac's accounts; undefined when it named none.
   */
  servingAccount(session: ModelSession): string | undefined;
  /**
   * The same account for a task, keyed as the cut-off contract names an
   * account (`<account>@<computer>`, never one of this Mac's ids): from its
   * open conversation, else the computer's roster. Undefined when it names
   * none, or nothing has said yet.
   */
  accountOf(machine: string, taskId: string): string | undefined;
  /**
   * The version of the home's personal instructions and skills a task's
   * conversation there read when it opened (docs/personal-resources.md);
   * undefined when it read none, or its computer did not say.
   */
  personalOf?(taskId: string): PersonalVersion | undefined;
  /**
   * The cut-off that computer last said stands on an account `accountOf`
   * keyed (docs/helper.md, "Its own sign-ins"); undefined for none, and for
   * a key of this Mac's own.
   */
  cutOffOf(account: string): { class: CutOffClass; since: number; resetsAt?: number } | undefined;
  /**
   * Whether that computer has said anything of its sign-ins since this Mac
   * started, so a cut-off on the account is known to stand or to be over;
   * true for a key of this Mac's own.
   */
  knows(account: string): boolean;
  /** The account's provider and where it is ("on Mac mini"), for a key `accountOf` made. */
  accountPlace(account: string): { provider: string; where: string } | undefined;
  /**
   * The computer's own sign-in a cut-off alone keeps from serving a task
   * there, as it last said, when nothing else there serves: a task for it
   * waits until it serves again. Undefined when something there serves,
   * nothing would, or it has said nothing yet.
   */
  signInWait(
    machine: string,
  ): { account: string; provider: string; class: CutOffClass; resetsAt?: number } | undefined;
};

/** What a task's browser on a computer tells this Mac, by the computer that asked. */
export type PlacedBrowserSink = {
  /** The captain's private sites list, lent to a task's browser there as it opens a page. */
  privateSiteList?: () => string[];
  automaticSignIn?: (
    task: string,
    site: string,
  ) => InvokeResponse<"inf:work:browser-sign-in">["signIn"];
  heardFact: (
    deviceId: string,
    task: string,
    fact: InvokeRequest<"inf:work:browser">[0]["fact"],
  ) => void;
  heardFrame: (task: string, frame: InvokeRequest<"inf:work:browser-frame">[0]["frame"]) => void;
  heardEvent: (
    deviceId: string,
    task: string,
    event: InvokeRequest<"inf:work:browser-event">[0]["event"],
  ) => void;
};
