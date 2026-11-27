/**
 * Google's Drive MCP server, as the Google stand-in serves it
 * (`googleStandIn.ts`): the four read tools the Google row calls, by
 * Google's own name, input fields and answer shapes, as `tools/list` on
 * drivemcp.googleapis.com gave them (their `inputSchema` and
 * `outputSchema`), over the SDK's 2026-07-28 server. Every answer carries
 * `structuredContent`, as Google's do.
 *
 * Only what Google's list and descriptions state is modelled: search takes
 * Drive's query words joined by `and` (`title contains`, `fullText
 * contains`, `'<id>' in ancestors`, `mimeType =`, `mimeType contains`,
 * `trashed =`), with a value in single quotes whose quote and backslash are
 * escaped by a backslash; a file's size is a string of bytes; a Google
 * Doc, Sheet or Slides deck downloads only as an export, and its content
 * comes base64-encoded. Each tool answers a key granted none of Drive's
 * permissions Google's insufficient-scopes refusal.
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** One file in the stand-in's Drive. */
export type StandInDriveFile = {
  id: string;
  title: string;
  mimeType: string;
  owner: string;
  modifiedTime: string;
  /** The folder it sits in; absent, the top of My Drive. */
  parentId?: string;
  trashed?: boolean;
  /** The text Drive reads from it; absent, Drive reads none (an image, a zip). */
  text?: string;
  /** Its bytes, for a file that is not one of Google's own types. */
  bytes?: Buffer;
};

export type DriveWorld = {
  files: Map<string, StandInDriveFile>;
  /** The permissions the request's key was granted. */
  granted: () => string[];
};

/** What Google's own types export as, by Drive's export type: the stand-in's bytes for each. */
const EXPORTED: Record<string, (file: StandInDriveFile) => Buffer> = {
  "application/pdf": (file) =>
    Buffer.from(`%PDF-1.7\n% ${file.title}\n${file.text ?? ""}\n%%EOF\n`),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (file) =>
    Buffer.from(`PK\u0003\u0004word/document.xml ${file.text ?? ""}`),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (file) =>
    Buffer.from(`PK\u0003\u0004xl/workbook.xml ${file.text ?? ""}`),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": (file) =>
    Buffer.from(`PK\u0003\u0004ppt/presentation.xml ${file.text ?? ""}`),
};

/** Which exports each of Google's own types takes, as Drive's export list names them. */
const EXPORTS_OF: Record<string, string[]> = {
  "application/vnd.google-apps.document": [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  "application/vnd.google-apps.spreadsheet": [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  "application/vnd.google-apps.presentation": [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
};

const ANSWER = z.looseObject({});
const FILES_A_PAGE = 100;

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
const refused = (words: string): CallToolResult => ({
  content: [{ type: "text", text: words }],
  isError: true,
});

const sizeOf = (file: StandInDriveFile) =>
  file.bytes
    ? String(file.bytes.length)
    : file.mimeType.startsWith("application/vnd.google-apps.")
      ? undefined
      : "0";

function described(file: StandInDriveFile) {
  const size = sizeOf(file);
  return {
    id: file.id,
    title: file.title,
    mimeType: file.mimeType,
    owner: file.owner,
    modifiedTime: file.modifiedTime,
    ...(size !== undefined ? { fileSize: size } : {}),
    viewUrl: `https://drive.google.com/file/d/${file.id}/view`,
    ...(file.parentId ? { parentId: file.parentId } : {}),
  };
}

/** One quoted value of Drive's query words, with its escapes undone. */
const QUOTED = String.raw`'((?:[^'\\]|\\.)*)'`;
const unquote = (value: string) => value.replace(/\\(.)/g, "$1");

/** Drive's query words split at each `and` outside a quoted value. */
function clausesOf(query: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let quoted = false;
  for (let at = 0; at < query.length; at += 1) {
    const char = query[at] ?? "";
    if (quoted && char === "\\") {
      current += char + (query[at + 1] ?? "");
      at += 1;
      continue;
    }
    if (char === "'") quoted = !quoted;
    if (!quoted && query.startsWith(" and ", at)) {
      clauses.push(current);
      current = "";
      at += 4;
      continue;
    }
    current += char;
  }
  return [...clauses, current];
}

/** Whether a file matches Drive's query words; throws Google's words for a clause it does not take. */
function matches(
  file: StandInDriveFile,
  query: string,
  files: Map<string, StandInDriveFile>,
): boolean {
  return clausesOf(query).every((raw) => {
    const clause = raw.trim();
    let found = new RegExp(String.raw`^title contains ${QUOTED}$`).exec(clause);
    if (found) return file.title.toLowerCase().includes(unquote(found[1] ?? "").toLowerCase());
    found = new RegExp(String.raw`^fullText contains ${QUOTED}$`).exec(clause);
    if (found) {
      const words = unquote(found[1] ?? "").toLowerCase();
      return `${file.title} ${file.text ?? ""}`.toLowerCase().includes(words);
    }
    found = new RegExp(String.raw`^${QUOTED} in ancestors$`).exec(clause);
    if (found) {
      const folder = unquote(found[1] ?? "");
      for (let at = file.parentId; at; at = files.get(at)?.parentId) if (at === folder) return true;
      return false;
    }
    found = new RegExp(String.raw`^mimeType = ${QUOTED}$`).exec(clause);
    if (found) return file.mimeType === unquote(found[1] ?? "");
    found = new RegExp(String.raw`^mimeType contains ${QUOTED}$`).exec(clause);
    if (found) return file.mimeType.includes(unquote(found[1] ?? ""));
    found = /^trashed = (true|false)$/.exec(clause);
    if (found) return (file.trashed === true) === (found[1] === "true");
    throw new Error(`Invalid Value: ${clause}`);
  });
}

/** Drive's MCP server, one per request, over the stand-in's files. */
export function driveMcpServer(world: DriveWorld): McpServer {
  const server = new McpServer({ name: "drivemcp", version: "ESF" });
  const scoped = (): CallToolResult | undefined =>
    world
      .granted()
      .some((scope) =>
        ["drive", "drive.readonly"].some(
          (name) => scope === `https://www.googleapis.com/auth/${name}`,
        ),
      )
      ? undefined
      : refused("Request had insufficient authentication scopes.");
  const find = (id: string) => world.files.get(id);
  server.registerTool(
    "search_files",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        query: z.string().optional(),
        pageSize: z.number().int().min(1).max(FILES_A_PAGE).optional(),
        pageToken: z.string().optional(),
        excludeContentSnippets: z.boolean().optional(),
        orderBy: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, pageSize, pageToken }) => {
      const scope = scoped();
      if (scope) return scope;
      let listed: StandInDriveFile[];
      try {
        listed = [...world.files.values()].filter((file) =>
          query ? matches(file, query, world.files) : !file.trashed,
        );
      } catch (error) {
        return refused((error as Error).message);
      }
      const offset = Number(pageToken ?? 0);
      const size = pageSize ?? FILES_A_PAGE;
      return text({
        files: listed.slice(offset, offset + size).map(described),
        ...(offset + size < listed.length ? { nextPageToken: String(offset + size) } : {}),
      });
    },
  );
  server.registerTool(
    "get_file_metadata",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        fileId: z.string(),
        excludeContentSnippets: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      const scope = scoped();
      if (scope) return scope;
      const file = find(fileId);
      return file ? text(described(file)) : refused(`File not found: ${fileId}.`);
    },
  );
  server.registerTool(
    "read_file_content",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({ fileId: z.string(), includeComments: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      const scope = scoped();
      if (scope) return scope;
      const file = find(fileId);
      if (!file) return refused(`File not found: ${fileId}.`);
      const view = { title: file.title, viewUrl: described(file).viewUrl };
      return text(
        file.text === undefined
          ? { ...view, textFormattingNotSupported: true }
          : { ...view, fileContent: file.text },
      );
    },
  );
  server.registerTool(
    "download_file_content",
    {
      outputSchema: ANSWER,
      inputSchema: z.strictObject({
        fileId: z.string(),
        exportMimeType: z.string().optional(),
        revisionId: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId, exportMimeType }) => {
      const scope = scoped();
      if (scope) return scope;
      const file = find(fileId);
      if (!file) return refused(`File not found: ${fileId}.`);
      const exports = EXPORTS_OF[file.mimeType];
      if (exports) {
        const exporting = exportMimeType ? EXPORTED[exportMimeType] : undefined;
        if (!exportMimeType || !exports.includes(exportMimeType) || !exporting)
          return refused(
            `Only files with binary content can be downloaded. Use Export with Docs Editors files.`,
          );
        return text({
          id: file.id,
          title: file.title,
          mimeType: exportMimeType,
          content: exporting(file).toString("base64"),
        });
      }
      if (exportMimeType) return refused(`Export only supports Docs Editors files.`);
      return text({
        id: file.id,
        title: file.title,
        mimeType: file.mimeType,
        content: (file.bytes ?? Buffer.alloc(0)).toString("base64"),
      });
    },
  );
  return server;
}
