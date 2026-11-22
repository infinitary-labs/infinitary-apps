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
      /** An on/off setting: a small switch at its end in this state; a pick flips it and the menu stays open. */
      checked?: boolean;
    }
  | { separator: true };
export interface RowMenuProps {
  /** Accessible name of the kebab, e.g. "Work #2 actions". */
  label: string;
  items: RowMenuItem[];
  /** Kebab size; 28 in a 50px list row. */
  size?: number;
  /** A word in place of the kebab, as a small ghost Button ("More" in a task's browser view). */
  word?: string;
  style?: React.CSSProperties;
  className?: string;
  /** -1 where the row opens the menu by a key of its own (a task board tile's Space). */
  triggerTabIndex?: number;
  /** Where focus returns on Escape or a pick; the kebab by default (the tile it belongs to). */
  restoreFocus?: () => HTMLElement | null;
  /** The key of the command that opens the menu too, drawn after the kebab's label (Move the selected task). */
  keys?: string;
  "aria-keyshortcuts"?: string;
  /** That command, so a mouse click on the kebab shows its key reminder (`KeyReminder.prompt.md`); passed with `keys`. */
  "data-key-command"?: string;
}
