import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GoogleStandIn,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../../../../../tests/helpers/googleStandIn";
import { serveNotesHttp } from "../../../../../tests/helpers/mcpStandIn";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { hostEnv } from "../../../hostEnv";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { atUtilityQos } from "../../../utilityQos";
import {
  FileIntegrationSecrets,
  GOOGLE_OAUTH_CLIENT,
  GOOGLE_SCOPES,
  googleIntegration,
  googleSetup,
  IntegrationSettingsStore,
  IntegrationsService,
  mcpIntegration,
} from "../..";

/**
 * INF-784, piece 5 of the accepted integrations plan (INF-775): "one Google
 * row on Infinitary's own client, signing in once on a loopback address
 * with PKCE and asking every Gmail and Calendar permission up front, with
 * Gmail actions and new-mail events" - the captain's q8 ("one Google row
 * that signs in once for both, asking every permission up front") and q5
 * (a change or a send asks on a card). The plan's tests: "Unit tests
 * against recorded Gmail answers for the cursor, the 404 resync and the
 * quota backoff".
 *
 * Google is the stand-in (`tests/helpers/googleStandIn.ts`), answering in
 * the shapes Google documents; the browser is a fetch that follows the
 * consent page's redirect back to the app's loopback address, as the
 * person's browser does.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const ARRIVING = {
  from: "Lena Ortiz <lena@ortiz-studio.com>",
  subject: "Invoice 2214 for the October shoot",
  text: "Hi Ada,\n\nThe invoice for the October shoot is attached. Payment is due by Nov 4.\n\nThanks,\nLena",
  html: "<div>Hi Ada,</div><div><br></div><div>The invoice for the October shoot is attached.</div>",
  attachment: { name: "invoice-2214.pdf", type: "application/pdf", size: 48_211 },
};

async function fixture(browser?: (url: string) => Promise<void>, withMcp = false) {
  const google: GoogleStandIn = await startGoogleStandIn();
  cleanup.push(() => google.close());
  const dir = join(scratchDir("fm-google-"), "integrations");
  const secrets = new FileIntegrationSecrets(join(dir, "secrets"));
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "task-1", title: "Answer Lena", status: "idle" });
  const clock = { now: Date.UTC(2026, 9, 22, 16) };
  const opened: string[] = [];
  const pages: string[] = [];
  const pushed: string[] = [];
  const setup = googleSetup({
    packaged: false,
    env: {
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: google.base,
    },
  });
  if (!setup) throw new Error("a run that names a client has a Google setup");
  let integrations: IntegrationsService | undefined;
  integrations = new IntegrationsService({
    bindings: [
      googleIntegration({
        root: dir,
        secrets,
        ...setup,
        // The person's browser: it opens the page and follows Google back to the app.
        open:
          browser ??
          (async (url) => {
            opened.push(url);
            pages.push(await (await fetch(url)).text());
          }),
        now: () => clock.now,
        changed: () => integrations?.changed(),
      }),
      ...(withMcp
        ? [
            mcpIntegration({
              root: dir,
              env: () => hostEnv(),
              belowUi: (file, args) => atUtilityQos(file, args),
              cwd: () => dir,
              version: "0.0.0-test",
              changed: () => integrations?.changed(),
            }),
          ]
        : []),
    ],
    store: new IntegrationSettingsStore(dir),
    secrets,
    asks: {
      keep: (taskId, ask) => tasks.keepWriteAsk(taskId, ask),
      take: (taskId, askId) => tasks.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) => tasks.recordWriteAskOutcome(taskId, askId, outcome),
    },
    now: () => clock.now,
    push: (view) => pushed.push(JSON.stringify(view)),
  });
  cleanup.push(() => integrations?.dispose());
  return { google, dir, tasks, clock, opened, pages, pushed, integrations };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function signedIn(): Promise<Fixture> {
  const world = await fixture();
  await world.integrations.signIn("google");
  return world;
}

function parsed(text: string) {
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Google as an integration", () => {
  it("signs in once on a loopback address with PKCE, asking every Gmail and Calendar permission, and shows one row", async () => {
    const { google, dir, opened, pages, pushed, integrations } = await fixture();
    expect(integrations.view()).toMatchObject({
      integrations: [],
      addable: [{ kind: "google", name: "Google" }],
    });

    const { id, view } = await integrations.signIn("google");

    expect(id).toBe("google");
    const consent = new URL(opened[0] ?? "");
    expect(consent.origin + consent.pathname).toBe(`${google.base}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(consent.searchParams)).toMatchObject({
      client_id: STAND_IN_CLIENT_ID,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(consent.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pages[0]).toContain("Signed in to Google. You can close this tab");
    // The code was traded with the verifier only this sign-in held.
    expect(google.tokens[0]).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: consent.searchParams.get("redirect_uri"),
    });
    expect(google.tokens[0]?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(view.integrations).toEqual([
      expect.objectContaining({
        id: "google",
        kind: "google",
        name: "Google",
        account: STAND_IN_ACCOUNT,
        health: "ok",
        actions: [
          expect.objectContaining({ name: "search_mail", effect: "reads", rule: "allow" }),
          expect.objectContaining({ name: "read_message", effect: "reads", rule: "allow" }),
          expect.objectContaining({ name: "label_message", effect: "changes", rule: "ask" }),
          expect.objectContaining({ name: "draft_message", effect: "changes", rule: "ask" }),
          expect.objectContaining({ name: "send_message", effect: "sends", rule: "ask" }),
        ],
        events: [expect.objectContaining({ name: "message_received", label: "A message arrives" })],
      }),
    ]);
    expect(view.addable).toEqual([]);
    // Nothing is pasted, so the row has no key fields.
    expect(view.integrations[0]?.secrets).toBeUndefined();

    // Its keys are kept 0600 in a 0700 folder, and nothing a person or an agent reads holds them.
    const folder = join(dir, "secrets", "google");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "google.json")).mode & 0o777).toBe(0o600);
    const reads = [
      JSON.stringify(view),
      ...pushed,
      JSON.stringify(integrations.roster()),
      JSON.stringify(integrations.show("Google")),
      integrations.rosterLine() ?? "",
      readFileSync(join(dir, "google.json"), "utf8"),
    ];
    for (const key of google.issued()) for (const read of reads) expect(read).not.toContain(key);
  });

  it("keeps no sign-in when the person declines on Google's page, or unchecks Gmail", async () => {
    const declined = await fixture();
    declined.google.knobs.consent.deny = true;
    await expect(declined.integrations.signIn("google")).rejects.toThrow(
      "The sign-in was declined on Google's page.",
    );
    expect(declined.pages[0]).toContain("Not signed in to Google");
    expect(declined.integrations.view().integrations).toEqual([]);

    const partial = await fixture();
    partial.google.knobs.consent.grant = GOOGLE_SCOPES.filter((scope) => !scope.includes("gmail"));
    await expect(partial.integrations.signIn("google")).rejects.toThrow(
      "Google did not grant the Gmail permission. Sign in again and leave every box checked.",
    );
    expect(partial.integrations.view().integrations).toEqual([]);
    // What Google did grant is handed back, not kept.
    expect(partial.google.revoked).toHaveLength(1);
    expect(partial.google.issued()).toEqual([]);
  });

  it("refuses to sign in while another connection is named Google, before the browser opens or a key is kept", async () => {
    // The captain's answer to review finding F3 on INF-784: "refuse the sign-in and say which connection holds the name".
    const notes = await serveNotesHttp("modern");
    cleanup.push(() => notes.close());
    const { google, dir, opened, integrations } = await fixture(undefined, true);
    const { id: server } = await integrations.add("mcp", { name: "Google", runs: notes.url });
    await expect(integrations.signIn("google")).rejects.toThrow(
      "The MCP server named Google already uses that name, so Google cannot be added beside it. Remove that MCP server in Settings → Integrations, or ask your first mate to rename it, then sign in to Google again.",
    );
    expect(opened).toEqual([]);
    expect(google.tokens).toEqual([]);
    expect(existsSync(join(dir, "google.json"))).toBe(false);
    expect(integrations.view().integrations.map((row) => row.name)).toEqual(["Google"]);

    // Renamed, the server leaves the name free, and Google signs in under it.
    integrations.configure(server, { name: "Drive notes" });
    await integrations.signIn("google");
    // A Google row the person renamed keeps its name when it signs in again.
    integrations.configure("google", { name: "Mail" });
    integrations.configure(server, { name: "Google" });
    await integrations.signIn("google");
    expect(integrations.view().integrations.map((row) => row.name)).toEqual(["Mail", "Google"]);
  });

  it("ends a sign-in waiting for the browser when it is cancelled", async () => {
    let opened!: () => void;
    const pageOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    // A browser that opens the page, and the person never finishes there.
    const { integrations } = await fixture(async () => opened());
    const signingIn = integrations.signIn("google");
    await pageOpen;
    integrations.cancelSignIn();
    await expect(signingIn).rejects.toThrow("The sign-in was cancelled.");
    expect(integrations.view().integrations).toEqual([]);
  });

  it("searches and reads mail as the person, and keeps a label, a draft and a send as asks that run once on the captain's click", async () => {
    const { google, tasks, integrations } = await signedIn();
    const id = google.deliver(ARRIVING);
    const crew = integrations.forTask("task-1");

    const found = await crew.call("Google", "search_mail", { query: "invoice", max: 10 });
    expect(found.refused).toBeUndefined();
    expect(parsed(found.text)).toEqual({
      messages: [
        expect.objectContaining({
          id,
          from: ARRIVING.from,
          subject: ARRIVING.subject,
          labels: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        }),
      ],
    });
    const message = parsed((await crew.call("Google", "read_message", { id })).text);
    expect(message).toMatchObject({
      id,
      subject: ARRIVING.subject,
      text: ARRIVING.text,
      attachments: [ARRIVING.attachment],
    });
    expect(google.seen.every((request) => request.authorization?.startsWith("Bearer ya29."))).toBe(
      true,
    );

    // A label asks first: nothing reaches Gmail until the click, and then once.
    const before = google.seen.length;
    const asked = await crew.call("Google", "label_message", {
      id,
      add: ["receipts"],
      remove: ["INBOX"],
    });
    expect(asked.text).toContain('"kind":"request_write"');
    expect(google.seen).toHaveLength(before);
    const label = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    expect(label).toMatchObject({
      kind: "integration",
      integration: "google",
      action: "label_message",
    });
    const labelled = await integrations.sendAsk("task-1", label?.id ?? "");
    expect(labelled.outcome).toEqual({ kind: "ran" });
    expect(parsed(labelled.answer ?? "{}")).toEqual({
      id,
      labels: ["UNREAD", "CATEGORY_PERSONAL", "Receipts"],
    });
    expect((await integrations.sendAsk("task-1", label?.id ?? "")).ok).toBe(false);

    // A reply drafts in the thread, and a send goes out once on its click.
    await crew.call("Google", "draft_message", {
      to: [ARRIVING.from],
      body: "Thanks Lena, paying it this week.",
      reply_to: id,
    });
    await crew.call("Google", "send_message", {
      to: ["Lena Ortiz <lena@ortiz-studio.com>"],
      subject: "Paid: invoice 2214 ✓",
      body: "Sent the payment today.",
    });
    expect(google.drafts).toEqual([]);
    expect(google.sent).toEqual([]);
    const asks = tasks.get("task-1")?.delivery?.writeAsks ?? [];
    const draft = asks.find((ask) => ask.kind === "integration" && ask.action === "draft_message");
    const send = asks.find((ask) => ask.kind === "integration" && ask.action === "send_message");
    expect((await integrations.sendAsk("task-1", draft?.id ?? "")).outcome).toEqual({
      kind: "ran",
    });
    expect((await integrations.sendAsk("task-1", send?.id ?? "")).outcome).toEqual({ kind: "ran" });
    expect(google.drafts).toHaveLength(1);
    expect(google.drafts[0]?.threadId).toBe(id);
    expect(google.drafts[0]?.text).toContain(`Subject: Re: ${ARRIVING.subject}`);
    expect(google.drafts[0]?.text).toContain(`In-Reply-To: <CAF${id}@mail.gmail.com>`);
    expect(google.sent).toHaveLength(1);
    expect(google.sent[0]?.text).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Paid: invoice 2214 ✓").toString("base64")}?=`,
    );
    expect(google.sent[0]?.text).toContain(
      Buffer.from("Sent the payment today.").toString("base64"),
    );

    // The first mate's seat cannot send: only a crewmate's card carries the exact call.
    const seat = await integrations.call({ kind: "firstmate" }, "Google", "send_message", {
      to: ["lena@ortiz-studio.com"],
      body: "x",
    });
    expect(seat.refused).toBe("refused");
  });

  it("reads an HTML-only message as its words in one pass, however its sender wrote the markup", async () => {
    // Review finding F1 on INF-784: the app's own process reads what any sender wrote, and
    // markup that never closes, at a size a quadratic reading takes tens of seconds over,
    // comes back within this cohort's time.
    const { google, integrations } = await signedIn();
    const newsletter =
      "<html><head><title>October offers</title><style>p { color: #c00 }</style></head>" +
      "<body><P>Hi Ada,</P><p>Your October offers are here:&nbsp;20% off &amp; free returns.<br>" +
      "See you soon.</p><header>Maple Air</header></body></html>";
    const neverClosed = `${" ".repeat(200_000)}x${"<head>".repeat(40_000)}${"<".repeat(200_000)}`;
    const id = google.deliver({
      from: "Maple Air <offers@mapleair.example>",
      subject: "October offers",
      html: newsletter + neverClosed,
    });
    const message = parsed(
      (await integrations.forTask("task-1").call("Google", "read_message", { id })).text,
    );
    expect(message.text).toBe(
      `Hi Ada,\nYour October offers are here: 20% off & free returns.\nSee you soon.\nMaple Air${" ".repeat(200_000)}x${"<".repeat(200_000)}`,
    );
  });

  it("calls a send unknown when Gmail took it and then dropped the connection or failed, and never sends it again", async () => {
    // Review finding F2 on INF-784: told "sent nothing" after Gmail took it, a crewmate would send a second email.
    const { google, tasks, integrations } = await signedIn();
    const crew = integrations.forTask("task-1");
    await crew.call("Google", "send_message", {
      to: ["Lena Ortiz <lena@ortiz-studio.com>"],
      subject: "Paid: invoice 2214",
      body: "Sent the payment today.",
    });
    await crew.call("Google", "draft_message", {
      to: ["Lena Ortiz <lena@ortiz-studio.com>"],
      body: "Paying it this week.",
    });
    const asks = tasks.get("task-1")?.delivery?.writeAsks ?? [];
    const send = asks.find((ask) => ask.kind === "integration" && ask.action === "send_message");
    const draft = asks.find((ask) => ask.kind === "integration" && ask.action === "draft_message");
    google.knobs.afterTaking.push("drop", 500);

    expect((await integrations.sendAsk("task-1", send?.id ?? "")).outcome).toEqual({
      kind: "unknown",
      why: "Google could not do that: Gmail did not answer.",
    });
    expect((await integrations.sendAsk("task-1", draft?.id ?? "")).outcome).toEqual({
      kind: "unknown",
      why: "Google could not do that: Gmail failed (status 500): Backend Error",
    });
    expect(google.sent).toHaveLength(1);
    expect(google.drafts).toHaveLength(1);
    // Neither is ever run again.
    expect((await integrations.sendAsk("task-1", send?.id ?? "")).ok).toBe(false);
    expect((await integrations.sendAsk("task-1", draft?.id ?? "")).ok).toBe(false);
    expect(google.sent).toHaveLength(1);
    expect(google.drafts).toHaveLength(1);
  });

  it("refuses a header that would start another one before anything is asked", async () => {
    const { integrations } = await signedIn();
    const answer = await integrations.forTask("task-1").call("Google", "send_message", {
      to: ["lena@ortiz-studio.com\r\nBcc: someone@example.com"],
      body: "x",
    });
    expect(answer.refused).toBe("invalid");
  });

  it("tells each message that arrives from its history cursor, and starts again from now when Gmail forgot the cursor or the mailbox changed", async () => {
    const { google, integrations } = await signedIn();
    const start = await integrations.look("google", "message_received", null);
    expect(start.items).toEqual([]);

    const first = google.deliver(ARRIVING);
    const second = google.deliver({
      from: "United Airlines <unitedairlines@news.united.com>",
      subject: "",
      text: "Your trip to Lisbon is coming up.",
      labels: ["Label_7"],
    });
    const found = await integrations.look("google", "message_received", start.cursor);
    expect(found.items).toEqual([
      { id: first, summary: `From ${ARRIVING.from}: ${ARRIVING.subject}` },
      {
        id: second,
        summary: "From United Airlines <unitedairlines@news.united.com>: (no subject)",
      },
    ]);
    expect(found.resynced).toBeUndefined();
    // Looking again from the new cursor finds nothing new.
    const again = await integrations.look("google", "message_received", found.cursor);
    expect(again.items).toEqual([]);

    // Gmail keeps about a week of history; past that it answers 404.
    google.forgetHistory();
    google.deliver({ from: "a@example.com", subject: "Lost in between", text: "x" });
    const resynced = await integrations.look("google", "message_received", again.cursor);
    expect(resynced).toMatchObject({ items: [], resynced: true });
    const after = google.deliver({ from: "b@example.com", subject: "After", text: "y" });
    expect(
      (await integrations.look("google", "message_received", resynced.cursor)).items.map(
        (item) => item.id,
      ),
    ).toEqual([after]);

    // A cursor from another mailbox starts again from now.
    const other = again.cursor.replace(STAND_IN_ACCOUNT, "someone.else@gmail.com");
    expect(await integrations.look("google", "message_received", other)).toMatchObject({
      items: [],
      resynced: true,
    });
  });

  it("waits as long as Gmail asks when it answers 429, and looks again after", async () => {
    const { google, clock, integrations } = await signedIn();
    const start = await integrations.look("google", "message_received", null);
    const id = google.deliver(ARRIVING);
    google.knobs.limited.push("30");

    await expect(integrations.look("google", "message_received", start.cursor)).rejects.toThrow(
      "Gmail asked the app to slow down for 30 seconds.",
    );
    const asked = google.seen.length;
    clock.now += 10_000;
    await expect(integrations.look("google", "message_received", start.cursor)).rejects.toThrow(
      "Gmail asked the app to wait 20 more seconds.",
    );
    expect(google.seen).toHaveLength(asked);
    // The sign-in itself is fine.
    expect(integrations.view().integrations[0]?.health).toBe("ok");

    clock.now += 20_000;
    const found = await integrations.look("google", "message_received", start.cursor);
    expect(found.items.map((item) => item.id)).toEqual([id]);
  });

  it("renews the access before it runs out and after Google refuses it, and asks for a new sign-in only when Google refuses the lasting key", async () => {
    const { google, clock, integrations } = await signedIn();
    const renewals = () => google.tokens.filter((form) => form.grant_type === "refresh_token");

    // An hour on, the access is about to run out: it renews before the request.
    clock.now += 3_599_000 - 10_000;
    await integrations.forTask("task-1").call("Google", "search_mail", { max: 1 });
    expect(renewals()).toHaveLength(1);
    expect(renewals()[0]).toMatchObject({
      client_id: STAND_IN_CLIENT_ID,
      client_secret: STAND_IN_CLIENT_SECRET,
    });

    // Google refuses the access before it says it runs out: renew once and send again.
    google.lapse();
    const answer = await integrations.forTask("task-1").call("Google", "search_mail", { max: 1 });
    expect(answer.refused).toBeUndefined();
    expect(renewals()).toHaveLength(2);
    expect(integrations.view().integrations[0]?.health).toBe("ok");

    // The person removed the app's access in their Google account.
    google.revokeElsewhere();
    const refused = await integrations.forTask("task-1").call("Google", "search_mail", { max: 1 });
    expect(refused.refused).toBe("refused");
    expect(refused.text).toContain("Sign in again in Settings -> Integrations");
    expect(integrations.view().integrations[0]).toMatchObject({ health: "needs_reauth" });

    // Signing in again brings the row back.
    await integrations.signIn("google");
    expect(integrations.view().integrations[0]).toMatchObject({ health: "ok" });
  });

  it("tells Google to forget the sign-in when the row is removed, and forgets it here", async () => {
    const { google, dir, integrations } = await signedIn();
    const keys = google.issued();
    expect(keys.length).toBeGreaterThan(0);

    const view = await integrations.remove("google");

    expect(google.revoked).toHaveLength(1);
    expect(keys).toContain(google.revoked[0]);
    expect(google.issued()).toEqual([]);
    expect(view.integrations).toEqual([]);
    expect(view.addable).toEqual([{ kind: "google", name: "Google" }]);
    expect(() => statSync(join(dir, "secrets", "google"))).toThrow();
    expect(() => statSync(join(dir, "google.json"))).toThrow();
  });

  it("reaches only Google from a packaged build, and only as Infinitary's own client", () => {
    const setup = googleSetup({
      packaged: true,
      env: {
        INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
        INFINITARY_GOOGLE_URL: "http://127.0.0.1:1",
      },
    });
    // Until Infinitary registers its client there is none, and so no Google row.
    expect(setup?.client ?? null).toBe(GOOGLE_OAUTH_CLIENT);
    if (setup) expect(new URL(setup.endpoints.auth).host).toBe("accounts.google.com");
  });
});
