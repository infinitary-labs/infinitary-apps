A device's row in Settings → Devices' Your devices list (`components/devices/DevicesTab.prompt.md`): this computer, another computer, or running as another user on this computer.
```jsx
<MachineRow name="This computer" detail="MacBook Pro · your first mate lives here" summary="Runs notes · Signed in to Codex, Claude and GitHub" state="1 task" busy/>
<MachineRow name="Mac mini" detail="a computer · joined today 15:02 · seen just now" summary="Runs website and api · Signed in to Codex, Claude and GitHub" state="1 task" busy action={<Button variant="secondary" size="sm">Remove</Button>}/>
<MachineRow name="Running as Builder" tone="warn" detail="another user on this computer · runs work only, while Builder is logged in · out of reach since 15:10" summary="Runs api · Signed in to Codex and GitHub" state="out of reach"/>
```
It sits inside the list box, which draws the `--line-1` hairline between rows.
The dot is `ok` while the device answers, `warn` while it is out of reach, and `idle` while it is being set up.
The name is the device's own, drawn as text; the mono line says what it is, when it joined and when it was last seen; the summary says what it runs and what it is signed in to, led by "Controlling your first mate now" while Infinitary is open on it.
A computer on another version of Infinitary than this computer's has one more line under the summary, "Has Infinitary 0.1.20, older than this computer's.", `--warn` with "It takes no new work until it is updated." while it takes none (`components/devices/DevicesTab.prompt.md`, "Another version"), and a small secondary "Update" before Remove.
The state on the right is mono: "1 task" in the accent, "idle", "no new work" in `--warn` for a computer on another version that takes none, or "out of reach" in `--warn`.
There is no load, no meter and no address of a pool in this row.
A project's Runs on offers Automatic or an explicit computer (`components/devices/RunsOn.prompt.md`); task Details explain each Automatic commitment.
