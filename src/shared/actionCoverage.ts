import { COMPUTER, HERE } from "./deviceNames";
import type { CoreInvokeChannel } from "./ipc";

/** A crewmate's tool callback, asked by the computer that holds its conversation (src/shared/work.ts). */
const WORK_REQUEST =
  "A crewmate's own work, asked by the computer that runs it; not an app setting";

/** Operations which are not app settings, with the reason they stay outside the table. */
export const ACTION_EXCEPTIONS: Partial<Record<CoreInvokeChannel, string>> = {
  "inf:secrets:entry":
    "The captain's trusted secure entry; never a first mate operation or an agent-authored form",
  "inf:secrets:action":
    "Captain-only secret authority: exact host confirmation, withdrawal, local forgetting or history deletion",
  "inf:secrets:enroll":
    "A phone offers its approval key; nothing changes until the captain confirms on the home",
  "inf:secrets:decide":
    "A phone's signed decision on one exact use, or its refusal; never a first mate operation",
  "inf:decisions:use:set":
    "Captain-only in Settings: turning a decision model use on can approve what a model receives",
  "inf:quota:opened":
    "The person opening Subscriptions, which reads an allowance read only on a press; the asked refresh-usage reads it all",
  "inf:converse": "Conversation, not an app setting",
  "inf:cards:act": "Captain card clicks",
  "inf:cards:close": "Captain card clicks",
  "inf:cards:note-done": "Captain card clicks",
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
  "inf:auth:cancel": "Sign-in cancellation",
  "inf:accounts:custom:connect": "Sign-in preparation",
  "inf:accounts:custom:prepare": "Sign-in preparation",
  "inf:accounts:custom:check": "Sign-in check",
  "inf:accounts:custom:recheck": "Sign-in check",
  "inf:accounts:custom:discover": "Sign-in discovery",
  "inf:accounts:custom:cancel": "Sign-in cancellation",
  "inf:forges:cancel": "Sign-in cancellation",
  "inf:integrations:sign-in-cancel": "Sign-in cancellation",
  "inf:integrations:sign-in-return":
    "Sign-in interaction: the browser's return from the computer the captain is at, handed once to the waiting sign-in",
  "inf:repos:queue-credential-create":
    "Makes the queue's key where the project lives on the captain's click in Settings: a credential the captain's sign-in creates, never set on the first mate's words",
  "inf:integrations:inbox-link":
    "Links the inbox's command into /usr/local/bin on the captain's click in Settings; no app setting changes",
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
  "inf:devices:forge-sign-in-cli":
    "GitHub sign-in through a computer's own GitHub CLI, on the captain's click in Settings",
  "inf:devices:forge-sign-out": "Signs a computer that runs work out of its own GitHub sign-in",
  "inf:devices:custom:connect":
    "Sign-in preparation: the key, headers or token command go to that computer once; the command runs there and its output stays private",
  "inf:devices:custom:check": "Sign-in check on a computer that runs work",
  "inf:devices:custom:discover": "Sign-in discovery on a computer that runs work",
  "inf:devices:custom:cancel": "Sign-in cancellation",
  "inf:devices:custom:save": "Saves a custom API connection on a computer that runs work",
  "inf:devices:custom:recheck": "Sign-in check on a computer that runs work",
  "inf:settings:local-orchestrator:set": "Development-only model control",
  "inf:tasks:opened": "View stamp",
  "inf:task:pin":
    "The captain's own pin in Tasks, on the task board or on the record; what the Tasks panel lists first, never an app setting",
  "inf:browser:stop": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:reopen": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:take": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:return": "The captain's click in a task's browser view; nothing is set",
  "inf:browser:size":
    "The room the captain's maximized task browser view gives its page; nothing is set",
  "inf:browser:input":
    "The captain's own presses and typing in a task's browser while they have control; nothing is set",
  "inf:update:install":
    "The captain's own update-and-restart consent in the update panel; a model cannot grant it",
  "inf:update:later":
    "The captain's own Update later in the update panel, which lets an update go; a model cannot choose it",
  "inf:update:channel":
    "The captain's installed-app subscription on the controlling computer, chosen in Settings; never an agent change to the home computer",
  "inf:browser:sign-ins:automatic":
    "The captain's separate grant or revocation of saved website account access; the first mate never changes it",
  "inf:browser:private-sites:remove":
    "The captain's own Remove of a private site in Settings; the first mate never removes one",
  "inf:browser:sign-ins:remove":
    "The captain's own Remove of a saved website sign-in; the first mate never removes one",
  "inf:cards:seen": "View stamp",
  "inf:cards:seen-update": "View stamp",
  "inf:settings:sharing:viewed": "View stamp",
  "inf:settings:sharing:phone":
    "A paired phone handing its own usage events to Diagnostics; not an app setting",
  "inf:app:first-run:crew-word": "First-run view stamp",
  "inf:plugins:fetch": "Panel internal operation",
  "inf:plugins:invoke": "Panel internal operation",
  "inf:plugins:db": "Panel internal operation",
  "inf:plugins:retry":
    "The captain's Retry on a panel whose background work the app stopped; it clears that stop and starts the panel again, and nothing is set",
  "inf:plugins:update":
    "The captain's Update panel on a panel whose background work the app refused; it tells the first mate, which starts the update, and nothing is set",
  "inf:plugins:integrations":
    "A panel's own call on the captain's integrations; each action keeps its Settings rule, and the first mate reaches them through its own integration tools",
  "inf:plugins:ask-again":
    "The captain's Ask again on a panel's integration call; it shows that call's approval card again, and nothing is set",
  "inf:plugins:personal:mounts":
    "The window's own answer about which panels it drew, sent whenever it changes; nothing is set",
  "inf:own-window:here":
    "This computer's window saying it is open beside a first mate a command started; nothing is set",
  "inf:own-window:answer":
    "This computer's window answering what its first mate asked of it; nothing is set",
  "inf:own-window:focused":
    "This computer's window coming to the front, which reads a stale allowance again; nothing is set",
  "inf:voice:primed":
    "The window's own record of the first hold to talk, after the system was asked about the microphone",
  "inf:settings:keys:set":
    "The captain's own keys, changed in Keyboard settings; the first mate never changes a key",
  "inf:runbooks:folder":
    "The captain's click on a runbook's folder button; it makes the folder ready and answers its path, and nothing is set",
  "inf:update:hold":
    "The hold this computer's window keeps on the crew's saved work while it installs the captain's own update; a model cannot grant it",
  "inf:work:card": WORK_REQUEST,
  "inf:work:card-refused": WORK_REQUEST,
  "inf:work:close-card": WORK_REQUEST,
  "inf:work:followup": WORK_REQUEST,
  "inf:work:start-program": WORK_REQUEST,
  "inf:work:progress": WORK_REQUEST,
  "inf:work:speed-note": WORK_REQUEST,
  "inf:work:report": WORK_REQUEST,
  "inf:work:reply": WORK_REQUEST,
  "inf:work:revise-required-action": WORK_REQUEST,
  "inf:work:github-write": WORK_REQUEST,
  "inf:work:prepare-change": WORK_REQUEST,
  "inf:work:open-change": WORK_REQUEST,
  "inf:work:show-merge-card": WORK_REQUEST,
  "inf:work:check-change": WORK_REQUEST,
  "inf:work:download-artifact": WORK_REQUEST,
  "inf:work:record-knowledge": WORK_REQUEST,
  "inf:work:use-integration": WORK_REQUEST,
  "inf:work:copy-file": WORK_REQUEST,
  "inf:work:picture": WORK_REQUEST,
  "inf:work:media": WORK_REQUEST,
  "inf:work:handover-file": WORK_REQUEST,
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
    keepCardsMaximized:
      "A view choice for how cards keep their size, set by the captain in Settings → Appearance",
    cardsMaximized:
      "Whether the captain last maximized or restored a card, kept while Keep cards maximized is on; not a setting",
    language:
      "The language the window and the crew's words to the captain use, chosen by the captain in Settings → Appearance",
    usageUnit:
      "A view choice inside Settings → Usage, switched there or by Switch Usage units in command search",
  },
  "inf:settings:layout:set": {
    placements:
      "Where a panel sat before the arrangement existed; nothing writes it now, and the panel action moves panels in the arrangement",
    panelOrder:
      "The More picks saved before the arrangement existed; nothing writes it now, and a More pick moves its panel in the arrangement",
    morePick:
      "The captain's last More pick, which the rail keeps on screen; the pick's move itself is in the arrangement the panel action writes",
    focusedProjectId:
      "The window's project focus is the captain's pick in the top bar's pill or a project chip, and only a hint to the first mate (docs/project-focus.md)",
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
