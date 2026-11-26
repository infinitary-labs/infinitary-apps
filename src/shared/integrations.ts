import { z } from "zod";
import {
  hostOfServerIntegration,
  isServerIntegration,
  SERVER_INTEGRATION_KINDS,
  type SignInKind,
} from "./forgeKinds";
import { forgeSignInStateSchema, isForgeHostName } from "./forges";
import * as m from "./i18n/messages.generated.ts";
import { type KeptOutsideData, SAVED_OUTSIDE_DATA_WORDS } from "./savedOutsideData";

/**
 * Integrations (docs/integrations.md): a connection to something outside
 * the person's projects that the first mate and every crewmate can reach,
 * signed in as the person. One record per connection, declared by its kind
 * as facets: what it can do (actions, each marked with what it does to the
 * world), and who it is signed in as. The core holds the record
 * (`src/core/integrations/`); this file is the wire shape Settings ->
 * Integrations draws and the first mate reads.
 *
 * Nothing here carries a secret: a kind's sign-in stays with its own owner
 * (GitHub's with the forge's 0600 store, `docs/forge.md`), and a slot a
 * kind declares is shown only as kept or not (`docs/integrations.md`,
 * "Keys"). The one request that carries a value is
 * `inf:integrations:secret`, and nothing hands it back.
 */

/**
 * The kinds the app can connect: GitHub, per-host GitLab and GitHub Enterprise, Google (one row for Gmail and
 * Calendar, signed in once), and any MCP server the person adds (each its
 * own row), and the inbox, a door the person's own programs drop events
 * through (`docs/integrations.md`, "The inbox"). A new kind is one more binding. `stand-in` is a development or
 * end-to-end run's stand-in that tells events from a folder
 * (`INFINITARY_STAND_IN_INTEGRATION`), never connected in a packaged build.
 */
export const integrationKindSchema = z.enum([
  "github",
  "gitlab",
  "github-enterprise",
  "bitbucket",
  "google",
  "mcp",
  "inbox",
  "stand-in",
]);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

export const INTEGRATION_KIND_NAMES: Record<IntegrationKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "github-enterprise": "GitHub Enterprise",
  bitbucket: "Bitbucket",
  google: "Google",
  mcp: "MCP server",
  inbox: "Infinitary Inbox",
  "stand-in": "Stand-in",
};

/**
 * What an action does to the world, as the kind's binding declares it,
 * never read off its name: `reads` changes nothing, `changes` alters
 * something there, `sends` reaches other people.
 */
export const integrationEffectSchema = z.enum(["reads", "changes", "sends"]);
export type IntegrationEffect = z.infer<typeof integrationEffectSchema>;

/** A connection action asks until the captain chooses Always allow (INF-950). */
export const integrationRuleSchema = z.enum(["allow", "ask", "never"]);
export type IntegrationRule = z.infer<typeof integrationRuleSchema>;

/** Off takes precedence over a connection-bound grant. */
export function integrationRule(allowed: boolean, enabled: boolean): IntegrationRule {
  return !enabled ? "never" : allowed ? "allow" : "ask";
}

export const integrationActionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, "an action is named in lowercase words joined by underscores");

export const integrationActionViewSchema = z
  .object({
    name: integrationActionNameSchema,
    /** The action in a few plain words ("Read from GitHub"). */
    label: z.string().min(1).max(64),
    effect: integrationEffectSchema,
    enabled: z.boolean(),
    rule: integrationRuleSchema,
  })
  .strict();
export type IntegrationActionView = z.infer<typeof integrationActionViewSchema>;

/**
 * Something an integration can tell (docs/integrations.md, "What an integration can tell"): an
 * event a rule may listen to, looked for every `every` minutes.
 */
export const integrationEventViewSchema = z
  .object({
    name: integrationActionNameSchema,
    /** The event in a few plain words ("The count changed"). */
    label: z.string().min(1).max(64),
    /** How often, in minutes, a listening rule looks for it. */
    every: z.number().int().min(1),
    filters: z
      .array(
        z.strictObject({
          name: z.string(),
          label: z.string(),
          defaultValue: z.string().optional(),
        }),
      )
      .optional(),
  })
  .strict();
export type IntegrationEventView = z.infer<typeof integrationEventViewSchema>;

/** An integration's id: lowercase words joined by dashes ("github", "mcp-linear"). */
export const integrationIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, "an integration is named by its id");

/**
 * A secret slot's name, as its kind declares it: a word or an environment
 * variable's name ("api_key", "LINEAR_API_KEY").
 */
export const integrationSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "a key is named in letters, digits and underscores");

/** A slot as Settings draws it: its name, its words, and whether a value is kept. Never the value. */
export const integrationSecretViewSchema = z
  .object({
    name: integrationSecretNameSchema,
    /** A few plain words for the slot ("Linear key"). */
    label: z.string().min(1).max(64),
    kept: z.boolean(),
    /** Its actions run without it. */
    optional: z.boolean().optional(),
  })
  .strict();
export type IntegrationSecretView = z.infer<typeof integrationSecretViewSchema>;

/** A value the captain enters for a slot, once; nothing hands it back. */
export const integrationSecretValueSchema = z
  .string()
  .min(1)
  .max(16 * 1024);

/** One name shared by saved settings, Settings and the crew's lookup. */
export const integrationNameSchema = z.string().trim().min(1).max(64);

/** Why the app gave an existing connection a distinct name (INF-882). */
export const integrationRenameSchema = z.strictObject({
  from: integrationNameSchema,
  for: integrationNameSchema,
});

export function integrationRenameWords(rename: z.infer<typeof integrationRenameSchema>): string {
  return `Renamed from “${rename.from}” to keep it distinct from your ${rename.for} connection.`;
}

/**
 * The inbox's door as Settings shows it (docs/integrations.md, "The
 * inbox"): the command's full path in the app, the one line to copy, and
 * the link a click can make into `/usr/local/bin` - made (`linked`, or
 * installed by a Linux package), free to make (`offered`), a folder only an
 * administrator can write (`unwritable`), or a path something else holds
 * (`taken`). Once something ran the command's old name,
 * `infinitary-inbox-axi`, it also says when that last happened and from
 * which folder (`oldName`), so the captain knows what still uses it before
 * retiring it.
 */
export const integrationDoorViewSchema = z
  .object({
    command: z.string().max(4096),
    line: z.string().max(8192),
    link: z
      .object({
        state: z.enum(["linked", "offered", "unwritable", "taken"]),
        path: z.string().max(4096),
      })
      .strict(),
    oldName: z
      .object({
        /** When the old name last ran, in epoch milliseconds. */
        at: z.number(),
        cwd: z.string().max(4096),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IntegrationDoorView = z.infer<typeof integrationDoorViewSchema>;

/**
 * The client a kind signs in as, for a kind that signs in as the person's
 * own client (Google's, docs/integrations.md "Google"): typed
 * facts the row draws its state from, never the client's id or secret.
 */
export const integrationClientViewSchema = z
  .object({
    /** The person keeps a client of their own here. */
    kept: z.boolean(),
    /** The place refused that client itself (Google's `invalid_client` or `deleted_client`). */
    refused: z.enum(["invalid_client", "deleted_client"]).optional(),
    /**
     * The sign-in was made with the app's own client, which still renews it
     * but takes no new sign-in: the row asks the person to set up their own.
     */
    retiring: z.literal(true).optional(),
    /** A new sign-in needs no client of the person's: the run names its own, as a development or test run does. */
    runClient: z.literal(true).optional(),
    /**
     * When the place said the sign-in itself ends, on the home's clock: a
     * client not in Google's Personal mode, whose sign-ins last 7 days.
     */
    endsAt: z.number().optional(),
  })
  .strict();
export type IntegrationClientView = z.infer<typeof integrationClientViewSchema>;

/**
 * The page where a person makes their own Google client in Personal mode,
 * with a Desktop app client and the Workspace APIs filled in: only the
 * account that makes it can sign in with it, and Google neither reviews it
 * nor ends its sign-ins after 7 days (INF-6340's proof run).
 */
export const GOOGLE_CLIENT_SETUP_PAGE =
  "https://console.cloud.google.com/auth/overview/personal?apis=ws&clientType=desktop";

/** A client file as the person drops or pastes it: Google's JSON is a few hundred bytes. */
export const integrationClientFileSchema = z
  .string()
  .min(1)
  .max(16 * 1024);

export const integrationViewSchema = z
  .object({
    id: integrationIdSchema,
    kind: integrationKindSchema,
    /** The host whose existing forge sign-in this row manages. */
    host: z.string().optional(),
    /** The person's word for it; the kind's name until renamed. */
    name: integrationNameSchema,
    /** An automatic name repair, kept until the person chooses a name themselves. */
    renamed: integrationRenameSchema.optional(),
    /** Who it is signed in as there; null until it has answered once. */
    account: z.string().max(100).nullable(),
    /** The sign-in's health, through the five rules (`docs/quota.md`). */
    health: forgeSignInStateSchema,
    /** Paused: nobody reaches it until it is resumed. */
    paused: z.boolean(),
    /**
     * What an MCP server's row runs: the program and its arguments, or its
     * address. Settings alone shows it - a command line may hold a secret,
     * so the first mate and the crew never read it.
     */
    runs: z.string().max(2048).optional(),
    /** An MCP server lists every tool it has, so a row may carry many. */
    actions: z.array(integrationActionViewSchema),
    /** What it can tell a listening rule; absent where it tells of nothing. */
    events: z.array(integrationEventViewSchema).max(256).optional(),
    /** The keys its kind signs in with, kept or not; absent when it declares none. */
    secrets: z.array(integrationSecretViewSchema).max(32).optional(),
    /** The inbox's door, for Settings alone; absent on every other kind. */
    door: integrationDoorViewSchema.optional(),
    /**
     * It signs in in the person's browser and can be signed in again from
     * its row (an MCP server that asked for a sign-in); absent otherwise.
     */
    signIn: z.literal(true).optional(),
    /** The client it signs in as, for a kind that signs in as the person's own (Google). */
    client: integrationClientViewSchema.optional(),
  })
  .strict();
export type IntegrationView = z.infer<typeof integrationViewSchema>;

export const integrationsViewSchema = z
  .object({
    integrations: z.array(integrationViewSchema).max(64),
    /** The kinds that can be connected now, each once: the tab's add chips. */
    addable: z
      .array(
        z
          .object({
            kind: integrationKindSchema,
            name: z.string(),
            /** Whether the person keeps their own client, for a kind that signs in as one. */
            client: integrationClientViewSchema.optional(),
          })
          .strict(),
      )
      .max(16),
    /**
     * The app's own events, always there with nothing to connect, which a
     * rule listens to as it does an integration's (docs/automation.md, "A
     * task closes"). Absent from a home without them.
     */
    appEvents: z
      .array(
        z
          .object({
            id: integrationIdSchema,
            name: z.string().min(1).max(64),
            events: z.array(integrationEventViewSchema).max(32),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    /**
     * A sign-in waiting for the person's browser that said which page it
     * opened (an MCP server's): the name it is for, and the page's address.
     */
    signingIn: z
      .object({ name: integrationNameSchema, page: z.string().min(1).max(8192) })
      .strict()
      .optional(),
  })
  .strict();
export type IntegrationsView = z.infer<typeof integrationsViewSchema>;

/**
 * A change to one integration's settings: a new name (null restores the
 * kind's), pause or resume, and actions turned on or off by name.
 */
export const integrationSettingsPatchSchema = z
  .object({
    name: integrationNameSchema.nullable().optional(),
    paused: z.boolean().optional(),
    actions: z.record(integrationActionNameSchema, z.boolean()).optional(),
  })
  .strict();
export type IntegrationSettingsPatch = z.infer<typeof integrationSettingsPatchSchema>;

/**
 * An MCP server to add (docs/integrations.md, "MCP servers"): the person's
 * name for it, and what it runs - a program with its arguments, started on
 * this computer, or an https address (http only on this computer).
 */
export const integrationMcpAddSchema = z
  .object({
    name: integrationNameSchema,
    runs: z.string().trim().min(1).max(2048),
  })
  .strict();
export type IntegrationMcpAdd = z.infer<typeof integrationMcpAddSchema>;

/**
 * How Settings adds an MCP server: `signIn` lets a server that asks for a
 * sign-in open it in the person's browser. The first mate's addition never
 * passes it.
 */
export const integrationAddHowSchema = z.object({ signIn: z.literal(true) }).strict();
export type IntegrationAddHow = z.infer<typeof integrationAddHowSchema>;

/** The words Settings -> Integrations shows, and the host card's button that opens it. */
export const INTEGRATIONS_WORDS = {
  title: "Integrations",
  intro:
    "What your first mate and your crew can reach outside your projects. Each row is one connection, signed in as you.",
  quiet: "Nothing connected yet.",
  open: "Open Integrations",
  /** The section at the tab's foot that deletes what the crew read (the captain: a "Data" section at the bottom). */
  data: "Data",
} as const;

/** The words an open row's keys show (design skill `components/integrations/IntegrationRow`). */
export const INTEGRATION_SECRET_WORDS = {
  heading: "Keys",
  kept: "Kept on this computer",
  missing: "Not entered",
  placeholder: "Paste it here",
  save: "Save",
  replace: "Replace",
  remove: "Remove",
  stays: "It stays on this computer. Your first mate and your crew use it but never see it.",
} as const;

/**
 * The MCP servers Settings adds with one press, beside the MCP server chip:
 * each asks for a sign-in, which opens in the person's browser
 * (docs/integrations.md, "MCP servers that sign in").
 */
// i18n-exempt: product names and their addresses
export const MCP_SIGN_IN_PICKS: readonly IntegrationMcpAdd[] = [
  { name: "Notion", runs: "https://mcp.notion.com/mcp" },
  { name: "Linear", runs: "https://mcp.linear.app/mcp" },
  { name: "Atlassian", runs: "https://mcp.atlassian.com/v2/mcp" },
];

export const INTEGRATIONS_MCP_WORDS = {
  add: "MCP server",
  title: "Add an MCP server",
  name: "Name",
  namePlaceholder: "Example",
  runs: "Runs",
  runsPlaceholder: "npx -y @example/mcp-server, or https://example.com/mcp",
  runsHint:
    "A program and its arguments, started on this computer when someone uses it, or the server's https address.",
  connect: "Connect",
  connecting: "Connecting…",
  cancel: "Cancel",
  connected: "connected",
  remove: "Remove",
  /** An event's badge, beside the actions' "reads" and "changes". */
  events: "tells",
} as const;

/**
 * The words of the box of the captain's own command, `infinitary-axi`
 * (docs/axi-commands.md, "Infinitary from your terminal"; INF-1894, from
 * INF-1893's agreed design, titled as the captain picked). It took the
 * inbox's place (docs/integrations.md, "The inbox"; INF-1474, INF-1567):
 * the line to copy and what to run, then the short name's link where one
 * can be made or already was. The switch is still the inbox's pause, and
 * the box says whether a rule tells the first mate of a note, never "told
 * at once" when none does (INF-1567, the captain's q4). The delete in the
 * Data section removes the notes and the key.
 */
export const INBOX_WORDS = {
  title: "Infinitary command",
  intro:
    "Programs on this computer, and your own AI agents, can read and act on your cards and tasks and talk to your first mate as you, with one command. A crewmate never gets it, and a note is information, never an instruction.",
  off: "Turn it on to see the line to run.",
  /** Switched off after it was on: the notes and the key are kept. */
  offKept: "Off. The saved notes stay, and the command answers with an error until you turn it on.",
  toggle: "Infinitary command on",
  exampleNote:
    'Run it bare to see what waits on you, or with card, task, say, watch and the rest. Add note "your words" to send your first mate a note.',
  /** The thin skill that points the person's own AI agents at the command, by its short name once linked. */
  setup: (linked: boolean) =>
    linked
      ? "Set up your own AI agents with infinitary-axi setup."
      : "Add setup to the line to set up your own AI agents.",
  copy: "Copy",
  linked: (path: string) => `Linked as ${path}, so the short name works too.`,
  offered: (folder: string) => `Link it into ${folder} to use the short name infinitary-axi.`,
  link: "Link it",
  /** Something still runs the old name, `infinitary-inbox-axi`: when it last did, and from where. */
  oldName: (when: string, cwd: string) =>
    `Something ran the old name infinitary-inbox-axi on ${when}, in ${cwd}. It still works; infinitary-axi is the new name.`,
  /**
   * The card a recorded run of the old name raises, once per folder: the
   * next version removes the name (the captain's words on INF-3904). Each
   * part arrives already marked up.
   */
  oldNameWarning: {
    title: "Your script uses infinitary-inbox-axi which is being deprecated",
    ran: (name: string, when: string, cwd: string) =>
      `Something ran ${name} on ${when}, in ${cwd}.`,
    change: (name: string) =>
      `The next version of Infinitary will remove that name, and the script will stop working. Change the name to ${name} in the script; nothing else changes.`,
    gotIt: "Got it",
  },
  /** A turned-on rule listens. */
  told: "Your first mate is told of a note at once.",
  /** Every rule on the inbox is paused in Automation. */
  rulePaused: (name: string) =>
    `The rule ${name} is paused in Automation, so your first mate is not told of a note. Notes are still saved.`,
  /** No rule on the inbox is left. */
  noRule: "No rule listens to the notes, so your first mate is not told of one.",
  offKeeps: "Off keeps the notes and stops the command until you turn it on.",
  ruleName: "Infinitary Inbox events",
  rulePrompt:
    "New events arrived in your Infinitary Inbox from programs on this computer. Read each one, decide what it needs, and act with your usual judgment: answer on a card, start a task, or do nothing.\n\n{{events}}",
  deleteTitle: "Delete Infinitary Inbox notes",
  deleteLead: "Removes every note your scripts sent and the inbox's key, and turns the inbox off.",
  delete: "Delete",
  confirm: "Confirm delete",
  pending: "Deleting...",
} as const;

export const INTEGRATION_EFFECT_WORDS: Record<IntegrationEffect, string> = {
  reads: "reads",
  changes: "changes",
  sends: "sends",
};

export const INTEGRATION_RULE_WORDS: Record<IntegrationRule, string> = {
  allow: "Always allowed",
  ask: "Asks you",
  never: "Off",
};

/** The host whose sign-in lives in Settings -> Integrations rather than Projects. */
export const INTEGRATIONS_SIGN_IN_HOST = "github.com";

/**
 * The host where projects live whose sign-in an integration's row is
 * (`docs/integrations.md`, "GitHub"): GitHub's own row is the github.com
 * sign-in, and a per-host GitLab or GitHub Enterprise row names its host.
 * Any other kind signs in on its own, and has none.
 */
export function forgeSignInHost(integration: {
  kind: IntegrationKind;
  host?: string;
}): string | undefined {
  return (
    integration.host ?? (integration.kind === "github" ? INTEGRATIONS_SIGN_IN_HOST : undefined)
  );
}

const browserSignInKindSchema = z.enum(["google"]);

/** A typed arrival for a newly named server, before the forge knows its kind. */
export function integrationHostArrival(
  value: string,
): { kind: SignInKind; host: string } | undefined {
  for (const server of SERVER_INTEGRATION_KINDS) {
    const prefix = `${server}:`;
    const kind = hostOfServerIntegration(server)?.kind;
    if (kind && value.startsWith(prefix) && isForgeHostName(value.slice(prefix.length)))
      return { kind, host: value.slice(prefix.length) };
  }
  return undefined;
}

/**
 * Whether a card's `signIn` names a sign-in Settings -> Integrations starts
 * on arrival: GitHub's by its host, or a kind that signs in in the browser
 * by its own name (`google`).
 */
export function isIntegrationSignIn(signIn: string | null | undefined): boolean {
  return (
    !!signIn &&
    (isForgeHostName(signIn) ||
      integrationHostArrival(signIn) !== undefined ||
      isServerIntegration(signIn) ||
      browserSignInKindSchema.safeParse(signIn).success)
  );
}

/**
 * The Settings section an `open` effect lands on: its target, except that
 * a sign-in Integrations owns opens Settings -> Integrations (INF-775, the
 * captain's q2), so a card naming `projects` with `signIn: "github.com"`
 * - written before the move, or by a host card - lands where it lives now.
 * Another computer's own GitHub sign-in (`forgeSignInOn`) is drawn there
 * too, so the card that asks for it opens Integrations with it started.
 */
export function openedSection(effect: {
  target: string;
  signIn?: string | undefined;
  forgeSignInOn?: object | undefined;
}): string {
  return effect.target === "projects" &&
    (isIntegrationSignIn(effect.signIn) || effect.forgeSignInOn !== undefined)
    ? "integrations"
    : effect.target;
}

/**
 * The words of a sign-in that finishes in the person's browser (Google's,
 * docs/integrations.md "Google"): the aside under the chip, or under the
 * row signing in again, while the app waits for the browser to come back.
 */
export const INTEGRATIONS_BROWSER_SIGN_IN_WORDS = {
  waiting: (name: string) => m.integrationsSignInWaiting({ name }),
  get again() {
    return m.integrationsSignInAgain();
  },
  get cancel() {
    return m.integrationsSignInCancel();
  },
};

/**
 * What a kind tells the person before its sign-in starts, and the accept
 * that starts it (INF-949). Google's Workspace user data policy asks for an
 * in-app disclosure of the data used and where it goes that "must
 * accompany and immediately precede a request for user consent", and that
 * no collection begin "prior to obtaining affirmative consent"
 * (docs/integrations.md, "Google's notice").
 */
export type IntegrationNotice = {
  readonly title: string;
  readonly lead: string;
  readonly groups: readonly {
    readonly heading: string;
    /** One item each; `name` leads it, when it has one. */
    readonly items: readonly { readonly name?: string; readonly text: string }[];
  }[];
  readonly closing: string;
  readonly accept: string;
  readonly cancel: string;
};

/**
 * How long Gmail and Calendar words stay in saved conversations before a
 * note takes their place, and what a person calls them: 30 days after they
 * were read, the captain's answer on INF-952 ("30 days, the same as
 * Claude's own sweep"), so no Google data is kept for good
 * (docs/task-retention.md, "Words from outside").
 */
export const GOOGLE_DATA_KEPT: Omit<KeptOutsideData, "label"> = {
  days: 30,
  what: "Gmail and Calendar content",
};

/**
 * Google's notice: what Infinitary uses from Gmail and Calendar, and where
 * it goes - the person's AI provider, another computer that runs the work,
 * and the saved task records, with how long they keep it and how to delete
 * it sooner (INF-952), and a saved attachment's stay and its unmarked words
 * (INF-2466). Only the person's own provider terms and
 * settings decide whether that provider trains on what it receives, while
 * Google forbids its data training AI models, so the notice says both.
 * It also says what the app does against a message written to steer an
 * agent, and the way out it cannot close: a crewmate's own reach to the
 * internet (INF-951, docs/google-verification.md "Prompt injection").
 */
const GOOGLE_NOTICE: IntegrationNotice = {
  title: "Before you connect Google",
  lead: "Read what Infinitary uses from your Google account and where it goes. Google's sign-in page opens only after you accept.",
  groups: [
    {
      heading: "What Infinitary uses",
      items: [
        {
          name: "Gmail",
          text: "The senders, recipients, subjects, dates, labels and text of your messages, and the names, types and sizes of attachments. A crewmate can save an attachment you approve into its task's folder.",
        },
        {
          name: "Calendar",
          text: "Your calendars, their events with titles, times, places, descriptions and guests, and the times you are busy.",
        },
        {
          text: "Infinitary uses them only to do what you ask and to run the rules you turn on. Each label, draft, sent message and event change waits for your approval.",
        },
      ],
    },
    {
      heading: "Where it goes",
      items: [
        {
          name: "Your AI provider",
          text: "What your first mate and crew read, whole messages included, goes to the provider whose model does the work. Your agreement and settings with that provider decide how long it keeps them and whether it trains its models on them. Google does not allow this data to train AI models. Before you connect, check that your provider does not train on your conversations.",
        },
        {
          name: "Other computers",
          text: `If another computer runs your first mate's work, the results that work needs reach it over Infinitary's encrypted connection and stay in its saved conversations for the same ${GOOGLE_DATA_KEPT.days} days. Your Google sign-in stays on this computer.`,
        },
        {
          name: "Saved task records",
          text: `What your first mate and crew read stays in their saved conversations for ${GOOGLE_DATA_KEPT.days} days, then a note takes its place. To delete it sooner, here and on the computers that run your work, use ${SAVED_OUTSIDE_DATA_WORDS.title([GOOGLE_DATA_KEPT])} in Settings → Integrations, under Data. A saved attachment stays in its task's folder until the task closes or ${GOOGLE_DATA_KEPT.days} days pass, and the same delete removes it sooner. Words a crewmate reads inside a saved file are not marked as information from outside, and stay in its conversation after the ${GOOGLE_DATA_KEPT.days} days. What they wrote themselves, in cards, notes and files, stays until you delete the task. Removing Google does not delete any of it. Purge task data deletes every saved task on this computer.`,
        },
      ],
    },
    {
      heading: "Messages written to mislead",
      items: [
        {
          name: "What Infinitary does",
          text: "Anyone can send you words written to steer an AI. Infinitary hands your mail and events to your first mate and crew marked as information from outside, never as instructions.",
        },
        {
          name: "What it cannot stop",
          text: "A message can still mislead an AI model. A crewmate can reach the internet without asking you, so a misled crewmate could send what it read elsewhere.",
        },
      ],
    },
  ],
  closing:
    "Infinitary runs no server that receives your Google data. Your Google data is never sold, used for ads, or used by Infinitary to train AI models.",
  accept: "Accept and continue to Google",
  cancel: "Cancel",
};

export const INTEGRATION_NOTICES: Partial<Record<IntegrationKind, IntegrationNotice>> = {
  google: GOOGLE_NOTICE,
};

/**
 * The person accepted the kind's notice for this sign-in. A sign-in to a
 * kind with a notice carries it, or the core refuses it before the browser
 * opens and before anything is asked of the kind.
 */
export const integrationSignInConsentSchema = z
  .object({ noticeAccepted: z.literal(true) })
  .strict();
export type IntegrationSignInConsent = z.infer<typeof integrationSignInConsentSchema>;

/** What the notice's accept sends with the sign-in. */
export const NOTICE_ACCEPTED: IntegrationSignInConsent = { noticeAccepted: true };

/** Why a sign-in that carries no accept of its kind's notice did not start. */
export function integrationNoticeRefusal(name: string): string {
  return `Read what connecting ${name} shares and accept it in Settings → Integrations before you sign in.`;
}

/**
 * The app's approval card buttons, shared with keyboard journeys. `task`
 * is the allowance for the rest of the asking task (INF-2993), offered only
 * on a crewmate's ask.
 */
export const INTEGRATION_APPROVAL_WORDS = {
  always: "Always allow",
  task: "Allow for the rest of this task",
  once: "Only this time",
  deny: "Not now",
} as const;
export type IntegrationApprovalChoice = keyof typeof INTEGRATION_APPROVAL_WORDS;

/**
 * The approval card's one line on what Allow for the rest of this task
 * covers (INF-2993), given the place's words, already escaped for HTML.
 */
export function integrationTaskAllowLine(covers: string): string {
  return `${INTEGRATION_APPROVAL_WORDS.task} lets this crewmate run this action for ${covers} without asking, until the task closes.`;
}

/**
 * One approval card listing several asks of one task to one connection
 * (INF-2993 piece 2): its title. Its buttons keep the one-ask card's words;
 * the rows say which of them run.
 */
export function integrationApprovalsTitle(count: number, place: string): string {
  return `Allow ${count} actions on ${place}?`;
}

/**
 * The Allow box on each row of a card listing several asks, ticked as the
 * card comes (the captain's ruling: a selection reads positive), and what
 * the crewmate hears of one the captain unticked. Each row is a question of
 * its own, so a row that joins when the card is revised comes ticked rather
 * than taking the earlier reading of the boxes.
 */
export const ALLOW_FIELD = "inf-allow-";
export function allowFieldOf(askId: string): string {
  return `${ALLOW_FIELD}${askId}`;
}
/** The asks a click's reading of the boxes did not allow: rows read unticked. */
export function notAllowedAsks(
  answers: readonly { name: string; values: readonly string[] }[] | undefined,
): string[] {
  return (answers ?? [])
    .filter((answer) => answer.name.startsWith(ALLOW_FIELD) && answer.values.length === 0)
    .map((answer) => answer.name.slice(ALLOW_FIELD.length));
}
export const NOT_ALLOWED_WHY = "The captain did not allow this one.";
/** The words on a row of that card: its box, and its state either way. */
export const ASK_ROW_WORDS = {
  allow: "Allow",
  /** The tally under the rows: "2 of 3 ticked to run on your click". */
  of: " of ",
  ticked: " ticked to run on your click",
  joined: "Joined while this card waited",
} as const;

/**
 * What each button does on a card listing several asks (INF-2993 piece 2),
 * given what the rest of the task would cover, already escaped for HTML.
 */
export function integrationApprovalsButtonLines(covers: string | undefined): readonly {
  choice: IntegrationApprovalChoice;
  words: string;
}[] {
  return [
    { choice: "once", words: "The ticked rows run once. Unticked rows never run." },
    ...(covers === undefined
      ? []
      : [
          {
            choice: "task" as const,
            words: `The same, and later calls for ${covers} run without asking until the task closes.`,
          },
        ]),
    {
      choice: "always",
      words:
        "The same, and these actions run without asking until you change it in Settings, replace the connection, or the action changes.",
    },
    { choice: "deny", words: "Nothing runs." },
  ];
}

/**
 * The host's title and journeys name the same approval card. A label that
 * already ends with its place ("Change something on GitHub") names it once.
 */
export function integrationApprovalTitle(label: string, place: string): string {
  return label.toLowerCase().endsWith(` on ${place.toLowerCase()}`)
    ? `Allow ${label}?`
    : `Allow ${label} on ${place}?`;
}
