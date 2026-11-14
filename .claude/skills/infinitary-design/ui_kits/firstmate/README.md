# Infinitary — App UI kit

The Electron desktop app, as a click-through mock.
One window, four states:

- **Null state** (`Home`) — the first mate big and centered, one pill input below. ~90% empty space by design.
- **Listening** — click the input (stands in for holding right ⌥).
  The first mate breathes, input becomes a waveform with abandon / accept / submit.
- **Working** — submit.
  The first mate docks top-right (small, energetic), the card stack takes center, crew strip wakes up bottom-left.
- **Settings** — gear, top-right.
  Tabs General, Appearance, Projects, Intelligence and Devices, in the app's order; Keyboard and Usage are drawn only in their prompts (`components/core/KeyboardSettings.prompt.md`, `components/usage/UsageTab.prompt.md`).
  Projects (`ProjectsTab.jsx`, `components/projects/`): no sign-ins, which are all in Integrations (`components/integrations/IntegrationRow.prompt.md`), then the projects folder, one row per project that opens to Where changes go, Ask before merging, Care and Remove project, and Add project's folder, GitHub repo and New project.
  Intelligence (`IntelligenceTab.jsx`): one flat list of accounts in every state a row can show - a reading with its verdict, paused, sign in again, stale, not read - each with its menu, the Add account chips, then First mate model and account, Dynamic routing and the Models board's levels, Add model, Not in use and Decisions (`components/quota/ModelsBoard.prompt.md`).
  The Custom API chip and its form, dragging a model and the model panel are described in their prompts only.
  Devices: one list, Your devices - This computer, running as another user, and each computer with Remove - with "+ A computer" (a link, a command or an address), "+ Running as another user", and the address a link sends a computer to (`components/devices/DevicesTab.prompt.md`).
  The other computer's own screens, signing in, and Runs on are described in `components/devices/`.

`Esc` abandons a recording.
Theme toggle in the top bar (light/dark).
All data is fake; oauth flows are out of scope.
Composes only system components from `components/` — nothing is re-implemented here.
The shared card uses `onMinimize` and a minus labelled Put aside, or Hide for a record; no close-question props or confirmation are part of this kit.
`index.html` loads the components the prebuilt `_ds_bundle.js` lacks or carries stale (GroupedPills, StatusDot, RowMenu, ConnectChips, QuotaMicroMeter, SlotBadge) from their sources.
