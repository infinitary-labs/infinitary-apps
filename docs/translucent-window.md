# The translucent window

The main window is see-through on macOS (captain's build from the prototype `crew-translucent-window-prototype`, 2026-09-27): the desktop shows through the whole window, blurred and tinted.
All shown macOS windows use the native under-window material.
The tint defaults to 0 percent opacity, adjustable from 0 to 100 percent in Settings → Appearance.
Every other desktop keeps the opaque void, so its Settings has no Window wash row (`docs/architecture.md`, "Desktop platform facts").
No island surfaces; hairlines at 1.5x, halo at 1.2x, no vignette, no text halo.

## What draws what

- **macOS draws the material.**
  A shown Mac window requests Electron's `under-window` vibrancy with an active visual effect and background `#00000000`, on macOS 26 as well as earlier releases.
  The material samples behind the window; the window is not marked `transparent`.
  The native blur is system-drawn, not CSS blur.
  The captain compared a disposable shown material.
  The wash defaults to 0%.
- **The renderer draws the tint, once.**
  The preload reads the material from its argv (`src/shared/windowMaterial.ts`, passed as `additionalArguments`) and marks `<html data-window-material>` before the first paint; on a translucent window `design/styles.css` paints `--material-tint` (the void color) at the chosen wash opacity.
  The default is 0%; the slider spans 0–100% opacity: dark #05070d, light #eef1f7.
  One-time conversion maps the old 78%-ceiling settings to actual opacity; old full/default wash becomes 20% on that conversion.
  A subsequent one-time migration moves saved 20% to 0%, leaves other opacities alone, and records completion even when no wash is saved.
  Later choices of 20% are preserved.
  The app root is clear.
  Nothing else paints a window-sized surface.
- **No new blur layers.**
  Every `backdrop-filter` the app draws re-samples the animating character every frame; the card already does and stays the only one.
  Panels are chromeless, the voice input's shell is clear over the tint (its hairline is the shell), and cards paint opaque `--bg-2` with no backdrop blur (legacy acrylic token names remain); the picture viewer’s modal blur is unchanged.

## What moved with it

- `--line-1` is 0.20 in dark and 0.18 in light, so hairlines read over the material.
- `--fg-3` is `#7a86a0` in dark and `#6c7891` in light: dim text (times, keys, group labels) was at 3.6:1 on the opaque void and would fall under 3:1 on every desktop; lifted one step it clears 3:1 at the tint's floor and 5.5:1 on the void.
- `--halo-boost` (1.2) is read by the character like `--wire-boost`, and lifts the ambient glow and the composited halo.
- The captain's theme is also the window's: `src/main/app.ts` writes `nativeTheme.themeSource` from the shell preferences and follows every write, so a dark material never sits under light tokens or the reverse.

## Settings on the glass

Settings was drawn for the opaque void: its rows paint solid `--bg-1`, which over the desktop read as near-black slabs, and its `--fg-3` labels fell under 3:1 on a mid-grey desktop.
On a translucent window, and only there, Settings is retuned (`settings/settingsScreen.css`, design skill `components/core/SettingsTabs.prompt.md`):

- **The page dims.**
  While Settings shows, `design/styles.css` raises the body's one tint to `max(wash, 65%)`, fading over `--dur-med`, and leaving Settings fades it back.
  No second window-sized surface appears, and a wash above 65% is kept.
  Below 65%, moving the Window wash slider shows no change until Settings closes.
- **Boxes take 55% fills.**
  Inside the shown section, `--bg-1` and `--bg-2` are redefined as the theme's own value at 55% over clear, so every box Settings draws picks up the hue behind it; the chosen tab takes `--bg-1` at 55% and hover `--bg-1` at 35%.
- **Rows group by section.**
  A Settings row next to another row gives up its inner corners and the stack's 12 px gap, so each section's rows sit in one box parted by `--line-1` hairlines.
- **Quiet text lifts.**
  Tab labels at rest, section labels and row descriptions use `--fg-2` instead of `--fg-3`.
- **Menus stay solid.**
  A menu drawn inside a section floats over the boxes and figures under it, so it paints the theme's opaque `--bg-2`, kept as `--settings-solid-bg-2`, as Usage's Cost per task filters do.

Reduce transparency answers with today's opaque Settings, as do hidden windows and other desktops, which never mark the window translucent.

## What stays opaque

- Every hidden window (an e2e run, the panel capture window) keeps the `#05070d` backing and its body paints the opaque `--bg-0`, so every pixel probe reads the frames it always did; every other platform is opaque too.
  Chromium composites the page over the color the window was created with, so a hidden window keeps an opaque backing that matches the theme.
- Reduce transparency in macOS accessibility: `design/styles.css` answers `prefers-reduced-transparency: reduce` by painting the body `--bg-0` again.

## Evidence and tests

`src/main/windowMaterial.test.ts` pins the option choice and `src/shared/windowMaterial.test.ts` the argv handshake; the guardrail specs (`phase0-guardrails`, `phase1-shell`) keep pinning the opaque void, which is what a hidden window paints.
`appearance.spec.ts` covers the Settings control and its persistence, and `window-wash.spec.ts` the old wash's one-time conversion through a relaunch; `settingsStore.test.ts` covers the conversion itself.
The translucent material itself runs only in a shown window, which the windowless e2e never opens: verify it by hand in a scratch run of the built app, capturing both themes when Screen Recording access is available.
The reduce-transparency fallback has no automated test either: Playwright cannot emulate that media feature, so check it by hand in System Settings.