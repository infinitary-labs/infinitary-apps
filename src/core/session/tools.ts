import type { CardEffect, CardPicture, LiveAttachment } from "@shared/cards";
import type { CheckChangeInput } from "@shared/checkRepair";
import type { CrewSpeed, SpeedSelection } from "@shared/crewSpeed";
import type { InvokeRequest } from "@shared/ipc";
import type { RequiredAction } from "@shared/requiredActions";
import type { RiskAssessment, RiskDeclaration } from "@shared/risk";
import { type Static, type TObject, type TUnsafe, Type } from "typebox";
import type { CrewmateBrowser } from "../browser/taskBrowsers";
import type {
  DownloadArtifactInput,
  GithubReadInput,
  GithubWriteInput,
  ReadWorkflowInput,
} from "../forge";
import type { RecordInput } from "../knowledge/knowledgeService";
import type { PanelCaptureResult } from "../personal/personalExtensions";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import type { CardRefusal, CardRefusalReason } from "../storage/taskStore";
import type { TaskQueryInput, TaskQueryRow } from "../tasks/taskQuery";
import type { ReportDeclaration } from "../tasks/taskService";

/**
 * One tool spec for every seat and both runtimes (primitives P7). A tool is
 * written once - its name, the words the model reads, its parameters and
 * what it does - as a bound tool, and each runtime generates its own tool
 * from that entry: `piToolOf` behind the Pi fence (`src/core/pi/toolSpec.ts`),
 * `claudeToolOf` behind the Claude one (`src/core/claude/claudeTaskTools.ts`).
 * This half imports neither runtime, so the session contract names a tool
 * without reaching into a backend's directory. A rule reaches both twins in
 * one edit, and the self-source pin reads the same lists the runtimes serve
 * (`CREWMATE_TOOLS` in `pi/crewmateTaskTools.ts`, `FIRSTMATE_TOOLS` below).
 *
 * A crewmate tool is an entry that binds to one crewmate's callbacks; the
 * Firstmate's factories bind to the host at once. Either way the result is
 * the same bound tool.
 *
 * The parameters are typebox, which is plain JSON Schema: Pi takes it as
 * is, and the Claude generator reads the same schema. A rule a Claude
 * model must see lives in the description or a top-level parameter's
 * description, because the Claude client drops every nested one
 * (`docs/claude-client.md`).
 */

/**
 * A declared card action (cards/tasks/agents P1): `default` marks the
 * proposed step, `effect` what the host does on the click - settle or open,
 * the only host semantics an agent may declare (ruling D2); the host kind is
 * refused at every emit boundary - and `danger` a destructive choice. No
 * effect: the click is a reply. Every declared action closes its card; the
 * non-closing `keepsOpen` is retired (contract 4.65); migration 73 drops
 * saved keep-open actions before the legacy click path is removed.
 */
export type EmittedAction = {
  id: string;
  label: string;
  default?: boolean;
  effect?: CardEffect;
  danger?: boolean;
};

/**
 * One card shape (ruling D1 a): no kind. A card with actions is a decision,
 * one without is a note; the host derives everything else.
 */
export type EmittedCardInput = {
  title: string;
  body: string;
  /** Current published story revision, resolved by the home before any card lint. */
  presentationRevision?: number;
  requiredActions?: RequiredAction[];
  actions: EmittedAction[];
  /** Stable kebab-case id; reuse to revise an open card in place. */
  id?: string;
  /** Task named by a Firstmate settle/merge decision. */
  taskId?: string;
  /** The independent review whose findings the first mate relays; host validates reviewOf. */
  reviewTaskId?: string;
  /** The pictures the tool verified in the body, for the card row (card pictures, phase 2). */
  pictures?: CardPicture[];
  /** The author's width hint: it can only widen what the body's facts ask for. */
  width?: "wide" | "full";
  holdsPlace?: boolean;
  /** The author's short answer to the captain's reply in this card's thread (`reply` on the tool). */
  reply?: string;
  /**
   * The label a crewmate gave its task's browser button (`browser_button`),
   * which the host turns into `attachment` from the browser it holds, or
   * refuses (docs/task-browser.md, "From a card").
   */
  browserButton?: string;
  /**
   * A crewmate's request that the captain take over its task's browser
   * (`browser_handoff`, docs/task-browser.md "Asking for help"): the site it
   * is on, why it needs him, and what it does once control comes back. The
   * host pauses the browser before the card goes up, or refuses the card.
   */
  browserHandoff?: { site: string; reason: string; after: string };
  /**
   * The HTML file in its task's project that a crewmate's browser button
   * opens (`browser_page`, docs/task-browser.md "A page from the project"):
   * the host checks it and turns the button into `attachment`, or refuses.
   */
  browserPage?: string;
  /** The live attachment the host resolved; never the author's to write. */
  attachment?: LiveAttachment;
  /**
   * The risk a crewmate declared on its completion card (`risk`,
   * docs/card-authoring.md "The risk chart"), which the host keeps as `risk`.
   */
  riskDeclaration?: RiskDeclaration;
  /** The risk assessment the host resolved; never the author's to write. */
  risk?: RiskAssessment;
  /** Declared: this card still asks a question and is not the ready plan. */
  asking?: boolean;
  /** Declared: this offer is design-only. Not inferred from its sentences. */
  designOnly?: boolean;
};

/**
 * An action as a crewmate's emit_card declares it: an `EmittedAction` whose
 * label may be missing. A completion decision's settle actions are the
 * host's to word (`CrewSupervisor.withCompletionActions`), so the crewmate
 * is told to declare no labels and its schema asks for none (FI3-249); the
 * host refuses any action it keeps that has no words.
 */
export type DeclaredAction = Omit<EmittedAction, "label"> & { label?: string };

/** A crewmate's card as its tool hands it to the host, before the host words its own buttons. */
export type DeclaredCardInput = Omit<EmittedCardInput, "actions"> & { actions: DeclaredAction[] };

/** Fail the build if a declared tool field has no place in its work request. */
type CarriedFields<T extends never> = T;
export type PlacedToolFieldCoverage = CarriedFields<
  | Exclude<
      keyof Omit<DeclaredCardInput, "taskId" | "reviewTaskId" | "attachment" | "risk">,
      keyof InvokeRequest<"inf:work:card">[0]["card"]
    >
  | Exclude<keyof CheckChangeInput, keyof InvokeRequest<"inf:work:check-change">[0]["input"]>
  | Exclude<keyof KnowledgeReadInput, keyof InvokeRequest<"inf:work:knowledge">[0]["input"]>
  | Exclude<keyof RecordInput, keyof InvokeRequest<"inf:work:record-knowledge">[0]["input"]>
>;

/**
 * A card the host refused, typed: `message` is the tool text the author
 * reads, `reason` and `why` the fact the host records when the card was a
 * completion card (`CrewmateToolDelegate.onCardRefused`). Any other error
 * the card tool throws records as `other`, with its message as the why.
 */
export class CardRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: CardRefusalReason,
    readonly why: string,
  ) {
    super(message);
    this.name = "CardRefusedError";
  }
}

/**
 * A change that went out and whose answer never came: it may already be
 * done, so nobody knows its outcome. A completion card that ends this way
 * may already be up, so the card tool records no refusal for it (INF-370 R1).
 */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

/**
 * A card's actions, each with the words its author gave, once the host has
 * worded its own (`DeclaredAction`). An action with no words, or blank
 * ones, would be a button that says nothing, so the card is refused.
 */
export function labeledActions(actions: readonly DeclaredAction[]): EmittedAction[] {
  return actions.map(({ label, ...action }) => {
    if (label === undefined || !label.trim()) {
      const why = `action "${action.id}" has no label. Give each action you declare a short label; only a completion decision's settle actions take theirs from the app.`;
      throw new CardRefusedError(`Card refused: ${why}`, "shape", why);
    }
    return { ...action, label };
  });
}

/** The recorded reason and words for whatever stopped a card. */
export function cardRefusalOf(error: unknown): Pick<CardRefusal, "reason" | "why"> {
  if (error instanceof CardRefusedError) return { reason: error.reason, why: error.why };
  return { reason: "other", why: error instanceof Error ? error.message : String(error) };
}

/**
 * A follow-up a crewmate files from its own task (task-system P2,
 * `file_followup`): work it found that it should not do itself.
 */
export type FollowupInput = {
  title: string;
  goal: string;
  why: string;
  /** The crewmate's own task cannot finish until this lands. */
  blocksMe?: boolean;
  /** The follow-up is a test failure, so testPath is required. */
  testFailure?: boolean;
  /** The failing test's path. The host dedupes open rows on it. */
  testPath?: string;
};

/** A callback's answer, now or later. */
type Awaitable<T> = T | Promise<T>;

/** A read of knowledge, as the `knowledge` tool passes it on (docs/knowledge.md). */
export type KnowledgeReadInput = {
  action: "search" | "get" | "neighbors" | "history";
  query?: string;
  ids?: string[];
  id?: string;
  revision?: number;
  scope?: string;
  cursor?: string;
};

/**
 * Knowledge, bound to one reader and writer (docs/knowledge.md): the host
 * makes it for Firstmate and for each crewmate in every build; a crewmate
 * on a computer that runs work asks the home to run it. Both answer the
 * words the model reads.
 */
export type KnowledgeBinding = {
  read: (input: KnowledgeReadInput, signal?: AbortSignal) => Awaitable<string>;
  record: (input: RecordInput, signal?: AbortSignal) => Awaitable<string>;
};

/**
 * What a crewmate tool runs on: the host's callbacks for one crewmate, plus
 * the task and working copy a card's pictures are verified against. Every
 * field is optional; a tool binds only when the callbacks it needs are
 * there. A callback may answer later - a conversation held on a computer
 * that runs work asks its home for each (src/core/helper/sessionHost.ts) -
 * and every tool awaits it. A callback that asks the home takes that
 * tool's own cancellation last, and only when the runtime gave this call
 * one; a refusal record is not that request.
 */
export type CrewmateToolDelegate = {
  /** A request policy read from the home, not an agent tool or transported credential. */
  onSpeed?: (
    model: { provider: string; id: string; name?: string },
    selection: SpeedSelection,
  ) => void;
  requestedSpeed?: (model: { provider: string; id: string }) => CrewSpeed | Promise<CrewSpeed>;
  taskId?: string;
  /** The working copy the crewmate operates in. */
  cwd?: string;
  /**
   * Where the host keeps copies of the pictures this crewmate's cards name
   * (`crewmates/<taskId>/cards`, card pictures phase 2). Absent, a card that
   * names a picture from the working copy is refused.
   */
  picturesDir?: string;
  /** Author-editable UTF-8 card bodies, outside the working copy. */
  cardBodiesDir?: string;
  /**
   * This task's evidence folder (`crewmates/<taskId>/evidence`), named in the
   * crewmate's instructions; a card may name a picture inside it by absolute
   * path.
   */
  evidenceDir?: string;
  /**
   * The host's isolated decoder for demo recordings (docs/card-authoring.md
   * "Demo recordings"). Absent, a card that names a recording is refused.
   */
  probeMedia?: MediaProbe;
  /**
   * The host's isolated loader for a preview's project fonts
   * (docs/card-authoring.md "Fonts by reference"). Absent, a card that names
   * a font file is refused.
   */
  probeTypeface?: TypefaceProbe;
  /**
   * Receives cards the crewmate emits through its card tool, as declared:
   * the host words a completion decision's buttons. A completion card's
   * merge decision may clear a live CI gate first (the standing CI rule's
   * host-side counterpart), so this may return a promise.
   */
  onCard?: (
    card: DeclaredCardInput,
    signal?: AbortSignal,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * A card declaring a settle effect - the completion card - that the card
   * tool refused, at whatever step refused it, so the host records the
   * refusal as a fact beside the crewmate's own account of its turn.
   */
  onCardRefused?: (refusal: Omit<CardRefusal, "at">) => void;
  /** Dismiss a card this crewmate emitted. Unknown or foreign ids must throw. */
  onCloseCard?: (
    input: { cardId: string; reason?: string },
    signal?: AbortSignal,
  ) => Awaitable<string>;
  /** File a follow-up under this crewmate's task (P2). Returns the tool text. */
  onFollowup?: (input: FollowupInput, signal?: AbortSignal) => Awaitable<string>;
  /**
   * One progress line onto this crewmate's own timeline (P2), with the
   * whole plan when the note carries one (FI3-734). Returns the tool text.
   */
  onProgress?: (text: string, plan?: unknown, signal?: AbortSignal) => Awaitable<string>;
  /**
   * The crewmate's explicit report for the turn in flight (WI-1), with its
   * own one-line headline when it gave one. Returns the tool text.
   */
  onReport?: (
    text: string,
    summary?: string,
    declared?: ReportDeclaration,
    signal?: AbortSignal,
  ) => Awaitable<string>;
  /**
   * The crewmate's answer in one of its own cards' threads (cards-as-threads
   * phase 1): prose the host renders as a message under the card, never a
   * second card. Returns the tool text, refusals included.
   */
  onReply?: (input: { cardId: string; text: string }, signal?: AbortSignal) => Awaitable<string>;
  /**
   * The read-only tasks query (cards/tasks/agents P0, WI-4): every crewmate
   * can search the backlog before filing, the way every engineer can read
   * the tracker. Reads only; the crewmate still writes nothing on the graph.
   */
  onQueryTasks?: (
    input: TaskQueryInput,
    signal?: AbortSignal,
  ) => Awaitable<{ rows: TaskQueryRow[]; total: number }>;
  /**
   * The live-build checks (talk-to-personalize Step 4), handed only to a
   * crewmate on the personal workspace: the adherence lint over the extension's
   * files, and a screenshot of the docked panel in both themes.
   */
  onLintPanel?: (input: { id?: string }) => Promise<string>;
  onCapturePanel?: (input: { id: string }) => Promise<PanelCaptureResult>;
  /**
   * The pair where the project lives (git integration PR 1.2), handed to a
   * crewmate whose task ships a change: offer the branch as a proposed
   * change, and read its checks, through the app's own sign-in.
   */
  onPrepareChange?: (
    input: import("@shared/changePresentation").StagedChangePresentation,
    signal?: AbortSignal,
  ) => Promise<string>;
  onOpenChange?: (
    input: import("@shared/changePresentation").OpenChangeInput,
    signal?: AbortSignal,
  ) => Promise<string>;
  onCheckChange?: (input?: CheckChangeInput, signal?: AbortSignal) => Promise<string>;
  /** Read-only evidence through the project's forge and the app's sign-in. */
  onReadWorkflow?: (input: ReadWorkflowInput, signal?: AbortSignal) => Promise<string>;
  onDownloadArtifact?: (input: DownloadArtifactInput, signal?: AbortSignal) => Promise<string>;
  /** Project-scoped JSON REST through the app's sign-in; the write is for a change-shipping task. */
  onGithubRead?: (input: GithubReadInput, signal?: AbortSignal) => Promise<string>;
  onGithubWrite?: (input: GithubWriteInput, signal?: AbortSignal) => Promise<string>;
  /**
   * This task's own browser (docs/task-browser.md), handed to a crewmate
   * whose task runs on this Mac when the host has one.
   */
  browser?: CrewmateBrowser;
  /**
   * The captain's factual knowledge (docs/knowledge.md), handed to every crewmate, in every build: on a
   * computer that runs work, each call asks the home.
   */
  knowledge?: KnowledgeBinding;
};

/** A tool's answer, whichever runtime carries it: the text, then any pictures. */
export type ToolOutput = {
  text: string;
  images?: ReadonlyArray<{ data: string; mimeType: string }>;
  /**
   * A structured record Pi keeps beside the result in its transcript. No
   * model reads it, and the Claude client has no place for it.
   */
  details?: Record<string, unknown>;
};

export type ToolRun = (params: unknown, signal?: AbortSignal) => Promise<ToolOutput>;

/**
 * One tool bound to what it runs on: the unit both runtimes serve. The name
 * and parameters stay typed where a tool is declared, so a call scripted
 * against the live set (`ToolCallOf`) is checked by the compiler.
 */
export type BoundTool<N extends string = string, T extends TObject = TObject> = {
  name: N;
  /** Pi's display label; the Claude client has none. */
  label: string;
  description: string;
  parameters: T;
  run: ToolRun;
};

/** The call a model makes of a tool: its name and the arguments its parameters accept. */
export type ToolCallOf<Tool> = Tool extends { name: infer N; parameters: infer T extends TObject }
  ? { name: N; args: Static<T> }
  : never;

/**
 * Declare a bound tool. The parameters type the run's params; the entry is
 * then held by the runtime-neutral shape both generators read.
 */
export function boundTool<const N extends string, T extends TObject>(spec: {
  name: N;
  label: string;
  description: string;
  parameters: T;
  run: (params: Static<T>, signal?: AbortSignal) => ToolOutput | Promise<ToolOutput>;
}): BoundTool<N, T> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    run: async (params, signal) =>
      signal === undefined ? spec.run(params as Static<T>) : spec.run(params as Static<T>, signal),
  };
}

/**
 * A parameter that takes one of a fixed set of words, written as one string
 * with an `enum` rather than a union of literals. Both validate the same
 * values; the union spells `{"type":"string","const":...}` once per value in
 * the schema every model reads on every request, which is most of what a
 * choice costs there (contract v4.59, the fixed-context trim).
 */
export function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string },
): StringEnum<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description !== undefined ? { description: options.description } : {}),
  }) as StringEnum<T[number]>;
}

/** The schema `stringEnum` writes: its value type for typebox, its keywords for a reader of the schema. */
export type StringEnum<V extends string> = TUnsafe<V> & {
  type: "string";
  enum: V[];
  description?: string;
};

/** One crewmate tool, before it is bound to a crewmate's callbacks. */
export type CrewmateTool<N extends string = string, T extends TObject = TObject> = {
  name: N;
  /** Pi's display label; the Claude client has none. */
  label: string;
  description: string;
  parameters: T;
  /**
   * The tool bound to one crewmate's callbacks, or undefined when the
   * callbacks it needs are absent - then neither runtime serves it.
   */
  bind: (delegate: CrewmateToolDelegate) => BoundTool<N, T> | undefined;
};

/**
 * Call a host callback with this tool's cancellation only when the runtime
 * gave one, so a call with no signal keeps the arguments the host expects.
 */
export function callWithSignal<R>(
  // biome-ignore lint/suspicious/noExplicitAny: a trailing optional signal is not a tuple the checker accepts.
  fn: (...args: any[]) => R,
  args: readonly unknown[],
  signal?: AbortSignal,
): R {
  return signal === undefined ? fn(...args) : fn(...args, signal);
}

/** Declare a crewmate tool: a bound tool once a crewmate's callbacks bind it. */
export function crewmateTool<const N extends string, T extends TObject>(spec: {
  name: N;
  label: string;
  description: string;
  parameters: T;
  bind: (
    delegate: CrewmateToolDelegate,
  ) => ((params: Static<T>, signal?: AbortSignal) => ToolOutput | Promise<ToolOutput>) | undefined;
}): CrewmateTool<N, T> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    bind: (delegate) => {
      const run = spec.bind(delegate);
      return run ? boundTool({ ...spec, run }) : undefined;
    },
  };
}

/** Every entry the delegate can bind, in the spec's order. */
export function bindTools(
  tools: readonly CrewmateTool[],
  delegate: CrewmateToolDelegate,
): BoundTool[] {
  return tools.flatMap((tool) => tool.bind(delegate) ?? []);
}

/** An entry whose callbacks the caller always supplies. */
export function bindTool<N extends string, T extends TObject>(
  tool: CrewmateTool<N, T>,
  delegate: CrewmateToolDelegate,
): BoundTool<N, T> {
  const bound = tool.bind(delegate);
  if (!bound) throw new Error(`${tool.name}: the delegate lacks the callback it runs on`);
  return bound;
}

/** The output as a tool result's content, text first: the one layout both runtimes send. */
export function toolContent(output: ToolOutput) {
  return [
    { type: "text" as const, text: output.text },
    ...(output.images ?? []).map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
}

/**
 * The Firstmate's tool set as the self-source map records it, in
 * registration order (`FirstmateAgent.buildTools`, which binds each entry
 * to the host; the host's own `emote` is not a tool the map indexes). The
 * self-source generator reads it here, beside the crewmate tool spec, and
 * its test pins it against the live agent's tools on both runtimes, so a
 * change to the set stays deliberate.
 *
 * Contract v2: no bash or direct filesystem reads; locate_project
 * remains a typed operation; CI state rides crew_status. flag_missed_escalation (PoC-2
 * C3) is the confirmed missed-escalation label. The task graph
 * (task-system P2) adds four: create_task, update_task, link_tasks, and the
 * tasks query. flag_duplicate (interaction P1 WI-14) is the captain's
 * confirmed duplicate-card label. recall_decision left with the park
 * machinery (cards/tasks/agents P0, contract v1.5). personalize (talk-to-
 * personalize Step 1) applies the captain's preferences about the app
 * itself. install_plugin (one plugin vehicle, Phase A) stages a panel from
 * elsewhere behind the host's consent card. knowledge and record_knowledge
 * (docs/knowledge.md) serve every build; the host's `emote` is registered
 * separately.
 */
export const FIRSTMATE_TOOLS: readonly { name: string; module: string }[] = [
  { name: "emit_card", module: "src/core/pi/cardTool.ts" },
  { name: "close_card", module: "src/core/pi/cardTool.ts" },
  { name: "spawn_crewmate", module: "src/core/pi/crewTools.ts" },
  { name: "steer_crewmate", module: "src/core/pi/crewTools.ts" },
  { name: "interrupt_crewmate", module: "src/core/pi/crewTools.ts" },
  { name: "settle_task", module: "src/core/pi/crewTools.ts" },
  { name: "crew_status", module: "src/core/pi/crewTools.ts" },
  { name: "create_task", module: "src/core/pi/taskTools.ts" },
  { name: "update_task", module: "src/core/pi/taskTools.ts" },
  { name: "link_tasks", module: "src/core/pi/taskTools.ts" },
  { name: "tasks", module: "src/core/pi/taskTools.ts" },
  { name: "locate_project", module: "src/core/pi/locateTool.ts" },
  { name: "schedule_prompt", module: "src/core/pi/scheduleTools.ts" },
  { name: "cancel_schedule", module: "src/core/pi/scheduleTools.ts" },
  { name: "supervision_log", module: "src/core/pi/supervisionTools.ts" },
  { name: "flag_missed_escalation", module: "src/core/pi/supervisionTools.ts" },
  { name: "flag_duplicate", module: "src/core/pi/supervisionTools.ts" },
  { name: "knowledge", module: "src/core/knowledge/knowledgeTools.ts" },
  { name: "record_knowledge", module: "src/core/knowledge/knowledgeTools.ts" },
  { name: "app_state", module: "src/core/pi/appTools.ts" },
  { name: "app_change", module: "src/core/pi/appTools.ts" },
  { name: "personalize", module: "src/core/pi/personalizeTool.ts" },
  { name: "install_plugin", module: "src/core/pi/pluginTools.ts" },
];
