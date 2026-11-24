import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOTICE_ACCEPTED } from "@shared/integrations";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GoogleStandIn,
  OWN_CLIENT_ID,
  OWN_CLIENT_SECRET,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
} from "../../../../../tests/helpers/googleStandIn";
import { type GoogleWorldOptions, googleWorld } from "../../../../../tests/helpers/googleWorld";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { GOOGLE_SCOPES, type IntegrationsService } from "../..";
import { GoogleClientStore, GoogleSignInStore } from "./store";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const fixture = (...args: GoogleWorldOptions) => googleWorld(cleanup, ...args);

/**
 * INF-5549's plan, piece 2: "Google sign-in and renewal take the person's
 * own client (id in a client record, secret in Secrets via the
 * google-sign-in broker), with GOOGLE_OAUTH_CLIENT still serving when none
 * exists"; "invalid_grant keeps today's Sign in again; invalid_client or
 * deleted_client reads as the client gone; a refresh_token_expires_in field
 * is recorded as the sign-in's end"; "Signing out keeps the client;
 * removing the Google connection forgets both Secrets entries".
 */
describe("the person's own Google client", () => {
  const search = (integrations: IntegrationsService) =>
    integrations
      .forTask("task-1")
      .call(
        "Google",
        "search_mail",
        { max: 1 },
        undefined,
        "To perform the task’s requested action.",
      );
  const tokenForms = (google: GoogleStandIn, grant: string) =>
    google.tokens.filter((form) => form.grant_type === grant);
  // Secrets zero-fills a value once it keeps it, so each keep gets its own copy.
  const ownClient = () => ({ id: OWN_CLIENT_ID, secret: Buffer.from(OWN_CLIENT_SECRET, "utf8") });

  async function signedInOwn() {
    const world = await fixture();
    await world.binding.keepClient(ownClient());
    await world.integrations.signIn("google", NOTICE_ACCEPTED);
    allowIntegrationReads(world.integrations);
    return world;
  }

  it("signs in and renews as the person's client, its secret added only inside Secrets", async () => {
    const { google, dir, clock, opened, integrations, keys } = await signedInOwn();
    const signedInAt = clock.now;

    expect(new URL(opened[0] ?? "").searchParams.get("client_id")).toBe(OWN_CLIENT_ID);
    expect(tokenForms(google, "authorization_code")).toEqual([
      expect.objectContaining({ client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET }),
    ]);
    expect(integrations.view().integrations[0]).toMatchObject({
      account: STAND_IN_ACCOUNT,
      health: "ok",
    });
    // The stand-in's lasting key lasts 604,799 seconds, as Google says for a client in Testing.
    expect(new GoogleSignInStore(dir).read()).toMatchObject({
      client: OWN_CLIENT_ID,
      endsAt: signedInAt + 604_799_000,
    });
    expect(await keys.entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Google client", discoverable: false }),
        expect.objectContaining({ label: "Google sign-in", discoverable: false }),
      ]),
    );
    for (const file of ["google.json", "google-client.json"]) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, file), "utf8")).not.toContain(OWN_CLIENT_SECRET);
    }
    expect(new GoogleClientStore(dir).read()).toMatchObject({ id: OWN_CLIENT_ID });

    clock.now += 3_600_000;
    expect((await search(integrations)).refused).toBeUndefined();
    expect(tokenForms(google, "refresh_token")).toEqual([
      expect.objectContaining({ client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET }),
    ]);
    // Signing in was the consent: neither the exchange nor the renewal asked.
    expect(keys.cards).toEqual([]);
    expect(keys.confirms()).toBe(0);
  });

  it("records no end when Google names none for the lasting key", async () => {
    const world = await fixture();
    world.google.knobs.lasts = undefined;
    await world.binding.keepClient(ownClient());
    await world.integrations.signIn("google", NOTICE_ACCEPTED);
    expect(new GoogleSignInStore(world.dir).read()?.endsAt).toBeUndefined();
  });

  it("reads a deleted or refused client as gone, and a refused lasting key as signed out only", async () => {
    const { google, dir, binding, clock, integrations } = await signedInOwn();

    google.knobs.deleted.add(OWN_CLIENT_ID);
    clock.now += 3_600_000;
    const deleted = await search(integrations);
    expect(deleted.refused).toBe("refused");
    expect(deleted.text).toContain("Google no longer accepts your Google client (deleted_client)");
    expect(integrations.view().integrations[0]?.health).toBe("needs_reauth");
    expect(new GoogleClientStore(dir).read()?.refused).toEqual({
      error: "deleted_client",
      at: clock.now,
    });

    // The person made a new secret in Google Cloud, so the kept one is refused.
    google.knobs.deleted.delete(OWN_CLIENT_ID);
    google.knobs.clients.set(OWN_CLIENT_ID, "GOCSPX-rotated-secret-9Kx1");
    clock.now += 60_000;
    expect((await search(integrations)).text).toContain(
      "Google no longer accepts your Google client (invalid_client)",
    );
    expect(new GoogleClientStore(dir).read()?.refused).toEqual({
      error: "invalid_client",
      at: clock.now,
    });

    // Keeping the new secret and signing in again clears the refusal.
    await binding.keepClient({
      id: OWN_CLIENT_ID,
      secret: Buffer.from("GOCSPX-rotated-secret-9Kx1", "utf8"),
    });
    await integrations.signIn("google", NOTICE_ACCEPTED);
    expect(new GoogleClientStore(dir).read()?.refused).toBeUndefined();
    expect(integrations.view().integrations[0]?.health).toBe("ok");

    // Google refusing the lasting key is a sign-out, never the client gone.
    google.revokeElsewhere();
    clock.now += 3_600_000;
    expect((await search(integrations)).text).toContain(
      "Sign in again in Settings -> Integrations",
    );
    expect(integrations.view().integrations[0]?.health).toBe("needs_reauth");
    expect(new GoogleClientStore(dir).read()?.refused).toBeUndefined();
  });

  it("fails a sign-in whose code exchange Google refuses for the client, keeping the client and recording why", async () => {
    const { google, dir, binding, integrations, keys } = await fixture();
    await binding.keepClient(ownClient());
    // The person made a new secret in Google Cloud after giving the app the old one.
    google.knobs.clients.set(OWN_CLIENT_ID, "GOCSPX-rotated-secret-9Kx1");
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow(
      "Google did not finish the sign-in (invalid_client).",
    );
    expect(new GoogleClientStore(dir).read()).toMatchObject({
      id: OWN_CLIENT_ID,
      refused: { error: "invalid_client" },
    });
    expect(existsSync(join(dir, "google.json"))).toBe(false);
    expect(await keys.entries()).toEqual([
      expect.objectContaining({ label: "Google client", discoverable: false }),
    ]);

    google.knobs.deleted.add(OWN_CLIENT_ID);
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow(
      "Google did not finish the sign-in (deleted_client).",
    );
    expect(new GoogleClientStore(dir).read()?.refused?.error).toBe("deleted_client");
  });

  it("keeps the earlier sign-in when a new one is cancelled while Google trades its code", async () => {
    const { google, dir, integrations } = await signedInOwn();
    const earlier = new GoogleSignInStore(dir).read();
    const revoked = google.revoked.length;
    google.knobs.onExchange = () => integrations.cancelSignIn();
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow(
      "The sign-in was cancelled.",
    );
    expect(new GoogleSignInStore(dir).read()).toEqual(earlier);
    expect(integrations.view().integrations[0]).toMatchObject({
      account: STAND_IN_ACCOUNT,
      health: "ok",
    });
    // What Google issued for the cancelled sign-in went back, as nothing keeps it.
    await expect.poll(() => google.revoked.length).toBe(revoked + 1);
  });

  it("stops renewing a sign-in made with a client the person no longer keeps, without asking Google", async () => {
    const { google, binding, clock, integrations } = await signedInOwn();
    await binding.keepClient({
      id: "730158442917-another-desktop.apps.googleusercontent.com",
      secret: Buffer.from("GOCSPX-another-secret", "utf8"),
    });
    clock.now += 3_600_000;
    const asked = google.tokens.length;
    expect((await search(integrations)).text).toContain(
      "Sign in again in Settings -> Integrations",
    );
    expect(google.tokens).toHaveLength(asked);
    expect(integrations.view().integrations[0]?.health).toBe("needs_reauth");
  });

  it("keeps the client through a declined sign-in and one handed back to Google", async () => {
    const { google, dir, binding, integrations, keys } = await fixture();
    await binding.keepClient(ownClient());
    const keptClient = () => [
      expect.objectContaining({ label: "Google client", discoverable: false }),
    ];

    google.knobs.consent.deny = true;
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow();
    expect(new GoogleClientStore(dir).read()?.id).toBe(OWN_CLIENT_ID);
    expect(await keys.entries()).toEqual(keptClient());

    // Gmail unchecked: the sign-in is handed back to Google and kept nowhere, but the client stays.
    google.knobs.consent.deny = false;
    google.knobs.consent.grant = GOOGLE_SCOPES.filter((scope) => !scope.includes("gmail"));
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow(
      "Google did not grant the Gmail permission",
    );
    expect(google.revoked).toHaveLength(1);
    expect(new GoogleClientStore(dir).read()?.id).toBe(OWN_CLIENT_ID);
    expect(await keys.entries()).toEqual(keptClient());
  });

  it("forgets the sign-in, the client and both Secrets entries when the connection is removed", async () => {
    // A sign-in an earlier run made with the person's client: no access key is in memory,
    // so removing renews once, as that client, to have one to revoke with.
    const { google, dir, integrations, keys } = await fixture(
      undefined,
      false,
      async (dir, google, keys) => {
        const secret = await keys.keys.keepHidden({
          label: "Google client",
          value: Buffer.from(OWN_CLIENT_SECRET, "utf8"),
        });
        const { refresh } = google.grantEarlier([...GOOGLE_SCOPES], OWN_CLIENT_ID);
        const key = await keys.keys.keepHidden({
          label: "Google sign-in",
          value: Buffer.from(refresh, "utf8"),
        });
        if (!secret || !key) throw new Error("Secrets keeps both entries");
        new GoogleClientStore(dir).write({ id: OWN_CLIENT_ID, secret });
        new GoogleSignInStore(dir).write({
          account: STAND_IN_ACCOUNT,
          scopes: [...GOOGLE_SCOPES],
          expiresAt: Date.UTC(2026, 9, 22, 15),
          health: "ok",
          signedInAt: Date.UTC(2026, 9, 1),
          key,
          client: OWN_CLIENT_ID,
        });
      },
    );
    await integrations.remove("google");
    await expect.poll(() => google.revoked.length).toBe(1);
    await expect.poll(async () => (await keys.entries()).length).toBe(0);
    expect(tokenForms(google, "refresh_token").at(-1)).toMatchObject({
      client_id: OWN_CLIENT_ID,
      client_secret: OWN_CLIENT_SECRET,
    });
    expect(google.issued()).toEqual([]);
    expect(existsSync(join(dir, "google.json"))).toBe(false);
    expect(existsSync(join(dir, "google-client.json"))).toBe(false);
  });

  it("signs in and renews as the run's own client while the person keeps none", async () => {
    const { google, dir, clock, integrations } = await fixture();
    await integrations.signIn("google", NOTICE_ACCEPTED);
    allowIntegrationReads(integrations);
    expect(tokenForms(google, "authorization_code")).toEqual([
      expect.objectContaining({
        client_id: STAND_IN_CLIENT_ID,
        client_secret: STAND_IN_CLIENT_SECRET,
      }),
    ]);
    // Google named an end for the lasting key, but a run-client sign-in records neither field,
    // so an older build still reads it.
    expect(google.knobs.lasts).toBeDefined();
    expect(new GoogleSignInStore(dir).read()).not.toHaveProperty("client");
    expect(new GoogleSignInStore(dir).read()).not.toHaveProperty("endsAt");
    expect(existsSync(join(dir, "google-client.json"))).toBe(false);
    clock.now += 3_600_000;
    expect((await search(integrations)).refused).toBeUndefined();
    expect(tokenForms(google, "refresh_token")).toEqual([
      expect.objectContaining({
        client_id: STAND_IN_CLIENT_ID,
        client_secret: STAND_IN_CLIENT_SECRET,
      }),
    ]);
  });
});
