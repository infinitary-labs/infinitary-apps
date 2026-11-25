import type React from "react";
import { forwardRef, useState } from "react";

/**
 * The row menu's panel and items (design skill RowMenu), shared by the
 * kebab's opening (`RowMenu`) and the right-click one (`PointMenu`): where
 * the panel stands and when it closes are the opener's; what it draws and
 * how a pick on a dim item does nothing are here.
 */

export type RowMenuItem =
  | {
      id: string;
      label: string;
      onSelect?: () => void;
      /** The one destructive item; last, behind a separator. */
      tone?: "danger";
      /** A trailing glyph, e.g. the ✱ pin. */
      trailing?: React.ReactNode;
      /** A sub-line under the label: what it does, or why it cannot run. */
      detail?: string;
      /** Listed but dim: it cannot run now, and its detail says why. */
      disabled?: boolean;
      /**
       * An on/off setting rather than an action: it draws a small switch at
       * its end in this state, keeps one fixed label, and a pick flips it
       * with the menu left open (design skill RowMenu, "Settings").
       */
      checked?: boolean;
      /**
       * One of a few choices of which only one holds (Group tasks: By
       * status, By tag): a check at its end while it is the current one,
       * and a pick makes it the choice and closes the menu, as an action
       * does (design skill RowMenu, "One of a few").
       */
      chosen?: boolean;
      /** The key that runs it outside the menu, drawn at its end as a key hint (`⌘C`). */
      keys?: string;
      /** Every key that runs it, as `aria-keyshortcuts` names them; pass it with `keys`. */
      keyShortcuts?: string;
    }
  | { separator: true };

/** Every item a key can reach: actions, on/off settings and one-of choices. */
export const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** The least room a panel keeps from the window's edge. */
export const EDGE = 8;

/** Up and down walk the panel's items, wrapping at either end. */
export function stepMenuFocus(menu: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const focusable = [...(menu?.querySelectorAll<HTMLButtonElement>(MENU_ITEMS) ?? [])];
  if (focusable.length === 0) return;
  event.preventDefault();
  const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = focusable[(index + step + focusable.length) % focusable.length];
  next?.focus();
}

type MenuAction = Exclude<RowMenuItem, { separator: true }>;

export const MenuPanel = forwardRef<
  HTMLDivElement,
  {
    label: string;
    items: readonly RowMenuItem[];
    /** Where it stands: the opener's `top` with `left` or `right`. */
    style: React.CSSProperties;
    /** A pick of an item that can run now; a dim one's pick never arrives. */
    onPick: (item: MenuAction) => void;
  }
>(function MenuPanel({ label, items, style, onPick }, ref) {
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{
        position: "fixed",
        zIndex: 4,
        minWidth: 180,
        maxWidth: `calc(100vw - ${EDGE * 2}px)`,
        boxSizing: "border-box",
        maxHeight: `calc(100vh - ${EDGE * 2}px)`,
        overflowY: "auto",
        background: "var(--bg-2)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        padding: 6,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        ...style,
      }}
    >
      {items.map((item, index) =>
        "separator" in item ? (
          <hr
            // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
            key={`separator-${index}`}
            style={{
              height: 1,
              border: 0,
              background: "var(--line-1)",
              margin: "4px 2px",
            }}
          />
        ) : (
          <MenuItem
            key={item.id}
            item={item}
            onPick={() => {
              if (!item.disabled) onPick(item);
            }}
          />
        ),
      )}
    </div>
  );
});

function MenuItem({ item, onPick }: { item: MenuAction; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const dim = item.disabled === true;
  const setting = item.checked !== undefined;
  const choice = item.chosen !== undefined;
  const label = setting ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span>{item.label}</span>
      {item.trailing}
    </span>
  ) : (
    <span>{item.label}</span>
  );
  return (
    <button
      type="button"
      {...(setting
        ? { role: "menuitemcheckbox", "aria-checked": item.checked }
        : choice
          ? { role: "menuitemradio", "aria-checked": item.chosen }
          : { role: "menuitem" })}
      data-menu-item={item.id}
      aria-keyshortcuts={item.keyShortcuts}
      aria-disabled={dim || undefined}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover && !dim ? "var(--bg-3)" : "transparent",
        border: 0,
        textAlign: "start",
        padding: "7px 10px",
        borderRadius: "var(--radius-s)",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-sm)",
        color: dim ? "var(--fg-3)" : item.tone === "danger" ? "var(--danger)" : "var(--fg-1)",
        cursor: dim ? "default" : "pointer",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        whiteSpace: "nowrap",
      }}
    >
      {item.detail ? (
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {label}
          <span
            data-menu-detail=""
            style={{
              color: "var(--fg-3)",
              fontSize: "var(--text-xs)",
              whiteSpace: "normal",
              maxWidth: 260,
            }}
          >
            {item.detail}
          </span>
        </span>
      ) : (
        label
      )}
      {setting ? (
        <MenuSwitch on={item.checked === true} dim={dim} />
      ) : choice ? (
        <MenuCheck on={item.chosen === true} />
      ) : item.keys ? (
        <span
          data-menu-keys=""
          aria-hidden="true"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
          }}
        >
          {item.keys}
        </span>
      ) : (
        item.trailing
      )}
    </button>
  );
}

/**
 * The check at the end of a one-of choice: drawn only on the current one,
 * its room kept on the others so every label starts and ends alike.
 */
function MenuCheck({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-menu-check={on ? "on" : "off"}
      style={{ display: "inline-flex", flexShrink: 0, width: 14, color: "var(--accent)" }}
    >
      {on ? (
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * The switch at the end of an on/off item: the Switch's look at menu size,
 * drawn only, since the whole item is the control that flips it.
 */
function MenuSwitch({ on, dim }: { on: boolean; dim: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-menu-switch={on ? "on" : "off"}
      style={{
        position: "relative",
        flexShrink: 0,
        width: 28,
        height: 16,
        boxSizing: "border-box",
        borderRadius: "var(--radius-pill)",
        background: on ? "var(--accent)" : "var(--bg-3)",
        border: `1px solid ${on ? "transparent" : "var(--line-1)"}`,
        opacity: dim ? 0.4 : 1,
        transition: "background var(--dur-med) var(--ease-out)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          insetInlineStart: on ? 14 : 2,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: on ? "#05070d" : "var(--fg-2)",
          transition:
            "inset-inline-start var(--dur-med) var(--ease-out),background var(--dur-med) var(--ease-out)",
        }}
      />
    </span>
  );
}
