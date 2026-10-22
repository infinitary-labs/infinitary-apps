/**
 * The integrations seam's one door (docs/integrations.md). Everything
 * outside `src/core/integrations/` imports this file; a kind's binding
 * under `./providers/` is reachable only through it and the composition
 * root, the way the forge's providers are.
 */

export type {
  IntegrationActionSpec,
  IntegrationAnswer,
  IntegrationBinding,
  IntegrationCaller,
  IntegrationConnection,
  IntegrationSecretSlot,
} from "./binding";
export { CREWMATE_INTEGRATIONS_LINE, INTEGRATIONS_COMMAND } from "./commandWords";
export {
  type GithubIntegrationGateway,
  type GithubIntegrationOptions,
  githubIntegration,
} from "./providers/github";
export {
  FileIntegrationSecrets,
  type IntegrationSecrets,
  MissingSecret,
  REDACTED,
  type SecretRequestInit,
} from "./secrets";
export {
  type IntegrationAskSent,
  type IntegrationAskStore,
  IntegrationRefusal,
  IntegrationsService,
  type IntegrationsServiceOptions,
  isIntegrationAnswer,
  type TaskIntegrations,
} from "./service";
export { IntegrationSettingsStore } from "./store";
