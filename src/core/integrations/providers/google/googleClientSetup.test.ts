import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTICE_ACCEPTED } from "@shared/integrations";
import { afterEach, describe, expect, it } from "vitest";
import {
  OWN_CLIENT_ID,
  OWN_CLIENT_SECRET,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
} from "../../../../../tests/helpers/googleStandIn";
import { googleWorld } from "../../../../../tests/helpers/googleWorld";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { GOOGLE_SCOPES } from "../..";
import { readGoogleClientFile } from "./clientFile";
import { GoogleClientStore, GoogleSignInStore } from "./store";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

/** A released build's Google: a new sign-in needs the person's own client. */
const released = (older?: Parameters<typeof googleWorld>[3]) =>
  googleWorld(cleanup, undefined, false, older, undefined, false);

/** The file Google Cloud gives for a Desktop app client, as it downloads it. */
const desktopFile = (id = OWN_CLIENT_ID, secret = OWN_CLIENT_SECRET) =>
  JSON.stringify({
    installed: {
      client_id: id,
      project_id: "ada-mail-assistant",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: secret,
      redirect_uris: ["http://localhost"],
    },
  });

/**
 * INF-5549's plan, piece 3: the Google row's setup "asks Secrets to keep the
 * client file through a drop target; the owner reads Google's nested
 * `installed` fields, keeps the secret hidden, and writes the client record";
 * the seven row states, the 7-day check, and the switch-over: "new sign-ins
 * use only an own client. A sign-in made with Infinitary's client keeps
 * renewing until piece 5 and shows Set up your own Google connection".
 */
describe("setting up the person's own Google client", () => {
  it("reads a Desktop app client file, and refuses a Web one, a file not Google's and one missing its secret", () => {
    expect(readGoogleClientFile(desktopFile())).toEqual({
      id: OWN_CLIENT_ID,
      secret: OWN_CLIENT_SECRET,
    });
    expect(() =>
      readGoogleClientFile(
        JSON.stringify({
          web: { client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET },
        }),
      ),
    ).toThrow(
      "That file is for a web application client. Make a Desktop app client on Google's page, then drop its file here.",
    );
    expect(() => readGoogleClientFile("client_id=1")).toThrow("That isn't a Google client file.");
    expect(() =>
      readGoogleClientFile(
        JSON.stringify({ installed: { client_id: "1234", client_secret: "x" } }),
      ),
    ).toThrow("That isn't a Google client file.");
    expect(() => readGoogleClientFile(desktopFile(OWN_CLIENT_ID, ""))).toThrow(
      "That client file has no client ID or secret.",
    );
  });

  it("keeps the client from its file with the secret only in Secrets, and signs in as it", async () => {
    const { dir, opened, google, integrations, keys } = await released();
    expect(integrations.view().addable.find((entry) => entry.kind === "google")?.client).toEqual({
      kept: false,
    });

    const view = await integrations.keepClient("google", desktopFile());
    expect(view.addable.find((entry) => entry.kind === "google")?.client).toEqual({ kept: true });
    expect(new GoogleClientStore(dir).read()?.id).toBe(OWN_CLIENT_ID);
    expect(readFileSync(join(dir, "google-client.json"), "utf8")).not.toContain(OWN_CLIENT_SECRET);
    expect(await keys.entries()).toEqual([
      expect.objectContaining({ label: "Google client", discoverable: false }),
    ]);

    await integrations.signIn("google", NOTICE_ACCEPTED);
    expect(new URL(opened[0] ?? "").searchParams.get("client_id")).toBe(OWN_CLIENT_ID);
    expect(google.tokens.at(-1)).toMatchObject({
      grant_type: "authorization_code",
      client_id: OWN_CLIENT_ID,
      client_secret: OWN_CLIENT_SECRET,
    });
    // The stand-in's lasting key lasts 604,799 seconds, as Google says for a client in Testing.
    const row = integrations.view().integrations[0];
    expect(row).toMatchObject({ kind: "google", account: STAND_IN_ACCOUNT, health: "ok" });
    expect(row?.client).toEqual({
      kept: true,
      endsAt: Date.UTC(2026, 9, 22, 16) + 604_799_000,
    });
  });

  it("keeps nothing from a file it refuses", async () => {
    const { dir, integrations, keys } = await released();
    await expect(
      integrations.keepClient(
        "google",
        JSON.stringify({ web: { client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET } }),
      ),
    ).rejects.toThrow(
      "That file is for a web application client. Make a Desktop app client on Google's page, then drop its file here.",
    );
    await expect(integrations.keepClient("google", desktopFile(OWN_CLIENT_ID, ""))).rejects.toThrow(
      "That client file has no client ID or secret.",
    );
    expect(new GoogleClientStore(dir).read()).toBeUndefined();
    expect(await keys.entries()).toEqual([]);
  });

  it("refuses a new sign-in without an own client, opening nothing", async () => {
    const { opened, google, integrations } = await released();
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow(
      "Set up your own Google client first, in Settings → Integrations → Google.",
    );
    expect(opened).toEqual([]);
    expect(google.tokens).toEqual([]);
    expect(integrations.view().integrations).toEqual([]);
  });

  it("keeps renewing a sign-in made with Infinitary's client, and says to set up an own one", async () => {
    const { google, clock, integrations } = await released(async (dir, google, keys) => {
      const { refresh } = google.grantEarlier([...GOOGLE_SCOPES]);
      const key = await keys.keys.keepHidden({
        label: "Google sign-in",
        value: Buffer.from(refresh, "utf8"),
      });
      if (!key) throw new Error("Secrets keeps the sign-in");
      new GoogleSignInStore(dir).write({
        account: STAND_IN_ACCOUNT,
        scopes: [...GOOGLE_SCOPES],
        expiresAt: Date.UTC(2026, 9, 22, 15),
        health: "ok",
        signedInAt: Date.UTC(2026, 9, 1),
        key,
      });
    });
    allowIntegrationReads(integrations);
    expect(integrations.view().integrations[0]?.client).toEqual({ kept: false, retiring: true });

    clock.now += 60_000;
    const answer = await integrations
      .forTask("task-1")
      .call(
        "Google",
        "search_mail",
        { max: 1 },
        undefined,
        "To perform the task’s requested action.",
      );
    expect(answer.refused).toBeUndefined();
    expect(google.tokens.at(-1)).toMatchObject({
      grant_type: "refresh_token",
      client_id: STAND_IN_CLIENT_ID,
      client_secret: STAND_IN_CLIENT_SECRET,
    });

    // With an own client kept, the row still says so until the person signs in as it.
    await integrations.keepClient("google", desktopFile());
    expect(integrations.view().integrations[0]?.client).toEqual({ kept: true, retiring: true });
    await integrations.signIn("google", NOTICE_ACCEPTED);
    expect(integrations.view().integrations[0]?.client).toEqual({
      kept: true,
      endsAt: clock.now + 604_799_000,
    });
  });

  it("reads a sign-in made with Infinitary's retired client as needing a sign-in, and never sends it to Google", async () => {
    // INF-6344: Infinitary's own client is gone, so nothing can renew such a sign-in.
    const { google, clock, integrations } = await googleWorld(
      cleanup,
      undefined,
      false,
      async (dir, google, keys) => {
        const { refresh } = google.grantEarlier([...GOOGLE_SCOPES]);
        const key = await keys.keys.keepHidden({
          label: "Google sign-in",
          value: Buffer.from(refresh, "utf8"),
        });
        if (!key) throw new Error("Secrets keeps the sign-in");
        new GoogleSignInStore(dir).write({
          account: STAND_IN_ACCOUNT,
          scopes: [...GOOGLE_SCOPES],
          expiresAt: Date.UTC(2026, 9, 22, 15),
          health: "ok",
          signedInAt: Date.UTC(2026, 9, 1),
          key,
        });
      },
      undefined,
      false,
      false,
    );
    allowIntegrationReads(integrations);
    expect(integrations.view().integrations[0]?.health).toBe("needs_reauth");
    expect(integrations.view().integrations[0]?.client).toEqual({ kept: false });

    clock.now += 60_000;
    const answer = await integrations
      .forTask("task-1")
      .call(
        "Google",
        "search_mail",
        { max: 1 },
        undefined,
        "To perform the task’s requested action.",
      );
    expect(answer.refused).toBeDefined();
    expect(google.tokens).toEqual([]);
    await expect(integrations.signIn("google", NOTICE_ACCEPTED)).rejects.toThrow(
      "Set up your own Google client first",
    );
  });

  it("turns a sign-in to Sign in again when another client is kept in its place, and keeps it for a new secret", async () => {
    const { integrations } = await released();
    await integrations.keepClient("google", desktopFile());
    await integrations.signIn("google", NOTICE_ACCEPTED);

    // The same client with a new secret still renews the sign-in.
    await integrations.keepClient(
      "google",
      desktopFile(OWN_CLIENT_ID, "GOCSPX-rotated-secret-9Kx1"),
    );
    expect(integrations.view().integrations[0]?.health).toBe("ok");

    await integrations.keepClient(
      "google",
      desktopFile(
        "730158442917-another-desktop.apps.googleusercontent.com",
        "GOCSPX-another-secret",
      ),
    );
    expect(integrations.view().integrations[0]?.health).toBe("needs_reauth");
  });

  it("names the refused client on the row", async () => {
    const { google, clock, integrations } = await released();
    await integrations.keepClient("google", desktopFile());
    google.knobs.lasts = undefined;
    await integrations.signIn("google", NOTICE_ACCEPTED);
    expect(integrations.view().integrations[0]?.client).toEqual({ kept: true });

    google.knobs.deleted.add(OWN_CLIENT_ID);
    clock.now += 3_600_000;
    await integrations.check("google");
    expect(integrations.view().integrations[0]).toMatchObject({
      health: "needs_reauth",
      client: { kept: true, refused: "deleted_client" },
    });
  });
});
