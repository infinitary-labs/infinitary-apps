Toggle for settings rows; checked = accent fill.
A changing state label goes before the switch so the switch stays at the right edge as its words change; other labels follow it.
The production renderer supports `labelPosition="before"`; the design mock (`Switch.jsx`, `Switch.d.ts`, bundled preview) supports only the default label position and must not be used to preview this setting.
In Projects, “Ask before merging” is checked when the person is asked first, even though stored `autonomy: true` means the opposite.
The collapsed badge uses accent for “Asks first” and outline for “Merges on its own”, matching the expanded switch.
```jsx
<Switch checked={v} onChange={setV} label="Track quota pace"/>
```
