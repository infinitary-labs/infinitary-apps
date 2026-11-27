import { GOOGLE_CLIENTS_PAGE, GOOGLE_MCP_ENABLE_PAGE, NOTICE_ACCEPTED } from "@shared/integrations";
import { fencedSpans } from "@shared/outsideData";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_CHOICES } from "../../../../../tests/helpers/googleMcpStandIn";
import { STAND_IN_PROJECT } from "../../../../../tests/helpers/googleStandIn";
import {
  type GoogleWorld,
  type GoogleWorldOptions,
  googleWorld,
} from "../../../../../tests/helpers/googleWorld";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";

/**
 * INF-7012's approved plan, piece 1: Gmail and Calendar go through Google's
 * own MCP servers for them. Google's question about a call goes to the
 * captain on a card with Google's own choices and is never answered by the
 * host; the row says so, with Google Cloud's page, when Google refuses a
 * client not marked for an AI-powered agent or a service is off, and keeps
 * its sign-in; a send keeps to a draft when Gmail's server lists no send.
 *
 * Google is the stand-in (`tests/helpers/googleStandIn.ts`, its MCP servers
 * in `tests/helpers/googleMcpStandIn.ts`), answering in the shapes and with
 * the choices Google's servers list.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const ARRIVING = {
  from: "Lena Ortiz <lena@ortiz-studio.com>",
  subject: "Invoice 2214 for the October shoot",
  text: "Hi Ada,\n\nThe invoice for the October shoot is attached. Payment is due by Nov 4.\n\nThanks,\nLena",
};

type Fixture = GoogleWorld;
const fixture = (...args: GoogleWorldOptions) => googleWorld(cleanup, ...args);

async function signedIn(): Promise<Fixture> {
  const world = await fixture();
  await world.integrations.signIn("google", NOTICE_ACCEPTED);
  allowIntegrationReads(world.integrations);
  return world;
}

/** An answer's JSON, read from the one span Gmail fences it in. */
function parsed(text: string) {
  const [span] = fencedSpans(text);
  if (!span) throw new Error(`Not fenced as data from outside: ${text.slice(0, 120)}`);
  return JSON.parse(span.words) as Record<string, unknown>;
}

describe("Google's MCP servers", () => {
  const asksOf = (world: Fixture) => world.tasks.get("task-1")?.delivery?.writeAsks ?? [];
  /** The new card's ask a send that Google stopped names in its outcome. */
  const askNamed = (why: string) => {
    const id = /\(ask (ia[0-9a-f]{12})\)/.exec(why)?.[1];
    if (!id) throw new Error(`No ask named in: ${why}`);
    return id;
  };
  const labelAsk = async (world: Fixture, id: string, add: string[]) => {
    const before = new Set(asksOf(world).map((ask) => ask.id));
    await world.integrations
      .forTask("task-1")
      .call("Google", "label_message", { id, add }, undefined, "To file the invoice.");
    const kept = asksOf(world).find((ask) => !before.has(ask.id));
    if (!kept) throw new Error("the label must have been kept as an ask");
    return kept.id;
  };

  it("puts Google's own question and choices to the captain, and runs the call only with the choice the captain picked", async () => {
    const world = await signedIn();
    const { google, integrations } = world;
    const id = google.deliver(ARRIVING);
    google.knobs.confirm.add("update_message_labels");

    // The captain's click on the label sends it; Google stops it to ask the person.
    const first = await integrations.sendAsk("task-1", await labelAsk(world, id, ["receipts"]));
    expect(first.outcome).toMatchObject({ kind: "refused" });
    const why = first.outcome.kind === "refused" ? first.outcome.why : "";
    expect(why).toContain("Google asked the captain to confirm it first, on a new card");
    expect(google.mail.get(id)?.labelIds).not.toContain("Label_3");
    expect(google.answers).toEqual([]);
    const question = asksOf(world).find((ask) => ask.id === askNamed(why));
    expect(question).toMatchObject({
      kind: "integration",
      action: "label_message",
      input: JSON.stringify({ id, add: ["receipts"] }),
      confirm: {
        message: "Change this message's labels?",
        options: APPROVAL_CHOICES.map(([value, label]) => ({ value, label })),
      },
    });
    // A question's ask offers no Allow for the rest of this task.
    expect(question).not.toHaveProperty("scope");

    // A pick that is none of Google's choices sends nothing to Google.
    const unknown = await integrations.sendAsk("task-1", askNamed(why), "once", "ALLOW_EVERYTHING");
    expect(unknown.outcome).toEqual({
      kind: "refused",
      why: "The captain picked none of Google's choices. Nothing ran.",
    });
    expect(google.answers).toEqual([]);

    // Allow once answers Google's question in the same call, and the label is made once.
    const asked = await integrations.sendAsk("task-1", await labelAsk(world, id, ["receipts"]));
    const allow = askNamed(asked.outcome.kind === "refused" ? asked.outcome.why : "");
    const allowed = await integrations.sendAsk("task-1", allow, "once", "ALLOW_ONCE");
    expect(allowed.outcome).toEqual({ kind: "ran" });
    expect(google.mail.get(id)?.labelIds).toContain("Label_3");
    expect(google.answers).toEqual([
      {
        tool: "update_message_labels",
        choice: "ALLOW_ONCE",
        state: expect.stringMatching(/^approval-update_message_labels-/),
      },
    ]);
    expect((await integrations.sendAsk("task-1", allow, "once", "ALLOW_ONCE")).ok).toBe(false);
    expect(google.answers).toHaveLength(1);

    // The captain's Deny is Google's refusal: nothing changes.
    const again = await integrations.sendAsk("task-1", await labelAsk(world, id, ["travel"]));
    const deny = askNamed(again.outcome.kind === "refused" ? again.outcome.why : "");
    const denied = await integrations.sendAsk("task-1", deny, "once", "DENY_ONCE");
    expect(denied.outcome).toMatchObject({ kind: "refused" });
    expect(denied.outcome.kind === "refused" ? denied.outcome.why : "").toContain(
      "UserDeniedAction",
    );
    expect(google.mail.get(id)?.labelIds).not.toContain("Label_7");
    expect(google.answers.map((answer) => answer.choice)).toEqual(["ALLOW_ONCE", "DENY_ONCE"]);
  });

  it("still puts Google's question to the captain after a send read Gmail's list of tools", async () => {
    const world = await signedIn();
    const { google, integrations } = world;
    const id = google.deliver(ARRIVING);
    await integrations
      .forTask("task-1")
      .call(
        "Google",
        "send_message",
        { to: ["lena@ortiz-studio.com"], subject: "Got it", body: "Thanks, Lena." },
        undefined,
        "To tell Lena it arrived.",
      );
    const send = asksOf(world).find(
      (ask) => ask.kind === "integration" && ask.action === "send_message",
    );
    expect((await integrations.sendAsk("task-1", send?.id ?? "")).outcome).toEqual({ kind: "ran" });
    expect(google.sent).toHaveLength(1);

    google.knobs.confirm.add("update_message_labels");
    const asked = await integrations.sendAsk("task-1", await labelAsk(world, id, ["receipts"]));
    const why = asked.outcome.kind === "refused" ? asked.outcome.why : "";
    expect(why).toContain("Google asked the captain to confirm it first, on a new card");
    expect(asksOf(world).find((ask) => ask.id === askNamed(why))).toMatchObject({
      action: "label_message",
      confirm: { message: "Change this message's labels?" },
    });
  });

  it("keeps Google's question for a call the captain always allows, and tells the crewmate it waits", async () => {
    const world = await signedIn();
    const { google, integrations } = world;
    const id = google.deliver(ARRIVING);
    google.knobs.confirm.add("update_message_labels");

    await integrations.sendAsk("task-1", await labelAsk(world, id, ["receipts"]), "always");
    const before = new Set(asksOf(world).map((ask) => ask.id));

    // Always allow runs the next label without a card, and Google stops it to ask.
    const call = await integrations
      .forTask("task-1")
      .call("Google", "label_message", { id, add: ["receipts"] }, undefined, "To file it.");
    expect(call.refused).toBe("refused");
    expect(call.text).toContain("Not run yet: Google asks the captain to confirm label_message");
    const kept = asksOf(world).filter((ask) => !before.has(ask.id));
    expect(kept).toEqual([
      expect.objectContaining({
        action: "label_message",
        confirm: expect.objectContaining({ message: "Change this message's labels?" }),
      }),
    ]);
    expect(call.text).toContain(`ask ${kept[0]?.id}`);
    expect(google.mail.get(id)?.labelIds).not.toContain("Label_3");
    expect(google.answers).toEqual([]);
  });

  it("says on the row when Google refuses a client not marked for agents, keeps the sign-in, and renews no more until the captain checks again", async () => {
    const world = await fixture();
    const { google, integrations } = world;
    google.knobs.agentRefused = true;
    await integrations.signIn("google", NOTICE_ACCEPTED);
    allowIntegrationReads(integrations);
    await integrations.check("google");

    const row = () => integrations.view().integrations[0];
    expect(row()).toMatchObject({ health: "ok", client: { mcp: { refused: "agent" } } });
    // A run's own client is none of the person's, so the link opens their list of clients.
    expect(row()?.client?.mcp).toEqual({ refused: "agent", link: GOOGLE_CLIENTS_PAGE });

    const renewals = () => google.tokens.filter((form) => form.grant_type === "refresh_token");
    const renewed = renewals().length;
    const refused = await integrations
      .forTask("task-1")
      .call("Google", "search_mail", { max: 1 }, undefined, "To find the invoice.");
    expect(refused.refused).toBeDefined();
    expect(refused.text).toContain('ticks "Use this client for an AI-powered agent"');
    expect(renewals()).toHaveLength(renewed);
    expect(row()?.health).toBe("ok");

    // The captain marks the client and presses Check now: the line goes.
    google.knobs.agentRefused = false;
    await integrations.check("google");
    expect(row()?.client).not.toHaveProperty("mcp");
    const found = await integrations
      .forTask("task-1")
      .call("Google", "search_mail", { max: 1 }, undefined, "To find the invoice.");
    expect(found.refused).toBeUndefined();
  });

  it("names the MCP service that is off on the row with Google's own page to turn it on, and one page for both", async () => {
    const world = await signedIn();
    const { google, integrations } = world;
    const row = () => integrations.view().integrations[0];
    google.knobs.off.add("calendar");

    const refused = await integrations
      .forTask("task-1")
      .call("Google", "list_calendars", {}, undefined, "To find the studio calendar.");
    expect(refused.refused).toBeDefined();
    expect(refused.text).toContain(
      "Google Calendar's MCP service is off in the captain's Google Cloud project.",
    );
    expect(row()).toMatchObject({ health: "ok" });
    expect(row()?.client?.mcp).toEqual({
      refused: "service",
      services: ["calendar"],
      link: `https://console.developers.google.com/apis/api/calendarmcp.googleapis.com/overview?project=${STAND_IN_PROJECT}`,
    });

    google.knobs.off.add("gmail");
    await integrations.check("google");
    expect(row()?.client?.mcp).toEqual({
      refused: "service",
      services: ["gmail", "calendar"],
      link: `${GOOGLE_MCP_ENABLE_PAGE}&project=${STAND_IN_PROJECT}`,
    });

    google.knobs.off.clear();
    await integrations.check("google");
    expect(row()?.client).not.toHaveProperty("mcp");
  });

  it("keeps a send as a draft and says nothing was sent when Gmail's server offers no sending", async () => {
    const world = await fixture();
    const { google, integrations, tasks } = world;
    google.knobs.withoutSend = true;
    await integrations.signIn("google", NOTICE_ACCEPTED);
    allowIntegrationReads(integrations);

    await integrations.forTask("task-1").call(
      "Google",
      "send_message",
      {
        to: ["Lena Ortiz <lena@ortiz-studio.com>"],
        subject: "Paid: invoice 2214",
        body: "Sent the payment today.",
      },
      undefined,
      "To tell Lena it is paid.",
    );
    const send = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    const sent = await integrations.sendAsk("task-1", send?.id ?? "");
    expect(sent.outcome).toEqual({ kind: "ran" });
    expect(parsed(sent.answer ?? "{}")).toMatchObject({
      sent: false,
      note: expect.stringContaining("nothing was sent"),
    });
    expect(google.sent).toEqual([]);
    expect(google.drafts).toEqual([
      {
        to: ["lena@ortiz-studio.com"],
        subject: "Paid: invoice 2214",
        body: "Sent the payment today.",
        threadId: expect.any(String),
      },
    ]);
    expect(google.calls("gmail").map((call) => call.tool)).not.toContain("send_message");
  });
});
