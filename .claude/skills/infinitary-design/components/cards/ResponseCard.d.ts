/**
 * @startingPoint section="Cards" subtitle="How the first mate communicates — never chat bubbles" viewport="700x340"
 */
export interface ResponseCardProps {
  /**
   * Derived from what the card is, never declared on the wire: decision = has actions (the user
   * chooses); note = no actions (a fact); attention = the app's own card (a provider needs sign
   * in, Firstmate is down); working = mid-revision; record = a task's record (no card actions,
   * ever; its footer is the host's lifecycle toggles).
   */
  kind?: "decision" | "note" | "attention" | "working" | "record";
  title?: React.ReactNode;
  /** Small mono metadata, e.g. "2m ago · crewmate 4". */
  meta?: React.ReactNode;
  /**
   * The quiet revised line under the title - "Revised 14:02 · 2 parts new · 1 removed", or
   * "Rewritten 14:02" - on a card revised since the captain last saw it. Mono
   * xs fg-3. The app derives it; the body's change bars beside new parts come with it.
   */
  revised?: React.ReactNode;
  /**
   * The "You asked" line under the title and the revised line: "You asked · 9:10 AM" in mono xs
   * fg-3, then the captain's words in the grey bubble, sm fg-2, cut after two lines; the bubble
   * opens the whole message (`ResponseCard.prompt.md`, "The You asked line"). It may instead read
   * "You chose", "You said", "Run by an automation" with its name, or "From INF-2081" with a task's
   * title. The app draws it from the saved message or origin, never from the card's words.
   */
  asked?: React.ReactNode;
  /** Footer action row — Button elements. */
  actions?: React.ReactNode;
  /**
   * Host chrome between the body and the action row: the card's live attachment, a micro label,
   * one line of what it is now, and the author's label as a small secondary Button
   * (`ResponseCard.prompt.md`, "A live attachment"). Never a card action.
   */
  attachment?: React.ReactNode;
  /**
   * Host chrome at the top right of the reading area, level with the title's top: a merge card's
   * risk chart (`ResponseCard.prompt.md`, "The risk chart"). The title gives way by its width.
   */
  aside?: { node: React.ReactNode; width: number };
  /** Shared minus callback: puts the card away, never a choice or task ending. */
  onMinimize?: () => void;
  /** Card body. Any HTML artifact; keep it on system tokens. */
  children?: React.ReactNode;
  width?: number | string;
  /** Default 340 — sized to fully cover the 300px Firstmate behind the stack. Actions pin to the bottom. */
  minHeight?: number | string;
  style?: React.CSSProperties;
}
