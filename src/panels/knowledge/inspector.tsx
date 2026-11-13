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
import * as m from "./messages.generated";
import { SECTIONS, type Section, type Selection } from "./place";
import {
  aroundSlot,
  CHECK_WORDS,
  connectionSentence,
  OP_WORDS,
  originLine,
  relationLine,
  SLOT,
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
  point: Pick<PanelPoint, "peekTask" | "openRecord">;
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

const SECTION_WORDS: Readonly<Record<Section, string>> = {
  get overview() {
    return m.knowledgePanelSectionOverview();
  },
  get evidence() {
    return m.knowledgePanelSectionEvidence();
  },
  get history() {
    return m.knowledgePanelSectionHistory();
  },
  get used() {
    return m.knowledgePanelSectionUsed();
  },
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
        {m.knowledgePanelSourceCheckLine({
          check: CHECK_WORDS[source.check.state],
          when: whenOf(source.capturedAt),
        })}
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
        {m.knowledgePanelAskAboutThis()}
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
        {same
          ? m.knowledgePanelCompareUnchanged({ label })
          : m.knowledgePanelCompareChanged({ label })}
      </div>
      {same ? (
        <p>{then || m.knowledgePanelNone()}</p>
      ) : (
        <>
          <p>
            <span className="fm-kb-label">
              {m.knowledgePanelRevisionLabel({ revision: String(revision) })}
            </span>{" "}
            {then || m.knowledgePanelNone()}
          </p>
          <p data-knowledge-compare-now="">
            <span className="fm-kb-label">
              {m.knowledgePanelRevisionLabel({ revision: String(current) })}
            </span>{" "}
            {now || m.knowledgePanelNone()}
          </p>
        </>
      )}
    </div>
  );
}

function eyebrowOf(selection: Selection, entry: PanelKnowledgeEntry): string {
  if (selection.kind === "connection") {
    return selection.id.startsWith("claim:")
      ? m.knowledgePanelRecordedClaim()
      : m.knowledgePanelContextKindLine();
  }
  if (entry.kind === "concept") return m.knowledgePanelConceptEyebrow();
  return entry.revision === entry.current
    ? m.knowledgePanelFindingEyebrow({ revision: String(entry.revision) })
    : m.knowledgePanelFindingEarlierEyebrow({
        revision: String(entry.revision),
        current: String(entry.current),
      });
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
        {m.knowledgePanelBack()}
      </Button>
    </div>
  ) : null;
  if (!selection) {
    return (
      <div className="fm-kb-inspector-inner" data-knowledge-inspector="">
        {back}
        <p className="fm-kb-quiet">{m.knowledgePanelSelectPrompt()}</p>
      </div>
    );
  }
  if (!read) {
    return (
      <div className="fm-kb-inspector-inner" data-knowledge-inspector="">
        {back}
        <p className="fm-kb-quiet">{m.knowledgePanelReading()}</p>
      </div>
    );
  }
  if (read.state !== "ready") {
    return (
      <div className="fm-kb-inspector-inner" data-knowledge-inspector="">
        {back}
        <p className="fm-kb-quiet">
          {read.state === "missing" ? m.knowledgePanelEntryMissing() : read.reason}
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
      detail={named.retired ? m.knowledgePanelRetired() : undefined}
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
      <h4>{m.knowledgePanelCompareHeading()}</h4>
      <p className="fm-kb-note">
        {m.knowledgePanelCompareNote({
          revision: String(entry.revision),
          current: String(entry.current),
        })}
      </p>
      {now ? (
        <>
          <CompareRow
            name="title"
            label={
              entry.kind === "finding"
                ? m.knowledgePanelCompareStatement()
                : m.knowledgePanelCompareName()
            }
            then={entry.title}
            now={now.title}
            revision={entry.revision}
            current={entry.current}
          />
          {entry.kind === "finding" ? (
            <CompareRow
              name="conditions"
              label={m.knowledgePanelWhereItHolds()}
              then={entry.conditions}
              now={now.conditions}
              revision={entry.revision}
              current={entry.current}
            />
          ) : (
            <CompareRow
              name="explanation"
              label={m.knowledgePanelCompareExplanation()}
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
              {sourcesOf(entry) === sourcesOf(now)
                ? m.knowledgePanelCompareSourcesSame()
                : m.knowledgePanelCompareSourcesChanged()}
            </div>
            <p>
              {m.knowledgePanelCompareSourcesCounts({
                revision: String(entry.revision),
                earlierCount: String(entry.sources.length),
                current: String(entry.current),
                currentCount: String(now.sources.length),
              })}
            </p>
          </div>
          {now.standing ? (
            <p className="fm-kb-note" data-knowledge-standing-now="">
              {aroundSlot(m.knowledgePanelStandingNow({ standing: SLOT }))[0]}
              <Chip standing={now.standing} />
              {aroundSlot(m.knowledgePanelStandingNow({ standing: SLOT }))[1]}
            </p>
          ) : null}
        </>
      ) : (
        <p className="fm-kb-quiet">{m.knowledgePanelReadingCurrent()}</p>
      )}
      <div className="fm-kb-actions">
        <Button
          variant="secondary"
          size="sm"
          data-knowledge-current=""
          onClick={() => onSelect({ kind: entry.kind, id: entry.id })}
        >
          {m.knowledgePanelShowCurrent()}
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
          <Block title={m.knowledgePanelSupportingFinding()}>
            <LinkRow
              testId={entry.id}
              title={finding.title}
              detail={STANDING_WORDS[entry.standing ?? "unchecked"]}
              onOpen={() => onSelect({ kind: "finding", id: entry.id })}
            />
            <p className="fm-kb-note">{m.knowledgePanelOpenEvidenceNote()}</p>
          </Block>
          <Block title={m.knowledgePanelConnectedConcepts()}>
            {concept(connection.from)}
            {concept(connection.to)}
          </Block>
        </>
      );
    }
    if (connection?.kind === "context") {
      return (
        <>
          <Block title={m.knowledgePanelWhyConnect()}>
            <p>{connection.reason}</p>
            <p className="fm-kb-note">{m.knowledgePanelReadingSuggestionNote()}</p>
          </Block>
          <Block title={m.knowledgePanelConnectedConcepts()}>
            {concept(connection.from)}
            {concept(connection.to)}
          </Block>
        </>
      );
    }
    if (selection.kind === "connection") {
      return <p className="fm-kb-quiet">{m.knowledgePanelConnectionMissing()}</p>;
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
              {m.knowledgePanelAliases({ aliases: entry.aliases.join(", ") })}
            </p>
          ) : null}
          <Block title={m.knowledgePanelConnectedIdeas()}>
            {entry.connections.length === 0 ? (
              <p className="fm-kb-quiet">{m.knowledgePanelNoConnections()}</p>
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
                        ? m.knowledgePanelClaimDetail({
                            predicate: link.predicate,
                            standing: STANDING_WORDS[link.standing],
                          })
                        : m.knowledgePanelContextDetail({ reason: link.reason })
                    }
                    onOpen={() => onSelect({ kind: "connection", id: link.id })}
                  />
                );
              })
            )}
          </Block>
          <Block title={m.knowledgePanelSupportingFindings()}>
            {entry.findings.length === 0 ? (
              <p className="fm-kb-quiet">{m.knowledgePanelNoFindings()}</p>
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
                    {m.knowledgePanelMoreFindings({
                      count: entry.findingsTotal - entry.findings.length,
                    })}
                  </p>
                ) : null}
              </>
            )}
          </Block>
          <div className="fm-kb-actions">
            <Button variant="secondary" size="sm" onClick={() => onShowOnGraph(entry.id)}>
              {m.knowledgePanelShowOnGraph()}
            </Button>
          </div>
        </>
      );
    }
    const basisAround = aroundSlot(
      entry.basis === "inference"
        ? m.knowledgePanelReasonedBy({ author: SLOT })
        : m.knowledgePanelObservedBy({ author: SLOT }),
    );
    return (
      <>
        {earlier ? compare() : null}
        <p className="fm-kb-note">
          {basisAround[0]}
          <Words text={entry.author} look="quiet" />
          {basisAround[1]}
        </p>
        {entry.conditions && !earlier ? (
          <Block title={m.knowledgePanelWhereItHolds()}>
            <p data-knowledge-conditions="">
              <Words text={entry.conditions} />
            </p>
          </Block>
        ) : null}
        {entry.relationship ? (
          <Block title={m.knowledgePanelRelationshipClaimed()}>
            <p>
              {entry.relationship.from.title} <strong>{entry.relationship.predicate}</strong>{" "}
              {entry.relationship.to.title}
            </p>
          </Block>
        ) : null}
        <Block title={m.knowledgePanelAbout()}>
          {entry.about.length === 0 ? (
            <p className="fm-kb-quiet">{m.knowledgePanelNoConcept()}</p>
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
              {m.knowledgePanelShowOnGraph()}
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  const evidence = (): ReactNode => {
    if (connection?.kind === "context") {
      return <p className="fm-kb-quiet">{m.knowledgePanelContextNoEvidence()}</p>;
    }
    return (
      <>
        <Block
          title={
            entry.kind === "concept" ? m.knowledgePanelItsSources() : m.knowledgePanelKeptSources()
          }
        >
          {entry.sources.length === 0 ? (
            <p className="fm-kb-quiet">{m.knowledgePanelNoSources()}</p>
          ) : (
            entry.sources.map(sourceBlock)
          )}
        </Block>
        {entry.kind === "finding" ? (
          <Block title={m.knowledgePanelChecks()}>
            {entry.checks.length === 0 ? (
              <p className="fm-kb-quiet">{m.knowledgePanelNoChecks()}</p>
            ) : (
              entry.checks.map((check) => {
                const head = aroundSlot(
                  m.knowledgePanelCheckHead({
                    verdict: VERDICT_WORDS[check.verdict],
                    revision: String(check.revision),
                    by: SLOT,
                    when: whenOf(check.at),
                  }),
                );
                return (
                  <div
                    key={check.id}
                    className="fm-kb-check"
                    data-knowledge-verdict={check.verdict}
                  >
                    <div className="fm-kb-check-head">
                      {head[0]}
                      <Words text={check.by} look="quiet" />
                      {head[1]}
                    </div>
                    <p>
                      <span className="fm-kb-label">{m.knowledgePanelMethod()}</span>{" "}
                      <Words text={check.method} />
                    </p>
                    {check.conditions ? (
                      <p>
                        <span className="fm-kb-label">{m.knowledgePanelConditions()}</span>{" "}
                        <Words text={check.conditions} />
                      </p>
                    ) : null}
                    {check.sources.length === 0 ? (
                      <p className="fm-kb-note">{m.knowledgePanelCheckNoEvidence()}</p>
                    ) : (
                      check.sources.map(sourceBlock)
                    )}
                  </div>
                );
              })
            )}
          </Block>
        ) : null}
      </>
    );
  };

  const history = (): ReactNode => (
    <>
      <Block title={m.knowledgePanelRevisions()}>
        {entry.revisions.map((revision) => {
          const head = aroundSlot(
            m.knowledgePanelRevisionHead({
              revision: String(revision.revision),
              op: OP_WORDS[revision.op],
              by: SLOT,
              when: whenOf(revision.at),
            }),
          );
          return (
            <div
              key={revision.revision}
              className="fm-kb-revision"
              data-knowledge-revision={revision.revision}
            >
              <div className="fm-kb-check-head">
                {head[0]}
                <Words text={revision.by} look="quiet" />
                {head[1]}
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
                  {earlier ? m.knowledgePanelShownHere() : m.knowledgePanelCurrentShownHere()}
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
                      ? m.knowledgePanelReadCurrent()
                      : m.knowledgePanelReadRevision({ revision: String(revision.revision) })}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {entry.olderRevisions > 0 ? (
          <p className="fm-kb-note">
            {m.knowledgePanelEarlierRevisions({ count: entry.olderRevisions })}
          </p>
        ) : null}
      </Block>
      <Block title={m.knowledgePanelDisagreements()}>
        {entry.relations.length === 0 ? (
          <p className="fm-kb-quiet">{m.knowledgePanelNoDisagreements()}</p>
        ) : (
          entry.relations.map((relation) => (
            <LinkRow
              key={`${relation.type}:${relation.other.id}:${relation.at}`}
              testId={relation.other.id}
              title={m.knowledgePanelRelationTitle({
                relation: relationLine(relation),
                title: relation.other.title,
              })}
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
      <p className="fm-kb-quiet">{m.knowledgePanelContextNoUse()}</p>
    ) : entry.uses.count === 0 ? (
      <p className="fm-kb-quiet">{m.knowledgePanelNoUses()}</p>
    ) : (
      <>
        <p className="fm-kb-note">{m.knowledgePanelDeclaredUseNote()}</p>
        {entry.uses.recent.map((use) => {
          const head = aroundSlot(
            m.knowledgePanelUseHead({
              by: SLOT,
              revision: String(use.revision),
              when: whenOf(use.at),
            }),
          );
          return (
            <div key={`${use.at}:${use.by}`} className="fm-kb-revision" data-knowledge-use="">
              <div className="fm-kb-check-head">
                {head[0]}
                <Words text={use.task ?? use.by} look="quiet" />
                {head[1]}
              </div>
              <p>
                <Words text={use.purpose} />
              </p>
            </div>
          );
        })}
        {entry.uses.count > entry.uses.recent.length ? (
          <p className="fm-kb-note">
            {m.knowledgePanelEarlierUses({ count: entry.uses.count - entry.uses.recent.length })}
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
          {m.knowledgePanelEarlierRevision()}
        </span>
      ) : standing ? (
        <Chip standing={standing} />
      ) : null}
      {selection.kind === "finding" && entry.attention?.recheck && entry.standing !== "recheck" ? (
        <p className="fm-kb-note" data-warn="">
          {m.knowledgePanelSourceChangedNote()}
        </p>
      ) : null}
      <div
        className="fm-kb-sections"
        role="tablist"
        aria-label={m.knowledgePanelInspectorSections()}
      >
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
