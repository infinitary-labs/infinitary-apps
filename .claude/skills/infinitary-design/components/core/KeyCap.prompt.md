Keyboard key rendering for the configurable talk keybind and shortcuts.
```jsx
press/hold <KeyCap>⌥</KeyCap> to talk
```
Real glyphs only (⌥ ⌘ ⇧ ⎋, "space") on a Mac.
On Linux a key reads in words joined by `+` (`Ctrl+Shift+L`, `Ctrl+,`, right `Ctrl` for the dictation key), never a Mac glyph (readme, "Linux desktop conventions").
JetBrains Mono inside, at `--text-sm` (the kbd style) for both sizes.
The composer hint and a settings keybind share that size; nothing draws under the type scale.
A lit cap (`lit`) marks the one key that is pressed and waiting, such as a two-key shortcut's first key in the next-keys hint: an `--accent-dim` fill, an `--accent` border and `--fg-1` type.
