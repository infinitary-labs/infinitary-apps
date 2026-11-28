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
 * then a sign-in that ends, then one that left Drive out.
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

  // The captain's answer 2a on INF-6447: a sign-in without Drive keeps Gmail and Calendar, and
  // the row says so quietly with Sign in again.
  it("says quietly that a sign-in left Drive out, below every warning", () => {
    expect(googleClientState({ kept: true, withoutDrive: true }, "ok")).toEqual({
      words: m.integrationsGoogleWithoutDrive(),
      tone: "quiet",
      detail: m.integrationsGoogleWithoutDriveDetail(),
      next: "sign-in-again",
    });
    const endsAt = Date.UTC(2026, 9, 29, 16);
    expect(googleClientState({ kept: true, endsAt, withoutDrive: true }, "ok")?.tone).toBe("warn");
    expect(googleClientState({ kept: true, withoutDrive: true }, "needs_reauth")).toBeUndefined();
  });

  it("names Drive among the services that are off, and reads a view from before Drive", () => {
    const link = "https://console.cloud.google.com/flows/enableapi";
    expect(
      googleClientState(
        {
          kept: true,
          mcp: { refused: "service", services: ["gmail"], off: ["gmail", "drive"], link },
        },
        "ok",
      )?.detail,
    ).toBe(
      m.integrationsGoogleServiceOffDetail({
        count: 2,
        services: `${m.integrationsGoogleServiceGmail()} and ${m.integrationsGoogleServiceDrive()}`,
      }),
    );
    expect(
      googleClientState(
        { kept: true, mcp: { refused: "service", services: ["calendar"], link } },
        "ok",
      )?.detail,
    ).toBe(
      m.integrationsGoogleServiceOffDetail({
        count: 1,
        services: m.integrationsGoogleServiceCalendar(),
      }),
    );
  });
});
