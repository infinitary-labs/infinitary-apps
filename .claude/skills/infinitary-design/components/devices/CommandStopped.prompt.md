# Command stopped

The notice over a window that was opened while Infinitary started by a command ran this computer's first mate, once that command no longer runs (the app's `docs/run.md`, "When the command stops").
The window joined that first mate and holds none of its own, so with the command gone it has nothing to show: it says so over the whole window, and never starts a first mate by itself.
Its words always say "started by a command", never the command's own name.

**The surface.**
The modal-level surface command search, the picture viewer and the consent dialog use: `--bg-0` at 80% under `--blur-overlay`, over the whole window, the top bar included.
On it one panel, centred: `--bg-2`, a `--line-2` hairline, `--radius-l`, `--shadow-2`, `--space-5` of padding, as wide as five `--space-9` or the window less `--space-4` at each side.
`role="alertdialog"`, `aria-modal`, named by its title and described by its line.
It grows in like a popover, from `--scale-pop` over `--dur-quick`; reduced motion makes it a cut.

**The words.**
The title at `--text-md`, weight 500, `--fg-1`: "Infinitary stopped", or "Infinitary is updating" and "Infinitary was updated" when the command ended for its own update.
Under it one line at `--text-sm` / `--fg-2` saying what happened and what the window does about it.
While whatever started the command at boot is expected to start it again, the line ends "This window waits for it." and there is no way to start it here.
Once nothing will start it again, or nothing did in time, the line ends "Start it here to carry on in this window."
The line names how the command ended only as far as its own record says: stopped, ended for its update, could not start, or "stopped without saying why" when it left no record.

**The buttons.**
At the panel's foot, right-aligned: Quit (ghost), then Start it here (primary, the notice's one accent) once it is offered.
Start it here starts Infinitary again in this window as this computer's own first mate.
Quit closes this window's program and is always there, so the person is never held in front of a window that can do nothing.
While the window waits, Quit is the only button.

**The keys.**
Focus starts on Quit, the notice's first button, as the consent dialog starts on its first: Enter alone never starts a first mate here.
Tab and ⇧Tab move between the notice's own buttons and wrap at either end; nothing underneath is reached while it is up.
Escape does nothing: the notice goes only when the command is running again, or by one of its buttons.
Enter and Space press the focused button.

**When.**
It comes up by itself the moment the window sees the command gone, and comes down by itself when the command welcomes the window again, with everything read anew.
A window opened while the command is between two starts opens straight under the waiting notice.

```jsx
<CommandStopped notice={{ state: "stopped", ending: "quit" }} onStartHere={startHere} onQuit={quit}/>
```
