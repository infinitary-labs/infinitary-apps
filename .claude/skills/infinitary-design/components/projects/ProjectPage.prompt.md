Each project in Settings → Projects opens a page of its own, which replaces the list inside the Projects tab while it is open (the captain asked for it once the settings inline in an open row had grown too many to read and use).

**The list.**
The Projects list box holds one line per project, each a button the width of the box: the project's name, then, in quiet mono words, the same words a project's line has always said (only what is set differently from a new project, `docs/fleet.md` in the app), then a chevron pointing right at the line's end.
A project of several names itself in the UI font, followed by its task key and how many repositories it holds: "Harbor Ledger  HBL · 2 repositories".
A project of one names itself in mono, as its repository is named.
No line opens in place.
Pressing a line, or Enter or Space on it, opens its page with focus on Back.
Add project and the projects folder line stay at the foot of the list box (`AddProject.prompt.md`, `ProjectsFolder.prompt.md`).

**The page, top to bottom.**
Every project's page has the same parts in the same order, with one repository or several.
1. Back: a small ghost Button with a chevron pointing left and the word "Projects", pulled into the gutter so its words line up with the page.
2. The heading: the project's name at `--text-md`, weight 500, then in quiet mono words its task key and its count of repositories, "HBL · 2 repositories".
3. The uppercase micro label "Project" over one box holding the Name row: an Input and a small secondary Save.
   In a project of one, Name renames the project and its repository together, in mono, as it always has; in a project of several it names the project alone, and says each repository keeps its own name.
4. The uppercase micro label "Repositories" over one framed panel, the list box's own `--bg-1`, hairline and `--radius-m`.

**The Repositories panel.**
Its top edge is a strip of tabs, one per repository, drawn like the tabs on a task card: the repository's name in mono at `--text-sm`, `--fg-3`, and the chosen tab in `--fg-1` with a 2px `--accent` line under it, sitting on the strip's hairline.
After the last tab comes Add a repository, drawn the same way with a plus; it is pressed in while its form is open.
A strip too long for one line wraps onto a second, so no name is cut short.
The strip stays at the top of the Settings view while the page scrolls, so the chosen repository is named beside whichever setting is being changed.
The strip of tabs is one Tab stop, the chosen tab: ← and → move between tabs, wrapping round, Home and End go to the ends, and Enter or Space chooses one; Tab goes on to Add a repository.
Choosing a tab changes only what is inside the panel; the Project box above stays.

Inside the panel sit the chosen repository's settings, each group under its uppercase micro label:
- **Changes**: Where changes go with its notes, Target project, the held batch panel (it says who has the hold, tinted only while the next step is not the crew's, with Try again and Send back folded under Answer it yourself while a repair or a rule has it), When a batch starts on a batched project, Require pull request checks, Ask before merging, and Rigor with its warning for Careful on a project that merges locally.
- **Tasks**: Runs on (`components/devices/RunsOn.prompt.md`) and Cost limit (`CostLimit.prompt.md`); the label shows only when one of them does.
- **Details**: Scope, Folder, Where it lives and Save details, plus the repository's own Name in a project of several.
  Then the Move row (`MoveRepository.prompt.md`) and the Remove row, whose titles name their repository (`RemoveProject.prompt.md`).
  Every setting shows under the same conditions, with the same words and the same saving, as it did in the open row.

**Adding a repository.**
Add a repository shows `AddProject.prompt.md`'s form for a repository inside the panel, in place of the settings, with a ghost Cancel under it that brings the settings back.
After adding, the new repository's tab is chosen and focused, and the panel says "Added harbor-ledger-api to Harbor Ledger." above its settings.

**A newly added project.**
A project added from Add project opens its page, with Add project's confirmation ("Added launch-site.", "Started git in it", "already added") in the panel, since the form is no longer in view.

**The personal workspace.**
Its page has Back, the heading and one box with its read-only rows, and no Project box or Repositories panel, since it takes no repository.

**Leaving.**
Escape on a page goes back to the list, with focus on that project's line; Back does the same.
Escape on the list closes Settings.
Leaving Settings and coming back shows the list; no key opens a project's page.
Removing a project's last repository goes back to the list.
