The first mate character — a continuously-animating 4D tesseract of lines and dots; its motion reflects state.
```jsx
<Firstmate state="idle" size={300}/>       // null state, center stage
<Firstmate state="working" size={64}/>     // docked when a card has focus
```
States: idle (near-still 4D drift), listening (TARS-style shapeshift: the tesseract flattens into two counter-rotating concentric hexagons + an inner square that breathe with the voice — pass level 0–1), working (fast double rotation + shimmer + pulsing nodes; "thinking" is a legacy alias).
All transitions are continuous morphs, never cuts.
Canvas-based; colors track CSS vars live, so theme switches re-paint.
