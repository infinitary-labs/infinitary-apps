import { formatDate } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { IntegrationClientView } from "@shared/integrations";
import { describe, expect, it } from "vitest";
import { googleClientState } from "./GoogleClientSetup";

/**
 * The Google row's client state (docs/integrations.md, "Google"), which the
 * phone's `PhoneGoogleClientState` says in the same order: a refused client,
 * then a refused sign-in as every row shows it, then Google's MCP servers
 * refusing the client or a service (`tests/e2e/integrations-google.spec.ts`),
 * then a sign-in that ends.
 */
describe("the Google row's client state", () => {
  it("names a client Google refused, even on a sign-in it refused", () => {
    const client: IntegrationClientView = { kept: true, refused: "deleted_client" };
    expect(googleClientState(client, "needs_reauth")).toEqual({
      words: m.integrationsGoogleStopped(),
      tone: "danger",
      detail: m.integrationsGoogleStoppedDetail(),
      next: "set-up-again",
    });
  });

  it("says when a sign-in ends, and leaves a refused one to its health", () => {
    const endsAt = Date.UTC(2026, 9, 29, 16);
    const date = formatDate(endsAt, { dateStyle: "medium" });
    expect(googleClientState({ kept: true, endsAt }, "ok")).toEqual({
      words: m.integrationsGoogleStops({ date }),
      tone: "warn",
      detail: m.integrationsGoogleStopsDetail({ date }),
      next: "set-up-again",
    });
    expect(googleClientState({ kept: true, endsAt }, "needs_reauth")).toBeUndefined();
  });

  it("draws no state from the retiring fact a home from before Infinitary's own client retired still sends", () => {
    expect(googleClientState({ kept: false, retiring: true }, "ok")).toBeUndefined();
    expect(googleClientState({ kept: true, retiring: true }, "ok")).toBeUndefined();
  });
});
