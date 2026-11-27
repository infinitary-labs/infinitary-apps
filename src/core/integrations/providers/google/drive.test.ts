import { readFileSync } from "node:fs";
import { NOTICE_ACCEPTED } from "@shared/integrations";
import { fencedSpans } from "@shared/outsideData";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StandInDriveFile } from "../../../../../tests/helpers/driveMcpStandIn";
import { STAND_IN_PROJECT } from "../../../../../tests/helpers/googleStandIn";
import {
  type GoogleWorld,
  type GoogleWorldOptions,
  googleWorld,
} from "../../../../../tests/helpers/googleWorld";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { GOOGLE_SCOPES } from "./client";

/**
 * INF-7012's approved plan, piece 2: Drive joins the Google row through
 * Google's Drive MCP server, with the captain's answers on INF-6447 - "All
 * of Drive, including folders", and "Keep Gmail and Calendar; Drive waits
 * for a new sign-in" for a sign-in that leaves Drive out. Its three actions
 * only read: search, read a file's text, and save one file into the task's
 * hand-over folder; none deletes, moves or shares.
 *
 * Google is the stand-in (`tests/helpers/googleStandIn.ts`, its Drive
 * server in `tests/helpers/driveMcpStandIn.ts`), answering in the shapes
 * Drive's MCP server lists.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const DRIVE = "https://www.googleapis.com/auth/drive";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A studio's Drive: a folder with a Doc in it, a Sheet, a photo, a PDF and a trashed Doc. */
const FILES: StandInDriveFile[] = [
  {
    id: "1FoLdEr0rtiz",
    title: "Ortiz Studio",
    mimeType: "application/vnd.google-apps.folder",
    owner: "ada.park@gmail.com",
    modifiedTime: "2026-10-01T09:00:00.000Z",
  },
  {
    id: "1DoCsHoTlIsT",
    title: "October shoot shot list",
    mimeType: "application/vnd.google-apps.document",
    owner: "ada.park@gmail.com",
    modifiedTime: "2026-10-20T17:12:00.000Z",
    parentId: "1FoLdEr0rtiz",
    text: "Roof at 6am, then the courtyard. Lena brings the 85mm.",
  },
  {
    id: "1ShEeTbUdGeT",
    title: "Shoot budget",
    mimeType: "application/vnd.google-apps.spreadsheet",
    owner: "lena@ortiz-studio.com",
    modifiedTime: "2026-10-18T11:30:00.000Z",
    text: "Item,Cost\nLights,420\nPermits,180",
  },
  {
    id: "1PhOtOrOoF",
    title: "roof.jpg",
    mimeType: "image/jpeg",
    owner: "ada.park@gmail.com",
    modifiedTime: "2026-10-21T06:05:00.000Z",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  },
  {
    id: "1InVoIcE2214",
    title: "Invoice 2214.pdf",
    mimeType: PDF,
    owner: "lena@ortiz-studio.com",
    modifiedTime: "2026-10-22T08:00:00.000Z",
    text: "Invoice 2214 for the October shoot",
    bytes: Buffer.from("%PDF-1.7\nInvoice 2214\n%%EOF\n"),
  },
  {
    id: "1OlDdRaFt",
    title: "Old shot list draft",
    mimeType: "application/vnd.google-apps.document",
    owner: "ada.park@gmail.com",
    modifiedTime: "2026-09-01T10:00:00.000Z",
    trashed: true,
    text: "Roof at 7am",
  },
];

type Fixture = GoogleWorld;
const fixture = (...args: GoogleWorldOptions) => googleWorld(cleanup, ...args);

/** Signed in with every box ticked, Drive filled, reads allowed and the sign-in's probe answered. */
async function signedIn(grant: readonly string[] = GOOGLE_SCOPES): Promise<Fixture> {
  const world = await fixture();
  for (const file of FILES) world.google.files.set(file.id, file);
  world.google.knobs.consent.grant = [...grant];
  await world.integrations.signIn("google", NOTICE_ACCEPTED);
  // The probe reads Gmail and Calendar on its own after the sign-in; a test's knob waits for it.
  await vi.waitFor(() =>
    expect(world.google.calls().map((call) => call.tool)).toEqual(
      expect.arrayContaining(["list_labels", "list_calendars"]),
    ),
  );
  allowIntegrationReads(world.integrations);
  return world;
}

/** An answer's JSON, read from the one span Google's words are fenced in. */
function parsed(text: string) {
  const [span] = fencedSpans(text);
  if (!span) throw new Error(`Not fenced as data from outside: ${text.slice(0, 120)}`);
  return JSON.parse(span.words) as Record<string, unknown>;
}

const call = (world: Fixture, action: string, input: unknown) =>
  world.integrations.forTask("task-1").call("Google", action, input, undefined, "For the shoot.");

describe("Drive on the Google row", () => {
  it("searches by name, words, folder and type, leaving trashed files out, and lists each file's facts", async () => {
    const world = await signedIn();
    const found = parsed(
      (await call(world, "search_files", { words: "roof", type: "document", max: 10 })).text,
    );
    expect(found).toEqual({
      files: [
        {
          id: "1DoCsHoTlIsT",
          name: "October shoot shot list",
          type: "application/vnd.google-apps.document",
          owner: "ada.park@gmail.com",
          modified: "2026-10-20T17:12:00.000Z",
          link: "https://drive.google.com/file/d/1DoCsHoTlIsT/view",
        },
      ],
    });
    expect(world.google.calls("drive").at(-1)?.args).toEqual({
      query:
        "fullText contains 'roof' and mimeType = 'application/vnd.google-apps.document' and trashed = false",
      pageSize: 10,
      excludeContentSnippets: true,
    });

    const inFolder = parsed(
      (await call(world, "search_files", { folder: "1FoLdEr0rtiz", max: 10 })).text,
    );
    expect((inFolder.files as { id: string }[]).map((file) => file.id)).toEqual(["1DoCsHoTlIsT"]);

    // A quote in a name stays inside Drive's quoted value.
    await call(world, "search_files", { name: "Lena's", max: 5 });
    expect(world.google.calls("drive").at(-1)?.args.query).toBe(
      "title contains 'Lena\\'s' and trashed = false",
    );
  });

  it("pages a long search with next_page", async () => {
    const world = await signedIn();
    const first = parsed((await call(world, "search_files", { name: "o", max: 2 })).text);
    expect(first.files).toHaveLength(2);
    expect(first.next_page).toBe("2");
    const next = parsed(
      (await call(world, "search_files", { name: "o", max: 2, page: String(first.next_page) }))
        .text,
    );
    expect(world.google.calls("drive").at(-1)?.args).toMatchObject({
      pageToken: "2",
      query: "title contains 'o' and trashed = false",
    });
    expect((next.files as unknown[]).length).toBeGreaterThan(0);

    // Google's page token continues the search that made it, so a page
    // given without that search's words would list other files.
    const before = world.google.calls("drive").length;
    expect(
      await call(world, "search_files", { max: 2, page: String(first.next_page) }),
    ).toMatchObject({ refused: "invalid" });
    expect(world.google.calls("drive")).toHaveLength(before);
  });

  it("refuses a search that names nothing to search by", async () => {
    const world = await signedIn();
    const before = world.google.calls("drive").length;
    const answer = await call(world, "search_files", { max: 5 });
    expect(answer.refused).toBe("invalid");
    expect(world.google.calls("drive")).toHaveLength(before);
  });

  it("reads a file's text, says when Drive reads none, and cuts a long one saying so", async () => {
    const world = await signedIn();
    expect(parsed((await call(world, "read_file", { id: "1DoCsHoTlIsT" })).text)).toEqual({
      id: "1DoCsHoTlIsT",
      name: "October shoot shot list",
      link: "https://drive.google.com/file/d/1DoCsHoTlIsT/view",
      content: "Roof at 6am, then the courtyard. Lena brings the 85mm.",
    });
    expect(parsed((await call(world, "read_file", { id: "1PhOtOrOoF" })).text)).toEqual({
      id: "1PhOtOrOoF",
      name: "roof.jpg",
      link: "https://drive.google.com/file/d/1PhOtOrOoF/view",
      note: "Drive reads no text from this file. save_file saves it whole.",
    });

    // A transcript of 150,000 characters: the answer keeps the first 100,000.
    const long = "a".repeat(150_000);
    world.google.files.set("1LoNgNoTeS", {
      id: "1LoNgNoTeS",
      title: "Interview transcript",
      mimeType: "application/vnd.google-apps.document",
      owner: "ada.park@gmail.com",
      modifiedTime: "2026-10-22T09:00:00.000Z",
      text: long,
    });
    const cut = parsed((await call(world, "read_file", { id: "1LoNgNoTeS" })).text);
    expect(String(cut.content)).toHaveLength(100_000);
    expect(cut).toMatchObject({ cut: true, length: 150_000 });
  });

  it("saves an ordinary file byte for byte, and a Doc as PDF or Word into the task's hand-over folder", async () => {
    const world = await signedIn();
    const invoice = await call(world, "save_file", { id: "1InVoIcE2214" });
    expect(invoice.refused).toBeUndefined();
    const saved = parsed(invoice.text);
    expect(saved).toMatchObject({ name: "Invoice 2214.pdf", type: PDF });
    expect(readFileSync(String(saved.path)).equals(FILES[4]?.bytes ?? Buffer.alloc(1))).toBe(true);

    const asPdf = parsed((await call(world, "save_file", { id: "1DoCsHoTlIsT" })).text);
    expect(asPdf).toMatchObject({ name: "October shoot shot list.pdf", type: PDF });
    expect(world.google.calls("drive").at(-1)).toMatchObject({
      tool: "download_file_content",
      args: { fileId: "1DoCsHoTlIsT", exportMimeType: PDF },
    });
    expect(readFileSync(String(asPdf.path), "utf8").startsWith("%PDF-")).toBe(true);

    const asWord = parsed(
      (await call(world, "save_file", { id: "1DoCsHoTlIsT", as: "docx" })).text,
    );
    expect(asWord).toMatchObject({ name: "October shoot shot list.docx", type: DOCX });

    // A slash in a Drive title is part of the name, never a folder.
    world.google.files.set("1BuDgEt1022", {
      id: "1BuDgEt1022",
      title: "Budget 10/22",
      mimeType: "application/vnd.google-apps.document",
      owner: "ada.park@gmail.com",
      modifiedTime: "2026-10-22T09:00:00.000Z",
      text: "Lenses, roof permit, lunch.",
    });
    const dated = parsed((await call(world, "save_file", { id: "1BuDgEt1022" })).text);
    expect(dated).toMatchObject({ name: "Budget 10-22.pdf", type: PDF });
  });

  it("refuses a folder, an export the type does not take and a format for an ordinary file, downloading nothing", async () => {
    const world = await signedIn();
    const downloads = () =>
      world.google.calls("drive").filter((entry) => entry.tool === "download_file_content");
    expect(await call(world, "save_file", { id: "1FoLdEr0rtiz" })).toMatchObject({
      refused: "invalid",
    });
    expect(await call(world, "save_file", { id: "1DoCsHoTlIsT", as: "xlsx" })).toEqual({
      text: "File 1DoCsHoTlIsT exports as pdf or docx, not xlsx.",
      refused: "invalid",
    });
    expect(await call(world, "save_file", { id: "1PhOtOrOoF", as: "pdf" })).toMatchObject({
      refused: "invalid",
    });
    expect(downloads()).toEqual([]);
  });

  it("refuses a file past 25 MB before downloading it", async () => {
    const world = await signedIn();
    world.google.files.set("1BiGvIdEo", {
      id: "1BiGvIdEo",
      title: "roof timelapse.mov",
      mimeType: "video/quicktime",
      owner: "ada.park@gmail.com",
      modifiedTime: "2026-10-21T07:00:00.000Z",
      bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
    });
    expect(await call(world, "save_file", { id: "1BiGvIdEo" })).toEqual({
      text: "File 1BiGvIdEo is 26 MB, past the 25 MB save_file saves, so nothing was saved. Ask the captain to download it from Drive.",
      refused: "refused",
    });
    expect(world.google.calls("drive").map((entry) => entry.tool)).not.toContain(
      "download_file_content",
    );
  });

  // The captain's answer 2a on INF-6447: "Keep Gmail and Calendar; Drive waits for a new sign-in".
  it("keeps a sign-in that leaves Drive out, says so on the row, and refuses Drive before any card while Gmail works", async () => {
    const world = await signedIn(GOOGLE_SCOPES.filter((scope) => scope !== DRIVE));
    const { google, integrations, tasks } = world;
    const row = integrations.view().integrations[0];
    expect(row).toMatchObject({ id: "google", health: "ok" });
    expect(row?.client?.withoutDrive).toBe(true);

    // Even with no rule allowing it, the refusal comes before the captain is asked.
    integrations.setRule("google", "search_files", false);
    const refused = await call(world, "search_files", { name: "shot", max: 5 });
    expect(refused).toEqual({
      text: "Not run: Drive, Docs and Sheets were not added to the captain's Google sign-in, so nothing reached Google. The captain chooses Sign in again on the Google row in Settings -> Integrations and leaves the Drive box ticked; Gmail and Calendar keep working meanwhile.",
      refused: "refused",
    });
    expect(tasks.get("task-1")?.delivery?.writeAsks ?? []).toEqual([]);
    expect(google.calls("drive")).toEqual([]);

    expect((await call(world, "search_mail", { max: 1 })).refused).toBeUndefined();
  });

  it("names Drive's MCP service when it is off, with Google's page that turns it on", async () => {
    const world = await signedIn();
    world.google.knobs.off.add("drive");
    const refused = await call(world, "read_file", { id: "1DoCsHoTlIsT" });
    expect(refused.refused).toBe("refused");
    const mcp = world.integrations.view().integrations[0]?.client?.mcp;
    expect(mcp).toEqual({
      refused: "service",
      off: ["drive"],
      link: `https://console.developers.google.com/apis/api/drivemcp.googleapis.com/overview?project=${STAND_IN_PROJECT}`,
    });
    expect(mcp).not.toHaveProperty("services");
  });
});
