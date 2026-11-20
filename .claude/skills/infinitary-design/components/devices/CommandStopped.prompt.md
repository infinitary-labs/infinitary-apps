# Command stopped

The notice over a window that was opened while Infinitary started by a command ran this computer's first mate, once that command no longer runs (the app's `docs/run.md`, "When the command stops").
The window joined that first mate and holds none of its own, so with the command gone it has nothing to show: it says so over the whole window, and never starts a first mate by itself.
Beside a command the person set up, its words say "started by a command", never the command's own name.
Beside the program the window started itself (`byWindow`), the person never ran a command, so the line speaks of their first mate instead, as in "Your first mate could not start."

**The surface.**
The modal-level surface command search, the picture viewer and the consent dialog use: `--bg-0` at 80% under `--blur-overlay`, over the whole window, the top bar included.
On it one panel, centred: `--bg-2`, a `--line-2` hairline, `--radius-l`, `--shadow-2`, `--space-5` of padding, as wide as five `--space-9` or the window less `--space-4` at each side.
`role="alertdialog"`, `aria-modal`, named by its title and described by its line.
It grows in like a popover, from `--scale-pop` over `--dur-quick`; reduced motion makes it a cut.

**The words.**
The title at `--text-md`, weight 500, `--fg-1`: "Infinitary stopped", or "Infinitary is updating" and "Infinitary was updated" when the command ended for its own update, or "Infinitary is not answering" when the command still runs and has not answered the window in time.
Under it one line at `--text-sm` / `--fg-2` saying what happened and what the window does about it.
While whatever started the command at boot is expected to start it again, the line ends "This window waits for it." and there is no way to start it here.
Once nothing will start it again, or nothing did in time, the line ends "Start it here to carry on in this window." beside a command, and says Start it here starts it again beside the program the window started.
The line names how the command ended only as far as its own record says: stopped, ended for its update, could not start, or "stopped without saying why" when it left no record.
A command that runs and does not answer says so, "running but not answering", and offers to wait for it or start it here, which stops that command first.
Beside the program the window started, it also offers Restart it, which ends that program by force and starts it again, and the line says so; the notice then waits for it as for any start again.
A command that ended to start its first mate again here, after a move to another computer failed or the person started it here again, reads as stopped: never as an update.

**The buttons.**
At the panel's foot, right-aligned: Quit (ghost), then Start it here (primary, the notice's one accent) once it is offered.
Over the program the window started that runs and does not answer, Restart it comes last as the primary, and Start it here steps down to ghost, so the notice keeps one accent.
Start it here starts Infinitary again in this window as this computer's own first mate, or, beside the program the window started, starts that program again and waits for it.
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
<CommandStopped notice={{ state: "stopped", ending: "quit" }} onStartHere={startHere} onRestart={restart} onQuit={quit}/>
```
