/**
 * Google's Docs and Sheets MCP servers, as the Google stand-in serves them
 * (`googleStandIn.ts`), over the same files as its Drive server
 * (`driveMcpStandIn.ts`): the tools the Google row calls, by Google's own
 * name and input fields as `tools/list` on docsmcp.googleapis.com and
 * sheetsmcp.googleapis.com gave them, over the SDK's 2026-07-28 server.
 *
 * Only what Google's lists and descriptions state is modelled, and what
 * they leave open is assumed here, for only a call to Google's own servers
 * proves it:
 * - update_doc applies `insertText` at the end of the body and
 *   `replaceAllText`, and answers `replies` holding each request's Docs API
 *   answer; a count of zero is left out, as Google's JSON leaves out zeros.
 *   Its list says those replies include errors: an edit to a doc shared to
 *   view only answers one there, `{ error: { message } }`, changing nothing.
 * - Sheets answers its Sheets API resource under `content`, except
 *   get_values, whose `range` and `values` stand at the top, as its list
 *   says. Values come back as shown: every cell as text.
 * - update_formulas reads values as a person types them (a number, `TRUE`,
 *   and a sum of numbers after `=` are worked out), update_values keeps
 *   them exactly, and append_values enters them as typed, which its list
 *   leaves open.
 * A Doc's text is its file's `text`; a Sheet's cells are its file's `tabs`.
 * Each tool answers a key granted none of Drive's, Docs' or Sheets'
 * permissions Google's insufficient-scopes refusal.
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { StandInDriveFile, StandInTab } from "./driveMcpStandIn";

export type DocsSheetsWorld = {
  files: Map<string, StandInDriveFile>;
  /** The permissions the request's key was granted. */
  granted: () => string[];
};

type Cell = string | number | boolean | null;

const ANSWER = z.looseObject({});
const VALUES = z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])));

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
const refused = (words: string): CallToolResult => ({
  content: [{ type: "text", text: words }],
  isError: true,
});

function scopedTo(world: DocsSheetsWorld, own: string): CallToolResult | undefined {
  return world
    .granted()
    .some((scope) =>
      ["drive", own].some((name) => scope === `https://www.googleapis.com/auth/${name}`),
    )
    ? undefined
    : refused("Request had insufficient authentication scopes.");
}

/** A column's letters as its number from 0: A is 0, AA is 26. */
function columnOf(letters: string): number {
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

function lettersOf(column: number): string {
  let letters = "";
  for (let at = column + 1; at > 0; at = Math.floor((at - 1) / 26))
    letters = String.fromCharCode(65 + ((at - 1) % 26)) + letters;
  return letters;
}

/** A tab's name as A1 notation writes it: quoted when it holds more than letters and digits. */
const named = (tab: string) =>
  /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replaceAll("'", "''")}'`;

type Range = { tab: StandInTab; top: number; left: number; bottom?: number; right?: number };

/** A1 notation over a sheet's tabs: `Tab!A1:C3`, `'Tab name'!B2`, `A1:B2` or a tab alone. */
function rangeOf(file: StandInDriveFile, a1: string): Range | undefined {
  const tabs = file.tabs ?? [];
  // A tab's name alone, quoted or not, is the whole tab.
  const whole = /^'((?:[^']|'')*)'$/.exec(a1)?.[1]?.replaceAll("''", "'") ?? a1;
  const alone = tabs.find((each) => each.title === whole);
  if (alone) return { tab: alone, top: 0, left: 0 };
  const found = /^(?:(?:'((?:[^']|'')*)'|([^!']+))!)?([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(
    a1,
  );
  const [, quotedName, plainName, fromColumn, fromRow, toColumn, toRow] = found ?? [];
  if (!fromColumn || !fromRow) return undefined;
  const name = quotedName?.replaceAll("''", "'") ?? plainName;
  const tab = name === undefined ? tabs[0] : tabs.find((each) => each.title === name);
  if (!tab) return undefined;
  return {
    tab,
    top: Number(fromRow) - 1,
    left: columnOf(fromColumn),
    ...(toColumn && toRow ? { bottom: Number(toRow) - 1, right: columnOf(toColumn) } : {}),
  };
}

const a1Of = (tab: StandInTab, top: number, left: number, bottom: number, right: number) =>
  `${named(tab.title)}!${lettersOf(left)}${top + 1}:${lettersOf(right)}${bottom + 1}`;

/** A value as a person typing it into Sheets would leave it. */
function typed(value: Cell): Cell {
  if (typeof value !== "string") return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  const sum = /^=\s*(-?\d+(?:\.\d+)?)\s*\+\s*(-?\d+(?:\.\d+)?)$/.exec(value);
  if (sum) return Number(sum[1]) + Number(sum[2]);
  return value;
}

/** Write rows into a tab from a cell; null leaves a cell as it is. Answers the range written. */
function write(
  tab: StandInTab,
  top: number,
  left: number,
  rows: Cell[][],
  read: (cell: Cell) => Cell,
) {
  let right = left;
  rows.forEach((row, down) => {
    const line = tab.rows[top + down] ?? [];
    while (tab.rows.length <= top + down) tab.rows.push([]);
    row.forEach((cell, across) => {
      if (cell === null) return;
      while (line.length < left + across) line.push(null);
      line[left + across] = read(cell);
    });
    tab.rows[top + down] = line;
    right = Math.max(right, left + row.length - 1);
  });
  return { bottom: top + rows.length - 1, right };
}

const shown = (cell: Cell | undefined) =>
  cell === null || cell === undefined
    ? ""
    : typeof cell === "boolean"
      ? String(cell).toUpperCase()
      : String(cell);

/** Google Docs' MCP server, one per request. */
export function docsMcpServer(world: DocsSheetsWorld): McpServer {
  const server = new McpServer({ name: "docsmcp", version: "ESF" });
  const docOf = (id: string) => {
    const file = world.files.get(id);
    return file?.mimeType === "application/vnd.google-apps.document" ? file : undefined;
  };
  server.registerTool(
    "read_doc",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        documentId: z.string(),
        commentsIncluded: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ documentId }) => {
      const scope = scopedTo(world, "documents");
      if (scope) return scope;
      const doc = docOf(documentId);
      return doc
        ? text({ content: { title: doc.title, body: doc.text ?? "" } })
        : refused(`Requested entity was not found.`);
    },
  );
  server.registerTool(
    "update_doc",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        documentId: z.string(),
        requests: z.array(z.looseObject({})).optional(),
        writeControl: z.looseObject({}).optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ documentId, requests }) => {
      const scope = scopedTo(world, "documents");
      if (scope) return scope;
      const doc = docOf(documentId);
      if (!doc) return refused(`Requested entity was not found.`);
      if (doc.viewOnly)
        return text({
          replies: [{ error: { message: "The caller does not have permission" } }],
        });
      let body = doc.text ?? "";
      const replies: Record<string, unknown>[] = [];
      for (const request of requests ?? []) {
        const insert = request.insertText as
          | { text?: string; endOfSegmentLocation?: object }
          | undefined;
        const replace = request.replaceAllText as
          | { containsText?: { text?: string; matchCase?: boolean }; replaceText?: string }
          | undefined;
        if (insert?.endOfSegmentLocation && typeof insert.text === "string") {
          body += insert.text;
          replies.push({});
        } else if (replace?.containsText?.text) {
          const find = replace.containsText.text;
          const flags = replace.containsText.matchCase ? "g" : "gi";
          const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
          const count = body.match(pattern)?.length ?? 0;
          body = body.replace(pattern, () => replace.replaceText ?? "");
          replies.push({ replaceAllText: count > 0 ? { occurrencesChanged: count } : {} });
        } else
          return refused(
            `Invalid requests[${replies.length}]: the stand-in takes only insertText at the end and replaceAllText.`,
          );
      }
      doc.text = body;
      doc.modifiedTime = new Date().toISOString();
      return text({ replies, writeControl: { requiredRevisionId: `rev-${body.length}` } });
    },
  );
  return server;
}

/** Google Sheets' MCP server, one per request. */
export function sheetsMcpServer(world: DocsSheetsWorld): McpServer {
  const server = new McpServer({ name: "sheetsmcp", version: "ESF" });
  const sheetOf = (id: string) => {
    const file = world.files.get(id);
    return file?.mimeType === "application/vnd.google-apps.spreadsheet" ? file : undefined;
  };
  const guard = (id: string): CallToolResult | StandInDriveFile => {
    const scope = scopedTo(world, "spreadsheets");
    if (scope) return scope;
    return sheetOf(id) ?? refused(`Requested entity was not found.`);
  };
  const isRefusal = (value: CallToolResult | StandInDriveFile): value is CallToolResult =>
    "content" in value && Array.isArray(value.content);
  server.registerTool(
    "get_spreadsheet",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        spreadsheetId: z.string(),
        includeGridData: z.boolean().optional(),
        fields: z.array(z.string()).optional(),
        ranges: z.array(z.string()).optional(),
        commentsIncluded: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ spreadsheetId }) => {
      const file = guard(spreadsheetId);
      if (isRefusal(file)) return file;
      return text({
        content: {
          spreadsheetId,
          properties: { title: file.title },
          sheets: (file.tabs ?? []).map((tab) => ({
            properties: {
              sheetId: tab.sheetId,
              title: tab.title,
              gridProperties: {
                rowCount: Math.max(1000, tab.rows.length),
                columnCount: Math.max(26, ...tab.rows.map((row) => row.length)),
              },
            },
          })),
        },
      });
    },
  );
  server.registerTool(
    "get_values",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({ spreadsheetId: z.string(), range: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ spreadsheetId, range }) => {
      const file = guard(spreadsheetId);
      if (isRefusal(file)) return file;
      const at = rangeOf(file, range);
      if (!at) return refused(`Unable to parse range: ${range}`);
      const bottom = at.bottom ?? Math.max(at.top, at.tab.rows.length - 1);
      const right = at.right ?? Math.max(at.left, ...at.tab.rows.map((row) => row.length - 1));
      const values = at.tab.rows.slice(at.top, bottom + 1).map((row) => {
        const cells = row.slice(at.left, right + 1).map(shown);
        while (cells.length > 0 && cells.at(-1) === "") cells.pop();
        return cells;
      });
      while (values.length > 0 && values.at(-1)?.length === 0) values.pop();
      return text({ range: a1Of(at.tab, at.top, at.left, bottom, right), values });
    },
  );
  const setter = (name: "update_values" | "update_formulas") =>
    server.registerTool(
      name,
      {
        outputSchema: ANSWER,
        inputSchema: z.strictObject({
          spreadsheetId: z.string(),
          range: z.string(),
          ...(name === "update_values" ? { values: VALUES } : { formulas: VALUES }),
        }),
        annotations: { readOnlyHint: false },
      },
      async (input: {
        spreadsheetId: string;
        range: string;
        values?: Cell[][];
        formulas?: Cell[][];
      }) => {
        const file = guard(input.spreadsheetId);
        if (isRefusal(file)) return file;
        const at = rangeOf(file, input.range);
        if (!at) return refused(`Unable to parse range: ${input.range}`);
        const rows = input.values ?? input.formulas ?? [];
        const done = write(
          at.tab,
          at.top,
          at.left,
          rows,
          name === "update_values" ? (cell) => cell : typed,
        );
        return text({
          content: {
            spreadsheetId: input.spreadsheetId,
            updatedRange: a1Of(at.tab, at.top, at.left, done.bottom, done.right),
            updatedRows: rows.length,
            updatedCells: rows.reduce(
              (sum, row) => sum + row.filter((cell) => cell !== null).length,
              0,
            ),
            status: "OK",
          },
        });
      },
    );
  setter("update_values");
  setter("update_formulas");
  server.registerTool(
    "update_spreadsheet",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        spreadsheetId: z.string(),
        requests: z.array(z.looseObject({})),
        writeControl: z.looseObject({}).optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ spreadsheetId, requests }) => {
      const file = guard(spreadsheetId);
      if (isRefusal(file)) return file;
      const tabs = file.tabs ?? [];
      const replies: Record<string, unknown>[] = [];
      for (const request of requests) {
        const rename = request.updateSheetProperties as
          | { properties?: { sheetId?: number; title?: string }; fields?: string }
          | undefined;
        const add = request.addSheet as { properties?: { title?: string } } | undefined;
        if (rename?.fields === "title" && rename.properties?.title) {
          const tab = tabs.find((each) => each.sheetId === rename.properties?.sheetId);
          if (!tab) return refused(`No grid with id: ${rename.properties.sheetId}`);
          tab.title = rename.properties.title;
          replies.push({});
        } else if (add?.properties?.title) {
          if (tabs.some((each) => each.title === add.properties?.title))
            return refused(`A sheet with the name "${add.properties.title}" already exists.`);
          const sheetId = 1000 + tabs.length;
          tabs.push({ sheetId, title: add.properties.title, rows: [] });
          replies.push({ addSheet: { properties: { sheetId, title: add.properties.title } } });
        } else
          return refused(
            `Invalid requests[${replies.length}]: the stand-in takes only a tab's new title and addSheet.`,
          );
      }
      file.tabs = tabs;
      return text({ content: { spreadsheetId, replies, status: "OK" } });
    },
  );
  server.registerTool(
    "append_values",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({ spreadsheetId: z.string(), range: z.string(), values: VALUES }),
      annotations: { readOnlyHint: false },
    },
    async ({ spreadsheetId, range, values }) => {
      const file = guard(spreadsheetId);
      if (isRefusal(file)) return file;
      const at = rangeOf(file, range);
      if (!at) return refused(`Unable to parse range: ${range}`);
      // The table's last filled row, at or below the range's top.
      let last = at.top - 1;
      at.tab.rows.forEach((row, index) => {
        if (index >= at.top && row.some((cell) => cell !== null && cell !== "")) last = index;
      });
      const done = write(at.tab, last + 1, at.left, values, typed);
      return text({
        content: {
          spreadsheetId,
          tableRange: last >= at.top ? a1Of(at.tab, at.top, at.left, last, done.right) : undefined,
          updates: {
            updatedRange: a1Of(at.tab, last + 1, at.left, done.bottom, done.right),
            updatedRows: values.length,
          },
          status: "OK",
        },
      });
    },
  );
  return server;
}
