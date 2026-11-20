import { z } from "zod";
import { HOST_OPS } from "./hostOps.ts";

/**
 * A host-run discard: the task closes unmerged and its working copy goes.
 * `confirm` discards work the body already says is unlanded (the host's
 * own confirm gate). `proceedWithOpen` is P2's (WI-11) close over open
 * follow-ups.
 */
export const settleEffectSchema = z.object({
  kind: z.literal("settle"),
  mode: z.literal("discard"),
  confirm: z.literal(true).optional(),
  proceedWithOpen: z.literal(true).optional(),
});
export type SettleEffect = z.infer<typeof settleEffectSchema>;

/**
 * The one merge request (INF-2744, the captain's "every request to merge a
 * PR should be raised through the exact same ... card"): every merge card
 * carries it, whichever change it merges and whoever asked. Declaring it
 * grants no approval and merges nothing; the merge gate decides
 * (`SettleService.mergeGate`).
 *
 * - `review` names the change: the id `check_change` stored for a pull
 *   request. Absent, it is the task's current change - its pull request, or
 *   its branch on a project that merges locally - which the host resolves
 *   from the task's delivery, so no agent learns merge-pr from land.
 * - `after` is what follows for the task, the crewmate's declaration: the
 *   merge closes it, or it continues. An open question or another open pull
 *   request on the task keeps it open either way (INF-2525).
 * - `asksFirst` keeps a task whose autonomy is on from merging on its own:
 *   the crewmate names the standing direction whose exception this merge
 *   is, and the card waits for the captain's click.
 * - `proceedWithOpen` merges past open follow-ups (WI-11).
 */
export const mergeEffectSchema = z.object({
  kind: z.literal("merge"),
  review: z.string().min(1).max(64).optional(),
  after: z.enum(["close", "continue"]),
  asksFirst: z.string().min(1).max(400).optional(),
  proceedWithOpen: z.literal(true).optional(),
});
export type MergeEffect = z.infer<typeof mergeEffectSchema>;

/**
 * A request to send one write a crewmate asked for where a project lives
 * (FI3-1571 piece 4). Declaring it sends nothing. `ask` is the id
 * `github_write` kept; the host resolves the exact call from that record,
 * draws it on the card and names the button, and only the captain's click
 * sends it, once.
 */
export const requestWriteEffectSchema = z.object({
  kind: z.literal("request_write"),
  ask: z.string().min(1).max(64),
  /**
   * Only the host's integration approval card declares the duration or
   * refusal; `task` allows it for the rest of the asking task, sent only to
   * a view that lists `integration-task-allow` (INF-2993).
   */
  integration: z.enum(["always", "task", "once", "deny"]).optional(),
});
export type RequestWriteEffect = z.infer<typeof requestWriteEffectSchema>;

/**
 * The shell opens Settings, on the named section. `signIn` names a host
 * whose sign-in Settings -> Projects starts on arrival (git integration
 * PR 1.2), so the code is already on screen when the section opens.
 * `make` and `remove` are what Settings -> Devices does on arrival
 * (docs/devices.md, "Asking the first mate"): make a link or a command there,
 * which the card never holds, or remove the device with that id. `signInOn` names a
 * computer that runs work and a subscription whose sign-in Settings ->
 * Intelligence starts there on arrival (docs/helper.md, "Its own
 * sign-ins"). Only the host's own cards carry `devices` or `signInOn`; no
 * agent's tool offers either.
 */
/**
 * What Settings -> Devices makes on arrival from a card's button
 * (docs/devices.md, "Asking the first mate"): a link, the command for another
 * Mac, or the command for another user on this Mac.
 */
export const deviceMakeSchema = z.enum(["link", "command", "user-command"]);
export type DeviceMake = z.infer<typeof deviceMakeSchema>;

/**
 * What Settings -> Devices does on arrival from a card's button, carried
 * from the card's open effect: make a link or a command, remove a device,
 * add the Mac at an address over Remote Login, or update Firstmate on a Mac
 * added that way.
 */
export type DeviceArrival =
  | { make: DeviceMake | "phone" }
  | { remove: string }
  | { add: string }
  | { update: string };

/** The arrival an open effect on Devices carries, as the store keeps it. */
export function deviceArrival(effect: {
  make?: DeviceMake | undefined;
  phone?: true | undefined;
  remove?: string | undefined;
  add?: string | undefined;
  update?: string | undefined;
}): { pendingDeviceArrival: DeviceArrival } | Record<string, never> {
  // A phone's link is its own field, so a view from before opens Devices and makes nothing.
  if (effect.phone) return { pendingDeviceArrival: { make: "phone" } };
  if (effect.make) return { pendingDeviceArrival: { make: effect.make } };
  if (effect.remove) return { pendingDeviceArrival: { remove: effect.remove } };
  if (effect.add) return { pendingDeviceArrival: { add: effect.add } };
  if (effect.update) return { pendingDeviceArrival: { update: effect.update } };
  return {};
}

export const signInOnSchema = z.object({
  deviceId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(256),
});

/**
 * A computer that runs work and a host where projects live whose sign-in
 * Settings starts there on arrival (docs/forge.md, "A computer's own
 * sign-in"): the effect names `projects`, which lands on Settings ->
 * Integrations (`openedSection`), and the code to read opens under that
 * computer's row. Only the host's own cards carry it.
 */
export const forgeSignInOnSchema = z.object({
  deviceId: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
});

/**
 * The exact place in Settings a host card's button opens, beside what the
 * target already says (primitives/app-actions.md, "Hand over"): `section`
 * names the section when the target does not (Secrets, Automation,
 * Integrations), `item` what that section shows on arrival, as a panel's
 * `point.openSettings` names it (a project's id in Projects, a computer's in
 * Devices, a page in Secrets, `kept:<id>` in Automation, `inbox` in
 * Integrations), and `phone` asks Devices to make a phone's link on
 * arrival. `fromHome` says the act there is only on the first mate's own
 * computer, as Settings shows it: a computer that controls the first mate
 * keeps the card up and says where to choose it. Each is optional, so a
 * view from before opens the target's section as it did. Only the host's
 * own cards carry them.
 */
export const settingsPlaceShape = {
  section: z.string().min(1).max(64).optional(),
  item: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\r\n]*$/)
    .optional(),
  phone: z.literal(true).optional(),
  fromHome: z.literal(true).optional(),
};

/**
 * An open effect: Settings on a section, or - on a crewmate's card that asks the captain to take
 * over its task's browser - that browser's view with the captain in control (`browser`,
 * docs/task-browser.md "Asking for help"), the card's own attachment naming which browser. With
 * `savedSignIn` the browser gets the captain's saved sign-in for its site instead and goes back to
 * its crewmate ("Signed-in sites"); only the host adds that action.
 */
export const openEffectSchema = z.object({
  kind: z.literal("open"),
  target: z.enum(["settings", "subscriptions", "projects", "devices", "browser"]),
  folder: z.literal(true).optional(), // A Choose folder button on projects (docs/fleet.md)
  savedSignIn: z.literal(true).optional(),
  signIn: z.string().min(1).max(253).optional(),
  make: deviceMakeSchema.optional(),
  remove: z.string().min(1).max(64).optional(),
  // The address, as the line's own value schema read it (`remoteLoginAddressSchema`);
  // `inf:devices:add` reads it again before anything is reached.
  add: z.string().min(1).max(255).optional(),
  update: z.string().min(1).max(64).optional(),
  privateSite: z.string().min(1).max(253).optional(),
  signInOn: signInOnSchema.optional(),
  forgeSignInOn: forgeSignInOnSchema.optional(),
  ...settingsPlaceShape,
});
export type OpenEffect = z.infer<typeof openEffectSchema>;

export { HOST_OPS };

/**
 * The host ops the task record's footer and the task board run, on one
 * task. `drop-task` is the footer's own, and `queue-task` and
 * `unqueue-task` the board's (src/shared/taskQueue.ts): none is a card host
 * effect.
 */
export const TASK_LIFECYCLE_OPS = [
  "answer-done",
  "dismiss-question",
  "start-task",
  "start-again",
  "stop-task",
  "continue-task",
  "drop-task",
  "queue-task",
  "unqueue-task",
  "show-card",
] as const;
export const taskLifecycleOpSchema = z.enum(TASK_LIFECYCLE_OPS);
export type TaskLifecycleOp = z.infer<typeof taskLifecycleOpSchema>;

/**
 * The graph effects the captain reviewed before Drop task. The host
 * recomputes the same lists and writes only when they still match.
 * `parts` is empty when the drop may proceed: open parts are refused.
 */
export const dropTaskReviewSchema = z.object({
  parts: z.array(z.string().min(1).max(64)).max(64),
  waiting: z.array(z.string().min(1).max(64)).max(64),
  underway: z.array(z.string().min(1).max(64)).max(64),
});
export type DropTaskReview = z.infer<typeof dropTaskReviewSchema>;

/**
 * Where a move on `inf:task:run` came from when a panel made it on the
 * captain's click or key (docs/ui-plugins.md, "A panel's cards"): the
 * panel's title, which the task's record names beside the move. Absent for
 * the task record's own buttons and the task board.
 */
export const taskMoveFromSchema = z.strictObject({ panel: z.string().min(1).max(40) });
export type TaskMoveFrom = z.infer<typeof taskMoveFromSchema>;

export const hostEffectSchema = z.object({
  kind: z.literal("host"),
  op: z.enum(HOST_OPS),
  arg: z.string().optional(),
});
export type HostEffect = z.infer<typeof hostEffectSchema>;

export const cardEffectSchema = z.discriminatedUnion("kind", [
  settleEffectSchema,
  mergeEffectSchema,
  requestWriteEffectSchema,
  openEffectSchema,
  hostEffectSchema,
]);
export type CardEffect = z.infer<typeof cardEffectSchema>;

/** The effects an agent may declare (D2): every kind but the host's own. */
export const agentEffectSchema = z.discriminatedUnion("kind", [
  settleEffectSchema,
  mergeEffectSchema,
  requestWriteEffectSchema,
  openEffectSchema,
]);
export type AgentEffect = z.infer<typeof agentEffectSchema>;
