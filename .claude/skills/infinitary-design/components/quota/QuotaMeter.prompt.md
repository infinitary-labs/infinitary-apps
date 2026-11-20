One quota window as a 3px bar: "62% left · on pace · resets Fri".
```jsx
<QuotaMeter label="weekly" percentRemaining={62} pace="on_pace" resetText="resets Fri" clockPercent={38}/>
```
Pace vocabulary: "ahead" = usage ahead of the reset clock (burning faster than linear - conserve, warn/amber); "behind" = usage behind the clock (calm, green); on_pace=accent; ≤10% forces danger.
`clockPercent` draws the linear-pace marker (┃) at the window's timeRemainingPercent - fill ending left of it means burning faster than the reset clock; omit it when pace is unknown.
A signed-in account with no readable window renders a disclosed one-line detail ("Usage isn't readable on this account's sign-in."), never a silent blank and never an invented meter.
