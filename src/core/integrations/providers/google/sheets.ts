import { servedNumber } from "@shared/i18n/format";
import { z } from "zod";
import type { IntegrationActionSpec, IntegrationAnswer } from "../../binding";
import { googleFileScope, newGoogleFileScope } from "../../scopes";
import { answer, DRIVE_READ_CHARS, fileIdSchema } from "./drive";
import type { GoogleTool } from "./mcp";

/**
 * Sheets on the Google row (docs/integrations.md, "Google"; INF-6447 piece
 * 2): read a spreadsheet's tabs or a range, make a spreadsheet, set cells
 * and add rows. A new spreadsheet is made by Drive's MCP server; everything
 * else goes through Sheets' MCP server. Every change waits for the
 * captain's approval; no action deletes, clears, moves or shares.
 */

/** The most rows one change writes, and cells in a row: a few thousand rows of a working tracker. */
const MOST_ROWS = 5_000;
const MOST_CELLS_A_ROW = 200;
/** The most tabs a new spreadsheet is made with. */
const MOST_TABS = 20;

// i18n-exempt: served to the crew, which stays English
const oneLine = (most: number) =>
  z
    .string()
    .min(1)
    .max(most)
    .regex(/^[^\r\n]*$/, "one line, with no line breaks");
/** A range in A1 notation, a tab's name in it when it is not the first tab: `Budget!A1:C20`. */
const rangeSchema = oneLine(256);
const tabSchema = oneLine(100);
const cell = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()]);
const rowsSchema = z.array(z.array(cell).max(MOST_CELLS_A_ROW)).min(1).max(MOST_ROWS);
type Rows = z.infer<typeof rowsSchema>;

export const SHEETS_ACTIONS: readonly IntegrationActionSpec[] = [
  {
    name: "read_sheet",
    label: "Read a Google Sheet",
    effect: "reads",
    // i18n-exempt: served to the crew, which stays English
    description: `Read a Google Sheet by its id. Without range, the answer lists its tabs, each with its rows and columns. With range in A1 notation (Budget!A1:D40; the first tab when no tab is named), it answers the cells' values as the sheet shows them, row by row, with empty trailing cells left out, cut after ${servedNumber(DRIVE_READ_CHARS)} characters, when cut says so.`,
    input: z.strictObject({ id: fileIdSchema, range: rangeSchema.optional() }),
  },
  {
    name: "create_spreadsheet",
    label: "Create a Google Sheet",
    effect: "changes",
    scope: newGoogleFileScope("spreadsheet"),
    // i18n-exempt: served to the crew, which stays English
    description: `Create a Google Sheet named title, at the top of My Drive or in folder, a folder's id from search_files. tabs names its tabs in order (one tab when omitted). rows fill the first tab from A1, entered as if typed, so numbers, dates and formulas starting with = are read as such; each cell is text, a number, true or false, or null to leave it empty. The answer names the new sheet's id and link. Its approval state controls whether the host asks.`,
    input: z
      .strictObject({
        title: z.string().min(1).max(256),
        tabs: z.array(tabSchema).min(1).max(MOST_TABS).optional(),
        rows: rowsSchema.optional(),
        folder: fileIdSchema.optional(),
      })
      .refine(
        (v) => !v.tabs || new Set(v.tabs.map((tab) => tab.toLowerCase())).size === v.tabs.length,
        // i18n-exempt: served to the crew, which stays English
        { message: "each tab needs its own name" },
      ),
  },
  {
    name: "update_cells",
    label: "Update cells in a Google Sheet",
    effect: "changes",
    scope: googleFileScope("spreadsheet"),
    // i18n-exempt: served to the crew, which stays English
    description:
      "Set the cells of a range in a Google Sheet by its id: range in A1 notation (Budget!B2:D4) and rows of values from its top left cell. entered is typed when omitted, which reads each value as if typed, so numbers, dates and formulas starting with = become such; exact keeps each value as given, so =1+1 and 0012 stay text. A cell is text, a number, true or false, or null to leave it as it is. The answer names the range changed and how many cells. Its approval state controls whether the host asks, for each spreadsheet.",
    input: z.strictObject({
      id: fileIdSchema,
      range: rangeSchema,
      rows: rowsSchema,
      entered: z.enum(["typed", "exact"]).optional(),
    }),
  },
  {
    name: "append_rows",
    label: "Add rows to a Google Sheet",
    effect: "changes",
    scope: googleFileScope("spreadsheet"),
    // i18n-exempt: served to the crew, which stays English
    description:
      "Add rows to a Google Sheet by its id, right after the last filled row of the table found in tab (a tab's name) or range (A1 notation); name one. Nothing already there is overwritten. Each value is entered as if typed, so numbers, dates and formulas starting with = are read as such; update_cells with entered exact sets text such as 0012 after. A cell is text, a number, true or false, or null to leave it empty. The answer names the range the rows went into. Its approval state controls whether the host asks, for each spreadsheet.",
    input: z
      .strictObject({
        id: fileIdSchema,
        tab: tabSchema.optional(),
        range: rangeSchema.optional(),
        rows: rowsSchema,
      })
      .refine((v) => (v.tab === undefined) !== (v.range === undefined), {
        // i18n-exempt: served to the crew, which stays English
        message: "name exactly one of tab or range",
      }),
  },
];

/** A sheet's link, as Google's own editor opens it. */
const sheetLink = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** A tab's name as A1 notation reads it: in single quotes, a quote in it doubled. */
export function quotedTab(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

/** What Sheets' MCP server wraps its Sheets API answer in. */
const contentOf = (body: Record<string, unknown>) =>
  (body.content && typeof body.content === "object" ? body.content : {}) as Record<string, unknown>;

/**
 * Set a range's cells. Both of Google's Sheets MCP setters take no input
 * option and enter every value as a person types it (a live call turned
 * `0012` into 12 and `=1+1` into 2 through `update_values` too), so exact
 * entry gives each text cell Sheets' leading `'`, which keeps the rest as
 * text and is not shown. An empty text cell stays empty, since `'` alone
 * would enter nothing either.
 */
async function setCells(
  sheets: GoogleTool,
  id: string,
  range: string,
  rows: Rows,
  entered: "typed" | "exact",
): Promise<Record<string, unknown>> {
  const formulas =
    entered === "typed"
      ? rows
      : rows.map((row) =>
          row.map((cell) => (typeof cell === "string" && cell !== "" ? `'${cell}` : cell)),
        );
  return sheets("update_formulas", { spreadsheetId: id, range, formulas }, true);
}

/** The rows that fit in the answer's characters, and whether any were left out. */
function fitting(values: unknown[][]): { values: unknown[][]; cut: boolean } {
  let used = 0;
  for (let at = 0; at < values.length; at += 1) {
    used += JSON.stringify(values[at]).length + 1;
    if (used > DRIVE_READ_CHARS) return { values: values.slice(0, at), cut: true };
  }
  return { values, cut: false };
}

/** Run one Sheets action whose input already passed its schema. */
export async function runSheetsAction(
  drive: GoogleTool,
  sheets: GoogleTool,
  action: string,
  input: unknown,
): Promise<IntegrationAnswer> {
  switch (action) {
    case "read_sheet": {
      const { id, range } = input as { id: string; range?: string };
      if (range !== undefined) {
        const body = await sheets("get_values", { spreadsheetId: id, range });
        const values = Array.isArray(body.values) ? (body.values as unknown[][]) : [];
        const kept = fitting(values);
        return answer({
          id,
          range: typeof body.range === "string" ? body.range : range,
          values: kept.values,
          ...(kept.cut ? { cut: true, rows: values.length } : {}),
        });
      }
      const sheet = contentOf(
        await sheets("get_spreadsheet", {
          spreadsheetId: id,
          fields: [
            "properties.title",
            "sheets.properties.title",
            "sheets.properties.gridProperties",
          ],
        }),
      );
      const tabs = (Array.isArray(sheet.sheets) ? sheet.sheets : []) as {
        properties?: {
          title?: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
      const title = (sheet.properties as { title?: unknown } | undefined)?.title;
      return answer({
        id,
        ...(typeof title === "string" ? { name: title } : {}),
        link: sheetLink(id),
        tabs: tabs.map((tab) => ({
          name: tab.properties?.title,
          rows: tab.properties?.gridProperties?.rowCount ?? 0,
          columns: tab.properties?.gridProperties?.columnCount ?? 0,
        })),
      });
    }
    case "create_spreadsheet": {
      const v = input as { title: string; tabs?: string[]; rows?: Rows; folder?: string };
      const made = await drive(
        "create_file",
        {
          title: v.title,
          contentMimeType: "application/vnd.google-apps.spreadsheet",
          ...(v.folder ? { parentId: v.folder } : {}),
        },
        true,
      );
      const id = typeof made.id === "string" ? made.id : undefined;
      if (!id) throw new Error("Google Drive made the spreadsheet but named no id for it.");
      const named = {
        id,
        name: typeof made.title === "string" ? made.title : v.title,
        link: typeof made.viewUrl === "string" ? made.viewUrl : sheetLink(id),
        ...(v.folder ? { folder: v.folder } : {}),
      };
      // The sheet now exists: a later step that fails, or that Google stops to
      // ask about, is answered beside it, since asking again would make a second sheet.
      try {
        if (v.tabs) {
          const first = contentOf(
            await sheets("get_spreadsheet", {
              spreadsheetId: id,
              fields: ["sheets.properties.sheetId"],
            }),
          );
          const sheetId =
            (first.sheets as { properties?: { sheetId?: number } }[] | undefined)?.[0]?.properties
              ?.sheetId ?? 0;
          const [rename, ...more] = v.tabs;
          await sheets(
            "update_spreadsheet",
            {
              spreadsheetId: id,
              requests: [
                {
                  updateSheetProperties: {
                    properties: { sheetId, title: rename },
                    fields: "title",
                  },
                },
                ...more.map((title) => ({ addSheet: { properties: { title } } })),
              ],
            },
            true,
          );
        }
        if (v.rows) {
          const tab = v.tabs?.[0];
          await setCells(sheets, id, tab ? `${quotedTab(tab)}!A1` : "A1", v.rows, "typed");
        }
      } catch (error) {
        return answer({
          ...named,
          // i18n-exempt: words served to the crew, which stay English
          incomplete: `The spreadsheet was made, but its tabs and rows were not all added: ${error instanceof Error ? error.message : String(error)} update_cells and append_rows can fill the tabs it has; a missing tab is added in Google Sheets.`,
        });
      }
      return answer({
        ...named,
        ...(v.tabs ? { tabs: v.tabs } : {}),
        ...(v.rows ? { rows: v.rows.length } : {}),
      });
    }
    case "update_cells": {
      const v = input as { id: string; range: string; rows: Rows; entered?: "typed" | "exact" };
      const done = contentOf(await setCells(sheets, v.id, v.range, v.rows, v.entered ?? "typed"));
      return answer({
        id: v.id,
        ...(typeof done.updatedRange === "string" ? { range: done.updatedRange } : {}),
        ...(typeof done.updatedCells === "number" ? { cells: done.updatedCells } : {}),
        link: sheetLink(v.id),
      });
    }
    case "append_rows": {
      const v = input as { id: string; tab?: string; range?: string; rows: Rows };
      const done = contentOf(
        await sheets(
          "append_values",
          {
            spreadsheetId: v.id,
            range: v.range ?? quotedTab(v.tab ?? ""),
            values: v.rows,
          },
          true,
        ),
      );
      const updates = (done.updates ?? {}) as { updatedRange?: unknown; updatedRows?: unknown };
      return answer({
        id: v.id,
        ...(typeof updates.updatedRange === "string" ? { range: updates.updatedRange } : {}),
        rows: typeof updates.updatedRows === "number" ? updates.updatedRows : v.rows.length,
        link: sheetLink(v.id),
      });
    }
    default:
      throw new Error(`Sheets has no action ${action}.`);
  }
}
