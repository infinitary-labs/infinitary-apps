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

  /**
   * Every server, none when there is no file yet, or undefined, with a
   * warning, when the file is there but cannot be read whole - damaged, or
   * written by a build that saves what this one does not know - so nothing
   * is decided from what it seems not to hold.
   */
  read(): McpSavedServer[] | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.root, MCP_FILE), "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
    }
    try {
      return fileSchema.parse(JSON.parse(raw)).servers;
    } catch {
      console.warn("[integrations] the MCP servers file could not be read; showing none");
      return undefined;
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

/**
 * The sign-ins of servers that ask for one (docs/integrations.md, "MCP
 * servers that sign in"): one file beside `mcp.json`, `mcp-sign-ins.json`
 * (0600), by server id - where the server's sign-in lives, the client it
 * registered there, and which Secrets entries keep its keys. No key is
 * here: the lasting key, and a client's own key where the sign-in gave
 * one, live in Secrets, and the access key only in the app's memory. It is
 * a file of its own so a build without sign-ins still reads `mcp.json` and
 * lists the server. The MCP binding is its one writer.
 */

const SIGN_INS_FILE = "mcp-sign-ins.json";

const signInSchema = z
  .object({
    /** The server's id in `mcp.json`. */
    id: z.string().min(1).max(48),
    /** The sign-in's own address (its issuer), from the server's documents. */
    issuer: z.string().min(1).max(2048),
    /** What the keys are for (RFC 8707), when the server named it. */
    resource: z.string().min(1).max(2048).optional(),
    /** Where a key is renewed. */
    token: z.string().min(1).max(2048),
    /** Where a key is revoked, when the sign-in offers it. */
    revoke: z.string().min(1).max(2048).optional(),
    /** The client Infinitary registered there for this sign-in. */
    clientId: z.string().min(1).max(1024),
    /** How the client shows itself when it renews: by its id alone, or with its own key. */
    clientAuth: z.enum(["none", "client_secret_post", "client_secret_basic"]),
    /** The Secrets reference of the client's own key, when it has one. */
    clientKey: z.string().min(1).max(64).optional(),
    /** The Secrets reference of the lasting key; none when the sign-in gave none. */
    key: z.string().min(1).max(64).optional(),
    scope: z.string().max(2048).optional(),
    signedInAt: z.number(),
  })
  .strict();
export type McpSavedSignIn = z.infer<typeof signInSchema>;

const signInsFileSchema = z.object({ signIns: z.array(signInSchema) }).strict();

export class McpSignInStore {
  constructor(readonly root: string) {}

  /** Every sign-in, none when there is no file yet, or undefined, with a warning, when it cannot be read whole. */
  read(): McpSavedSignIn[] | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.root, SIGN_INS_FILE), "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
    }
    try {
      return signInsFileSchema.parse(JSON.parse(raw)).signIns;
    } catch {
      console.warn("[integrations] the MCP sign-ins file could not be read; using none");
      return undefined;
    }
  }

  write(signIns: readonly McpSavedSignIn[]): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, SIGN_INS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ signIns })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
