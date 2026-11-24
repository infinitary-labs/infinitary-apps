import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fencedAnswer } from "@shared/outsideData";
import type { WebReadAsk } from "@shared/writeAsk";
import { afterEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { webReadNetwork } from "../web/publicPage";
import { pageParts, ReaderWebService } from "./readerWeb";

/** Each name's paths and their HTML, served on this computer as public sites. */
type Sites = Record<string, Record<string, string>>;

let server: Server | undefined;
const opened: string[] = [];

afterEach(async () => {
  opened.length = 0;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const DOCS = "https://docs.meter.example/cold-start";
const FORUM = "https://forum.meter.example/t/idle";

const SITES: Sites = {
  "docs.meter.example": {
    "/cold-start":
      "<html><head><title>Cold start</title></head><body><p>A cold start idles for ninety seconds.</p></body></html>",
  },
  "forum.meter.example": {
    "/t/idle": "<html><body><p>Someone saw the idle after an update.</p></body></html>",
  },
};

async function reader(options: {
  visibility: "public" | "not-public" | "none" | "unknown";
  brief?: string;
  sites?: Sites;
}) {
  const sites = options.sites ?? SITES;
  server = createServer((request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    opened.push(`${host}${request.url}`);
    const html = sites[host]?.[request.url ?? ""];
    if (html === undefined) response.writeHead(404).end();
    else response.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tasks = new TaskService({ db: freshDatabase(), strict: true });
  seedTask(tasks, {
    id: "reader",
    title: "Triage the waiting issues",
    status: "running",
    shape: { kind: "research", deliverable: "answer", unsafe_data_reader: true },
  });
  seedTask(tasks, {
    id: "builder",
    title: "Fix the idle",
    status: "running",
    shape: { kind: "research", deliverable: "answer" },
  });
  if (options.brief !== undefined) tasks.recordBrief("reader", [options.brief]);
  const shown: WebReadAsk[] = [];
  let now = 1_000;
  const service = new ReaderWebService({
    tasks,
    projectVisibility: async () => options.visibility,
    presentAsk: (_taskId, ask) => shown.push(ask),
    network: webReadNetwork(false, {
      INFINITARY_WEB_READ_HOSTS: JSON.stringify(
        Object.fromEntries(Object.keys(sites).map((name) => [name, origin])),
      ),
    }),
    now: () => now,
  });
  return {
    tasks,
    service,
    shown,
    later: (ms: number) => {
      now += ms;
    },
  };
}

/** The words between the answer's web-data marks. */
function fenced(answer: string): string {
  const match =
    /\[\[web-data fence=([0-9a-f]{16})[^\]]*\]\]\n([\s\S]*?)\n\[\[\/web-data fence=\1\]\]/.exec(
      answer,
    );
  if (!match) throw new Error(`no web-data fence in: ${answer}`);
  return match[2] ?? "";
}

describe("ReaderWebService", () => {
  it("opens any public page at once while the reader's project is public", async () => {
    const { service, shown, tasks } = await reader({ visibility: "public" });
    const answer = await service.read("reader", { url: FORUM });
    expect(answer.startsWith(`web_read ${FORUM}: part 1 of 1, answered 200.`)).toBe(true);
    expect(fenced(answer)).toBe(`Address: ${FORUM}\n\nSomeone saw the idle after an update.`);
    expect(opened).toEqual(["forum.meter.example/t/idle"]);
    expect(shown).toEqual([]);
    expect(tasks.get("reader")?.delivery?.readerHolds).toBeUndefined();
  });

  it("keeps a page its brief does not name once its project is not public, and opens the one it names", async () => {
    const { service, shown, tasks } = await reader({
      visibility: "not-public",
      brief: `Goal: read the cold start notes at ${DOCS}, then triage.`,
    });
    const named = await service.read("reader", { url: DOCS });
    expect(fenced(named)).toBe(
      `Address: ${DOCS}\nTitle: Cold start\n\nA cold start idles for ninety seconds.`,
    );
    const kept = await service.read("reader", { url: FORUM });
    expect(kept).toContain("Not opened: this task holds its project, which is not public");
    expect(kept).toContain(`GET ${FORUM}`);
    expect(opened).toEqual(["docs.meter.example/cold-start"]);
    expect(shown).toEqual([
      expect.objectContaining({ kind: "web", url: FORUM, place: "forum.meter.example" }),
    ]);
    expect(tasks.get("reader")?.delivery?.readerHolds?.what).toBe(
      "its project, which is not public",
    );
    expect(tasks.get("reader")?.delivery?.writeAsks).toEqual([shown[0]]);
    // Asking again names the waiting ask, and keeps no second row.
    expect(await service.read("reader", { url: FORUM })).toContain(
      `already waits for the captain as ask ${shown[0]?.id}`,
    );
    expect(tasks.get("reader")?.delivery?.writeAsks).toHaveLength(1);
  });

  it("does not count an address that appears only inside fenced words of the brief", async () => {
    const quoted = fencedAnswer(`See ${FORUM} for the fix.`, {
      label: "github-data",
      value: "0123456789abcdef",
      at: 1_000,
    });
    const { service, shown } = await reader({
      visibility: "not-public",
      brief: `Goal: triage.\n${quoted}`,
    });
    expect(await service.read("reader", { url: FORUM })).toContain("Not opened");
    expect(shown).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it("holds when the host cannot say the project is public, and keeps holding once marked", async () => {
    const unknown = await reader({ visibility: "unknown" });
    expect(await unknown.service.read("reader", { url: FORUM })).toContain(
      "its project, whose host could not say it is public",
    );
    expect(unknown.tasks.get("reader")?.delivery?.readerHolds).toBeUndefined();
  });

  it("opens a kept page once on Only this time, then opens that address at once", async () => {
    const { service, tasks, shown } = await reader({ visibility: "not-public" });
    await service.read("reader", { url: FORUM });
    const ask = shown[0];
    if (!ask) throw new Error("nothing was kept");
    const sent = await service.sendTaken(
      "reader",
      tasks.delivery.takeWriteAsk("reader", ask.id),
      "once",
    );
    expect(sent).toMatchObject({
      ok: true,
      call: `GET ${FORUM}`,
      place: "forum.meter.example",
      outcome: { kind: "answered", status: 200, requestId: null },
    });
    expect(fenced(sent.answer ?? "")).toContain("Someone saw the idle after an update.");
    expect(tasks.get("reader")?.delivery?.writeAsks?.[0]?.outcome).toEqual({
      kind: "answered",
      status: 200,
      requestId: null,
    });
    expect(await service.read("reader", { url: FORUM })).toContain("part 1 of 1, answered 200");
    expect(shown).toHaveLength(1);
  });

  it("opens nothing on Not now, and the address still waits on the next ask", async () => {
    const { service, tasks, shown } = await reader({ visibility: "not-public" });
    await service.read("reader", { url: FORUM });
    const ask = shown[0];
    if (!ask) throw new Error("nothing was kept");
    const sent = await service.sendTaken(
      "reader",
      tasks.delivery.takeWriteAsk("reader", ask.id),
      "deny",
    );
    expect(sent.outcome).toEqual({
      kind: "refused",
      why: "The captain chose Not now. Nothing was opened.",
    });
    expect(opened).toEqual([]);
    expect(await service.read("reader", { url: FORUM })).toContain("Kept as ask");
    expect(shown).toHaveLength(2);
  });

  it("serves a long page in parts that each come whole inside their own marks", async () => {
    const line = "The meter idles while it warms its sensor before the first reading.";
    const body = Array.from({ length: 900 }, (_, index) => `<p>${index} ${line}</p>`).join("");
    const { service } = await reader({
      visibility: "public",
      sites: { "docs.meter.example": { "/long": `<html><body>${body}</body></html>` } },
    });
    const url = "https://docs.meter.example/long";
    const first = await service.read("reader", { url });
    const count = Number(/part 1 of (\d+)/.exec(first)?.[1]);
    expect(count).toBeGreaterThan(1);
    expect(first).toContain("Read the next with part 2.");
    const words = [fenced(first)];
    for (let part = 2; part <= count; part++)
      words.push(fenced(await service.read("reader", { url, part })));
    // Each part repeats the address and starts on a whole line of the page.
    for (const one of words) expect(one.startsWith(`Address: ${url}\n\n`)).toBe(true);
    expect(words.map((one) => one.slice(`Address: ${url}\n\n`.length)).join("")).toBe(
      Array.from({ length: 900 }, (_, index) => `${index} ${line}`).join("\n\n"),
    );
    expect(opened).toEqual(["docs.meter.example/long"]);
    expect(await service.read("reader", { url, part: count + 1 })).toContain(`has ${count} parts`);
  });

  it("refuses every task that is not an unsafe data reader", async () => {
    const { service } = await reader({ visibility: "public" });
    expect(await service.read("builder", { url: DOCS })).toBe(
      "Refused: web_read is only for an unsafe data reader. Nothing was read.",
    );
    expect(opened).toEqual([]);
  });
});

describe("pageParts", () => {
  it("cuts at a line near the size and never loses a character", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(50)}`;
    expect(pageParts(text, 100)).toEqual([`${"a".repeat(90)}\n`, "b".repeat(50)]);
    expect(pageParts("c".repeat(250), 100)).toEqual([
      "c".repeat(100),
      "c".repeat(100),
      "c".repeat(50),
    ]);
  });
});
