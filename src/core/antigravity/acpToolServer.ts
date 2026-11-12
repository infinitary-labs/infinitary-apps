import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { type BoundTool, toolContent } from "../session/tools";
import { CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";

/**
 * The app's tools for one Antigravity session, served to the program over
 * this computer's loopback as an MCP server (the protocol's HTTP transport):
 * the same bound tools Pi and Claude serve, by the same names, descriptions
 * and JSON Schemas, each call checked against its schema before it runs.
 *
 * Anything on this computer can reach a loopback port, a web page among
 * them, so each session's server has its own 256-bit key, handed to the
 * program only inside its `session/new` request (never on a command line),
 * and a request without it, one that names another host or one that carries
 * an origin is refused before it is read - the task channel's rules
 * (docs/axi-commands.md, "The channel").
 */

/** What the program is told to reach: the address and the one header that carries the key. */
export type AcpToolServerAddress = {
  name: string;
  url: string;
  headers: { name: string; value: string }[];
};

/** A call that ran, as the server saw it: which tool, and whether it answered an error. */
export type AcpToolCallSeen = { name: string; isError: boolean };

export class AcpToolServer {
  private readonly key = randomBytes(32).toString("hex");
  private server: Server | undefined;
  private port = 0;
  private readonly byName: Map<string, BoundTool>;
  private listed = false;

  constructor(
    private readonly tools: readonly BoundTool[],
    private readonly onCall?: (call: AcpToolCallSeen) => void,
  ) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Starts listening on a free loopback port; idempotent. */
  async start(): Promise<AcpToolServerAddress> {
    if (!this.server) {
      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.port = (server.address() as AddressInfo).port;
      this.server = server;
    }
    return {
      name: CLAUDE_SEAT_TOOL_SERVER,
      url: `http://127.0.0.1:${this.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${this.key}` }],
    };
  }

  /**
   * Whether the program asked for the tools since the last time this was
   * read, which starts the count over: the one sign that a program which
   * does not advertise MCP over HTTP reached the server anyway.
   */
  takeListed(): boolean {
    const listed = this.listed;
    this.listed = false;
    return listed;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private allowed(request: IncomingMessage): boolean {
    if (request.headers.origin !== undefined) return false;
    if (request.headers.host !== `127.0.0.1:${this.port}`) return false;
    const header = request.headers.authorization ?? "";
    const expected = Buffer.from(`Bearer ${this.key}`);
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0];
    if (!this.allowed(request)) {
      response.writeHead(403).end();
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      // Stateless: no stream to open and no session to end.
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // Stateless, one server per request: nothing outlives the answer.
    const mcp = this.mcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  }

  private mcpServer(): McpServer {
    const server = new McpServer(
      { name: CLAUDE_SEAT_TOOL_SERVER, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => {
      this.listed = true;
      return {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters as { type: "object" },
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.call(request.params.name, request.params.arguments ?? {}),
    );
    return server;
  }

  /** One call: checked against the tool's own schema, then run to its real answer. */
  async call(name: string, args: unknown): Promise<CallToolResult> {
    const tool = this.byName.get(name);
    if (!tool) return this.answer(name, `There is no tool named ${name}.`, true);
    if (!Value.Check(tool.parameters, args)) {
      const problems = [...Value.Errors(tool.parameters, args)]
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"} ${error.message}`);
      return this.answer(
        name,
        `The arguments for ${name} do not match its parameters: ${problems.join("; ")}.`,
        true,
      );
    }
    try {
      // A turn's cancel does not cut a call short: the tool's effect and its
      // answer belong together, as on the other backends.
      const output = await tool.run(args);
      this.onCall?.({ name, isError: false });
      return { content: toolContent(output) };
    } catch (caught) {
      return this.answer(name, caught instanceof Error ? caught.message : String(caught), true);
    }
  }

  private answer(name: string, text: string, isError: boolean): CallToolResult {
    this.onCall?.({ name, isError });
    return { content: [{ type: "text", text }], isError };
  }
}
