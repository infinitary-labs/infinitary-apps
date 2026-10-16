import { z } from "zod";
import { CUT_OFF_CLASSES } from "./authFailure";

/**
 * Account views for the multi-account broker (the AccountVault). An account
 * is one signed-in subscription or key for one provider; each account owns
 * an isolated harness-native auth store under userData/accounts/. Views are
 * metadata only - no schema here can ever carry a credential.
 *
 * Product rule (captain, account-broker review): the user sees providers
 * and accounts, labeled by subscription - never the harness machinery.
 */

/** The longest label a rename takes; the rename field stops there. */
export const ACCOUNT_LABEL_MAX = 64;

export const credentialKindSchema = z.enum(["subscription_oauth", "api_key"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

export const accountViewSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  kind: credentialKindSchema,
  /** User-facing label ("Personal", "Work #2"); always editable. */
  label: z.string(),
  /** Disabled accounts keep their credentials but leave the selection pool. */
  enabled: z.boolean(),
  /** Whether the store currently holds a usable credential. */
  connected: z.boolean(),
  /**
   * Local proof this account needs a sign-in (a lapsed refresh token).
   * Distinct from a missing first-run login and from a retryable miss.
   */
  needsReauth: z.boolean().optional(),
  /** The provider-level account pin (the one that always wins selection). */
  pinned: z.boolean(),
  createdAt: z.number(),
  lastConnectedAt: z.number().optional(),
  /**
   * Who the provider says signed in - an email or org - where the provider
   * reports one at all. Pi has no identity surface; Claude does. Never a
   * credential, and never the internal account id.
   */
  identity: z.string().optional(),
  /** The plan the provider reports ("Max", "Pro"), when it reports one. */
  plan: z.string().optional(),
  /**
   * Why this account cannot serve right now although its credential is
   * fine, in the backend's own sentence: a Claude account whose machine has
   * no Claude Code, or one too old (`src/shared/claudeClient.ts`). Rendered
   * verbatim; absent when the account can serve.
   */
  detail: z.string().optional(),
  /**
   * A typed cut-off standing on this account (docs/quota.md, "Typed
   * cut-offs"): its class, when it was seen, and a spent allowance's reset
   * (epoch ms). A computer that runs work tells its home this with its
   * sign-ins, so a task there waits as one on the home's own accounts does
   * (docs/helper.md, "Its own sign-ins"). Absent when none stands.
   */
  cutOff: z
    .object({
      class: z.enum(CUT_OFF_CLASSES),
      since: z.number(),
      resetsAt: z.number().optional(),
    })
    .optional(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

/**
 * The cut-off an account row says stands at `now`: a spent allowance stands
 * only until its reset, as the vault holds it (`AccountVault.cutOff`).
 */
export function standingCutOff(
  account: Pick<AccountView, "cutOff">,
  now: number,
): AccountView["cutOff"] {
  const cutOff = account.cutOff;
  if (!cutOff) return undefined;
  if (cutOff.class === "no_headroom" && (cutOff.resetsAt ?? 0) <= now) return undefined;
  return cutOff;
}

/**
 * What signing out of an account did to the login its vendor's own client
 * keeps for the whole macOS user, for an account that stands on one
 * (Claude's, docs/helper.md "Its own sign-ins"):
 *
 * - `signed-out`: Firstmate made that login from a code the captain pasted,
 *   and it is signed out now;
 * - `kept`: the login there is not one Firstmate made - it was there before,
 *   or another took its place - so it stays;
 * - `not-signed-out`: Firstmate made it and could not sign it out.
 */
export const machineLoginOutcomeSchema = z.enum(["signed-out", "kept", "not-signed-out"]);
export type MachineLoginOutcome = z.infer<typeof machineLoginOutcomeSchema>;
