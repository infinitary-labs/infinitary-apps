/**
 * A stand-in MCP server for the MCP integration's tests (INF-781): a
 * small notes server, served in either protocol era - the 2025 one
 * through the SDK's first version, the 2026-07-28 one through its second -
 * over stdio as a child program, or over Streamable HTTP on this computer.
 *
 * It lists three tools, two read-only and one that changes the notes, and
 * one resource, `notes://all`, whose changes it tells a subscribed client
 * about. Over HTTP the test changes the notes itself; over stdio the child
 * reads its notes from a file, writes a note it adds back to it, and tells
 * when the file changes.
 *
 *   node tests/helpers/mcpStandIn.ts stdio <legacy|modern> <notes.json>
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport as LegacyStdioTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport as LegacyHttpTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  type JSONRPCMessage,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

export type StandInEra = "legacy" | "modern";

/**
 * The notes the server holds, the way a person keeps them. A book that
 * names why it is `unavailable` - its service's own sign-in lapsed - still
 * starts over stdio but refuses to list its tools (INF-3367). A book with a
 * `key` is a service that needs one: a child started without it in
 * `NOTES_KEY_VARIABLE` says so on stderr and stops before it answers.
 */
export type NotesBook = { notes: string[]; unavailable?: string; key?: string };

export const NOTES_KEY_VARIABLE = "NOTES_KEY";

export const NOTES_URI = "notes://all";

export const SAMPLE_NOTES = [
  "Groceries: oat milk, eggs, the good bread from the corner bakery",
  "Call the dentist to move Thursday's cleaning",
  "Mia's birthday is on the 14th - she wanted the blue raincoat",
];

export const NOTES_LIST_TITLE = "List notes";
export const NOTES_ADD_TOOL = "add_note";
export const addedNote = (count: number) => `Added note ${count}.`;

const LIST = { title: NOTES_LIST_TITLE, description: "Lists every note with its number." };
const GET = { title: "Read a note", description: "Reads one note by its number." };
const ADD = { description: "Adds a note to the end of the list." };

function listed(book: NotesBook): string {
  return book.notes.map((note, index) => `${index + 1}. ${note}`).join("\n");
}

function noteOf(book: NotesBook, id: number): string {
  return book.notes[id - 1] ?? `There is no note ${id}.`;
}

function modernNotes(book: NotesBook, added: () => void, notebooks: string[] = []): McpServer {
  const server = new McpServer(
    { name: "notes-stand-in", version: "1.0.0" },
    { capabilities: { resources: { subscribe: true } } },
  );
  server.registerTool(
    "list_notes",
    { ...LIST, inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: listed(book) }] }),
  );
  server.registerTool(
    "getNote",
    {
      ...GET,
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => ({ content: [{ type: "text", text: noteOf(book, id) }] }),
  );
  server.registerTool(
    NOTES_ADD_TOOL,
    { ...ADD, inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => {
      book.notes.push(text);
      added();
      return { content: [{ type: "text", text: addedNote(book.notes.length) }] };
    },
  );
  // INF-1408: a notes workspace can expose one reader per notebook.
  for (const notebook of notebooks)
    server.registerTool(
      notebook,
      {
        description: `Reads the ${notebook} notebook.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: `${notebook}: ${listed(book)}` }] }),
    );
  server.registerResource(
    "notes",
    NOTES_URI,
    { title: "All notes", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: listed(book) }] }),
  );
  return server;
}

function legacyNotes(
  book: NotesBook,
  added: () => void,
  notebooks: string[] = [],
): LegacyMcpServer {
  const server = new LegacyMcpServer(
    { name: "notes-stand-in", version: "1.0.0" },
    { capabilities: { resources: { subscribe: true } } },
  );
  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
  server.registerTool(
    "list_notes",
    { ...LIST, inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: listed(book) }] }),
  );
  server.registerTool(
    "getNote",
    { ...GET, inputSchema: { id: z.number().int() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ({ content: [{ type: "text", text: noteOf(book, id) }] }),
  );
  server.registerTool(
    NOTES_ADD_TOOL,
    { ...ADD, inputSchema: { text: z.string() } },
    async ({ text }) => {
      book.notes.push(text);
      added();
      return { content: [{ type: "text", text: addedNote(book.notes.length) }] };
    },
  );
  // INF-1408: a notes workspace can expose one reader per notebook.
  for (const notebook of notebooks)
    server.registerTool(
      notebook,
      {
        description: `Reads the ${notebook} notebook.`,
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: `${notebook}: ${listed(book)}` }] }),
    );
  server.registerResource(
    "notes",
    NOTES_URI,
    { title: "All notes", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: listed(book) }] }),
  );
  return server;
}

export type NotesHttpServer = {
  url: string;
  book: NotesBook;
  /** Add a note as the person would elsewhere, and tell every subscribed client. */
  addNote: (text: string) => void;
  /** The next add_note is taken, and its connection drops before the server answers. */
  dropNextAdd: () => void;
  close: () => Promise<void>;
};

export async function serveNotesHttp(
  era: StandInEra,
  notebooks: () => string[] = () => [],
): Promise<NotesHttpServer> {
  const book: NotesBook = { notes: [...SAMPLE_NOTES] };
  let tell: () => void;
  let stop: () => Promise<void>;
  let respond: (request: IncomingMessage, reply: ServerResponse, body: unknown) => Promise<void>;
  if (era === "modern") {
    const handler = createMcpHandler(() => modernNotes(book, () => tell(), notebooks()), {
      legacy: "reject",
    });
    tell = () => handler.notify.resourceUpdated(NOTES_URI);
    stop = () => handler.close();
    respond = async (request, reply, body) => {
      const response = await handler.fetch(
        new Request(`http://127.0.0.1${request.url ?? "/"}`, {
          method: request.method,
          headers: Object.entries(request.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
          ) as [string, string][],
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        reply.end();
        return;
      }
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(reply);
    };
  } else {
    const sessions = new Map<string, { transport: LegacyHttpTransport; server: LegacyMcpServer }>();
    tell = () => {
      for (const { server } of sessions.values())
        void server.server.sendResourceUpdated({ uri: NOTES_URI }).catch(() => undefined);
    };
    stop = async () => {
      for (const { transport } of sessions.values()) await transport.close();
    };
    respond = async (request, reply, body) => {
      const id = request.headers["mcp-session-id"];
      let session = typeof id === "string" ? sessions.get(id) : undefined;
      if (!session) {
        if (request.method !== "POST" || !isInitializeRequest(body)) {
          reply.writeHead(400, { "content-type": "application/json" });
          reply.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: No valid session ID provided" },
              id: null,
            }),
          );
          return;
        }
        const server = legacyNotes(book, () => tell(), notebooks());
        const transport: LegacyHttpTransport = new LegacyHttpTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { transport, server });
          },
        });
        session = { transport, server };
        await server.connect(transport);
      }
      await session.transport.handleRequest(request, reply, body);
    };
  }
  let dropAdd = false;
  const http = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : undefined;
      const call = body as {
        method?: string;
        params?: { name?: string; arguments?: { text?: string } };
      };
      if (dropAdd && call?.method === "tools/call" && call.params?.name === NOTES_ADD_TOOL) {
        dropAdd = false;
        book.notes.push(call.params.arguments?.text ?? "");
        request.socket.destroy();
        return;
      }
      void respond(request, reply, body).catch(() => {
        if (!reply.headersSent) reply.writeHead(500);
        reply.end();
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    book,
    addNote: (text) => {
      book.notes.push(text);
      tell();
    },
    dropNextAdd: () => {
      dropAdd = true;
    },
    close: async () => {
      await stop();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/**
 * Publish a notes file whole, for the child below or a test changing its
 * notes: a complete sibling renamed over it in one step. The child polls
 * the file it serves, and a rewrite in place first shows it a truncated
 * file. A reader then sees an empty or half-written book (INF-1573), and
 * the child's watcher, its read late under load, tells one edit as two
 * changes (INF-2782).
 */
export function publishNotes(file: string, book: NotesBook): void {
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify(book));
  renameSync(pending, file);
}

async function serveNotesStdio(era: StandInEra, file: string): Promise<void> {
  const { key } = JSON.parse(readFileSync(file, "utf8")) as NotesBook;
  if (key && process.env[NOTES_KEY_VARIABLE] !== key) {
    process.stderr.write(
      `The notes service refused this server: ${NOTES_KEY_VARIABLE} is not its key.\n`,
    );
    process.exit(1);
  }
  const read = (): string[] => JSON.parse(readFileSync(file, "utf8")).notes;
  const book: NotesBook = { notes: read() };
  const servers: { sendResourceUpdated: (params: { uri: string }) => Promise<void> }[] = [];
  const tell = () => {
    for (const server of servers)
      void server.sendResourceUpdated({ uri: NOTES_URI }).catch(() => undefined);
  };
  watchFile(file, { interval: 50 }, () => {
    book.notes = read();
    tell();
  });
  process.stdin.on("end", () => unwatchFile(file));
  // INF-1573: a journey may read while this child writes.
  const added = () => publishNotes(file, { notes: book.notes, ...(key ? { key } : {}) });
  if (era === "modern") {
    serveStdio(() => {
      const server = modernNotes(book, added);
      servers.push(server.server);
      return server;
    });
  } else {
    const server = legacyNotes(book, added);
    servers.push(server.server);
    const transport = new LegacyStdioTransport();
    await server.connect(transport);
    const answer = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage) => {
      const { unavailable } = JSON.parse(readFileSync(file, "utf8")) as NotesBook;
      if (
        unavailable &&
        "method" in message &&
        message.method === "tools/list" &&
        "id" in message
      ) {
        void transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: unavailable },
        });
        return;
      }
      answer?.(message);
    };
  }
}

if (process.argv[2] === "stdio") {
  const era = process.argv[3] === "modern" ? "modern" : "legacy";
  void serveNotesStdio(era, process.argv[4] as string);
}
