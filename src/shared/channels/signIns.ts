import { z } from "zod";
import { ACCOUNT_LABEL_MAX, accountViewSchema } from "../accounts";
import {
  customApiAddressSchema,
  customApiConnectInputSchema,
  customApiConnectResultSchema,
  customApiInputSchema,
  customApiReviewSchema,
  customApiViewSchema,
  customCapabilityProfileSchema,
  customListedModelSchema,
  customNetworkModeSchema,
} from "../customApi";
import {
  forgeBrowserSignInSchema,
  forgeChangesViewSchema,
  forgeCliSignInResultSchema,
  forgeKeySignInResultSchema,
  forgeKeySignInSchema,
  forgeProjectListingSchema,
  forgeProjectSchema,
  forgeSignInFlowSchema,
  forgesViewSchema,
} from "../forges";
import {
  integrationActionNameSchema,
  integrationAddHowSchema,
  integrationClientFileSchema,
  integrationIdSchema,
  integrationKindSchema,
  integrationMcpAddSchema,
  integrationSecretNameSchema,
  integrationSecretValueSchema,
  integrationSettingsPatchSchema,
  integrationSignInConsentSchema,
  integrationsViewSchema,
} from "../integrations";
import { providerViewSchema } from "../providers";
import { savedResetResultSchema, useSavedResetOptionsSchema } from "../savedResets";
import { type ChannelDeclaration, okSchema } from "./common";

/** Sign-ins: subscriptions and their accounts, custom API connections, where projects live, and integrations. */
/** The computer that runs work a change is for; absent, it is this Mac's own. */
const DEVICE = z.string().min(1).max(64).optional();

export const signInChannels = {
  "inf:auth:providers": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(providerViewSchema),
  },
  "inf:auth:prompt-reply": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.string().nullable()]),
    response: okSchema,
  },
  // Stops every sign-in this Mac's window started and is still waiting on,
  // wherever it waits: a prompt, a browser, or a code being polled. The
  // stopped add or sign-in rejects, and nothing is added (INF-838).
  "inf:auth:cancel": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: okSchema,
  },
  // The account broker: N accounts per provider, each an isolated store.
  // Built-in sign-in runs the provider's own flow. Custom preparation sends
  // an opaque key once to its owner; no response schema returns credentials.
  "inf:accounts:custom:profiles": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(customCapabilityProfileSchema),
  },
  "inf:accounts:custom:review": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), customNetworkModeSchema, z.string().optional()]),
    response: customApiReviewSchema,
  },
  // The address's canonical form and the network its name points to now; DNS only.
  "inf:accounts:custom:address": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().max(4096)]),
    response: customApiAddressSchema,
  },
  // Save's and Fetch's one step: the network read, a draft and the server's
  // model list, with each failure as a category rather than thrown text.
  "inf:accounts:custom:connect": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([customApiConnectInputSchema]),
    response: customApiConnectResultSchema,
  },
  "inf:accounts:custom:prepare": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([customApiInputSchema]),
    response: customApiViewSchema,
  },
  "inf:accounts:custom:check": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.string()]),
    response: customApiViewSchema,
  },
  "inf:accounts:custom:discover": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: z.array(customListedModelSchema),
  },
  "inf:accounts:custom:cancel": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  "inf:accounts:custom:save": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean()]),
    response: customApiViewSchema,
  },
  // A saved connection's one fresh check, once its saved checks no longer
  // count (an earlier version's): the first-launch gate asks for it in place.
  "inf:accounts:custom:recheck": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: customApiViewSchema,
  },
  "inf:accounts:custom:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(customApiViewSchema),
  },
  "inf:accounts:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(accountViewSchema),
  },
  // The third part is the GitHub Enterprise host a Copilot sign-in goes to,
  // as typed; absent is github.com (INF-838).
  "inf:accounts:add": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string(),
      z.enum(["oauth", "api_key"]),
      z.strictObject({ enterpriseHost: z.string().min(1).max(253) }).optional(),
    ]),
    response: accountViewSchema,
  },
  "inf:accounts:sign-in": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: accountViewSchema,
  },
  // A last element names the computer that runs work whose own account it
  // is (`computer-account-settings`): the change is made and saved there.
  "inf:accounts:remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), DEVICE]),
    response: okSchema,
  },
  "inf:accounts:rename": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.string().min(1).max(ACCOUNT_LABEL_MAX), DEVICE]),
    response: okSchema,
  },
  "inf:accounts:set-enabled": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean(), DEVICE]),
    response: okSchema,
  },
  // Keep going on credits (docs/quota.md): the account's switch, on or off.
  // A third element names the computer that runs work whose own account it
  // is (`computer-keep-going`), where the switch is saved.
  "inf:accounts:keep-going": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean(), DEVICE]),
    response: okSchema,
  },
  // Uses one of a Codex account's saved resets through the Codex CLI the
  // person installed (docs/codex-client.md, `use-saved-reset`): with
  // `signIn`, Codex may sign in to the account, its link and paste-back
  // prompt shown as a sign-in's; with `deviceId`, the account is that
  // computer that runs work's own and is used there.
  "inf:accounts:use-saved-reset": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), useSavedResetOptionsSchema.optional()]),
    response: savedResetResultSchema,
  },
  // Use saved resets on their own, on or off (docs/quota.md, "Saved resets
  // on their own", `auto-saved-resets`): turning it on with `signIn` lets
  // Codex sign in to the account first, its link and paste-back prompt
  // shown as a sign-in's; with `deviceId`, the account is that computer
  // that runs work's own and its switch is saved there.
  "inf:accounts:use-saved-resets": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean(), useSavedResetOptionsSchema.optional()]),
    response: okSchema,
  },
  "inf:accounts:pin": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.string().nullable(), DEVICE]),
    response: okSchema,
  },
  // The app's own sign-ins where projects live (git integration PR 1.2,
  // docs/forge.md): optional, one per host. Sign-in starts the host's
  // device flow and answers with the code; how it ends rides `inf:forges`.
  // No schema here carries a secret.
  "inf:forges:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: forgesViewSchema,
  },
  "inf:forges:projects": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(253)]),
    response: z.array(forgeProjectSchema),
  },
  // The same listing, saying whether it read every project.
  "inf:forges:projects-listed": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(253)]),
    response: forgeProjectListingSchema,
  },
  "inf:forges:sign-in": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(253)]),
    response: forgeSignInFlowSchema,
  },
  // A public application registered on the chosen host; no application secret.
  "inf:forges:sign-in-browser": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([forgeBrowserSignInSchema]),
    response: forgeSignInFlowSchema,
  },
  // A host on the person's own server (GitHub Enterprise) signs in with a
  // key the person made there: this request hands it to the core once,
  // which checks it with the host before keeping it. The one request here
  // that carries a secret; nothing hands it back.
  "inf:forges:sign-in-key": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([forgeKeySignInSchema]),
    response: forgeKeySignInResultSchema,
  },
  // A GitHub host signed in through the person's own GitHub CLI: the core
  // asks GitHub CLI for its sign-in and the host who that is, and keeps
  // only the way and the program's path (docs/forge.md, "GitHub CLI's
  // sign-in"). The address is github.com or a GitHub Enterprise host's.
  "inf:forges:sign-in-cli": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(2000)]),
    response: forgeCliSignInResultSchema,
  },
  "inf:forges:cancel": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: forgesViewSchema,
  },
  // A second element signs a computer that runs work out of its own sign-in
  // there (`computer-account-settings`); the answer is still this Mac's view.
  "inf:forges:sign-out": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(253), DEVICE]),
    response: forgesViewSchema,
  },
  // The person's open proposed changes where their projects live, read
  // with the app's sign-in: the `forge.changes` panel read.
  "inf:forges:changes": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: forgeChangesViewSchema,
  },
  // Integrations (docs/integrations.md): connections outside the person's
  // projects the first mate and the crew reach. A connection is made by
  // its kind's own sign-in (GitHub's is `inf:forges:sign-in`, Google's
  // `inf:integrations:sign-in`), or added from the person's words (an MCP
  // server, `inf:integrations:add`); these
  // change its settings, forget it, or check it. Only `secret` carries a
  // value, the captain's own entry, and nothing hands it back.
  "inf:integrations:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
  "inf:integrations:configure": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationIdSchema, integrationSettingsPatchSchema]),
    response: integrationsViewSchema,
  },
  "inf:integrations:rule": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationIdSchema, integrationActionNameSchema, z.boolean()]),
    response: integrationsViewSchema,
  },
  "inf:integrations:remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationIdSchema]),
    response: integrationsViewSchema,
  },
  "inf:integrations:check": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationIdSchema]),
    response: integrationsViewSchema,
  },
  // A key the captain enters for one slot (docs/integrations.md, "Keys"),
  // or null to forget it. The answer says only whether each slot is kept.
  "inf:integrations:secret": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      integrationIdSchema,
      integrationSecretNameSchema,
      integrationSecretValueSchema.nullable(),
    ]),
    response: integrationsViewSchema,
  },
  // The person's own client for a kind that signs in as one (Google's
  // client file, docs/integrations.md "Your own Google client"), dropped or
  // pasted: its secret goes into Secrets, and the answer says only whether a
  // client is kept.
  "inf:integrations:client": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationKindSchema, integrationClientFileSchema]),
    response: integrationsViewSchema,
  },
  "inf:integrations:add": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationMcpAddSchema, integrationAddHowSchema.optional()]),
    response: z.object({ id: integrationIdSchema, view: integrationsViewSchema }).strict(),
  },
  // Sign one row in again in the person's browser (an MCP server whose
  // sign-in ended); the cancel below ends its wait too.
  "inf:integrations:sign-in-again": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationIdSchema]),
    response: integrationsViewSchema,
  },
  // Open the waiting sign-in's page once more (`IntegrationsView.signingIn`).
  "inf:integrations:sign-in-page": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
  // Sign in to a kind that signs in in the person's browser (Google): the
  // answer comes once the browser is back, and the cancel ends the wait.
  // A kind with a notice needs its accept (INF-949), or nothing opens.
  "inf:integrations:sign-in": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([integrationKindSchema, integrationSignInConsentSchema.optional()]),
    response: z.object({ id: integrationIdSchema, view: integrationsViewSchema }).strict(),
  },
  // What the browser brought back to a sign-in's return on the computer the
  // person is at, as its path, or the address it ended on, pasted: handed to
  // the port that sign-in listens on, once, with the page it answered
  // (`SIGN_IN_RETURN`, src/core/signInReturns.ts).
  "inf:integrations:sign-in-return": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.object({ id: z.string().min(1).max(64), address: z.string().min(1).max(4096) }).strict(),
    ]),
    response: z
      .object({ status: z.number().int().min(100).max(599), page: z.string().max(16_384) })
      .strict(),
  },
  "inf:integrations:sign-in-cancel": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
  // The inbox's one-click link of its command into /usr/local/bin
  // (docs/integrations.md, "The inbox"), only where that path is free and
  // the folder writable without an administrator.
  "inf:integrations:inbox-link": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
