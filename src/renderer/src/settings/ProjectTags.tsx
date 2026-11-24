import * as m from "@shared/i18n/messages.generated";
import { type ProjectTagChange, type ProjectTagView, sameTagName } from "@shared/tags";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useProjectTags } from "../app/useProjectTags";
import { Button, Input } from "../design";
import { SettingError } from "./settingRows";

/**
 * The rows inside a project page's Tags box (design skill
 * components/projects/ProjectTags; docs/task-tags.md): one row per tag,
 * alphabetical, with Edit and Remove, then Add a tag. Edit and Add open a
 * form in the row's place; Remove turns its row into one question that
 * names how many tasks lose the tag, with Cancel focused so Enter never
 * removes. Escape inside a form or a question puts the row back, and goes
 * no further, so the page stays open.
 */

type Phase =
  | { kind: "rest" }
  | { kind: "editing"; tagId: string | null }
  | { kind: "asking"; tagId: string };

const ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "10px 0",
  borderTop: "1px solid var(--line-1)",
  flexWrap: "wrap",
} as const;

export function ProjectTags({ projectId }: { projectId: string }) {
  const tags = useProjectTags(projectId);
  const [phase, setPhase] = useState<Phase>({ kind: "rest" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Where the keyboard lands once a form or a question closes: its row's
  // Edit, or Add a tag after a removal. A new tag's row is drawn only once
  // the project list reads it back, after the request answers, so the
  // target waits here until a render draws it.
  const focusNext = useRef<{ tagId: string | null } | null>(null);
  useEffect(() => {
    const wanted = focusNext.current;
    if (!wanted || phase.kind !== "rest") return;
    const target = box.current?.querySelector<HTMLElement>(
      wanted.tagId ? `[data-project-tag="${wanted.tagId}"] [data-tag-edit]` : "[data-tag-add]",
    );
    if (!target) return;
    focusNext.current = null;
    target.focus();
  });
  const settle = (tagId: string | null) => {
    focusNext.current = { tagId };
    setPhase({ kind: "rest" });
    setError(null);
  };

  const send = async (change: ProjectTagChange, then: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.infinitary.projects.tags(change);
      const added =
        change.op === "add" ? result.tags.find((tag) => sameTagName(tag.name, change.name)) : null;
      settle(change.op === "remove" ? null : (added?.id ?? then));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const closeOnEscape = (tagId: string | null) => (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || busy) return;
    event.preventDefault();
    event.stopPropagation();
    settle(tagId);
  };

  return (
    <div ref={box} data-project-tags={projectId}>
      {tags.length === 0 && phase.kind === "rest" && (
        <div
          data-project-tags-empty
          style={{ ...ROW_STYLE, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
        >
          {m.settingsProjectsTagsEmpty()}
        </div>
      )}
      {tags.map((tag) =>
        phase.kind === "editing" && phase.tagId === tag.id ? (
          <TagForm
            key={tag.id}
            tag={tag}
            tags={tags}
            busy={busy}
            error={error}
            onKeyDown={closeOnEscape(tag.id)}
            onCancel={() => settle(tag.id)}
            onSave={(name, description) =>
              void send(
                {
                  op: "edit",
                  tagId: tag.id,
                  ...(name !== tag.name ? { name } : {}),
                  ...(description !== tag.description ? { description } : {}),
                },
                tag.id,
              )
            }
          />
        ) : phase.kind === "asking" && phase.tagId === tag.id ? (
          // Its own key, so React mounts the question afresh: reusing the
          // row's buttons would leave focus on the pressed Remove, now the
          // question's Remove, and a second Enter would remove the tag.
          // biome-ignore lint/a11y/noStaticElementInteractions: Escape from either of the question's buttons answers Cancel.
          <div
            key={`${tag.id}:asking`}
            data-project-tag={tag.id}
            data-project-tag-asking
            style={ROW_STYLE}
            onKeyDown={closeOnEscape(tag.id)}
          >
            <div style={{ minWidth: 0, flex: 1, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {tag.tasks === 0
                ? m.settingsProjectsTagsRemoveQuestionNone({ name: tag.name })
                : m.settingsProjectsTagsRemoveQuestion({ name: tag.name, count: tag.tasks })}
              <SettingError error={error} surface="project-tags" />
            </div>
            <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Button
                variant="secondary"
                size="sm"
                autoFocus
                disabled={busy}
                onClick={() => settle(tag.id)}
              >
                {m.settingsProjectsTagsCancel()}
              </Button>
              <Button
                variant="danger"
                size="sm"
                pending={busy}
                data-tag-remove-confirm
                onClick={() => void send({ op: "remove", tagId: tag.id }, null)}
              >
                {m.settingsProjectsTagsRemove()}
              </Button>
            </span>
          </div>
        ) : (
          <div key={tag.id} data-project-tag={tag.id} style={ROW_STYLE}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
                {tag.name}
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    fontWeight: 400,
                    color: "var(--fg-3)",
                    marginInlineStart: "var(--space-2)",
                  }}
                >
                  {m.settingsProjectsTagsTasks({ count: tag.tasks })}
                </span>
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-3)",
                  overflowWrap: "anywhere",
                }}
              >
                {tag.description}
              </div>
            </div>
            <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <Button
                variant="ghost"
                size="sm"
                data-tag-edit
                aria-label={m.settingsProjectsTagsEditNamed({ name: tag.name })}
                disabled={phase.kind !== "rest"}
                onClick={() => {
                  setError(null);
                  setPhase({ kind: "editing", tagId: tag.id });
                }}
              >
                {m.settingsProjectsTagsEdit()}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-tag-remove
                aria-label={m.settingsProjectsTagsRemoveNamed({ name: tag.name })}
                disabled={phase.kind !== "rest"}
                onClick={() => {
                  setError(null);
                  setPhase({ kind: "asking", tagId: tag.id });
                }}
              >
                {m.settingsProjectsTagsRemove()}
              </Button>
            </span>
          </div>
        ),
      )}
      {phase.kind === "editing" && phase.tagId === null ? (
        <TagForm
          tags={tags}
          busy={busy}
          error={error}
          onKeyDown={closeOnEscape(null)}
          onCancel={() => settle(null)}
          onSave={(name, description) =>
            void send({ op: "add", projectId, name, description }, null)
          }
        />
      ) : (
        <div style={ROW_STYLE}>
          <Button
            variant="secondary"
            size="sm"
            data-tag-add
            disabled={phase.kind !== "rest"}
            onClick={() => {
              setError(null);
              setPhase({ kind: "editing", tagId: null });
            }}
          >
            {m.settingsProjectsTagsAdd()}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A tag's name and which tasks qualify, for a new tag or one being edited.
 * Both are required, and a name another tag of the project has, in any
 * case, is refused here in the person's words before anything is sent.
 */
function TagForm({
  tag,
  tags,
  busy,
  error,
  onKeyDown,
  onCancel,
  onSave,
}: {
  tag?: ProjectTagView;
  tags: readonly ProjectTagView[];
  busy: boolean;
  error: string | null;
  onKeyDown: (event: KeyboardEvent) => void;
  onCancel: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(tag?.name ?? "");
  const [description, setDescription] = useState(tag?.description ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = () => {
    const wantedName = name.trim();
    const wantedDescription = description.trim();
    const taken = tags.find((other) => other.id !== tag?.id && sameTagName(other.name, wantedName));
    const refused = !wantedName
      ? m.settingsProjectsTagsNeedsName()
      : !wantedDescription
        ? m.settingsProjectsTagsNeedsDescription()
        : taken
          ? m.settingsProjectsTagsNameTaken({ name: taken.name })
          : null;
    setRefusal(refused);
    if (refused) return;
    if (tag && wantedName === tag.name && wantedDescription === tag.description) onCancel();
    else onSave(wantedName, wantedDescription);
  };
  return (
    <form
      data-project-tag={tag?.id}
      data-project-tag-form={tag ? "edit" : "add"}
      style={{ ...ROW_STYLE, alignItems: "stretch", flexDirection: "column", gap: 8 }}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) submit();
      }}
    >
      <Input
        autoFocus
        aria-label={m.settingsProjectsTagsName()}
        placeholder={m.settingsProjectsTagsName()}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label={m.settingsProjectsTagsDescription()}
        placeholder={m.settingsProjectsTagsDescriptionExample()}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <SettingError error={refusal ?? error} surface="project-tags" />
      <span style={{ display: "flex", gap: 8 }}>
        <Button type="submit" variant="secondary" size="sm" pending={busy}>
          {m.settingsProjectsTagsSave()}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {m.settingsProjectsTagsCancel()}
        </Button>
      </span>
    </form>
  );
}
