import { readClaudeBedrockSetup } from "../claude/claudeAccess";
import type { StandIns } from "../standIns";
import { PiAccountBackend } from "./piAccountBackend";

/**
 * The app's own Pi account backend: every account runtime reads the app's
 * one models.json (custom providers and per-provider overrides), keeping its
 * own pi.dev overlay store, and an Amazon Bedrock sign-in starts from
 * Claude Code's Bedrock settings on this computer. Kept apart from
 * PiAccountBackend so that the backend's own tests load no Claude client
 * library, whose import writes a process environment variable.
 */
export function appPiAccountBackend(
  modelsPath: string,
  standIns: Pick<StandIns, "bedrockUrl" | "awsCli">,
  onCatalogRefreshed?: () => void,
): PiAccountBackend {
  return new PiAccountBackend({
    modelsPath,
    ...(onCatalogRefreshed ? { onCatalogRefreshed } : {}),
    bedrockUrl: standIns.bedrockUrl,
    awsCli: standIns.awsCli,
    bedrockClaudeSetup: () => readClaudeBedrockSetup(),
  });
}
