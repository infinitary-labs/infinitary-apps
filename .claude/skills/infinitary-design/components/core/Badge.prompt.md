Uppercase micro-label for statuses; muted background tints, never loud.
```jsx
<Badge tone="ok" dot>live</Badge>
<Badge tone="accent" mono>on pace</Badge>
```
Tones: neutral / accent / ok / warn / danger / outline. dot adds a status dot; mono for data-derived text.

**The model chip** (`ModelChip`; the captain's 1C, 2026-09-28): everywhere a model name sits in a container's top row - a card's head, Observe's session rows and header - it is `<Badge tone="outline" mono>`, never muted text.
It is never truncated and never pushed out of view: it does not shrink, and its flexible neighbor (the task key, the meta line) takes `min-width: 0` and the ellipsis; a name longer than all the room its row has wraps inside the chip rather than being cut.
It is not clickable, so it has no hover state.
```jsx
<Badge tone="outline" mono>GPT-6 Sol</Badge>
```

**The reduced motion indicator** (the captain, 2026-10-02): while the computer's Reduce motion setting is on, the main view's top bar shows `<Badge tone="warn" dot>Reduced motion</Badge>` directly left of the settings gear (right of the update button), so a still first mate reads as a setting, not a fault; its panel's last line names where to change it, macOS's System Settings on a Mac and the desktop's accessibility settings on Linux.
It is a focusable no-drag button; hover or focus opens a 340 px panel in the update panel's style (`--bg-2`, `--line-1` border, `--radius-m`, `--shadow-2`), right-aligned under it, listing what holds still and what appears at once and where to change it; a click keeps it open until a click elsewhere or Esc.
It follows the preference live (the app's `character/reducedMotion.ts`), is absent when the setting is off and in Settings, never moves or pulses, and has no hide option or Infinitary override.
