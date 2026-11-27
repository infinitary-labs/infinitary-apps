import { readFileSync } from "node:fs";
import { NOTICE_ACCEPTED } from "@shared/integrations";
import { fencedSpans } from "@shared/outsideData";
import { afterEach, describe, expect, it } from "vitest";
import { STAND_IN_ACCOUNT } from "../../../../../tests/helpers/googleStandIn";
import {
  type GoogleWorld,
  type GoogleWorldOptions,
  googleWorld,
} from "../../../../../tests/helpers/googleWorld";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";

/**
 * Gmail through its MCP server (INF-7012's approved plan, piece 1), as the
 * captain picked on INF-7017's plan-mismatch card once the live check showed
 * Google asking before anything reads someone else's mail and refusing the
 * whole message for mail with a file: a rule's look tells only which
 * conversation got mail, and the crewmate reads it by that id; a file comes
 * from Gmail's own API until February 1, 2027.
 *
 * Google is the stand-in (`tests/helpers/googleStandIn.ts`, its MCP servers
 * in `tests/helpers/googleMcpStandIn.ts`), with Google's question raised for
 * the reads it asks about.
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

const fixture = (...args: GoogleWorldOptions) => googleWorld(cleanup, ...args);

async function signedIn(): Promise<GoogleWorld> {
  const world = await fixture();
  await world.integrations.signIn("google", NOTICE_ACCEPTED);
  allowIntegrationReads(world.integrations);
  return world;
}

/** The words of the one span Gmail fences an answer or a summary in (INF-951). */
function outside(text: string): string {
  const [span] = fencedSpans(text);
  if (!span) throw new Error(`Not fenced as data from outside: ${text.slice(0, 120)}`);
  return span.words;
}

function parsed(text: string) {
  return JSON.parse(outside(text)) as Record<string, unknown>;
}

describe("Gmail through its MCP server", () => {
  // The captain's pick on INF-7017's plan-mismatch card: "Keep saving files through Gmail's own
  // interface until February 1, 2027, then stop", the day Google's terms stop an AI agent's
  // client reaching attached files.
  it("saves a file until February 1, 2027, then refuses one without asking Gmail, saying the captain saves it from Gmail", async () => {
    const { google, clock, integrations } = await signedIn();
    const notes = Buffer.from("Shot list\nRoof, 6am\n", "utf8");
    const id = google.deliver({
      from: ARRIVING.from,
      subject: "Shot list",
      text: "Attached.",
      attachment: { name: "shot list.txt", type: "text/plain", size: notes.length, bytes: notes },
    });
    const row = integrations.view().integrations[0];
    integrations.setRule(row?.id ?? "", "save_attachment", true);
    const save = () =>
      integrations
        .forTask("task-1")
        .call("Google", "save_attachment", { id, part: "1" }, undefined, "Read the shot list.");

    clock.now = Date.UTC(2027, 0, 31, 23, 59, 59);
    const last = await save();
    expect(last.refused).toBeUndefined();
    expect(readFileSync(String(parsed(last.text).path)).equals(notes)).toBe(true);

    clock.now = Date.UTC(2027, 1, 1);
    const asked = google.seen.length;
    expect(await save()).toEqual({
      text: "Since February 1, 2027 Google hands an AI agent no attached file, so nothing was saved. Ask the captain to save it from Gmail.",
      refused: "refused",
    });
    expect(google.seen).toHaveLength(asked);
  });

  // INF-7012's approved plan: message_received reads Gmail's MCP server by polling
  // search_threads; the captain's pick B on INF-7017's plan-mismatch card: "Look reads only which
  // conversations got mail; Google asks once, at the read".
  it("tells each conversation that gets mail in the inbox by its id alone, asking Google nothing, and starts again from now for another mailbox or a cursor from before Gmail's MCP server", async () => {
    const { google, clock, tasks, integrations } = await signedIn();
    // Google asks the person before any of these reads someone else's mail.
    const reads = ["search_threads", "get_thread", "get_message"];
    for (const tool of reads) google.knobs.confirm.add(tool);
    google.deliver({ from: "a@example.com", subject: "Already there", text: "x" });
    clock.now += 1_000;
    const start = await integrations.look("google", "message_received", null);
    expect(start.items).toEqual([]);

    const first = google.deliver(ARRIVING);
    const second = google.deliver({
      from: "United Airlines <unitedairlines@news.united.com>",
      subject: "",
      text: "Your trip to Lisbon is coming up.",
      labels: ["Label_7"],
    });
    clock.now += 120_000;
    const asked = google.calls().length;
    const found = await integrations.look("google", "message_received", start.cursor);
    expect(found.items.map((item) => ({ id: item.id, summary: outside(item.summary) }))).toEqual([
      { id: google.mail.get(first)?.threadId, summary: "New mail in a Gmail conversation" },
      { id: google.mail.get(second)?.threadId, summary: "New mail in a Gmail conversation" },
    ]);
    expect(found.resynced).toBeUndefined();
    // Of the reads Google asks about, the look made one, for ids alone.
    expect(
      google
        .calls()
        .slice(asked)
        .filter((call) => reads.includes(call.tool))
        .map((call) => [call.tool, call.args.view]),
    ).toEqual([["search_threads", "THREAD_VIEW_IDS_ONLY"]]);
    expect(google.answers).toEqual([]);
    expect(tasks.get("task-1")?.delivery?.writeAsks ?? []).toEqual([]);
    const again = await integrations.look("google", "message_received", found.cursor);
    expect(again.items).toEqual([]);

    // A reply in a conversation already told tells it again.
    google.deliver({
      from: ARRIVING.from,
      subject: `Re: ${ARRIVING.subject}`,
      text: "One more thing.",
      threadId: google.mail.get(first)?.threadId,
    });
    clock.now += 120_000;
    const replied = await integrations.look("google", "message_received", again.cursor);
    expect(replied.items.map((item) => item.id)).toEqual([google.mail.get(first)?.threadId]);

    // Mail under a minute old waits for the next look, as Gmail's search may not hold it yet.
    const fresh = google.deliver({ from: "e@example.com", subject: "Fresh", text: "v" });
    clock.now += 30_000;
    const waiting = await integrations.look("google", "message_received", replied.cursor);
    expect(waiting.items).toEqual([]);
    clock.now += 31_000;
    const settled = await integrations.look("google", "message_received", waiting.cursor);
    expect(settled.items.map((item) => item.id)).toEqual([google.mail.get(fresh)?.threadId]);

    // Mail Gmail dates ahead of the app's clock is told once, when the clock reaches it.
    const ahead = google.deliver({
      from: "c@example.com",
      subject: "Ahead",
      text: "z",
      at: clock.now + 90_000,
    });
    clock.now += 61_000;
    const early = await integrations.look("google", "message_received", settled.cursor);
    expect(early.items).toEqual([]);
    clock.now += 120_000;
    const reached = await integrations.look("google", "message_received", early.cursor);
    expect(reached.items.map((item) => item.id)).toEqual([google.mail.get(ahead)?.threadId]);
    clock.now += 120_000;
    expect((await integrations.look("google", "message_received", reached.cursor)).items).toEqual(
      [],
    );

    // A cursor an earlier version kept, a Gmail history id, starts again from now.
    google.deliver({ from: "f@example.com", subject: "Before the update", text: "u" });
    clock.now += 1_000;
    const older = await integrations.look(
      "google",
      "message_received",
      `4812331 ${STAND_IN_ACCOUNT}`,
    );
    expect(older).toMatchObject({ items: [], resynced: true });
    const after = google.deliver({ from: "b@example.com", subject: "After", text: "y" });
    clock.now += 120_000;
    expect(
      (await integrations.look("google", "message_received", older.cursor)).items.map(
        (item) => item.id,
      ),
    ).toEqual([google.mail.get(after)?.threadId]);

    // A cursor from another mailbox starts again from now.
    const other = again.cursor.replace(STAND_IN_ACCOUNT, "someone.else@gmail.com");
    expect(await integrations.look("google", "message_received", other)).toMatchObject({
      items: [],
      resynced: true,
    });
  });

  // The captain's pick B on INF-7017's plan-mismatch card: a rule names only the conversation, and
  // the crewmate reads it by that id.
  it("reads the conversation a rule named as its newest message in the inbox, listing the rest by id, sender and date", async () => {
    const { google, integrations } = await signedIn();
    const first = google.deliver(ARRIVING);
    const thread = google.mail.get(first)?.threadId ?? "";
    const reply = google.deliver({
      from: ARRIVING.from,
      subject: `Re: ${ARRIVING.subject}`,
      text: "One more thing: the PO number is 7731.",
      threadId: thread,
    });
    // The captain's own answer from Gmail joins the conversation but not the inbox.
    const answered = google.deliver({
      from: `Ada Park <${STAND_IN_ACCOUNT}>`,
      subject: `Re: ${ARRIVING.subject}`,
      text: "Thanks, paying Friday.",
      threadId: thread,
    });
    const own = google.mail.get(answered);
    if (own) own.labelIds = ["SENT"];

    const read = parsed(
      (
        await integrations
          .forTask("task-1")
          .call("Google", "read_message", { thread }, undefined, "Read the mail the rule named.")
      ).text,
    );
    expect(read).toMatchObject({
      id: reply,
      thread,
      from: ARRIVING.from,
      subject: `Re: ${ARRIVING.subject}`,
      text: "One more thing: the PO number is 7731.",
    });
    expect(read.others).toEqual([
      { id: answered, from: `Ada Park <${STAND_IN_ACCOUNT}>`, date: expect.any(String) },
      { id: first, from: ARRIVING.from, date: expect.any(String) },
    ]);
  });

  it("refuses read_message naming both a message and a conversation, or neither, before asking Gmail", async () => {
    const { google, integrations } = await signedIn();
    const id = google.deliver(ARRIVING);
    const thread = google.mail.get(id)?.threadId ?? "";
    const asked = google.seen.length;
    for (const input of [{ id, thread }, {}])
      expect(
        await integrations
          .forTask("task-1")
          .call("Google", "read_message", input, undefined, "Read the mail."),
      ).toMatchObject({ refused: "invalid" });
    expect(google.seen).toHaveLength(asked);
  });
});
