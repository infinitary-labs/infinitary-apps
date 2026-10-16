import type { PanelKnowledgeDirectionRead } from "@infinitary/contracts";
import { Button, focusWithRing } from "@infinitary/ui";
import { AskButton, Block, Words } from "./inspector";
import { Pager } from "./lists";
import type { Section } from "./place";
import { directionOrigin, OP_WORDS, whenOf } from "./words";

/** Standing directions retain their origin and Knowledge edit history. */
export function DirectionInspector({
  read,
  section,
  onSection,
  onPage,
  onBack,
  onAsk,
}: {
  read: PanelKnowledgeDirectionRead | null;
  section: Section;
  onSection: (section: Section) => void;
  onPage: (page: number) => void;
  onBack: (() => void) | null;
  onAsk: (() => void) | null;
}) {
  const tab = section === "history" ? "history" : "overview";
  const back = onBack ? (
    <div className="fm-kb-back">
      <Button variant="secondary" size="sm" data-knowledge-back="" onClick={onBack}>
        Back
      </Button>
    </div>
  ) : null;
  if (read?.state !== "ready")
    return (
      <div className="fm-kb-inspector-inner">
        {back}
        <p className="fm-kb-quiet">
          {!read
            ? "Reading…"
            : read.state === "unavailable"
              ? read.reason
              : "This record is not available here."}
        </p>
      </div>
    );
  const note = read.direction;
  return (
    <div
      className="fm-kb-inspector-inner"
      data-knowledge-inspector={note.id}
      data-knowledge-direction=""
    >
      {back}
      <div className="fm-kb-eyebrow">Direction · revision {note.revision}</div>
      <h3 className="fm-kb-heading" data-knowledge-heading="">
        <Words text={note.text} />
      </h3>
      <span className="fm-kb-chip">
        {note.retired ? "Retired" : note.authority === "instruction" ? "Instruction" : "Advice"}
      </span>
      <div className="fm-kb-sections" role="tablist" aria-label="Inspector sections">
        {(["overview", "history"] as const).map((name) => (
          <button
            type="button"
            key={name}
            role="tab"
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            data-knowledge-section={name}
            onClick={() => onSection(name)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = tab === "overview" ? "history" : "overview";
              onSection(next);
              const button = event.currentTarget.parentElement?.querySelector<HTMLElement>(
                `[data-knowledge-section="${next}"]`,
              );
              if (button) focusWithRing(button);
            }}
          >
            {name === "overview" ? "Overview" : "History"}
          </button>
        ))}
      </div>
      <div className="fm-kb-section" role="tabpanel" data-knowledge-section-body={tab}>
        {tab === "overview" ? (
          <>
            <Block title="Applies to">
              <p>{note.scopeName}</p>
              <p className="fm-kb-count">{note.scope}</p>
            </Block>
            <Block title="Recorded origin">
              <p>{directionOrigin(note.origin)}</p>
              <p className="fm-kb-count">{note.origin}</p>
            </Block>
            <p className="fm-kb-note">
              Knowledge supplies this direction. Only your words are instructions; no record grants
              permission.
            </p>
            <p className="fm-kb-count">
              {whenOf(note.createdAt)} · updated {whenOf(note.updatedAt)}
            </p>
            <p className="fm-kb-count">d:{note.id}</p>
          </>
        ) : (
          <>
            <p className="fm-kb-note">
              Edits made in Knowledge keep the wording, origin and project for each revision.
            </p>
            <Pager
              page={note.page}
              shown={note.history.length}
              total={note.total}
              onPage={onPage}
              where="head"
            />
            {note.history.map((revision) => (
              <div
                className="fm-kb-source"
                key={revision.revision}
                data-knowledge-direction-revision={revision.revision}
              >
                <div className="fm-kb-check-head">
                  Revision {revision.revision} ·{" "}
                  {revision.op === "publish" ? "Recorded" : OP_WORDS[revision.op]} ·{" "}
                  {whenOf(revision.at)}
                </div>
                <p>{directionOrigin(revision.origin)}</p>
                <p>
                  <Words
                    text={revision.text ?? "This revision retired the record without new words."}
                  />
                </p>
                <p className="fm-kb-note">
                  <Words text={revision.evidence} />
                </p>
              </div>
            ))}
            <Pager
              page={note.page}
              shown={note.history.length}
              total={note.total}
              onPage={onPage}
              where="foot"
            />
          </>
        )}
      </div>
      <AskButton onAsk={onAsk} />
    </div>
  );
}
