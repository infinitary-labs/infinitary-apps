"Projects folder": the first row of the Projects list in Settings -> Projects, where the person chooses the folder the first mate clones into and starts new projects in.
```jsx
<ProjectsFolderRow folder={{path:"~/Library/Application Support/infinitary/fleet",custom:false}}/>   // the app's own folder
<ProjectsFolderRow folder={{path:"/Users/ana/code",custom:true}}/>                                         // a folder she chose
<ProjectsFolderRow folder={FOLDER} error="/Users/ana/code/site is inside your project site. Choose a folder outside your projects."/>
```
The shared `SettingRow` shape (`--bg-1`, `--line-1` hairline, `--radius-m`), so it reads as one more row of the same list: the title "Projects folder" at weight 500, the `--text-sm --fg-3` line "Where your first mate keeps the projects it clones or starts for you.
Projects already set up stay where they are.", then the folder itself on one mono `--text-xs --fg-2` line that ellipsizes rather than wraps; while it is cut it is a Tab stop and the full path shows on rest, the pointer's or the keyboard's focus (readme, "Facts shown on rest").
The app's own folder carries an outline `Badge` "default" beside the path; a chosen folder carries none.
The control sits right: a small secondary Button "Choose folder" that opens the system's folder picker at the current folder, pending "Choosing..." while the picker is open; beside it, only when a chosen folder is set, a small ghost "Use default".
Cancelling the picker changes nothing and says nothing.
A folder the app refuses (not there, inside its own data, inside a project, one it cannot write to) is the row's inline error in `--danger` with the reason, and the row keeps showing the saved folder.
Never a text field for the path, never a move or copy of projects already set up, and never the words fleet, root, symlink or userData.
