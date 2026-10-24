import { calledTool, type Scenario } from "../mockProvider";

export const FILE_CARD_PROMPT_MARKER = "show a file-backed card";
export const FILE_CARD_REVISE_MARKER = "show the edited card file";
export const FILE_CARD_TITLE = "A card edited in its file";
export const FILE_CARD_INITIAL =
  "<p>The original answer from the file.</p><p>The evidence stays unchanged.</p><p>The next check stays unchanged.</p><p>The scope stays unchanged.</p>";
export const FILE_CARD_REVISED =
  "<p>The updated answer from the file.</p><p>The evidence stays unchanged.</p><p>The next check stays unchanged.</p><p>The scope stays unchanged.</p>" +
  '<figure aria-label="Revised answer drawing"><svg viewBox="0 0 750 40" width="100%" role="img" aria-label="Revised answer drawing"><rect x="1" y="1" width="748" height="38" rx="6" fill="var(--accent-dim)" stroke="var(--accent)"/><text x="12" y="25">The revised file uses the wide card</text></svg></figure>';

/**
 * File-body journey: the crewmate writes its card body into the folder the
 * host's brief names, never a project file, then shows the card from that
 * file and, asked again, revises it from the edited file.
 */
export const fileCard: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (
      !latestUserTail.includes(FILE_CARD_PROMPT_MARKER) &&
      !latestUserTail.includes(FILE_CARD_REVISE_MARKER)
    )
      return undefined;
    const dir = body.match(/Your card body folder is ([^(]+) \(create it if it is missing\)/)?.[1];
    if (!dir) throw new Error("File card journey requires the real card body folder instruction");
    if (!hasToolResults && !latestUserTail.includes(FILE_CARD_REVISE_MARKER)) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: `mkdir -p ${quote(dir)} && printf '%s' ${quote(FILE_CARD_INITIAL)} > ${quote(`${dir}/answer.html`)}`,
            },
          },
        ],
      };
    }
    if (!calledTool(latestUserTail, "emit_card")) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: FILE_CARD_TITLE,
              id: "file-answer",
              reply: "Updated the answer from the file.",
              body_file: `${dir}/answer.html`,
            },
          },
        ],
      };
    }
    return undefined;
  };
