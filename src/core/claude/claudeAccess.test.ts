import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { accessFlagSettings, type ResolveClaudeSettings, readClaudeAccess } from "./claudeAccess";

/**
 * What Infinitary reads of the Claude access an organization or the person
 * set up for Claude Code (INF-3449, the captain's words: "accept the
 * company's setup first" and, of the person's own settings, "Yes. Take the
 * gateway address and token command from the person's own Claude settings
 * too"). The reader is the client library's own, over a scratch Claude
 * folder holding the person's settings file the way Claude Code writes it.
 * The organization's tier is the library's server-managed payload, which it
 * merges into the same policy tier as the installed file: writing that
 * file needs administrator rights.
 */

/** A scratch Claude folder whose user settings file holds `settings`. */
function personalSettings(settings: Record<string, unknown>): void {
  const dir = scratchDir("infinitary-claude-access-");
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
}

/**
 * The library's reader seeing only what a case planted: the scratch user
 * settings file and, when given, an organization's settings in its policy
 * tier (the library files that payload as a managed tier from `remote`). A
 * policy tier this computer's own organization installed stays out, so the
 * cases read the same on a managed computer.
 */
function planted(organization?: Record<string, unknown>): ResolveClaudeSettings {
  return async (options) => {
    const resolved = await resolveSettings({
      ...options,
      ...(organization ? { serverManagedSettings: organization } : {}),
    });
    return {
      ...resolved,
      sources: resolved.sources.filter(
        (tier) =>
          tier.source === "user" ||
          (organization !== undefined &&
            tier.source === "managed" &&
            tier.policyOrigin === "remote"),
      ),
    };
  };
}

/** The library's reader with an organization's settings in its policy tier. */
function withOrganization(settings: Record<string, unknown>): ResolveClaudeSettings {
  return planted(settings);
}

/** A person's own settings as a gateway user writes them, with keys the app must leave alone. */
const OWN_GATEWAY = {
  apiKeyHelper: "~/bin/gateway-token --profile work",
  env: { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com", DISABLE_TELEMETRY: "1" },
  model: "opus",
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }] },
  permissions: { allow: ["Bash(rm:*)"] },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claude access set up for Claude Code", () => {
  it("takes the token command and address from the person's own settings, and nothing else", async () => {
    personalSettings(OWN_GATEWAY);
    const read = await readClaudeAccess(planted());
    expect(read.access?.source).toBe("claude-settings");
    expect(accessFlagSettings(read)).toEqual({
      apiKeyHelper: "~/bin/gateway-token --profile work",
      env: { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" },
    });
  });

  it("names the organization when its tier sets a token command, over the person's own", async () => {
    personalSettings(OWN_GATEWAY);
    const read = await readClaudeAccess(
      withOrganization({
        apiKeyHelper: "/opt/corp/bin/claude-token",
        env: { ANTHROPIC_BASE_URL: "https://claude.corp.example.com" },
      }),
    );
    expect(read.access?.source).toBe("organization");
    // The person's own keys still ride flag settings; the client ranks the
    // organization's tier above them, so its own command and address win.
    expect(accessFlagSettings(read).apiKeyHelper).toBe("~/bin/gateway-token --profile work");
  });

  it("accepts an organization's setup when the person has no Claude settings at all", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", scratchDir("infinitary-claude-access-empty-"));
    const read = await readClaudeAccess(
      withOrganization({ apiKeyHelper: "/opt/corp/bin/claude-token" }),
    );
    expect(read.access?.source).toBe("organization");
    expect(accessFlagSettings(read)).toEqual({});
  });

  it("finds no access when no tier sets a token command", async () => {
    personalSettings({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" }, model: "opus" });
    const read = await readClaudeAccess(planted());
    expect(read.access).toBeUndefined();
    // An address alone still reaches sessions, as it reaches Claude Code,
    // and the row names whose address the subscription's requests go to,
    // as the captain chose an account's row to say where its access comes
    // from.
    expect(accessFlagSettings(read)).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" },
    });
    expect(read.gateway).toBe("claude-settings");
  });

  it("names the organization's address over the person's when neither sets a token command", async () => {
    personalSettings({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } });
    const read = await readClaudeAccess(
      withOrganization({ env: { ANTHROPIC_BASE_URL: "https://claude.corp.example.com" } }),
    );
    expect(read.access).toBeUndefined();
    expect(read.gateway).toBe("organization");
  });

  it("names no address when a token command is set, since the access already says where", async () => {
    personalSettings(OWN_GATEWAY);
    expect((await readClaudeAccess(planted())).gateway).toBeUndefined();
  });

  it("calls a changed token command a different access", async () => {
    personalSettings(OWN_GATEWAY);
    const before = await readClaudeAccess(planted());
    personalSettings({ ...OWN_GATEWAY, apiKeyHelper: "~/bin/other-token" });
    const after = await readClaudeAccess(planted());
    expect(after.access?.digest).not.toBe(before.access?.digest);
  });

  it("reads as no access when the settings cannot be read", async () => {
    const read = await readClaudeAccess(async () => {
      throw new Error("plutil failed");
    });
    expect(read).toEqual({});
  });
});
