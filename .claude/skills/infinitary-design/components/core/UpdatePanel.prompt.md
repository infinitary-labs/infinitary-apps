"The update panel": the popover under the top bar's update button, where a person reads the offered version and installs it, and, while an update saves the crew's work, sees whose running work it waits for and can let the update go.
```jsx
<UpdatePanel status={{channel:"stable",currentVersion:"0.1.30",latestVersion:"0.1.31",phase:"available",install:{restarts:true}}}/>                                                            // offered
<UpdatePanel status={{channel:"stable",currentVersion:"0.1.30",latestVersion:"0.1.31",phase:"installing",install:{restarts:true},work:{state:"saving",tasks:["Release notes"]}}} onLater={…}/> // saving work
<UpdatePanel status={{channel:"stable",currentVersion:"0.1.30",latestVersion:"0.1.31",phase:"installing",install:{restarts:true}}}/>                                                           // updating
```
A 340 px popover in `--bg-2` with a `--line-1` border, `--radius-m` and `--shadow-2`, right-aligned under its button, 14 by 16 px inside with 10 px between its parts; it grows from its button as every popover does (readme, "Motion").
From the top: the channel as a micro label, "Version 0.1.31 is available" at `--text-base` weight 500 in `--fg-1`, and "You have 0.1.30" at `--text-sm --fg-2` beneath it.
Where the app installs its own updates, one `--text-sm --fg-3` line says what Install does, then any status line, then the buttons at the panel's foot: Check for updates as a ghost button and Install (or Update and restart) as the primary, both small.
The offered version in the line is a link, `--accent` and underlined, that opens that version's release page; it takes the place of a View release button, so Check for updates fits beside the next step, since a newer version may be out.
While that check reads, the line and the primary hold still and only the ghost button says "Checking…"; a failed check keeps the line's version and says "Updates could not be checked.
Version 0.1.31 is still available."
- **Downloading:** "Downloading 42%" at `--text-sm --fg-2`, the percent in mono, over a full-width bar in `--accent`.
- **Saving work:** a `--text-sm --fg-2` status line saying the update saves work first and running work finishes, so nothing is lost; then one `--fg-3` line per task whose running work it waits for: Waiting for “Release notes” to finish what it is running.
  The primary button shows its pending state with "Saving work…", and Update later stands left of it as a small secondary button, reached by Tab from the update button and in command search as Update later.
- **Updating:** once the work is saved, the status line says Infinitary checks the new copy and restarts, and the primary button's pending label is "Updating…"; Update later is gone, because the copy is being replaced.
- **Asked from afar:** when a paired phone or Mac started the update, the panel opens by itself and a `--text-sm --fg-2` line under the status says who asked: "iPhone asked for this update."
  (`viewHomeUpdateAskedFrom`).
  Update later stands beside it only while the update saves work, as in the state above.
- **After Update later:** a `--text-sm --fg-3` line says the update waits and the work carries on, and Install is offered again.

The words come from `UPDATE_WORK_WORDS` and `UPDATE_LATER` (`src/shared/updateWords.ts`).
Never a countdown, a progress bar or a deadline for the saved work: the panel names whose work it waits for and nothing more.
