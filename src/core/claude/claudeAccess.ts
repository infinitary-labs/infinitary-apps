import { createHash } from "node:crypto";
import type { ResolvedSettings, ResolveSettingsOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAccessSource } from "@shared/claudeAccess";

/**
 * Claude access that is not a Claude subscription sign-in: a token command
 * (Claude Code's `apiKeyHelper`) and the address it is sent to (the
 * `ANTHROPIC_BASE_URL` of a settings file's `env`), set up for Claude Code
 * by an organization or by the person (docs/claude-client.md, "Access a
 * company set up").
 *
 * They are read with the client library's own settings reader, the same
 * merge the client runs at start, so the organization's tier is the
 * installed file and its drop-in folder, a device-management profile, the
 * Windows registry and the server-managed cache - but not what an
 * administrator's `policyHelper` program computes, which the reader does
 * not run - and the person's own tier is their user settings file. Only the person's settings file is
 * asked for (`settingSources: ["user"]`); a project's settings stay unread.
 *
 * Infinitary never runs the command and never sees what it prints. The
 * organization's tier needs nothing from the app: the client reads it in
 * every session whatever `settingSources` says. Of the person's own
 * settings only these two keys reach a session, as the app's own flag
 * settings (`accessSettings`); everything else in that file stays out, as
 * it always has.
 */

/** The organization's access, or the person's own, as a fact the row and the store stamp read. */
export type ClaudeAccess = {
  source: ClaudeAccessSource;
  /**
   * Which command and address are in use, as a digest compared for
   * equality alone: a different one is a changed sign-in, which ends a
   * refusal recorded under the old one. Never what the command prints.
   */
  digest: string;
};

/** The two keys of the person's own settings a session is handed, when they set any. */
export type ClaudeAccessSettings = {
  apiKeyHelper?: string;
  env?: { ANTHROPIC_BASE_URL: string };
};

export type ClaudeAccessRead = {
  /** Present when a token command is set: the client signs in with it, ahead of a subscription. */
  access?: ClaudeAccess;
  /** The person's own token command and address, for the app's flag settings. */
  settings?: ClaudeAccessSettings;
  /**
   * Who set the address requests go to when no tier sets a token command:
   * the subscription sign-in still serves, through that address.
   */
  gateway?: ClaudeAccessSource;
};

/** The settings reader's shape; production is the client library's own. */
export type ResolveClaudeSettings = (options: ResolveSettingsOptions) => Promise<ResolvedSettings>;

/**
 * The client library's own reader, loaded when first asked for: loading the
 * library sets a process-wide environment variable, which a module that
 * only imports the Claude sign-in must not do.
 */
const resolveSettings: ResolveClaudeSettings = async (options) =>
  (await import("@anthropic-ai/claude-agent-sdk")).resolveSettings(options);

/** One tier's command and address, each only when it is a non-empty string. */
function tierKeys(settings: unknown): { command?: string; address?: string } {
  if (!settings || typeof settings !== "object") return {};
  const record = settings as Record<string, unknown>;
  const command = typeof record.apiKeyHelper === "string" ? record.apiKeyHelper.trim() : "";
  const env = record.env && typeof record.env === "object" ? record.env : {};
  const raw = (env as Record<string, unknown>).ANTHROPIC_BASE_URL;
  const address = typeof raw === "string" ? raw.trim() : "";
  return { ...(command ? { command } : {}), ...(address ? { address } : {}) };
}

/**
 * What the client would sign in with, from the organization's tier and the
 * person's own. The organization's command wins over the person's, as it
 * does in the client. A reader that fails reads as no such access: the
 * account then reads its subscription sign-in as before.
 */
export async function readClaudeAccess(
  resolve: ResolveClaudeSettings = resolveSettings,
): Promise<ClaudeAccessRead> {
  let resolved: ResolvedSettings;
  try {
    resolved = await resolve({ settingSources: ["user"] });
  } catch {
    return {};
  }
  let organization: { command?: string; address?: string } = {};
  let own: { command?: string; address?: string } = {};
  // Sources run low to high precedence: a later tier of the same kind wins.
  for (const tier of resolved.sources) {
    if (tier.source === "managed") organization = { ...organization, ...tierKeys(tier.settings) };
    if (tier.source === "user") own = { ...own, ...tierKeys(tier.settings) };
  }
  const settings: ClaudeAccessSettings = {
    ...(own.command ? { apiKeyHelper: own.command } : {}),
    ...(own.address ? { env: { ANTHROPIC_BASE_URL: own.address } } : {}),
  };
  const command = organization.command ?? own.command;
  const source: ClaudeAccessSource | undefined = organization.command
    ? "organization"
    : own.command
      ? "claude-settings"
      : undefined;
  const address = organization.address ?? own.address ?? "";
  const gateway: ClaudeAccessSource | undefined = organization.address
    ? "organization"
    : own.address
      ? "claude-settings"
      : undefined;
  return {
    ...(source && command
      ? { access: { source, digest: accessDigest(source, command, address) } }
      : gateway
        ? { gateway }
        : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

function accessDigest(source: ClaudeAccessSource, command: string, address: string): string {
  return createHash("sha256")
    .update(`${source}\0${command}\0${address}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The flag settings a session lays over the app's own: the person's token
 * command and address, and nothing else of their settings. The
 * organization's tier ranks above flag settings in the client, so where it
 * sets either key, its own wins.
 */
export function accessFlagSettings(read: ClaudeAccessRead | undefined): ClaudeAccessSettings {
  return read?.settings ?? {};
}
