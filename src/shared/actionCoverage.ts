import { COMPUTER, HERE } from "./deviceNames";
import type { CoreInvokeChannel } from "./ipc";

/** A crewmate's tool callback, asked by the computer that holds its conversation (src/shared/work.ts). */
const WORK_REQUEST =
  "A crewmate's own work, asked by the computer that runs it; not an app setting";

/** Operations which are not app settings, with the reason they stay outside the table. */
export const ACTION_EXCEPTIONS: Partial<Record<CoreInvokeChannel, string>> = {
  "inf:converse": "Conversation, not an app setting",
  "inf:cards:act": "Captain card clicks",
  "inf:cards:close": "Captain card clicks",
  "inf:cards:minimize":
    "Captain-only saved card presentation; the first mate may restore through show-card, never minimize",
  "inf:cards:show-past":
    "Compatible closed-card gesture; the asked show-card action uses inf:cards:show for live and closed cards",
  "inf:cards:open-page":
    "The captain's click on a card's page from its task's project; it opens the task's browser and sets nothing",
  "inf:cards:reply": "Conversation, not an app setting",
  "inf:task:steer":
    "The captain's own line in a task's Crewmate tab; conversation, not an app setting",
  "inf:task:interrupt": "The captain's own key or click in a task's Crewmate tab; nothing is set",
  "inf:auth:prompt-reply": "Sign-in interaction",
  "inf:accounts:custom:connect": "Sign-in preparation",
  "inf:accounts:custom:prepare": "Sign-in preparation",
  "inf:accounts:custom:check": "Sign-in check",
  "inf:accounts:custom:recheck": "Sign-in check",
  "inf:accounts:custom:discover": "Sign-in discovery",
  "inf:accounts:custom:cancel": "Sign-in cancellation",
  "inf:forges:cancel": "Sign-in cancellation",
  "inf:devices:stop": "Closes the captain's own open link; nothing is set",
  "inf:devices:keep":
    "Keep it: takes back the captain's own wait to remove a computer once it is back; nothing is set",
  "inf:devices:add": `Adds a ${COMPUTER.one} over Remote Login on the captain's click in Settings; device-invite only offers the card, and the feed says each step`,
  "inf:devices:update": `Updates Infinitary on a ${COMPUTER.one} added by its address on the captain's click; device-update only offers the card, and the feed says each step`,
  "inf:devices:try-again": `Tries ${HERE.this}'s own SSH connection to a computer again on the captain's click; nothing is set`,
  "inf:devices:change-address": `Reaches a ${COMPUTER.one} added by its address at another address on the captain's click in Settings, once a look there finds the same computer`,
  "inf:devices:sign-in": "Sign-in on a computer that runs work, started by the captain's click",
  "inf:devices:sign-in:answer":
    "Sign-in interaction: what the captain typed goes to that computer once and is kept nowhere",
  "inf:devices:sign-in:cancel": "Sign-in cancellation",
  "inf:devices:sign-out": "Signs a computer that runs work out of its own account",
  "inf:devices:forge-sign-in":
    "GitHub sign-in on a computer that runs work, started by the captain's click in Settings",
  "inf:devices:forge-sign-out": "Signs a computer that runs work out of its own GitHub sign-in",
  "inf:devices:custom:connect":
    "Sign-in preparation: the key and headers go to that computer once and are kept nowhere here",
  "inf:devices:custom:check": "Sign-in check on a computer that runs work",
  "inf:devices:custom:discover": "Sign-in discovery on a computer that runs work",
  "inf:devices:custom:cancel": "Sign-in cancellation",
  "inf:devices:custom:save": "Saves a custom API connection on a computer that runs work",
  "inf:devices:custom:recheck": "Sign-in check on a computer that runs work",
  "inf:settings:local-orchestrator:set": "Development-only model control",
  "inf:tasks:opened": "View stamp",
  "inf:browser:stop": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:reopen": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:take": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:return": "The captain's click in a task's browser view; nothing is set",
  "inf:update:install":
    "The captain's own Install in the update panel; the system asks for the person's password and the app starts again",
  "inf:browser:sign-ins:remove":
    "The captain's own Remove of a saved website sign-in; the first mate never removes one",
  "inf:cards:seen": "View stamp",
  "inf:settings:sharing:viewed": "View stamp",
  "inf:app:first-run:crew-word": "First-run view stamp",
  "inf:plugins:fetch": "Panel internal operation",
  "inf:plugins:invoke": "Panel internal operation",
  "inf:plugins:db": "Panel internal operation",
  "inf:plugins:personal:mounts":
    "The window's own answer about which panels it drew, sent whenever it changes; nothing is set",
  "inf:work:card": WORK_REQUEST,
  "inf:work:card-refused": WORK_REQUEST,
  "inf:work:close-card": WORK_REQUEST,
  "inf:work:followup": WORK_REQUEST,
  "inf:work:progress": WORK_REQUEST,
  "inf:work:speed-note": WORK_REQUEST,
  "inf:work:report": WORK_REQUEST,
  "inf:work:reply": WORK_REQUEST,
  "inf:work:github-write": WORK_REQUEST,
  "inf:work:prepare-change": WORK_REQUEST,
  "inf:work:open-change": WORK_REQUEST,
  "inf:work:check-change": WORK_REQUEST,
  "inf:work:download-artifact": WORK_REQUEST,
  "inf:work:record-knowledge": WORK_REQUEST,
  "inf:work:use-integration": WORK_REQUEST,
  "inf:work:picture": WORK_REQUEST,
  "inf:work:media": WORK_REQUEST,
  "inf:work:typeface": WORK_REQUEST,
  "inf:work:job-exit": WORK_REQUEST,
  "inf:work:events": WORK_REQUEST,
  "inf:work:browser": WORK_REQUEST,
  "inf:work:browser-frame": WORK_REQUEST,
  "inf:work:browser-event": WORK_REQUEST,
  "inf:work:sign-in": "A computer's own sign-in, told to its home; not an app setting",
  "inf:work:sign-ins": "A computer's own sign-ins, told to its home; not an app setting",
};

/** Field exceptions name existing gaps or state that is not a Firstmate setting. */
export const ACTION_FIELD_EXCEPTIONS: Partial<Record<CoreInvokeChannel, Record<string, string>>> = {
  "inf:settings:appearance:set": {
    defaultCardSize: "A view choice for opening cards, set by the captain in Settings → Appearance",
    usageUnit:
      "A view choice inside Settings → Usage, switched there or by Switch Usage units in command search",
  },
  "inf:settings:layout:set": {
    panelOrder:
      "The captain's More-menu move saves rail order; the first mate's panel action changes rail and end, not order",
  },
  "inf:settings:decisions:set": {
    version: "Stored format version, not a control",
    egress: "Outbound consent stays captain-only in Settings",
  },
};

/** Read the actual request schema, not a second inventory of settings. */
export function settingFields(request: { toJSONSchema: () => unknown }): string[] {
  const schema = request.toJSONSchema() as {
    prefixItems?: { properties?: Record<string, unknown>; enum?: string[] }[];
  };
  const first = schema.prefixItems?.[0];
  return first?.properties ? Object.keys(first.properties) : (first?.enum ?? []);
}

export function uncoveredSettings(
  fields: string[],
  claimed: string[],
  exceptions: Record<string, string> = {},
): string[] {
  return fields.filter((field) => !claimed.includes(field) && !exceptions[field]?.trim());
}
