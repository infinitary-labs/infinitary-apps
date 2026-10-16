How a figure should look to belong in Infinitary.
No shape is prescribed: draw whatever the explanation calls for - a diagram, a chart, a map of a flow, a picture of the thing itself - and let these rules make it look like the app.
A drawing of a project's screens is the one exception: it takes that project's own colors, type, spacing and controls, read from its source, and for Infinitary's own screens those are these rules (`docs/card-authoring.md`, "Style").
An explanation with several parts gets several small figures, each beside the sentence it illustrates, rather than one crowded drawing.

A figure is inline SVG, written by hand.
There is no helper to call: a card body loads nothing but the host's own copies of what it names - its pictures, and a preview's project fonts - and every mark below is ordinary SVG that any body - scripted or not - can carry.

## Scaling

A full-width drawing is 750 units wide with `width="100%"`, so one unit is one pixel in the usual card and the figure scales down when the card is narrower.
A smaller drawing takes its pixel width, not 100 percent, so the card only shrinks it and never enlarges the type.
The height is whatever the drawing needs.
Wrap it in `<figure>` and give the `<svg>` `role="img"` with an `aria-label` that says what it shows.
Add a `<figcaption>` only when it says something the drawing does not - never to repeat the labels.
Give a part of the drawing its own `<title>` when hovering it should name what it is.

## Color

Every color is a theme token through `style`, so the figure follows light and dark without a second drawing: `fill:var(--accent)`, `stroke:var(--line-2)`.
The card frame colors unstyled filled shapes and labels with `currentColor` from `--fg-2`; do not put `fill="currentColor"` on the drawing root.
Give open connector paths, polylines, and lines `fill="none"` with a token stroke.
The card frame also defaults these unmarked connectors to no fill, so an omitted fill cannot turn a bend into a triangle.
Give arrowheads and intentionally filled paths their own explicit fill.

The palette, and what each token means:

- Text and marks: `--fg-1` the label that matters, `--fg-2` ordinary marks, `--fg-3` secondary text, times, and quiet arrows.
- Surfaces and lines: `--bg-0` through `--bg-3` for fills behind the drawing (`--bg-3` is the unfilled bar or track), `--line-1` for a hairline rule, `--line-2` for a visible border.
- `--accent` marks the single most-current or lit element in the figure - the one focal point that figure draws the eye to - over `--accent-dim` as the fill under its accent stroke.
  The budget is one accent per figure, not one per card: a card with several figures may light one element in each, and no figure carries two.
- Everything else in a figure is drawn with `--fg-1` through `--fg-3` and `--line-1` through `--line-2` for text, marks, rules, and borders, and `--bg-0` through `--bg-3` for fills behind the drawing.
  Reserve `--accent` for that figure's own focal point; a figure with nothing current or lit carries no accent at all.
- `--ok`, `--warn`, `--danger`, and `--idle` carry real state across any of those figures, never decoration: a mark is `--ok` because the thing passed, not because cyan looks calmer there.
- `--accent`, `--ok`, `--warn`, and `--danger` each have a `-dim` companion (`--accent-dim`, `--ok-dim`, ...) for a fill under a stroke of the same color.
  `--idle`, the text tokens, and the line tokens do not.

Ember (`--warn` / `--hot`) marks what needs attention, and nothing else.
A literal color is fine where no token would say more - a photograph's palette, a vendor's own brand mark, an illustration's shading.

## State colors

Where a mark carries status, it speaks `StatusDot`'s language, so a figure and the app's chrome say the same thing the same way:

- `ok` - filled `--ok`
- `running` - an `--accent` ring, unfilled
- `warn` - filled `--warn`
- `failed` - filled `--danger`
- `idle` - a `--idle` ring, unfilled

Shape should carry the state as well as color, wherever a reader might be scanning quickly: a tick inside the passing dot, a cross inside the failing one, a dash for skipped.

## Type

Labels use the app's own sizes, and never larger than body text unless the number is a deliberate display: unsized labels are 12.5px (`--text-sm`), 14px (`--text-base`) for the one that matters, 11px mono (`--text-xs`, `--font-mono`) for micro labels.
In the usual card those sizes draw as declared.
In a narrow card they shrink with the drawing, under 11px, which is accepted.
A card refuses measurable type, including flowing text in `<foreignObject>`, that would draw under 11px in the usual card: 11px in a 720-unit drawing is 7.8px there.
Labels in `--fg-1` or `--fg-2`, secondary text in `--fg-3`.
A micro label above a group is uppercase at 11 in `--fg-3`.

Text does not wrap in SVG: keep labels short, cut a long one with an ellipsis to its column, or wrap it yourself across two `<text>` lines.
Where real flowing text belongs inside the drawing, `<foreignObject>` renders it.

## Weight

The app is calm, so a figure is too: thin strokes (1 to 1.5 units, 3 units for a bar), generous space, no chart junk - no gridlines behind bars, no drop shadows, no gradient fills that carry no meaning.
Round a bar's ends (`rx` half its height).
Draw only the marks the point needs.

## Motion

A figure plays only when a press shows what one still drawing cannot hold - the same thing in two places, as a card moving through a stack or crew arriving on a ring, or more states than panels would fit.
A figure with one value the reader would vary - a width, a count, a moment - takes one control that redraws it.
Every other figure stays still, a timeline, a chart, numbered steps and a flow among them; a cursor or highlight sweeping a drawing that already shows every state adds nothing.
Previews are exempt: they draw something that does not exist yet.

Motion runs on the captain's press or drag, one pass from one state to the next, never on arrival, never in a loop and never on a timer.
The figure rests showing what the still drawing would show, and that resting markup is the whole explanation without the script.
Its labels are SVG text in the markup, where the 11px check reads them; the script changes their words and attributes, and never draws type the check cannot see.
Each state keeps the color rules: one accent, on what the press just changed.

The script sits inside the `<figure>` it drives, one script per figure in its own scope, and finds its parts inside that figure, so two moving figures never share a name or an id:

```html
<figure aria-label="A card label at the width you choose">
  <label>Width <input type="range" min="180" max="500" value="500"></label>
  <svg viewBox="0 0 510 64" width="510" role="img" aria-label="Card label at 500 pixels">
    <rect data-card x="0" y="0" width="500" height="40" rx="6" style="fill:var(--bg-2);stroke:var(--line-1)"/>
    <text x="12" y="25" style="fill:var(--fg-1)">Waiting on you</text>
    <text data-label x="0" y="60">500 pixels wide</text>
  </svg>
  <script>
    (function () {
      var figure = document.currentScript.closest("figure");
      var control = figure.querySelector("input");
      var card = figure.querySelector("[data-card]");
      var label = figure.querySelector("[data-label]");
      var svg = figure.querySelector("svg");
      control.addEventListener("input", function () {
        card.setAttribute("width", control.value);
        label.textContent = control.value + " pixels wide";
        svg.setAttribute("aria-label", "Card label at " + control.value + " pixels");
      });
    })();
  </script>
</figure>
```

A script outside every figure, a `<style>` sheet or a `<canvas>` makes the whole card a preview, which loses the shape lint, the change bars and the first mate's excerpt; style a moving figure through its attributes.

Its controls are plain `<button type="button">` and `<input type="range">` inside the figure, worded by their own text or a `<label>` around the range, and carry no `name`, so the footer never sends them as answers.
Pick the control by what moves:

- A stepper for arrivals that change the layout: each press adds or advances one (Next arrival), and after the last it starts again.
- A scrubber for a moment: a range along the timeline, and dragging it redraws which step reads, or who saw what.
- One pass for a move: a press replays the move once, from the first state to the last (Replay).
- One control for a value: a range or a few buttons for a width or a count, with a line in words beside the figure that reads the result.

Durations come from the tokens: `--dur-med` (360 ms) for a move, `--dur-slow` (700 ms) for a longer pass, eased by the glide, `--ease-out`.
The simplest move is a CSS transition on the part, `transition: opacity var(--dur-med) var(--ease-out)`, that the script sets off by changing a style or an attribute.
A script that steps a move itself reads `getComputedStyle(document.documentElement).getPropertyValue("--dur-med")` and jumps to the end state when it reads 0.
Under reduced motion the frame zeroes every duration token, so a move that reads them is a cut; a duration written into the script keeps moving.
Move with transitions or `requestAnimationFrame`, never a busy loop: a script that blocks is stopped after a few seconds.
A moving figure's script runs a few hundred bytes to about 3 KB, inside the body's 64 KB.
