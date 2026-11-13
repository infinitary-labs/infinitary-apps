import { z } from "zod";
import { afterMergeStepsSchema } from "./afterMerge";
import { cardPictureSchema, riskDeclarationSchema } from "./cards";
import { liveValidationSummarySchema } from "./liveValidationSummary";
import {
  type HostedPresentationDestination,
  hostedPresentation,
  presentationDestinationSchema,
} from "./presentationDestination";
import { requiredActionsSchema } from "./requiredActions";

/** INF-132: one explicit story, not a scraper for arbitrary card HTML. */
const words = z.string().trim().min(1).max(4000);
const paragraphs = z.array(words).min(1).max(20);
const head = z.string().regex(/^[0-9a-f]{40,64}$/);
const key = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);

export const presentationMediaSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  alt: z.string().trim().min(1).max(1000),
  /** The author inspected the exact upload copy, including any conversion. */
  inspected: z.literal(true),
  captureHead: head,
  /** Required when media was captured off its state's version: Before's base, After's head. */
  applicability: words.optional(),
  /** A recording names its inspected still poster here; an image has none. */
  poster: z.string().min(1).max(4096).optional(),
});
export type PresentationMedia = z.infer<typeof presentationMediaSchema>;

/**
 * The crewmate's answer, for one After picture or poster's final take, to
 * what a person using that view would call wrong in it (INF-3814's
 * direction B): each fault it noticed, with whose it is. The app sees no
 * picture; it carries this declaration and refuses a story only while a
 * fault is the change's own (`ownFaults`). The answer stays on the task's
 * record with the tool call and is never drawn on a card or published.
 */
export const PICTURE_FAULT_CAUSES = ["change", "before-change", "chosen"] as const;
export const presentationFaultSchema = z.strictObject({
  fault: words,
  cause: z.enum(PICTURE_FAULT_CAUSES),
});
const afterMediaSchema = presentationMediaSchema.extend({
  faults: z
    .array(presentationFaultSchema)
    .max(20)
    .describe(
      "What a person using this view would call wrong in this final take: [] when nothing. cause change is refused until fixed and taken again; before-change was there before the change; chosen is what the captain's words or an approved plan chose.",
    ),
});

export const presentationViewSchema = z.strictObject({
  id: key,
  caption: z.string().trim().min(1).max(1000),
  kind: z.enum(["changed", "new"]),
  layout: z.literal("adjacent").optional(),
  /**
   * A project map's change view (`story-map.md`): the path of a filled map
   * part's data block, which the merge card draws live; the view's one After
   * picture is that drawing, for the pull request, which cannot run it.
   */
  map: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Path of a filled map data block (JSON); the merge card draws it live. Kind changed, no Before, one After picture of it.",
    ),
  before: z.array(presentationMediaSchema).max(20),
  after: z.array(afterMediaSchema).min(1).max(20),
});

/** INF-467: a checked fact is a short subject and its observed result, not a command transcript. */
export const presentationCheckSchema = z.strictObject({
  check: words,
  result: words,
});
export const presentationValidationRowSchema = z.strictObject({
  id: z.string(),
  scenario: words,
  evidence: words,
});
const validationRows = z.array(presentationValidationRowSchema);
const checked = z.array(presentationCheckSchema).min(1).max(6);

/**
 * Typed publication intent: the author, not a prose classifier, decides what is safe to share.
 * `publishable` is the author's declaration that it read the story once as a stranger who
 * can see the project would, and it names nothing personal or local (INF-2142).
 */
export const changePresentationDraftSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    base: head,
    head,
    publishable: z.literal(true),
    why: z.array(words).min(1).max(2),
    whatChanged: z.array(words).min(1).max(5),
    /**
     * The crewmate's own drawing of what changed (INF-3749's free-form part,
     * as the captain amended it): the path of an HTML file the merge card
     * draws under What changed in place of the bullets, which the pull
     * request and the squash message keep. The story parameter's own words
     * say it (`WHAT_CHANGED_PART_RULE`), so the field carries no copy.
     */
    whatChangedPart: z.string().min(1).max(4096).optional(),
    before: z.array(words).length(1),
    after: z.array(words).length(1),
    views: z.array(presentationViewSchema).max(30),
    noPicture: words.optional(),
    checked,
    /** Public words only; the host fills results from the validation record. */
    validationRows: validationRows.optional(),
    verification: z.array(words).max(20),
    risk: riskDeclarationSchema,
    requiredActions: requiredActionsSchema,
    /** Work the crew starts once the merge goes through (INF-2796); optional, never published. */
    afterMerge: afterMergeStepsSchema.optional(),
    unfinished: z.array(words).max(20),
    /** Public project-required fields, issue references or template text, outside the owned region. */
    projectText: z.string().max(12000).optional(),
  })
  .superRefine(evidenceRelations)
  .superRefine(ownFaults);
export type ChangePresentationDraft = z.infer<typeof changePresentationDraftSchema>;

/** A retained image or recording, kept while its story is the newest or last published revision. */
export const presentationAssetSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+-[0-9a-f]{32}$/),
  file: z.string().regex(/^[A-Za-z0-9_-]+-[0-9a-f]{32}\.(png|jpg|webp|mp4)$/),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4"]),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive().optional(),
});
export type PresentationAsset = z.infer<typeof presentationAssetSchema>;

export const retainedPresentationMediaSchema = z.strictObject({
  asset: z.string(),
  poster: z.string().optional(),
  alt: z.string(),
  captureHead: head,
  applicability: words.optional(),
});
export type RetainedPresentationMedia = z.infer<typeof retainedPresentationMediaSchema>;

const savedPresentationShape = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  taskId: z.string(),
  revision: z.number().int().positive(),
  destination: presentationDestinationSchema,
  title: z.string(),
  base: head,
  head,
  why: paragraphs,
  whatChanged: paragraphs,
  /** The free-form part's HTML, its pictures named by the story's own copies. */
  whatChangedPart: z.string().min(1).max(60000).optional(),
  before: paragraphs,
  after: paragraphs,
  views: z.array(
    z.strictObject({
      id: key,
      caption: z.string(),
      kind: z.enum(["changed", "new"]),
      layout: z.literal("adjacent").optional(),
      /** The map's data block as the map part reads a packed one: deflated raw, in base64. */
      map: z
        .string()
        .regex(/^[A-Za-z0-9+/]+={0,2}$/)
        .optional(),
      before: z.array(retainedPresentationMediaSchema),
      after: z.array(retainedPresentationMediaSchema),
    }),
  ),
  noPicture: words.optional(),
  checked: checked.optional(),
  validationRows: validationRows.optional(),
  liveValidation: liveValidationSummarySchema.optional(),
  verification: z.array(words).max(20),
  risk: riskDeclarationSchema,
  requiredActions: requiredActionsSchema,
  afterMerge: afterMergeStepsSchema.optional(),
  unfinished: z.array(words),
  projectText: z.string(),
  assets: z.array(presentationAssetSchema),
  pictures: z.array(cardPictureSchema),
});
export const changePresentationSchema = savedPresentationShape
  .superRefine(evidenceRelations)
  .superRefine(storyTiers);
export type ChangePresentation = z.infer<typeof changePresentationSchema>;

export const stagedChangePresentationSchema = savedPresentationShape
  .omit({
    taskId: true,
    destination: true,
    revision: true,
  })
  .superRefine(evidenceRelations)
  .superRefine(storyTiers);
export type StagedChangePresentation = z.infer<typeof stagedChangePresentationSchema>;
export const presentationRecoverySchema = z.strictObject({
  retryOpening: z.literal(true).optional(),
  retryUploads: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(600)
    .optional(),
  replaceRegion: z.string().max(200000).optional(),
});
export type PresentationRecovery = z.infer<typeof presentationRecoverySchema>;

/** INF-497: one exact passage of the words around a published story, and what replaces it. */
export const storyAroundSchema = z.strictObject({
  from: z.string().max(200000),
  to: z.string().max(200000),
});
export type StoryAround = z.infer<typeof storyAroundSchema>;

export const openChangeInputSchema = z.object({
  title: z.string(),
  /**
   * The project the change opens on, as the crewmate names it (INF-1873): the
   * task's own or another project the app manages (INF-2510), by name, id,
   * owner/name or origin where it lives. A project the app does not manage
   * is refused.
   */
  repository: z.string().optional(),
  /** The branch the change targets, when not the default branch: another change's branch for a stacked change. */
  base: z.string().optional(),
  /**
   * An existing branch the captain asked to open the change from, instead of
   * the task's own (INF-2184): it opens from that branch as it is, and the
   * change becomes the task's current one (INF-2490).
   */
  branch: z.string().optional(),
  body: z.string().optional(),
  presentation: z.number().int().positive().optional(),
  recovery: presentationRecoverySchema.optional(),
  around: storyAroundSchema.optional(),
});
export type OpenChangeInput = z.infer<typeof openChangeInputSchema>;

/**
 * The merge card show_merge_card raises (INF-3717 piece 2): its id and the
 * crewmate's own words beside it. The app builds the one merge action and
 * takes the rest from the saved story, so no body, risk, required actions
 * or other action can be given.
 */
export const mergeCardRequestSchema = z.object({
  id: z.string(),
  reply: z.string().optional(),
  interim: z.boolean().optional(),
  /** The captain's message number the reply answers (`answers_message`). */
  answersMessage: z.number().int().min(1).optional(),
  /** What follows the merge: the task closes, or its crewmate continues. */
  after: z.enum(["close", "continue"]).optional(),
  /** Why a standing direction leaves this merge to the captain. */
  asksFirst: z.string().optional(),
  /** What changed since the captain saw an earlier merge card (`since_seen`). */
  sinceSeen: z.string().optional(),
});
export type MergeCardRequest = z.infer<typeof mergeCardRequestSchema>;

/** show_merge_card as the home takes it: the story staged where the crewmate runs, if given, and the card. */
export const showMergeCardInputSchema = z.object({
  story: stagedChangePresentationSchema.optional(),
  card: mergeCardRequestSchema,
});
export type ShowMergeCardInput = z.infer<typeof showMergeCardInputSchema>;

/** Durable write states belong to TaskService, not a network retry queue. */
export type PresentationReceipt = {
  destination: HostedPresentationDestination;
  digest: string;
  mediaType: PresentationAsset["mediaType"];
  state: "prepared" | "sending" | "confirmed" | "failed" | "uncertain" | "unavailable";
  url?: string;
  problem?: string;
  possibleOrphan?: boolean;
};
export type PresentationPublication = {
  revision: number;
  head: string;
  state: "sending" | "confirmed" | "uncertain";
  /** The exact generated region sent; surrounding human text is not owned by the app. */
  region: string;
  regionHash: string;
  /** The content the completion offer approved; the host's republication inherits it. */
  contentHash?: string;
  /**
   * INF-2509: the revision the author published, when this one is the host's
   * republication of it at a pull request's later version, words unchanged.
   * A completion card naming that revision shows this one.
   */
  refreshOf?: number;
  /** INF-717: the title the change carries once this write lands, absent where the app sent none. */
  title?: string;
  /** A deliberate opening retry was requested after a read found no open PR. */
  retryOpening?: true;
  number?: number;
};
/** A branch/local story is retained for completion, never called a published description. */
export type PresentationCompletion = {
  revision: number;
  head: string;
  contentHash: string;
};
export type ChangePresentationRecord = {
  /**
   * The branch of the change this ledger is for (INF-2490): each change of a
   * task keeps its own story. A ledger saved before then names none and is
   * the task's own branch's.
   */
  branch?: string;
  /** A fork may use the same branch name as another change. */
  forkNumber?: number;
  revisions: ChangePresentation[];
  completion?: PresentationCompletion;
  receipts: PresentationReceipt[];
  publication?: PresentationPublication;
  /** Keep the last complete story during a replacement's uploads or an uncertain write. */
  published?: PresentationPublication;
  /** A person reviewed this exact edit; it is an owned PR, not a confirmed generated story. */
  reconciled?: { number: number; region: string };
};

/** The complete story's binding, whether its destination keeps a description or only this app does. */
export function readyPresentation(
  record: ChangePresentationRecord | undefined,
): Pick<PresentationPublication, "revision" | "head" | "contentHash"> | undefined {
  const story = record?.revisions.at(-1);
  if (!story) return undefined;
  // A hosted story with no publication of its own was confirmed on its pushed
  // branch, to be published on its batch's pull request (docs/forge.md, "Batches of your own").
  const ready =
    hostedPresentation(story.destination) && (record?.publication || record?.published)
      ? record?.publication?.state === "confirmed"
        ? record.published
        : undefined
      : record?.completion;
  return ready?.revision === story.revision && ready.head === story.head ? ready : undefined;
}

/** The same typed evidence relationships are checked on the preparing computer and again at home. */
function evidenceRelations(
  draft: {
    base: string;
    head: string;
    noPicture?: string;
    views: {
      id: string;
      kind: "changed" | "new";
      layout?: "adjacent";
      map?: string;
      before: { captureHead: string; applicability?: string }[];
      after: { captureHead: string; applicability?: string }[];
    }[];
  },
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  // A map's change view draws the project's parts, not a screen people use,
  // so a change with nothing to see still says why beside it.
  const screens = draft.views.filter((view) => view.map === undefined);
  if (screens.length === 0 && !draft.noPicture)
    issue("A story without media needs a no-picture reason.");
  if (screens.length > 0 && draft.noPicture) issue("Use views or a no-picture account, not both.");
  // The map part draws into fixed element ids, so one card holds one map.
  if (draft.views.length - screens.length > 1) issue("A story holds at most one map view.");
  const ids = new Set<string>();
  for (const view of draft.views) {
    if (ids.has(view.id)) issue(`View ${view.id} appears more than once.`);
    ids.add(view.id);
    if (
      view.map !== undefined &&
      (view.kind !== "changed" || view.layout || view.before.length > 0 || view.after.length !== 1)
    )
      issue(
        `Map view ${view.id} is kind changed with no Before and one After picture of the drawn change view: its comparison shows what the map was.`,
      );
    if (view.map === undefined && view.kind === "changed" && view.before.length === 0)
      issue(`View ${view.id} needs Before evidence.`);
    if (view.kind === "new" && view.before.length > 0)
      issue(`New view ${view.id} cannot have Before evidence.`);
    if (
      view.layout === "adjacent" &&
      (view.after.length !== 2 || (view.kind === "changed" && view.before.length !== 2))
    )
      issue(`Adjacent view ${view.id} needs exactly two media in each shown state.`);
    // INF-2660: an older Before keeps its own version; the base stays the comparison.
    for (const media of view.before) {
      if (media.captureHead !== draft.base && !media.applicability)
        issue(
          `Before evidence for ${view.id} needs the original base or an applicability declaration.`,
        );
    }
    for (const media of view.after) {
      if (media.captureHead !== draft.head && !media.applicability)
        issue(`After evidence for ${view.id} needs fresh capture or an applicability declaration.`);
    }
  }
  // Keep the existing whole-story storage/publication guard, not a work-item count.
  // String.length measures serialized UTF-16 code units, including JSON punctuation.
  if (JSON.stringify(draft).length > 60000)
    issue(
      "The story exceeds 60,000 UTF-16 code units of JSON, including its after-merge work and any packed map. Shorten descriptions, map fewer folders, or file the work as tasks first and list their keys instead; keep every authorized task and dependency.",
    );
}

/**
 * INF-3814's direction B: a story is saved only once no After picture shows a
 * fault its change caused. The crewmate judged the picture; the host only
 * reads the cause it declared.
 */
function ownFaults(
  draft: {
    views: { id: string; after: { path: string; faults: { fault: string; cause: string }[] }[] }[];
  },
  ctx: z.RefinementCtx,
): void {
  for (const view of draft.views)
    for (const media of view.after)
      for (const { fault, cause } of media.faults)
        if (cause === "change")
          ctx.addIssue({
            code: "custom",
            message: `${media.path} in view ${view.id} shows a fault your change caused: ${fault} Fix it, take the picture again, open the new take and answer again for it. The story was not saved.`,
          });
}

/** Keep old saved stories readable without rewriting their authored content. */
function storyTiers(
  story: {
    version: number;
    checked?: unknown[];
    why: string[];
    whatChanged: string[];
    before: string[];
    after: string[];
  },
  ctx: z.RefinementCtx,
): void {
  if (story.version !== 2) return;
  if ([story.before, story.after].some((lines) => lines.length !== 1))
    ctx.addIssue({ code: "custom", message: "Give one Before and one After account." });
  if (!story.checked?.length)
    ctx.addIssue({ code: "custom", message: "A new story needs checked facts." });
  if (story.why.length > 2)
    ctx.addIssue({ code: "custom", message: "Give at most two Why entries." });
  if (story.whatChanged.length > 5)
    ctx.addIssue({ code: "custom", message: "Give at most five change bullets." });
}
