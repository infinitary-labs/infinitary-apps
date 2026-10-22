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
} from "./binding";
export { CREWMATE_INTEGRATIONS_LINE, INTEGRATIONS_COMMAND } from "./commandWords";
export {
  type GithubIntegrationGateway,
  type GithubIntegrationOptions,
  githubIntegration,
} from "./providers/github";
export {
  IntegrationRefusal,
  IntegrationsService,
  type IntegrationsServiceOptions,
  type TaskIntegrations,
} from "./service";
export { IntegrationSettingsStore } from "./store";
