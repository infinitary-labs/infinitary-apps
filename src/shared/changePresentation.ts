import { z } from "zod";
import { cardPictureSchema, riskDeclarationSchema } from "./cards";
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
  /** Required when After media was captured on another code version. */
  applicability: words.optional(),
  /** A recording names its inspected still poster here; an image has none. */
  poster: z.string().min(1).max(4096).optional(),
});
export type PresentationMedia = z.infer<typeof presentationMediaSchema>;

export const presentationViewSchema = z.strictObject({
  id: key,
  caption: z.string().trim().min(1).max(1000),
  kind: z.enum(["changed", "new"]),
  layout: z.literal("adjacent").optional(),
  before: z.array(presentationMediaSchema).max(20),
  after: z.array(presentationMediaSchema).min(1).max(20),
});

/** INF-467: a checked fact is a short subject and its observed result, not a command transcript. */
export const presentationCheckSchema = z.strictObject({
  check: words,
  result: words,
});
const checked = z.array(presentationCheckSchema).min(1).max(6);

/** Typed publication intent: the author, not a prose classifier, decides what is safe to share. */
export const changePresentationDraftSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    base: head,
    head,
    publishable: z.literal(true),
    why: z.array(words).min(1).max(2),
    whatChanged: z.array(words).min(1).max(5),
    before: z.array(words).length(1),
    after: z.array(words).length(1),
    views: z.array(presentationViewSchema).max(30),
    noPicture: words.optional(),
    checked,
    verification: z.array(words).max(20),
    risk: riskDeclarationSchema,
    requiredActions: requiredActionsSchema,
    unfinished: z.array(words).max(20),
    /** Public project-required fields, issue references or template text, outside the owned region. */
    projectText: z.string().max(12000).optional(),
  })
  .superRefine(evidenceRelations);
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
  destination: z.strictObject({
    /** INF-132: future github.com pull requests and gitlab.com merge requests, never a server's own host. */
    host: z.enum(["github.com", "gitlab.com"]),
    projectId: z.number().int().positive().safe(),
    fullName: z.string().min(1),
    visibility: z.enum(["public", "private", "internal"]),
  }),
  title: z.string(),
  base: head,
  head,
  why: paragraphs,
  whatChanged: paragraphs,
  before: paragraphs,
  after: paragraphs,
  views: z.array(
    z.strictObject({
      id: key,
      caption: z.string(),
      kind: z.enum(["changed", "new"]),
      layout: z.literal("adjacent").optional(),
      before: z.array(retainedPresentationMediaSchema),
      after: z.array(retainedPresentationMediaSchema),
    }),
  ),
  noPicture: words.optional(),
  checked: checked.optional(),
  verification: z.array(words).max(20),
  risk: riskDeclarationSchema,
  requiredActions: requiredActionsSchema,
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
  body: z.string().optional(),
  presentation: z.number().int().positive().optional(),
  recovery: presentationRecoverySchema.optional(),
  around: storyAroundSchema.optional(),
});
export type OpenChangeInput = z.infer<typeof openChangeInputSchema>;

/** Durable write states belong to TaskService, not a network retry queue. */
export type PresentationReceipt = {
  destination: ChangePresentation["destination"];
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
  /** The content the completion offer approved; conflict-only refreshes inherit it. */
  contentHash?: string;
  /** A deliberate opening retry was requested after a read found no open PR. */
  retryOpening?: true;
  number?: number;
};
export type ChangePresentationRecord = {
  revisions: ChangePresentation[];
  receipts: PresentationReceipt[];
  publication?: PresentationPublication;
  /** Keep the last complete story during a replacement's uploads or an uncertain write. */
  published?: PresentationPublication;
  /** A person reviewed this exact edit; it is an owned PR, not a confirmed generated story. */
  reconciled?: { number: number; region: string };
};

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
      before: { captureHead: string; applicability?: string }[];
      after: { captureHead: string; applicability?: string }[];
    }[];
  },
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (draft.views.length === 0 && !draft.noPicture)
    issue("A story without media needs a no-picture reason.");
  if (draft.views.length > 0 && draft.noPicture)
    issue("Use views or a no-picture account, not both.");
  const ids = new Set<string>();
  for (const view of draft.views) {
    if (ids.has(view.id)) issue(`View ${view.id} appears more than once.`);
    ids.add(view.id);
    if (view.kind === "changed" && view.before.length === 0)
      issue(`View ${view.id} needs Before evidence.`);
    if (view.kind === "new" && view.before.length > 0)
      issue(`New view ${view.id} cannot have Before evidence.`);
    if (
      view.layout === "adjacent" &&
      (view.after.length !== 2 || (view.kind === "changed" && view.before.length !== 2))
    )
      issue(`Adjacent view ${view.id} needs exactly two media in each shown state.`);
    for (const media of view.before) {
      if (media.captureHead !== draft.base)
        issue(`Before evidence for ${view.id} must name the original base.`);
    }
    for (const media of view.after) {
      if (media.captureHead !== draft.head && !media.applicability)
        issue(`After evidence for ${view.id} needs fresh capture or an applicability declaration.`);
    }
  }
  if (JSON.stringify(draft).length > 60000) issue("The story is too large; shorten its text.");
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
