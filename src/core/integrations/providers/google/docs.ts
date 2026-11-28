import { servedNumber } from "@shared/i18n/format";
import { z } from "zod";
import type { IntegrationActionSpec, IntegrationAnswer } from "../../binding";
import { googleFileScope, newGoogleFileScope } from "../../scopes";
import { answer, fileIdSchema } from "./drive";
import { type GoogleTool, GoogleToolRefused } from "./mcp";

/**
 * Docs on the Google row (docs/integrations.md, "Google"; INF-6447 piece 2):
 * make a Google Doc, add text at its end, and replace text in it. A new doc
 * is made by Drive's MCP server, which imports Markdown into a Doc; its text
 * changes through Docs' MCP server. Every action changes a file, so each
 * waits for the captain's approval; none deletes, moves or shares one.
 */

/** The most text one action writes, in characters: as much as read_file hands back. */
export const DOC_WRITE_CHARS = 100_000;

// i18n-exempt: served to the crew, which stays English
const writtenText = z.string().min(1).max(DOC_WRITE_CHARS);

export const DOCS_ACTIONS: readonly IntegrationActionSpec[] = [
  {
    name: "create_document",
    label: "Create a Google Doc",
    effect: "changes",
    scope: newGoogleFileScope("document"),
    // i18n-exempt: served to the crew, which stays English
    description: `Create a Google Doc named title from text written in Markdown (headings, lists, bold and links become the doc's own formatting), at the top of My Drive or in folder, a folder's id from search_files. text is up to ${servedNumber(DOC_WRITE_CHARS)} characters. The answer names the new doc's id and link; append_to_document and replace_in_document change it. Its approval state controls whether the host asks.`,
    input: z.strictObject({
      title: z.string().min(1).max(256),
      text: writtenText,
      folder: fileIdSchema.optional(),
    }),
  },
  {
    name: "append_to_document",
    label: "Add to a Google Doc",
    effect: "changes",
    scope: googleFileScope("document"),
    // i18n-exempt: served to the crew, which stays English
    description:
      'Add text at the end of a Google Doc by its id, as plain text with no formatting. Start text with a line break ("\\n") to begin a new paragraph. Nothing already in the doc changes. Its approval state controls whether the host asks, for each doc.',
    input: z.strictObject({ id: fileIdSchema, text: writtenText }),
  },
  {
    name: "replace_in_document",
    label: "Replace text in a Google Doc",
    effect: "changes",
    scope: googleFileScope("document"),
    // i18n-exempt: served to the crew, which stays English
    description:
      "Replace every place find occurs in a Google Doc, by its id, with replace (empty removes it). match_case is false when omitted. The answer says how many places changed; 0 means find was not there and nothing changed. Its approval state controls whether the host asks, for each doc.",
    input: z.strictObject({
      id: fileIdSchema,
      find: z.string().min(1).max(1024),
      replace: z.string().max(DOC_WRITE_CHARS),
      match_case: z.boolean().optional(),
    }),
  },
];

/** Google Docs' own type, which Drive makes a Markdown upload into. */
const DOCUMENT = "application/vnd.google-apps.document";

/** A doc's link, as Google's own editor opens it. */
const docLink = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** Every value under `key` in update_doc's replies, which carry Docs' own answers with Google's notes. */
function valuesOf(body: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const inner of value) walk(inner);
      return;
    }
    for (const [name, inner] of Object.entries(value)) {
      if (name === key) found.push(inner);
      else walk(inner);
    }
  };
  walk(body);
  return found;
}

/** Docs' refusal inside update_doc's replies, which list errors beside the raw answers. */
function refusalIn(body: Record<string, unknown>): string | undefined {
  const [error] = valuesOf(body.replies, "error");
  if (error === undefined) return undefined;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : JSON.stringify(error);
}

/** Run one Docs action whose input already passed its schema. */
export async function runDocsAction(
  drive: GoogleTool,
  docs: GoogleTool,
  action: string,
  input: unknown,
): Promise<IntegrationAnswer> {
  switch (action) {
    case "create_document": {
      const { title, text, folder } = input as { title: string; text: string; folder?: string };
      const made = await drive(
        "create_file",
        {
          title,
          textContent: text,
          contentMimeType: "text/markdown",
          ...(folder ? { parentId: folder } : {}),
        },
        true,
      );
      const id = typeof made.id === "string" ? made.id : undefined;
      if (!id) throw new Error("Google Drive made the doc but named no id for it.");
      return answer({
        id,
        name: typeof made.title === "string" ? made.title : title,
        ...(typeof made.mimeType === "string" && made.mimeType !== DOCUMENT
          ? { type: made.mimeType }
          : {}),
        link: typeof made.viewUrl === "string" ? made.viewUrl : docLink(id),
        ...(folder ? { folder } : {}),
      });
    }
    case "append_to_document": {
      const { id, text } = input as { id: string; text: string };
      const body = await docs(
        "update_doc",
        {
          documentId: id,
          requests: [{ insertText: { text, endOfSegmentLocation: {} } }],
        },
        true,
      );
      const refused = refusalIn(body);
      // i18n-exempt: Google's refusal, served to the crew, which stays English
      if (refused) throw new GoogleToolRefused(`Google Docs refused: ${refused}`);
      return answer({ id, added: text.length, link: docLink(id) });
    }
    case "replace_in_document": {
      const v = input as { id: string; find: string; replace: string; match_case?: boolean };
      const body = await docs(
        "update_doc",
        {
          documentId: v.id,
          requests: [
            {
              replaceAllText: {
                containsText: { text: v.find, matchCase: v.match_case === true },
                replaceText: v.replace,
              },
            },
          ],
        },
        true,
      );
      const refused = refusalIn(body);
      // i18n-exempt: Google's refusal, served to the crew, which stays English
      if (refused) throw new GoogleToolRefused(`Google Docs refused: ${refused}`);
      // Docs leaves out a count of zero, as Google's JSON leaves out every zero.
      const [count] = valuesOf(body.replies, "occurrencesChanged");
      return answer({ id: v.id, replaced: Number(count ?? 0) || 0, link: docLink(v.id) });
    }
    default:
      throw new Error(`Docs has no action ${action}.`);
  }
}
