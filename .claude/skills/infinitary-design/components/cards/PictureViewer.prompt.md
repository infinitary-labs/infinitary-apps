Where a card's picture is read.
The card shows which picture; the viewer shows it large, at the size the window allows.
It is host chrome over the whole window - the stage and any docked rails, which it covers like the rest - never inside the card, because the card's body is a sandboxed frame exactly the card's size.
Held between two docked rails it would leave a picture less than half the window on the default window.

**What opens it.**
A click on any picture in any card body.
The viewer pages within that picture's group: the `figure.inf-pictures` it sits in (its direct `<img>` children, in body order), else the picture alone as a group of one.
A click on a group's mono `+N` tile opens it at the first picture the strip does not show.
A picture inside a link, a button, a `summary`, a `label` or a `data-inf-action` element belongs to that control and opens nothing, and a body's own script that handles the click first keeps it.
A click on a diagram opens it the same way, alone, as a set of one: the outermost inline drawing in a figure, or one drawn the width of what holds it.
A small mark beside words, a drawing in a control or a `figcaption`, and a playable preview's drawings open nothing.
The diagram opens as it stands at the press, in the card's colors and type, with no script; its caption is the figure's `figcaption`, else its label.
In the body a picture or a diagram that opens the viewer shows the `zoom-in` cursor, and so does the `+N` tile.
The keyboard reaches the same pictures and diagrams: each is a Tab stop with the body's `:focus-visible` ring, and `Enter` or `Space` opens it as a click does; a group's pictures past the fifth thumbnail are reached in the viewer.
A picture opens only from the card the captain is in: the body's frame holds focus, which a click or a key gives it, never a card's own script.

**The surface.**
The design system's modal-level surface, which command search shares (`components/core/CommandSearch.prompt.md`): `--bg-0` at 80% under `--blur-overlay`, over everything in the window.
`role="dialog"`, `aria-modal`, named "Pictures from <card title>"; focus moves into it on open and Tab stays inside it.

**Three rows, top to bottom.**

- **Header**, 52 px (the top bar's height, which it covers): the card's title in `--fg-1` at `--text-base`, one line with an ellipsis; then the count in mono `--text-xs` / `--fg-3`, `2 / 6`, as the card pager counts - a group of one shows the picture's size instead (`2800 × 520`); then an `IconButton` "Close the viewer".
  The header drags the window like the top bar, and clears the window controls as it does, the Mac's at its left and Linux's at its right; its controls do not drag.
- **The picture**, the rest of the height: contained in the row minus `--space-8` at each side, never cropped, never upscaled past 1:1 (one picture pixel per CSS pixel, as the browser draws a picture of its own size), `--radius-s`, `--shadow-2`.
  A group puts previous and next `IconButton`s (36 px, `--fg-1`, a `--line-2` ring) in the row's side gutters, `--space-3` from its edges and centred on its height, disabled at the ends.
  The picture itself is the zoom control (a button, `aria-pressed`): a click, `Z`, `Enter` or `Space` toggles 1:1.
  At 1:1 the picture fills the row, clipped to it, opening centred; dragging or the wheel moves it, and it stops where an edge meets the row's edge; an axis narrower than the row stays centred.
  A picture that already fits at 1:1 does not zoom and keeps the default cursor.
  Another picture always opens fitted.
  A diagram is a drawing, sharp at any size, so fitted it fills the row, larger than its own size where there is room; a click, `Z`, `Enter` or `Space` toggles its own size, one unit to a pixel, wherever the two differ.
  It is drawn on `--bg-1` with `--radius-s`, as a picture is in the card.
- **Foot**: the picture's `alt` as its caption, `--text-sm` / `--fg-2`, centred, at most 70ch; under it one hint in mono `--text-xs` / `--fg-3` - `2800 × 520 · fitted · click or Z for 1:1`, `2800 × 520 · 1:1 · drag or scroll to move`, or `640 × 400 · shown at its own size`; under that, for a group, its thumbnails: 64 × 44 buttons, each picture cropped to its top on `--bg-1`, a `--line-1` border, `--radius-s`, at 70% opacity, each labelled "Picture N: <alt>".
  The current one is at full opacity with an `--accent` border - the viewer's only accent.
  When a group outgrows the row, the row scrolls sideways and keeps the current thumbnail in view.

**Keys**, while it is open: `←` `→` previous and next, `Home` `End` first and last, `Z` `Enter` `Space` toggle 1:1 (`Enter` and `Space` on a focused control press that control instead), `Esc` closes.
They never reach the card stack: the stack's own paging stays a click.

**Leave.**
`Esc`, the close control, or a click on the backdrop - anywhere in the picture row that is not the picture or an arrow.
Focus returns to the picture in the card body that opened it.
The card leaving the stage closes its viewer with it.

**A demo.**
A demo is a recording of the app being used, shown in the body as its poster (`ResponseCard.prompt.md`, "A demo"); the viewer is where it plays.
Its Play button opens the viewer playing it, one pass from the start; a press on its poster opens the viewer resting on the poster, paused.
It opens alone, a set of one: no arrows, no thumbnails; the dialog is named "Demo from <card title>".
The header's count is its length in mono, `0:12`.
The recording takes the picture's place, fitted the same way - never cropped, never upscaled, `--radius-s`, `--shadow-2` - resting on the poster until it plays; it does not zoom, and a press on it does nothing.
The foot holds the caption - the demo's `figcaption`, else the poster's `alt` - and under it the player, one row centred and at most 480 px wide: an `IconButton` that reads Play, Pause or Replay (`--fg-1`), a seek slider filling the row in `--accent` (the viewer's only accent), and the time in mono `--text-xs` / `--fg-3`, `0:04 / 0:12`.
At its end it stops on its last picture and the button reads Replay; nothing loops, and nothing plays on arrival, on hover or on a scroll.
Focus starts on the play control; Tab moves between Close, the play control and the slider, each with the focus ring; `Space` or `Enter` presses the focused button; on the slider `←` `→` seek a second and `Home` `End` go to the start and the end; `Esc` closes.
The picture keys - the arrows elsewhere, `Z` - do nothing on a demo.
The window hidden pauses it, and only a press plays it again; closing the viewer stops it, and it opens again on its poster.
A recording that cannot be played leaves its poster and says "This recording could not be played." where the time was.
Under reduced motion it still plays on a press - the press is the choice - and the viewer itself does not fade.

**A GIF demo.**
A demo whose recording is a GIF - the single-play fallback when no MP4 could be made - opens the same way and rests on its poster in the same place.
The GIF itself is drawn only once Play is pressed, laid over the poster, from its first frame; nothing of it loads before.
It cannot seek or pause, so its player row holds no slider: the `IconButton` reads Play, Stop or Replay, beside the time, the two centred.
Stop (a filled square) takes the animation away and leaves the poster, at `0:00`; a press on Play draws it again from its first frame.
Once its length has played the animation is taken away, the poster returns and the button reads Replay, at the end time, `0:03 / 0:03`.
The window hidden stops it the same way, and only a press plays it again.
Focus, Tab, `Space`, `Enter`, `Esc`, reduced motion and a recording that cannot be played are as for any demo; a GIF that cannot be played says so on the press that tried.

**Motion.**
A `--dur-med` (360 ms) `--ease-drift` fade in and out; none at all under reduced motion; never a slide, and nothing moves between pictures.

**Theme.**
Dark and light through the tokens alone.

In the app this is `src/renderer/src/design/cards/PictureViewer.tsx`, opened by the card layer (`src/renderer/src/app/stage/CardLayer.tsx`) from the frame bridge's `image` message (`src/shared/plugins/bridge.ts`).
The viewer shows only what the host accepts (`viewablePictures` in `src/shared/cardPictures.ts`): the host's own `app-frame://images/` copies, `data:` PNG, JPEG, GIF or WebP pictures, and a diagram the bridge wrote out as an SVG picture (`isDrawingSource`), nothing else.
A diagram's typefaces go inside it before it opens (`withDrawingFaces`), since a picture loads nothing.
It plays only the host's own `app-frame://media/` copy of a recording the card's body names (`isPlayableDemoSource`), opened from the bridge's `demo` message; the copy's kind (`playableDemoKind`) picks the MP4 player or the GIF one.
