One quota window as an instrument on a single line: "WEEKLY ▬▬▬┃▬ 62%".
The row form of QuotaMeter, for listing every window of an account side by side.
```jsx
<QuotaMicroMeter label="weekly" percentRemaining={62} pace="on_pace" resetText="resets Fri" clockPercent={38}/>
<QuotaMicroMeter label="session" percentRemaining={22} pace="ahead" stale/>
```
Same semantics as QuotaMeter: ≤10% forces danger, "ahead" warns, "behind" is calm, `clockPercent` draws the linear-pace marker.
Differences by design: the label NEVER truncates (it is what tells two bars apart), the reset note rides only the label the app draws on rest, and the percent tints warn below 50 and danger below 20.
A meter with a reset note is a Tab stop of its own: the pointer's rest or the keyboard's focus shows `weekly · resets Fri` in the icon button's label (readme, "Facts shown on rest").
The meter is one picture to assistive technology, named by its window, what is left and the reset: `weekly 62% left · resets Fri`.
`stale` dims the bar and number to tertiary - a last-known-good that must not read as current headroom - and the host says the age ("as of 3h ago") in the row's verdict slot.
An unread window shows "–", never 0.
Lay several in a wrapping flex flow with `gap: 6px 16px`, and end the flow with the row's one verdict in mono `--text-xs`: `on pace ✓` (ok) / `empty in 4h 45m` (danger) / `as of 3h ago` (warn) / `paused`.
