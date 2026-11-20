import * as m from "@shared/i18n/messages.generated";
import { Component, type ReactNode } from "react";

export function PanelStoppedLine({ card = false }: { card?: boolean }) {
  return (
    <p
      data-personal-stopped=""
      style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}
    >
      {card ? m.panelCardStopped() : m.panelStoppedLine()}
    </p>
  );
}

/**
 * Keeps a thrown render inside one panel, or one of its cards. It resets
 * only when its owner remounts it (a new version of the panel), never on a
 * timer. `onStop` hears what threw, for the window's answer about its
 * panels (./panelBodies.ts).
 */
export class PanelBoundary extends Component<
  { children: ReactNode; card?: boolean; onStop?: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onStop?.(error);
  }

  render() {
    return this.state.failed ? <PanelStoppedLine card={this.props.card} /> : this.props.children;
  }
}
