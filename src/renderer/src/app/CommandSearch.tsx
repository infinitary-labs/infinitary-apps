import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Input, KeyCap } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { useInstalledKeymap } from "../design/core/installedKeys";
import { usePopoverPresence } from "../design/motion";
import { commandRows, stepSelection } from "./commandRows";
import { closeCommandSearch, runWindowCommand, windowCommandRefusal } from "./shellCommands";
import { useShellStore } from "./store";

/**
 * Command search (docs/keyboard.md; design skill
 * `components/core/CommandSearch.prompt.md`): the window's commands by name
 * over the whole window, opened by its key from wherever focus is. Arrows
 * choose, Enter runs the chosen command when it can run, Escape closes it
 * alone and gives focus back. A command that cannot run now stays on the
 * list and says why; choosing it does nothing.
 */
export function CommandSearch() {
  const open = useShellStore((s) => s.commandSearchOpen);
  const panel = useRef<HTMLDivElement>(null);
  const drawn = usePopoverPresence(open, panel, NO_TRIGGER);
  if (!drawn) return null;
  return (
    <div
      data-command-search-backdrop=""
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeCommandSearch();
      }}
      style={
        {
          position: "fixed",
          inset: 0,
          zIndex: 40,
          background: "color-mix(in srgb, var(--bg-0) 80%, transparent)",
          backdropFilter: "var(--blur-overlay)",
          WebkitBackdropFilter: "var(--blur-overlay)",
          WebkitAppRegion: "no-drag",
          pointerEvents: open ? "auto" : "none",
        } as React.CSSProperties
      }
    >
      <SearchPanel panel={panel} open={open} />
    </div>
  );
}

const NO_TRIGGER = { current: null };

function SearchPanel({
  panel,
  open,
}: {
  panel: React.RefObject<HTMLDivElement | null>;
  open: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // The window as it would stand once search closes: every row is read
  // again whenever the shell changes, so a reason never goes stale.
  const shell = useShellStore();
  const { bindings, panels } = useInstalledKeymap();
  const rows = commandRows(
    query,
    (id) => windowCommandRefusal(id, { ...shell, commandSearchOpen: false }),
    bindings,
    { devices: shell.devicesShown, secrets: shell.secretsShown },
    panels,
    thisDesktop().keys,
  );
  const at = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1);
  const chosen = at >= 0 ? rows[at] : undefined;
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const field = useRef<HTMLDivElement>(null);

  // Each opening starts afresh with the caret in the field, also when it
  // opens again while its last closing is still fading out: the panel takes
  // focus again once its presence has let it (`usePopoverPresence`, whose
  // layout effect runs after this one's).
  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
  }, [open]);
  useEffect(() => {
    if (open) field.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [open]);

  // Search is modal: while it is open the caret stays in its field. Focus a
  // page takes after it opened - a frame answering an earlier way back, say
  // - comes back to the field as soon as that move is done, not on the next
  // drawn frame, which a busy computer may draw late.
  useEffect(() => {
    if (!open) return;
    const own = panel.current;
    const keep = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && own?.contains(event.relatedTarget)) return;
      setTimeout(() => {
        if (useShellStore.getState().commandSearchOpen)
          field.current?.querySelector("input")?.focus({ preventScroll: true });
      });
    };
    own?.addEventListener("focusout", keep);
    return () => own?.removeEventListener("focusout", keep);
  }, [open, panel]);

  // Runs a row when it can run: search closes and gives focus back first.
  const choose = (index: number) => {
    const row = rows[index];
    if (!row || row.refusal !== null) return;
    closeCommandSearch();
    runWindowCommand(row.id, "command-search");
  };
  const latest = useRef({ rows, at, choose });
  latest.current = { rows, at, choose };

  // Its keys, while it is open. Captured at the window so the shell's own
  // Escape and dictation key underneath never hear them; typing still
  // reaches the field.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.isComposing) return;
      const { rows: list, at: index, choose: run } = latest.current;
      switch (event.key) {
        case "Escape":
          closeCommandSearch();
          break;
        case "ArrowDown":
        case "ArrowUp": {
          // From the selection as it stands, never as it was last drawn, so
          // two presses that arrive between draws move it twice.
          const step = event.key === "ArrowDown" ? 1 : -1;
          setSelected((current) =>
            stepSelection(
              list.length,
              list.length === 0 ? -1 : Math.min(current, list.length - 1),
              step,
            ),
          );
          break;
        }
        case "Enter":
          run(index);
          break;
        // Focus stays in the field while search is open.
        case "Tab":
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useLayoutEffect(() => {
    if (at < 0) return;
    document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
  });

  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={m.shellCommandSearchLabel()}
      data-command-search=""
      style={{
        position: "absolute",
        top: "18%",
        left: 0,
        right: 0,
        // Centred by its margins: the entrance's own scale owns the transform.
        margin: "0 auto",
        width: "min(calc(var(--space-9) * 6), calc(100% - 2 * var(--space-6)))",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-l)",
        boxShadow: "var(--shadow-2)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div ref={field}>
        <Input
          size="lg"
          role="combobox"
          aria-label={m.shellCommandSearchLabel()}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          placeholder={m.shellCommandSearchLabel()}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSelected(0);
          }}
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={m.shellCommandSearchList()}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          maxHeight: "50vh",
          overflowY: "auto",
        }}
      >
        {rows.map((row, index) => (
          <Fragment key={row.id}>
            {row.panel !== undefined && row.panel !== rows[index - 1]?.panel && (
              // A panel's commands sit under its title, which is never a row.
              <div
                role="presentation"
                data-command-panel={row.panel}
                style={{
                  padding: "var(--space-2) var(--space-3) 0",
                  fontSize: "var(--text-xs)",
                  fontWeight: 500,
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--fg-3)",
                }}
              >
                {row.panel}
              </div>
            )}
            {/* The field keeps focus and names the chosen row (aria-activedescendant). */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the field's own keys choose and run rows */}
            <div
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === at}
              aria-disabled={row.refusal !== null || undefined}
              aria-label={row.panel === undefined ? undefined : `${row.panel}: ${row.label}`}
              data-command={row.id}
              onPointerMove={() => {
                if (index !== at) setSelected(index);
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: "var(--space-1) var(--space-3)",
                minHeight: "calc(var(--space-6) + var(--space-1))",
                boxSizing: "border-box",
                borderRadius: "var(--radius-m)",
                background: index === at ? "var(--accent-dim)" : "transparent",
                cursor: row.refusal === null ? "pointer" : "default",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span
                  style={{
                    fontSize: "var(--text-base)",
                    color:
                      row.refusal !== null
                        ? "var(--fg-3)"
                        : index === at
                          ? "var(--fg-1)"
                          : "var(--fg-2)",
                  }}
                >
                  {row.label}
                </span>
                {row.refusal !== null && (
                  <span
                    data-command-refusal=""
                    style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
                  >
                    {row.refusal}
                  </span>
                )}
              </span>
              {row.keys && <KeyCap>{row.keys}</KeyCap>}
            </div>
          </Fragment>
        ))}
        {rows.length === 0 && (
          <p
            role="status"
            style={{
              margin: 0,
              padding: "var(--space-2) var(--space-3)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
            }}
          >
            {m.shellCommandSearchNoMatch()}
          </p>
        )}
      </div>
      <p
        aria-hidden="true"
        style={{
          margin: 0,
          padding: "var(--space-1) var(--space-3) 0",
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
        }}
      >
        {m.shellCommandSearchHint()}
      </p>
      {chosen?.refusal && (
        <span role="status" style={VISUALLY_HIDDEN}>
          {`${chosen.label}: ${chosen.refusal}`}
        </span>
      )}
    </div>
  );
}

/** Read aloud, never drawn. */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
