import type { IntegrationsService } from "../../src/core/integrations";

/** INF-950: transport tests explicitly start with the captain's reads already allowed. */
export function allowIntegrationReads(service: IntegrationsService): void {
  for (const row of service.view().integrations)
    for (const action of row.actions)
      if (action.effect === "reads") service.setRule(row.id, action.name, true);
}
