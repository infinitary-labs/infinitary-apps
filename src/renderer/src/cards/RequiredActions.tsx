import type { RequiredAction } from "@shared/requiredActions";
import type { CSSProperties } from "react";
import { CARD_MAX_HEIGHT } from "../design/cards/ResponseCard";
import "./requiredActions.css";

/** Outside the body's scroller, beside the host's merge buttons. */
export function RequiredActions({ actions }: { actions: readonly RequiredAction[] }) {
  if (!actions.length) return null;
  const entries = actions.map((action) => (
    <li key={action.id}>
      <span>
        {action.title} · {action.target}
      </span>
      <p>{action.consequence}</p>
    </li>
  ));
  return (
    <section
      className="required-actions"
      aria-label="Required actions after merging"
      data-required-actions=""
      style={{ "--required-action-room": CARD_MAX_HEIGHT } as CSSProperties}
    >
      <p>After merging, you need to…</p>
      {actions.length === 1 ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This scrollable list needs keyboard focus outside the card body.
        <ul tabIndex={0} aria-label="Required actions">
          {entries}
        </ul>
      ) : (
        <details>
          <summary>{actions.length} required actions</summary>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: This scrollable list needs keyboard focus outside the card body. */}
          <ul tabIndex={0} aria-label="Required actions">
            {entries}
          </ul>
        </details>
      )}
    </section>
  );
}
