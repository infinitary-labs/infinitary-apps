"Version": the first row of Settings -> General, where a person reads the version they are running and opens any release note the app showed them again.
```jsx
<VersionRowView releaseNotes={{version:"0.1.28",name:"stable 0.1.28",notes:[{version:"0.1.28",name:"stable 0.1.28",cardId:"a",listed:true,shownAt:NOW}]}}/>   // notes shown
<VersionRowView releaseNotes={{version:"0.1.28",name:"stable 0.1.28",notes:[]}}/>                                                                        // none yet
```
The shared `SettingRow` shape (`--bg-1`, `--line-1` hairline, `--radius-m`) with no control of its own: the title "Version" at weight 500, then the `--text-sm --fg-3` line naming the version with its channel, "Stable 0.1.28.", followed by "Each release note you were shown opens again as you saw it." or, before any, "No release notes yet."
Under it, the notes the app showed, newest first, as a hairline list at `--text-sm`: each row the version with its channel in `--fg-1` ("Alpha 0.1.28-alpha.2"), " · no new changes" in `--fg-3` for a note that said nothing was new, and at the row's end the day it was shown in mono `--text-xs --fg-3` ("Oct 4, 2026").
Rows are separated by `--line-1` hairlines, with one above the first and none under the last; a pointer resting on a row turns its words `--accent`.
The list is one Tab stop, the row focus was last on; ↑ and ↓ move between rows and stop at either end, Home and End go to the ends, and each row draws the focus ring.
Enter or a click goes home and brings that note forward as the Help menu's What’s New does: to the front of the stack while it is open, read-only once closed.
While an update needs no answer it adds one `--text-sm --fg-3` line under the version line, in the update's own words (`UPDATE_WORK_WORDS`).
It says the update is saving work, with running work finishing first, while an update stops the crew's running work before replacing the copy.
It says the copy is updating while it installs.
After the restart it says Resuming work, with the count of tasks when more than one, until each task the update stopped has started again.
Never a version number without its channel, never a download or an update control here (the update arrow keeps those), and never a count of changes.
