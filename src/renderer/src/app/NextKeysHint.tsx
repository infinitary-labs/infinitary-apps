import * as m from "@shared/i18n/messages.generated";
import { chordLabel, commandEntry, type NextKey } from "@shared/keyboard";
import { useEffect, useState } from "react";
import { thisDesktop } from "../design/core/desktop";
import { useInstalledKeymap } from "../design/core/installedKeys";
import { KeyCap } from "../design/core/KeyCap";

/**
 * The next-keys hint (design skill `components/core/NextKeysHint.prompt.md`,
 * docs/keyboard.md "Two-key shortcuts"): while the window waits for a
 * two-key shortcut's second key, a quiet strip at the bottom of the window
 * lists each key that may follow and what the pair does. The main process
 * says which pairs; the strip only draws them, and takes no pointer.
 */
export function NextKeysHint() {
  const [next, setNext] = useState<readonly NextKey[] | null>(null);
  const { panels } = useInstalledKeymap();
  useEffect(() => window.infinitary.keyboard.onNext(setNext), []);
  const first = next?.[0];
  if (!next || !first) return null;
  const system = thisDesktop().keys;
  return (
    <div
      role="status"
      aria-label={m.shellNextKeysLabel()}
      data-next-keys=""
      style={{
        position: "absolute",
        left: "var(--space-4)",
        right: "var(--space-4)",
        bottom: "var(--space-3)",
        display: "flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        columnGap: "var(--space-4)",
        rowGap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        pointerEvents: "none",
        fontSize: "var(--text-sm)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <KeyCap lit>{chordLabel(first.binding, system)}</KeyCap>
        <span style={{ color: "var(--fg-3)" }}>{m.shellNextKeysThen()}</span>
      </span>
      {next.map(({ id, binding }) => (
        <span
          key={`${id} ${chordLabel(binding.second, system)}`}
          data-next-key={id}
          style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--space-2)" }}
        >
          <KeyCap>{chordLabel(binding.second, system)}</KeyCap>
          <span style={{ color: "var(--fg-2)" }}>
            {commandEntry(id, panels, system)?.label ?? id}
          </span>
        </span>
      ))}
      <span style={{ marginInlineStart: "auto", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {m.shellNextKeysHint()}
      </span>
    </div>
  );
}
