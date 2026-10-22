import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgeSignInStateSchema } from "@shared/forges";
import { z } from "zod";

/**
 * The MCP servers the person added (docs/integrations.md, "Where it
 * lives"): one file, `userData/integrations/mcp.json` (0600 in the
 * integrations' 0700 folder) - each server's name, what it runs, and the
 * tools and resources it listed when it last answered, so its row shows
 * them with no program running. The MCP binding writes it, only as the
 * integrations service adds, removes or uses a server.
 */

const MCP_FILE = "mcp.json";

const toolSchema = z
  .object({
    /** The server's own name for the tool, which a call sends. */
    tool: z.string().min(1),
    /** The action's name here: the tool's, in lowercase words joined by underscores. */
    action: z.string().min(1).max(48),
    title: z.string().optional(),
    description: z.string().optional(),
    /** The server marked it read-only (`readOnlyHint`): it changes nothing. */
    readOnly: z.boolean(),
    /** Its input as the server declared it. */
    schema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type McpSavedTool = z.infer<typeof toolSchema>;

const resourceSchema = z
  .object({ uri: z.string().min(1), name: z.string(), title: z.string().optional() })
  .strict();
export type McpSavedResource = z.infer<typeof resourceSchema>;

const serverSchema = z
  .object({
    id: z.string().min(1).max(48),
    name: z.string().min(1).max(64),
    runs: z.string().min(1).max(2048),
    /** An address's network class, read when it was added and held on every request. */
    network: z.enum(["public", "private", "local"]).optional(),
    health: forgeSignInStateSchema,
    tools: z.array(toolSchema),
    resources: z.array(resourceSchema),
    /** The server tells when a resource changes (`resources.subscribe`). */
    subscribe: z.boolean(),
  })
  .strict();
export type McpSavedServer = z.infer<typeof serverSchema>;

const fileSchema = z.object({ servers: z.array(serverSchema) }).strict();

export class McpServerStore {
  constructor(readonly root: string) {}

  /** Every server; an unreadable file reads as none, with a warning. */
  read(): McpSavedServer[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.root, MCP_FILE), "utf8");
    } catch {
      return [];
    }
    try {
      return fileSchema.parse(JSON.parse(raw)).servers;
    } catch {
      console.warn("[integrations] the MCP servers file could not be read; showing none");
      return [];
    }
  }

  /** Write the one file whole, never readable by anyone else even mid-write. */
  write(servers: readonly McpSavedServer[]): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, MCP_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ servers })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
