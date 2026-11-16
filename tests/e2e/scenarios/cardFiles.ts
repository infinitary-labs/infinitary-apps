import { shellJobsRunning } from "../browserScript";
import { writeFilesCalls } from "../crewCards";
import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/**
 * Marker prompt: the mock crewmate writes a letter into its working copy
 * with bash, then puts it on its card's files, as a crewmate hands the
 * captain a document to send (INF-3757, direction C). The card carries only
 * the reference; the journey's Save is what moves the bytes.
 */
export const CARD_FILES_PROMPT_MARKER = "hand me the letter on the card";
export const CARD_FILES_TITLE = "The letter to the landlord is ready";
/** The letter as the crewmate wrote it: its name in the working copy and in Downloads, and its bytes. */
export const CARD_FILE_LETTER = {
  path: "shots/landlord-letter.txt",
  name: "landlord-letter.txt",
  bytes: Buffer.from(
    [
      "Dear Ms. Alvarez,",
      "",
      "The heating in flat 4 has been off since Monday morning.",
      "Could someone look at the boiler this week? I am home after 5 PM every day.",
      "",
      "Kind regards,",
      "Sam Okafor",
      "",
    ].join("\n"),
  ),
} as const;

/**
 * Marker prompt: the crewmate hands the captain the whole repair pack - the
 * letter and four papers to send with it - which is more files than a card
 * shows whole, so they fold behind a counting row with Save all (INF-4427).
 */
export const CARD_FILES_PACK_PROMPT_MARKER = "hand me the whole repair pack on the card";
export const CARD_FILES_PACK_TITLE = "The repair pack for the landlord is ready";
/** The pack in the crewmate's order: the letter first, then what goes with it. */
export const CARD_FILES_PACK = [
  CARD_FILE_LETTER,
  {
    path: "shots/repair-request-form.txt",
    name: "repair-request-form.txt",
    bytes: Buffer.from(
      "Repair request\nFlat: 4\nWhat: boiler, no heating or hot water\nSince: Monday\n",
    ),
  },
  {
    path: "shots/boiler-pressure-gauge.txt",
    name: "boiler-pressure-gauge.txt",
    bytes: Buffer.from(
      "Photo note: the boiler's pressure gauge reads 0 bar, below the green band.\n",
    ),
  },
  {
    path: "shots/tenancy-repairs-clause.txt",
    name: "tenancy-repairs-clause.txt",
    bytes: Buffer.from("Clause 7: the landlord keeps the heating and hot water in repair.\n"),
  },
  {
    path: "shots/heating-log.csv",
    name: "heating-log.csv",
    bytes: Buffer.from("day,heating\nMonday,off\nTuesday,off\nWednesday,off\n"),
  },
] as const;

/**
 * The letter crewmate: write the file, then show the card naming it in
 * `files`; after the card it passes on to the default close-out. It reads
 * the whole conversation, because a write can resume it from a wake.
 */
export const cardFiles: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(CARD_FILES_PROMPT_MARKER)) return undefined;
    if (!calledTool(body, "bash"))
      return {
        calls: writeFilesCalls([{ path: CARD_FILE_LETTER.path, bytes: CARD_FILE_LETTER.bytes }]),
      };
    if (shellJobsRunning(body)) return { text: "The letter is still being written." };
    if (!calledTool(body, "emit_card"))
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: CARD_FILES_TITLE,
              body: "<p>The letter asks for the boiler to be looked at this week. Save it, then send it from your own mail.</p>",
              files: [CARD_FILE_LETTER.path],
            },
          },
        ],
      };
    return undefined;
  };

/**
 * The repair pack crewmate: write the five files, then show the card naming
 * them all in `files`, in the pack's order.
 */
export const cardFilesPack: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(CARD_FILES_PACK_PROMPT_MARKER))
      return undefined;
    if (!calledTool(body, "bash"))
      return {
        calls: writeFilesCalls(CARD_FILES_PACK.map(({ path, bytes }) => ({ path, bytes }))),
      };
    if (shellJobsRunning(body)) return { text: "The pack is still being written." };
    if (!calledTool(body, "emit_card"))
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: CARD_FILES_PACK_TITLE,
              body: "<p>The letter asks for the boiler to be looked at this week; the four papers back it up. Save them, then send them from your own mail.</p>",
              files: CARD_FILES_PACK.map((file) => file.path),
            },
          },
        ],
      };
    return undefined;
  };
