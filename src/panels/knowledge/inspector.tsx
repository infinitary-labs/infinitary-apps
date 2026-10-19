import type {
  PanelKnowledgeEntry,
  PanelKnowledgeEntryConnection,
  PanelKnowledgeEntryRead,
  PanelKnowledgeNamed,
  PanelKnowledgeSource,
  PanelKnowledgeStanding,
  PanelPoint,
} from "@infinitary/contracts";
import {
  Button,
  focusWithRing,
  type PanelTaskKeys,
  PanelTaskKeyText,
  type TaskKeyLook,
} from "@infinitary/ui";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useContext,
} from "react";
import { SECTIONS, type Section, type Selection } from "./place";
import {
  CHECK_WORDS,
  connectionSentence,
  OP_WORDS,
  originLine,
  relationLine,
  STANDING_WORDS,
  standingWarns,
  VERDICT_WORDS,
  whenOf,
} from "./words";

/**
 * The knowledge browser's one inspector (the design skill's
 * `components/knowledge/KnowledgeBrowser`, "The inspector"): the selected
 * concept, finding or connection, read whole, in four sections - Overview,
 * Evidence, History and Used in. A row in it is a pointing gesture that
 * selects what it names; nothing here writes.
 *
 * An earlier revision - one a task record's Knowledge used row opened, or
 * one chosen in History - reads as it was, with how it compares to the
 * current revision first in Overview (docs/knowledge.md, "Knowledge used on
 * a task"). Ask about this, under every section, starts the captain's next
 * message with a question about exactly what is shown.
 */

/**
 * The tasks the inspector's words name (FI3-1271): with them, every
 * recorded task's key it writes outside a row - a report a source came
 * from, the crewmate who observed, checked or revised it, a Used in row,
 * and the finding's and a check's own words - is a link to that task.
 */
export type InspectorTaskKeys = {
  taskOf: PanelTaskKeys;
  point: Pick<PanelPoint, "peekTask" | "openTask">;
  /** The panel's `view.litTaskId` (INF-237). */
  litTaskId: string | null;
};
export const InspectorTaskKeysContext = createContext<InspectorTaskKeys | null>(null);

/** Words with their task keys linked where the browser can point at tasks. */
export function Words({ text, look }: { text: string; look?: TaskKeyLook }) {
  const keys = useContext(InspectorTaskKeysContext);
  if (!keys) return <>{text}</>;
  return (
    <PanelTaskKeyText
      text={text}
      taskOf={keys.taskOf}
      point={keys.point}
      litTaskId={keys.litTaskId}
      {...(look ? { look } : {})}
    />
  );
}

const SECTION_WORDS: Record<Section, string> = {
  overview: "Overview",
  evidence: "Evidence",
  history: "History",
  used: "Used in",
};

export type InspectorProps = {
  selection: Selection | null;
  /** The entry the selection reads: the concept or finding, a claim's finding, a link's declaring concept. */
  read: PanelKnowledgeEntryRead | null;
  section: Section;
  onSection: (section: Section) => void;
  /** Selects what a row names, and opens it here. */
  onSelect: (selection: Selection) => void;
  /** Shows a concept or a finding's first concept on the Graph tab. */
  onShowOnGraph: (concept: string) => void;
  /** In a narrow card: the inspector stands in for the pane, with Back. */
  onBack: (() => void) | null;
  /** The entry's current revision, read beside an earlier one for the comparison. */
  current: PanelKnowledgeEntryRead | null;
  /** Ask about this: starts the captain's next message with a question about what is shown. */
  onAsk: (() => void) | null;
};

function Chip({ standing }: { standing: PanelKnowledgeStanding }) {
  return (
    <span
      className="fm-kb-chip"
      data-knowledge-standing={standing}
      data-warn={standingWarns(standing) ? "" : undefined}
    >
      {STANDING_WORDS[standing]}
    </span>
  );
}

/** A row that opens what it names in the inspector. */
function LinkRow({
  title,
  detail,
  onOpen,
  testId,
}: {
  title: ReactNode;
  detail?: ReactNode;
  onOpen: () => void;
  testId: string;
}) {
  return (
    <button type="button" className="fm-kb-linkrow" data-knowledge-link={testId} onClick={onOpen}>
      <span className="fm-kb-linkrow-title">{title}</span>
      {detail ? <span className="fm-kb-linkrow-detail">{detail}</span> : null}
    </button>
  );
}

export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fm-kb-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function sourceBlock(source: PanelKnowledgeSource) {
  return (
    <div key={source.id} className="fm-kb-source" data-knowledge-source={source.id}>
      <div className="fm-kb-source-origin">
        <Words text={originLine(source.origin)} look="quiet" />
      </div>
      <div
        className="fm-kb-source-check"
        data-knowledge-check={source.check.state}
        data-warn={
          source.check.state === "changed" || source.check.state === "missing" ? "" : undefined
        }
      >
        {CHECK_WORDS[source.check.state]} · kept {whenOf(source.capturedAt)}
      </div>
      <pre className="fm-kb-source-text">{source.text}</pre>
    </div>
  );
}

/** The connection a selection names, found on the entry it reads. */
function connectionOf(
  selection: Selection,
  entry: PanelKnowledgeEntry,
): PanelKnowledgeEntryConnection | null {
  if (selection.id.startsWith("claim:")) {
    return entry.relationship
      ? {
          kind: "claim",
          id: selection.id,
          finding: entry.id,
          from: entry.relationship.from,
          predicate: entry.relationship.predicate,
          to: entry.relationship.to,
          standing: entry.standing ?? "unchecked",
        }
      : null;
  }
  return entry.connections.find((connection) => connection.id === selection.id) ?? null;
}

/** Ask about this, under every section: it starts a message and sends nothing. */
export function AskButton({ onAsk }: { onAsk: (() => void) | null }) {
  if (!onAsk) return null;
  return (
    <div className="fm-kb-actions fm-kb-ask">
      <Button variant="secondary" size="sm" data-knowledge-ask="" onClick={onAsk}>
        Ask about this
      </Button>
    </div>
  );
}

/** One thing an earlier revision says beside what the current one says. */
function CompareRow({
  name,
  label,
  then,
  now,
  revision,
  current,
}: {
  name: string;
  label: string;
  then: string;
  now: string;
  revision: number;
  current: number;
}) {
  const same = then.trim() === now.trim();
  return (
    <div
      className="fm-kb-compare-row"
      data-knowledge-compare-row={name}
      data-changed={same ? undefined : ""}
    >
      <div className="fm-kb-check-head">
        {label} · {same ? "unchanged" : "changed"}
      </div>
      {same ? (
        <p>{then || "None"}</p>
      ) : (
        <>
          <p>
            <span className="fm-kb-label">Revision {revision}</span> {then || "None"}
          </p>
          <p data-knowledge-compare-now="">
            <span className="fm-kb-label">Revision {current}</span> {now || "None"}
          </p>
        </>
      )}
    </div>
  );
}

function eyebrowOf(selection: Selection, entry: PanelKnowledgeEntry): string {
  if (selection.kind === "connection") {
    return selection.id.startsWith("claim:") ? "Recorded claim" : "Read together · not a claim";
  }
  if (entry.kind === "concept") return "Concept";
  const revision = `Finding · revision ${entry.revision}`;
  return entry.revision === entry.current ? revision : `${revision} of ${entry.current}`;
}

export function Inspector({
  selection,
  read,
  section,
  onSection,
  onSelect,
  onShowOnGraph,
  onBack,
  current,
  onAsk,
}: InspectorProps) {
  const back = onBack ? (
    <div className="fm-kb-back">
      <Button variant="secondary" size="sm" onClick={onBack}>
        Back
      </Button>
    </div>
  ) : null;
  if (!selection) {
    return (
      <div className="fm-kb-inspector-inner" data-knowledge-inspector="">
        {back}
        <p className="fm-kb-quiet">Select a concept, a connection or a finding to read it here.</p>
      </div>
    );
  }
  if (!read) {
    return (
      <div className="fm-kb-inspector-inner" data-knowledge-inspector="">
        {back}
        <p className="fm-kb-quiet">Reading…</p>
      </div>
    );
  }
  if (read.state !== "ready") {
    return (
      <div className="fm-kb-inspector-inner" data-knowledge-inspector="">
        {back}
        <p className="fm-kb-quiet">
          {read.state === "missing"
            ? "This is no longer in a collection you can read."
            : read.reason}
        </p>
      </div>
    );
  }
  const entry = read.entry;
  const connection = selection.kind === "connection" ? connectionOf(selection, entry) : null;
  const concept = (named: PanelKnowledgeNamed) => (
    <LinkRow
      key={named.id}
      testId={named.id}
      title={named.title}
      detail={named.retired ? "Retired" : undefined}
      onOpen={() => onSelect({ kind: named.kind, id: named.id })}
    />
  );
  const title = connection ? connectionSentence(connection) : entry.title;
  const standing = connection?.kind === "claim" ? connection.standing : entry.standing;
  // An earlier revision reads as it was; where it stands is the current one's.
  const earlier = entry.revision < entry.current;
  const now = earlier && current?.state === "ready" ? current.entry : null;
  const sourcesOf = (of: PanelKnowledgeEntry) =>
    of.sources
      .map((source) => source.id)
      .sort()
      .join(" ");

  const compare = (): ReactNode => (
    <section className="fm-kb-block fm-kb-compare" data-knowledge-compare="">
      <h4>Compared with the current revision</h4>
      <p className="fm-kb-note">
        This is revision {entry.revision}. The current revision is {entry.current}, and reading
        either changes nothing.
      </p>
      {now ? (
        <>
          <CompareRow
            name="title"
            label={entry.kind === "finding" ? "What it says" : "Its name"}
            then={entry.title}
            now={now.title}
            revision={entry.revision}
            current={entry.current}
          />
          {entry.kind === "finding" ? (
            <CompareRow
              name="conditions"
              label="Where it holds"
              then={entry.conditions}
              now={now.conditions}
              revision={entry.revision}
              current={entry.current}
            />
          ) : (
            <CompareRow
              name="explanation"
              label="Its explanation"
              then={entry.explanation}
              now={now.explanation}
              revision={entry.revision}
              current={entry.current}
            />
          )}
          <div
            className="fm-kb-compare-row"
            data-knowledge-compare-row="sources"
            data-changed={sourcesOf(entry) === sourcesOf(now) ? undefined : ""}
          >
            <div className="fm-kb-check-head">
              Kept sources · {sourcesOf(entry) === sourcesOf(now) ? "the same" : "changed"}
            </div>
            <p>
              Revision {entry.revision} cites {entry.sources.length}; revision {entry.current} cites{" "}
              {now.sources.length}.
            </p>
          </div>
          {now.standing ? (
            <p className="fm-kb-note" data-knowledge-standing-now="">
              Now: <Chip standing={now.standing} />
            </p>
          ) : null}
        </>
      ) : (
        <p className="fm-kb-quiet">Reading the current revision…</p>
      )}
      <div className="fm-kb-actions">
        <Button
          variant="secondary"
          size="sm"
          data-knowledge-current=""
          onClick={() => onSelect({ kind: entry.kind, id: entry.id })}
        >
          Show the current revision
        </Button>
      </div>
    </section>
  );

  const onTabKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = SECTIONS.indexOf(section);
    const next =
      SECTIONS[(at + (event.key === "ArrowRight" ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    if (!next) return;
    onSection(next);
    const button = (event.currentTarget.parentElement as HTMLElement).querySelector<HTMLElement>(
      `[data-knowledge-section="${next}"]`,
    );
    if (button) focusWithRing(button);
  };

  const overview = (): ReactNode => {
    if (connection?.kind === "claim") {
      const finding: PanelKnowledgeNamed = {
        id: entry.id,
        kind: "finding",
        title: entry.title,
        retired: entry.retired,
      };
      return (
        <>
          <Block title="Supporting finding">
            <LinkRow
              testId={entry.id}
              title={finding.title}
              detail={STANDING_WORDS[entry.standing ?? "unchecked"]}
              onOpen={() => onSelect({ kind: "finding", id: entry.id })}
            />
            <p className="fm-kb-note">Open its evidence before relying on this relationship.</p>
          </Block>
          <Block title="Connected concepts">
            {concept(connection.from)}
            {concept(connection.to)}
          </Block>
        </>
      );
    }
    if (connection?.kind === "context") {
      return (
        <>
          <Block title="Why these connect">
            <p>{connection.reason}</p>
            <p className="fm-kb-note">
              This is a reading suggestion, not proof of a relationship or a causal claim.
            </p>
          </Block>
          <Block title="Connected concepts">
            {concept(connection.from)}
            {concept(connection.to)}
          </Block>
        </>
      );
    }
    if (selection.kind === "connection") {
      return <p className="fm-kb-quiet">This connection is no longer recorded.</p>;
    }
    if (entry.kind === "concept") {
      return (
        <>
          {earlier ? (
            compare()
          ) : (
            <p className="fm-kb-text" data-knowledge-explanation="">
              <Words text={entry.explanation} />
            </p>
          )}
          {entry.aliases.length > 0 ? (
            <p className="fm-kb-note" data-knowledge-aliases="">
              Also found as: {entry.aliases.join(", ")}
            </p>
          ) : null}
          <Block title="Connected ideas">
            {entry.connections.length === 0 ? (
              <p className="fm-kb-quiet">No connections are recorded for it yet.</p>
            ) : (
              entry.connections.map((link) => {
                const other = link.from.id === entry.id ? link.to : link.from;
                return (
                  <LinkRow
                    key={link.id}
                    testId={link.id}
                    title={other.title}
                    detail={
                      link.kind === "claim"
                        ? `${link.predicate} · recorded claim · ${STANDING_WORDS[link.standing]}`
                        : `${link.reason} · read together`
                    }
                    onOpen={() => onSelect({ kind: "connection", id: link.id })}
                  />
                );
              })
            )}
          </Block>
          <Block title="Supporting findings">
            {entry.findings.length === 0 ? (
              <p className="fm-kb-quiet">No finding is about it yet.</p>
            ) : (
              <>
                {entry.findings.map((finding) => (
                  <LinkRow
                    key={finding.id}
                    testId={finding.id}
                    title={finding.statement}
                    detail={STANDING_WORDS[finding.standing]}
                    onOpen={() => onSelect({ kind: "finding", id: finding.id })}
                  />
                ))}
                {entry.findingsTotal > entry.findings.length ? (
                  <p className="fm-kb-note">
                    And {entry.findingsTotal - entry.findings.length} more in Findings.
                  </p>
                ) : null}
              </>
            )}
          </Block>
          <div className="fm-kb-actions">
            <Button variant="secondary" size="sm" onClick={() => onShowOnGraph(entry.id)}>
              Show on graph
            </Button>
          </div>
        </>
      );
    }
    return (
      <>
        {earlier ? compare() : null}
        <p className="fm-kb-note">
          {entry.basis === "inference" ? "Reasoned to" : "Observed"} · by{" "}
          <Words text={entry.author} look="quiet" />
        </p>
        {entry.conditions && !earlier ? (
          <Block title="Where it holds">
            <p data-knowledge-conditions="">
              <Words text={entry.conditions} />
            </p>
          </Block>
        ) : null}
        {entry.relationship ? (
          <Block title="The relationship it claims">
            <p>
              {entry.relationship.from.title} <strong>{entry.relationship.predicate}</strong>{" "}
              {entry.relationship.to.title}
            </p>
          </Block>
        ) : null}
        <Block title="About">
          {entry.about.length === 0 ? (
            <p className="fm-kb-quiet">It names no concept.</p>
          ) : (
            entry.about.map(concept)
          )}
        </Block>
        {entry.about[0] ? (
          <div className="fm-kb-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onShowOnGraph((entry.about[0] as PanelKnowledgeNamed).id)}
            >
              Show on graph
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  const evidence = (): ReactNode => {
    if (connection?.kind === "context") {
      return (
        <p className="fm-kb-quiet">
          A read-together link carries its reason, not evidence. Its concepts keep their own.
        </p>
      );
    }
    return (
      <>
        <Block title={entry.kind === "concept" ? "Its sources" : "Kept sources"}>
          {entry.sources.length === 0 ? (
            <p className="fm-kb-quiet">No source was kept with it.</p>
          ) : (
            entry.sources.map(sourceBlock)
          )}
        </Block>
        {entry.kind === "finding" ? (
          <Block title="Checks">
            {entry.checks.length === 0 ? (
              <p className="fm-kb-quiet">Nobody has checked it yet.</p>
            ) : (
              entry.checks.map((check) => (
                <div key={check.id} className="fm-kb-check" data-knowledge-verdict={check.verdict}>
                  <div className="fm-kb-check-head">
                    {VERDICT_WORDS[check.verdict]} · revision {check.revision} ·{" "}
                    <Words text={check.by} look="quiet" /> · {whenOf(check.at)}
                  </div>
                  <p>
                    <span className="fm-kb-label">Method</span> <Words text={check.method} />
                  </p>
                  {check.conditions ? (
                    <p>
                      <span className="fm-kb-label">Conditions</span>{" "}
                      <Words text={check.conditions} />
                    </p>
                  ) : null}
                  {check.sources.length === 0 ? (
                    <p className="fm-kb-note">It cites no evidence, so it checks nothing.</p>
                  ) : (
                    check.sources.map(sourceBlock)
                  )}
                </div>
              ))
            )}
          </Block>
        ) : null}
      </>
    );
  };

  const history = (): ReactNode => (
    <>
      <Block title="Revisions">
        {entry.revisions.map((revision) => (
          <div
            key={revision.revision}
            className="fm-kb-revision"
            data-knowledge-revision={revision.revision}
          >
            <div className="fm-kb-check-head">
              Revision {revision.revision} · {OP_WORDS[revision.op]} by{" "}
              <Words text={revision.by} look="quiet" /> · {whenOf(revision.at)}
            </div>
            <p>
              <Words text={revision.title} />
            </p>
            {revision.reason ? (
              <p className="fm-kb-note">
                <Words text={revision.reason} />
              </p>
            ) : null}
            {selection.kind === "connection" ? null : revision.revision === entry.revision ? (
              <p className="fm-kb-note" data-knowledge-revision-shown="">
                {earlier ? "Shown here" : "The current revision, shown here"}
              </p>
            ) : (
              <div className="fm-kb-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  data-knowledge-read-revision={revision.revision}
                  onClick={() =>
                    onSelect({
                      kind: entry.kind,
                      id: entry.id,
                      ...(revision.revision === entry.current
                        ? {}
                        : { revision: revision.revision }),
                    })
                  }
                >
                  {revision.revision === entry.current
                    ? "Read the current revision"
                    : `Read revision ${revision.revision}`}
                </Button>
              </div>
            )}
          </div>
        ))}
        {entry.olderRevisions > 0 ? (
          <p className="fm-kb-note">And {entry.olderRevisions} earlier revisions.</p>
        ) : null}
      </Block>
      <Block title="Disagreements">
        {entry.relations.length === 0 ? (
          <p className="fm-kb-quiet">
            No other finding disagrees with it, replaces it or repeats it.
          </p>
        ) : (
          entry.relations.map((relation) => (
            <LinkRow
              key={`${relation.type}:${relation.other.id}:${relation.at}`}
              testId={relation.other.id}
              title={`${relationLine(relation)}: ${relation.other.title}`}
              detail={relation.reason}
              onOpen={() => onSelect({ kind: relation.other.kind, id: relation.other.id })}
            />
          ))
        )}
      </Block>
    </>
  );

  const used = (): ReactNode =>
    connection?.kind === "context" ? (
      <p className="fm-kb-quiet">Work declares the concepts and findings it used, not a link.</p>
    ) : entry.uses.count === 0 ? (
      <p className="fm-kb-quiet">No work has declared it used this yet.</p>
    ) : (
      <>
        <p className="fm-kb-note">Declared use, not proof the reasoning was right.</p>
        {entry.uses.recent.map((use) => (
          <div key={`${use.at}:${use.by}`} className="fm-kb-revision" data-knowledge-use="">
            <div className="fm-kb-check-head">
              <Words text={use.task ?? use.by} look="quiet" /> · revision {use.revision} ·{" "}
              {whenOf(use.at)}
            </div>
            <p>
              <Words text={use.purpose} />
            </p>
          </div>
        ))}
        {entry.uses.count > entry.uses.recent.length ? (
          <p className="fm-kb-note">
            And {entry.uses.count - entry.uses.recent.length} earlier uses.
          </p>
        ) : null}
      </>
    );

  const body =
    section === "overview"
      ? overview()
      : section === "evidence"
        ? evidence()
        : section === "history"
          ? history()
          : used();

  return (
    <div
      className="fm-kb-inspector-inner"
      data-knowledge-inspector={selection.id}
      data-knowledge-revision-read={entry.revision}
    >
      {back}
      <div className="fm-kb-eyebrow">{eyebrowOf(selection, entry)}</div>
      <h3 className="fm-kb-heading" data-knowledge-heading="">
        <Words text={title} />
      </h3>
      {earlier ? (
        <span className="fm-kb-chip" data-knowledge-earlier="">
          Earlier revision
        </span>
      ) : standing ? (
        <Chip standing={standing} />
      ) : null}
      {selection.kind === "finding" && entry.attention?.recheck && entry.standing !== "recheck" ? (
        <p className="fm-kb-note" data-warn="">
          A source it cites changed since it was kept.
        </p>
      ) : null}
      <div className="fm-kb-sections" role="tablist" aria-label="Inspector sections">
        {SECTIONS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={section === name}
            tabIndex={section === name ? 0 : -1}
            data-knowledge-section={name}
            onClick={() => onSection(name)}
            onKeyDown={onTabKey}
          >
            {SECTION_WORDS[name]}
          </button>
        ))}
      </div>
      <div className="fm-kb-section" role="tabpanel" data-knowledge-section-body={section}>
        {body}
      </div>
      <AskButton onAsk={onAsk} />
    </div>
  );
}
