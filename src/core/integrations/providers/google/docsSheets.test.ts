import { NOTICE_ACCEPTED } from "@shared/integrations";
import { fencedSpans } from "@shared/outsideData";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StandInDriveFile } from "../../../../../tests/helpers/driveMcpStandIn";
import { STAND_IN_PROJECT } from "../../../../../tests/helpers/googleStandIn";
import { type GoogleWorld, googleWorld } from "../../../../../tests/helpers/googleWorld";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { GOOGLE_SCOPES } from "./client";

/**
 * INF-7012's approved plan, piece 3, from INF-6447's piece 2: Docs and
 * Sheets join the Google row through Google's Docs, Sheets and Drive MCP
 * servers. The crew makes a doc or a spreadsheet, adds to a doc and
 * replaces text in it, reads a spreadsheet, sets its cells and adds rows.
 * Every change waits for the captain at Asks you, Allow for the rest of
 * this task covers one doc or one spreadsheet, and no action deletes,
 * moves or shares. The captain's answer 2a on INF-6447, "Keep Gmail and
 * Calendar; Drive waits for a new sign-in", holds for Docs and Sheets too.
 *
 * Google is the stand-in (`tests/helpers/googleStandIn.ts`, its Docs and
 * Sheets servers in `tests/helpers/docsSheetsMcpStandIn.ts`).
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const DRIVE = "https://www.googleapis.com/auth/drive";
const DOCUMENT = "application/vnd.google-apps.document";
const SPREADSHEET = "application/vnd.google-apps.spreadsheet";
const REASON = "For the October shoot.";

const STUDIO: StandInDriveFile = {
  id: "1FoLdEr0rtiz",
  title: "Ortiz Studio",
  mimeType: "application/vnd.google-apps.folder",
  owner: "ada.park@gmail.com",
  modifiedTime: "2026-10-01T09:00:00.000Z",
};
const SHOT_LIST: StandInDriveFile = {
  id: "1DoCsHoTlIsT",
  title: "October shoot shot list",
  mimeType: DOCUMENT,
  owner: "ada.park@gmail.com",
  modifiedTime: "2026-10-20T17:12:00.000Z",
  parentId: STUDIO.id,
  text: "Roof at 6am, then the courtyard. Lena brings the 85mm. Lena checks the roof permit.",
};
const budget = (): StandInDriveFile => ({
  id: "1ShEeTbUdGeT",
  title: "Shoot budget",
  mimeType: SPREADSHEET,
  owner: "lena@ortiz-studio.com",
  modifiedTime: "2026-10-18T11:30:00.000Z",
  tabs: [
    {
      sheetId: 0,
      title: "Costs",
      rows: [
        ["Item", "Cost", "Paid"],
        ["Lights", 420, true],
        ["Permits", 180, false],
      ],
    },
    { sheetId: 7, title: "Crew rates", rows: [["Name", "Day rate"]] },
  ],
});

/** Signed in with every box ticked, the studio's Drive filled, reads allowed and the sign-in's probe answered. */
async function signedIn(grant: readonly string[] = GOOGLE_SCOPES): Promise<GoogleWorld> {
  const world = await googleWorld(cleanup);
  for (const file of [STUDIO, { ...SHOT_LIST }, budget()]) world.google.files.set(file.id, file);
  world.google.knobs.consent.grant = [...grant];
  await world.integrations.signIn("google", NOTICE_ACCEPTED);
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

const call = (world: GoogleWorld, action: string, input: unknown) =>
  world.integrations.forTask("task-1").call("Google", action, input, undefined, REASON);

/**
 * The crew calls a change, which waits at Asks you having sent nothing; the
 * captain answers it with Send, or with Allow for the rest of this task.
 * Answers what Google said back.
 */
async function approved(
  world: GoogleWorld,
  action: string,
  input: unknown,
  allow?: "task",
): Promise<Record<string, unknown>> {
  const before = world.google.seen.length;
  const asked = await call(world, action, input);
  expect(asked.refused).toBe("refused");
  expect(world.google.seen).toHaveLength(before);
  const ask = world.tasks.get("task-1")?.delivery?.writeAsks?.at(0);
  expect(ask).toMatchObject({ kind: "integration", action });
  const sent = await world.integrations.sendAsk("task-1", ask?.id ?? "", allow);
  expect(sent.outcome).toEqual({ kind: "ran" });
  return parsed(sent.answer ?? "");
}

const fileOf = (world: GoogleWorld, id: string) => world.google.files.get(id);

describe("Docs on the Google row", () => {
  it("makes a doc from Markdown in a folder through Drive, after the captain's approval", async () => {
    const world = await signedIn();
    const made = await approved(world, "create_document", {
      title: "Call sheet, Oct 24",
      text: "# Call sheet\n\n**Roof** at 6am\n\n- Lena: lights\n- Ada: camera",
      folder: STUDIO.id,
    });
    expect(world.google.calls("drive").at(-1)).toMatchObject({
      tool: "create_file",
      args: {
        title: "Call sheet, Oct 24",
        textContent: "# Call sheet\n\n**Roof** at 6am\n\n- Lena: lights\n- Ada: camera",
        contentMimeType: "text/markdown",
        parentId: STUDIO.id,
      },
    });
    const id = String(made.id);
    expect(made).toEqual({
      id,
      name: "Call sheet, Oct 24",
      link: `https://drive.google.com/file/d/${id}/view`,
      folder: STUDIO.id,
    });
    expect(fileOf(world, id)).toMatchObject({
      mimeType: DOCUMENT,
      parentId: STUDIO.id,
      text: "Call sheet\n\nRoof at 6am\n\n- Lena: lights\n- Ada: camera",
    });
  });

  it("adds text at a doc's end and leaves what was there", async () => {
    const world = await signedIn();
    const added = await approved(world, "append_to_document", {
      id: SHOT_LIST.id,
      text: "\nWrap by noon.",
    });
    expect(added).toEqual({
      id: SHOT_LIST.id,
      added: 14,
      link: `https://docs.google.com/document/d/${SHOT_LIST.id}/edit`,
    });
    expect(world.google.calls("docs").at(-1)).toMatchObject({
      tool: "update_doc",
      args: {
        documentId: SHOT_LIST.id,
        requests: [{ insertText: { text: "\nWrap by noon.", endOfSegmentLocation: {} } }],
      },
    });
    expect(fileOf(world, SHOT_LIST.id)?.text).toBe(`${SHOT_LIST.text}\nWrap by noon.`);
  });

  it("replaces every place a word occurs, by case when asked, and says 0 when it was not there", async () => {
    const world = await signedIn();
    expect(
      await approved(world, "replace_in_document", {
        id: SHOT_LIST.id,
        find: "lena",
        replace: "Marco",
      }),
    ).toEqual({
      id: SHOT_LIST.id,
      replaced: 2,
      link: `https://docs.google.com/document/d/${SHOT_LIST.id}/edit`,
    });
    expect(fileOf(world, SHOT_LIST.id)?.text).toBe(
      "Roof at 6am, then the courtyard. Marco brings the 85mm. Marco checks the roof permit.",
    );

    expect(
      (
        await approved(world, "replace_in_document", {
          id: SHOT_LIST.id,
          find: "roof",
          replace: "rooftop",
          match_case: true,
        })
      ).replaced,
    ).toBe(1);
    expect(fileOf(world, SHOT_LIST.id)?.text).toBe(
      "Roof at 6am, then the courtyard. Marco brings the 85mm. Marco checks the rooftop permit.",
    );

    expect(
      (
        await approved(world, "replace_in_document", {
          id: SHOT_LIST.id,
          find: "drone",
          replace: "crane",
        })
      ).replaced,
    ).toBe(0);
  });

  it("names Docs' MCP service when it is off, with Google's page that turns it on", async () => {
    const world = await signedIn();
    world.google.knobs.off.add("docs");
    const asked = await call(world, "append_to_document", { id: SHOT_LIST.id, text: "\nWrap." });
    expect(asked.refused).toBe("refused");
    const ask = world.tasks.get("task-1")?.delivery?.writeAsks?.at(0);
    expect((await world.integrations.sendAsk("task-1", ask?.id ?? "")).outcome).toMatchObject({
      kind: "refused",
    });
    expect(world.integrations.view().integrations[0]?.client?.mcp).toEqual({
      refused: "service",
      off: ["docs"],
      link: `https://console.developers.google.com/apis/api/docsmcp.googleapis.com/overview?project=${STAND_IN_PROJECT}`,
    });
    expect(fileOf(world, SHOT_LIST.id)?.text).toBe(SHOT_LIST.text);
  });
});

describe("Sheets on the Google row", () => {
  it("lists a spreadsheet's tabs with their sizes, and reads a range's values as the sheet shows them", async () => {
    const world = await signedIn();
    expect(parsed((await call(world, "read_sheet", { id: "1ShEeTbUdGeT" })).text)).toEqual({
      id: "1ShEeTbUdGeT",
      name: "Shoot budget",
      link: "https://docs.google.com/spreadsheets/d/1ShEeTbUdGeT/edit",
      tabs: [
        { name: "Costs", rows: 1000, columns: 26 },
        { name: "Crew rates", rows: 1000, columns: 26 },
      ],
    });
    expect(
      parsed((await call(world, "read_sheet", { id: "1ShEeTbUdGeT", range: "Costs!A1:C3" })).text),
    ).toEqual({
      id: "1ShEeTbUdGeT",
      range: "Costs!A1:C3",
      values: [
        ["Item", "Cost", "Paid"],
        ["Lights", "420", "TRUE"],
        ["Permits", "180", "FALSE"],
      ],
    });
    expect(world.google.calls("sheets").at(-1)).toMatchObject({
      tool: "get_values",
      args: { spreadsheetId: "1ShEeTbUdGeT", range: "Costs!A1:C3" },
    });
  });

  it("makes a spreadsheet with named tabs and its first rows entered as typed", async () => {
    const world = await signedIn();
    const made = await approved(world, "create_spreadsheet", {
      title: "Lens rental",
      tabs: ["Lenses", "Returns"],
      rows: [
        ["Lens", "Days", "Rate", "Total"],
        ["85mm", "3", 45, "=3+45"],
      ],
    });
    const id = String(made.id);
    expect(made).toEqual({
      id,
      name: "Lens rental",
      link: `https://drive.google.com/file/d/${id}/view`,
      tabs: ["Lenses", "Returns"],
      rows: 2,
    });
    expect(world.google.calls("drive").at(-1)).toMatchObject({
      tool: "create_file",
      args: { title: "Lens rental", contentMimeType: SPREADSHEET },
    });
    expect(fileOf(world, id)?.tabs).toEqual([
      {
        sheetId: 0,
        title: "Lenses",
        rows: [
          ["Lens", "Days", "Rate", "Total"],
          ["85mm", 3, 45, 48],
        ],
      },
      { sheetId: 1001, title: "Returns", rows: [] },
    ]);
  });

  it("answers a spreadsheet Drive made even when adding its tabs fails, so the crew does not make a second", async () => {
    const world = await signedIn();
    world.google.knobs.off.add("sheets");
    const made = await approved(world, "create_spreadsheet", {
      title: "Lens rental",
      tabs: ["Lenses"],
    });
    const id = String(made.id);
    expect(fileOf(world, id)?.mimeType).toBe(SPREADSHEET);
    expect(made).toMatchObject({ id, name: "Lens rental" });
    expect(String(made.incomplete)).toMatch(
      /^The spreadsheet was made, but its tabs and rows were not all added: .*update_cells and append_rows can add them\.$/,
    );
  });

  it("sets cells as typed by default, and keeps them exactly when asked", async () => {
    const world = await signedIn();
    expect(
      await approved(world, "update_cells", {
        id: "1ShEeTbUdGeT",
        range: "Costs!B3:C3",
        rows: [["210", "TRUE"]],
      }),
    ).toEqual({
      id: "1ShEeTbUdGeT",
      range: "Costs!B3:C3",
      cells: 2,
      link: "https://docs.google.com/spreadsheets/d/1ShEeTbUdGeT/edit",
    });
    expect(world.google.calls("sheets").at(-1)?.tool).toBe("update_formulas");
    expect(fileOf(world, "1ShEeTbUdGeT")?.tabs?.[0]?.rows[2]).toEqual(["Permits", 210, true]);

    await approved(world, "update_cells", {
      id: "1ShEeTbUdGeT",
      range: "Costs!A4:B4",
      rows: [["=1+1", "0012"]],
      entered: "exact",
    });
    expect(world.google.calls("sheets").at(-1)?.tool).toBe("update_values");
    expect(fileOf(world, "1ShEeTbUdGeT")?.tabs?.[0]?.rows[3]).toEqual(["=1+1", "0012"]);
  });

  it("adds rows after a tab's last filled row, quoting a tab name with a space", async () => {
    const world = await signedIn();
    expect(
      await approved(world, "append_rows", {
        id: "1ShEeTbUdGeT",
        tab: "Crew rates",
        rows: [
          ["Lena", 650],
          ["Marco", 500],
        ],
      }),
    ).toEqual({
      id: "1ShEeTbUdGeT",
      range: "'Crew rates'!A2:B3",
      rows: 2,
      link: "https://docs.google.com/spreadsheets/d/1ShEeTbUdGeT/edit",
    });
    expect(world.google.calls("sheets").at(-1)).toMatchObject({
      tool: "append_values",
      args: { spreadsheetId: "1ShEeTbUdGeT", range: "'Crew rates'" },
    });
    expect(fileOf(world, "1ShEeTbUdGeT")?.tabs?.[1]?.rows).toEqual([
      ["Name", "Day rate"],
      ["Lena", 650],
      ["Marco", 500],
    ]);
  });

  it("refuses append_rows naming both a tab and a range, or neither, sending nothing", async () => {
    const world = await signedIn();
    const before = world.google.seen.length;
    for (const input of [
      { id: "1ShEeTbUdGeT", tab: "Costs", range: "Costs!A1", rows: [["Gaffer tape", 12]] },
      { id: "1ShEeTbUdGeT", rows: [["Gaffer tape", 12]] },
    ])
      expect(await call(world, "append_rows", input)).toMatchObject({ refused: "invalid" });
    expect(world.google.seen).toHaveLength(before);
    expect(world.tasks.get("task-1")?.delivery?.writeAsks ?? []).toEqual([]);
  });
});

describe("Checking Docs and Sheets on the row", () => {
  it("finds Docs and Sheets off on Check now without reading a file, and clears them once they answer", async () => {
    const world = await signedIn();
    const row = () => world.integrations.view().integrations[0];
    world.google.knobs.off.add("docs");
    world.google.knobs.off.add("sheets");
    await world.integrations.check("google");
    expect(row()?.client?.mcp).toEqual({
      refused: "service",
      off: ["docs", "sheets"],
      link: `https://console.cloud.google.com/flows/enableapi?apiid=docsmcp.googleapis.com,sheetsmcp.googleapis.com&project=${STAND_IN_PROJECT}`,
    });

    world.google.knobs.off.clear();
    await world.integrations.check("google");
    expect(row()?.client).not.toHaveProperty("mcp");
    // The probe names no file of the captain's: Google answers "not found" for its id.
    // Three probes ran: the sign-in's and each Check now.
    expect(world.google.calls("docs").map((entry) => entry.args)).toEqual(
      Array(3).fill({ documentId: "infinitary-probe" }),
    );
    expect(world.google.calls("sheets").map((entry) => entry.args)).toEqual(
      Array(3).fill({ spreadsheetId: "infinitary-probe", fields: ["spreadsheetId"] }),
    );
  });
});

describe("Docs and Sheets at Asks you", () => {
  it("lets Allow for the rest of this task cover one spreadsheet, and asks again for another", async () => {
    const world = await signedIn();
    const other: StandInDriveFile = {
      ...budget(),
      id: "1ShEeTnOvEmBeR",
      title: "November budget",
    };
    world.google.files.set(other.id, other);
    await approved(
      world,
      "append_rows",
      { id: "1ShEeTbUdGeT", tab: "Costs", rows: [["Catering", 260, false]] },
      "task",
    );

    const asks = () => world.tasks.get("task-1")?.delivery?.writeAsks ?? [];
    const before = asks().length;
    const again = await call(world, "append_rows", {
      id: "1ShEeTbUdGeT",
      tab: "Costs",
      rows: [["Van", 140, false]],
    });
    expect(again.refused).toBeUndefined();
    expect(parsed(again.text)).toMatchObject({ range: "Costs!A5:C5" });
    expect(asks()).toHaveLength(before);

    const elsewhere = await call(world, "append_rows", {
      id: other.id,
      tab: "Costs",
      rows: [["Van", 140, false]],
    });
    expect(elsewhere.refused).toBe("refused");
    expect(asks()).toHaveLength(before + 1);
    // The allowance is the action's: another change to the same spreadsheet still asks.
    expect(
      (
        await call(world, "update_cells", {
          id: "1ShEeTbUdGeT",
          range: "Costs!B2",
          rows: [[400]],
        })
      ).refused,
    ).toBe("refused");
  });

  // The captain's answer 2a on INF-6447: "Keep Gmail and Calendar; Drive waits for a new sign-in".
  it("refuses every Docs and Sheets action before any card when the sign-in left Drive out", async () => {
    const world = await signedIn(GOOGLE_SCOPES.filter((scope) => scope !== DRIVE));
    world.integrations.setRule("google", "read_sheet", false);
    for (const [action, input] of [
      ["create_document", { title: "Call sheet", text: "Roof at 6am" }],
      ["append_to_document", { id: SHOT_LIST.id, text: "\nWrap." }],
      ["replace_in_document", { id: SHOT_LIST.id, find: "Lena", replace: "Marco" }],
      ["read_sheet", { id: "1ShEeTbUdGeT" }],
      ["create_spreadsheet", { title: "Lens rental" }],
      ["update_cells", { id: "1ShEeTbUdGeT", range: "Costs!B2", rows: [[400]] }],
      ["append_rows", { id: "1ShEeTbUdGeT", tab: "Costs", rows: [["Van", 140]] }],
    ] as const)
      expect(await call(world, action, input)).toEqual({
        text: "Not run: Drive, Docs and Sheets were not added to the captain's Google sign-in, so nothing reached Google. The captain chooses Sign in again on the Google row in Settings -> Integrations and leaves the Drive box ticked; Gmail and Calendar keep working meanwhile.",
        refused: "refused",
      });
    expect(world.tasks.get("task-1")?.delivery?.writeAsks ?? []).toEqual([]);
    for (const service of ["drive", "docs", "sheets"] as const)
      expect(world.google.calls(service)).toEqual([]);
  });
});
