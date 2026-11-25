/**
 * The integrations seam's one door (docs/integrations.md). Everything
 * outside `src/core/integrations/` imports this file; a kind's binding
 * under `./providers/` is reachable only through it and the composition
 * root, the way the forge's providers are.
 */

export type {
  IntegrationAskSent,
  IntegrationAskStore,
  IntegrationAskTaken,
  PanelAskKept,
} from "./askStore";
export type {
  IntegrationActionSpec,
  IntegrationAnswer,
  IntegrationBinding,
  IntegrationCaller,
  IntegrationConnection,
  IntegrationEventItem,
  IntegrationEventSpec,
  IntegrationLook,
  PanelCaller,
} from "./binding";
export { IntegrationOutcomeUnknown } from "./binding";
export {
  CREWMATE_INTEGRATIONS_LINE,
  INBOX_COMMAND,
  INFINITARY_COMMAND,
  INTEGRATIONS_COMMAND,
} from "./commandWords";
export {
  ClaudeFiles,
  conversationFiles,
  type DueKind,
  dueIn,
  dueRule,
  rewrite as rewriteOutsideData,
  textFilesUnder,
} from "./outsideDataFiles";
export { FIRSTMATE_READER, OutsideReads } from "./outsideReads";
export { type PanelAskLine, PanelAsks } from "./panelAsks";
export { forgeHostIntegration, forgeIntegrationId } from "./providers/forgeHosts";
export {
  type GithubIntegrationGateway,
  type GithubIntegrationOptions,
  githubIntegration,
} from "./providers/github";
export { CALENDAR_ACTIONS, CALENDAR_CHANGED_EVENT } from "./providers/google/calendar";
export { GOOGLE_OAUTH_CLIENT, GOOGLE_SCOPES, googleSetup } from "./providers/google/client";
export { GMAIL_ACTIONS, GMAIL_MESSAGE_EVENT } from "./providers/google/gmail";
export {
  GOOGLE_DATA_FENCE,
  type GoogleIntegrationOptions,
  googleIntegration,
} from "./providers/google/googleIntegration";
export {
  INBOX_EVENT,
  INBOX_FENCE,
  INBOX_ID,
  Inbox,
  type InboxDoor,
  type InboxReceipt,
  type InboxReceiptLine,
  launcherDataDir,
} from "./providers/inbox";
export { type McpIntegrationOptions, mcpIntegration } from "./providers/mcp/mcpIntegration";
export {
  STAND_IN_EVENT,
  type StandInIntegrationOptions,
  standInIntegration,
} from "./providers/standIn";
export {
  type OutsideDue,
  type PlacedOutsideVisit,
  SavedOutsideData,
  type SavedOutsideDataOptions,
} from "./savedOutsideData";
export { type IntegrationKeys, REDACTED } from "./secrets";
export {
  type IntegrationListen,
  IntegrationRefusal,
  IntegrationsService,
  type IntegrationsServiceOptions,
  isIntegrationAnswer,
  type PanelIntegrationsReach,
  type TaskIntegrations,
} from "./service";
export { IntegrationSettingsStore } from "./store";
