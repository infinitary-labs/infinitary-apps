"Projects folder": one line under Add project, at the foot of the Projects list box in Settings -> Projects, where the person chooses the folder the first mate clones into and starts new projects in.
```jsx
<ProjectsFolderLine folder={{path:"~/Library/Application Support/infinitary/fleet",custom:false}}/>   // the app's own folder
<ProjectsFolderLine folder={{path:"/Users/ana/code",custom:true}}/>                                         // a folder she chose
<ProjectsFolderLine folder={FOLDER} error="/Users/ana/code/site is inside your project site. Choose a folder outside your projects."/>
```
It sits inside the list box with no hairline above it, since it belongs to Add project: the quiet `--text-sm --fg-3` words "New projects go in", then the folder on one mono `--text-xs --fg-2` line that ellipsizes rather than wraps; while it is cut it is a Tab stop and the full path shows on rest, the pointer's or the keyboard's focus (readme, "Facts shown on rest").
The app's own folder reads a quiet `--fg-3` "default" after the path; a chosen folder reads nothing there.
After them sit a small ghost Button "Choose folder" that opens the system's folder picker at the current folder, pending "Choosing..." while the picker is open, and, only when a chosen folder is set, a small ghost "Use default".
Cancelling the picker changes nothing and says nothing.
A folder the app refuses (not there, inside its own data, inside a project, one it cannot write to) is an inline error in `--danger` with the reason under the line, and the line keeps showing the saved folder.
Never a text field for the path on the Mac where the first mate lives, never a move or copy of projects already set up, and never the words fleet, root, symlink or userData.
