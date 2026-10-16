The app while it controls the first mate on another computer (captain's picks on FI3-681 and FI3-682, 2026-10-03): the same stage, cards, feed, Tasks and conversation, served by that computer.
This computer runs no first mate of its own and keeps no record.
It signs in only to run work it is given, and those sign-ins are managed on the computer where the first mate lives (`SignInOnAMac.prompt.md`).
The examples name the computer that holds the first mate "MacBook Pro"; the app always uses that computer's own name.
```jsx
<RemoteControlLine mac="MacBook Pro" state="connected"/>
<RemoteControlLine mac="MacBook Pro" state="out-of-reach" asOf="14:32"/>
<RemoteControlLine mac="MacBook Pro" state="closed-there" asOf="14:32"/>
<RemoteControlLine mac="MacBook Pro" state="newer-there"/>
```
**The top line.**
At the left of the window's top bar, across from the Settings button: a `StatusDot`, "Controlling your first mate on" at `--text-sm --fg-2`, and the computer's name at `--text-base --fg-1` weight 500.
Under it the stage is the ordinary one: the card stack and its pager, the Activity feed, the Tasks panel and task records, and the input, which reads "give your first mate a task" with no key hint.
A picture or text file dropped on or chosen for the input or a reply becomes a chip and goes to MacBook Pro with the message, as it would there.
Any other file stays out of the message, because MacBook Pro cannot open a file on this computer: no path is typed, and the composer's line reads "Only pictures and text files can go to MacBook Pro.
Other files were not added."
Voice, panels the person added, Observe and sign-ins stay on the computer that holds the first mate and do not appear here.
The update notice at the top bar's right is this computer's own, the same notice and panel the computer that holds the first mate shows for itself, naming this computer's version.

**Settings** has two tabs.
Appearance holds this computer's own size, theme, window wash and crew model names (captain's pick), starting from the other computer's when it joins, under the line "Set on this computer only.
MacBook Pro keeps its own."
Devices holds the micro label `CONTROLLING`, the line "What you do here happens on MacBook Pro.
Its settings, sign-ins and voice stay there.", and one row in the Devices list's shape: a `StatusDot`, the name, the mono line "joined today 14:06 · 192.168.1.20", and a small secondary "Leave".

**A card button that opens Settings there.**
A card's button whose click opens one of MacBook Pro's Settings sections - Sign in, a project's Sign in again, Make a link, Make the command, Add it, Update it, Remove, Open settings - stays enabled and in its place, and its click sends nothing.
Its `note` says before the click, on rest, the pointer's or the keyboard's focus, and the card's concise inline line (`../core/Button.prompt.md`) says after it: "Do this on MacBook Pro.
Its settings and sign-ins stay there."
The card stays on both computers, so its button is still there on MacBook Pro, and no Settings tab opens here.
The card's other buttons, such as "Move to Grok" beside "Sign in", work from here as before.
While changes are off, this button is marked off like the rest.

**A crewmate's request to take over its browser.**
A task's browser shows its page only on MacBook Pro, so a request card's button that hands it to the captain - `Open browser and sign in`, `Sign in myself`, `Open browser and pay` - stays enabled and in its place, and its click sends nothing.
Its `note` says before the click, on rest, and the card's inline line says after it: "Do this on MacBook Pro.
This task's browser shows only there."
The card stays on both computers and the browser stays paused for the captain's help on MacBook Pro.
`Use my saved aurora.example sign-in` needs no one at the page, so it works from here: the browser on MacBook Pro signs in and goes back to its crewmate, the card is answered on both computers, and no browser view opens here.
`Leave waiting` works from here as before.
The card's door, `Open browser`, and the record's `Open` show the task browser's view with only its stopped shape (`../cards/TaskBrowser.prompt.md`): "This task's browser shows only on MacBook Pro." over "Watch it and take control of it there.", with no page and no Open again.

**Leave** turns the row into one question in place: "Leave MacBook Pro?
This computer stops controlling it and running its work." over "Its unmerged work goes to MacBook Pro first." when it runs work, and "To control it again, make a new link there.", with a ghost "Stay" (focused) beside a danger "Leave".
While MacBook Pro is out of reach the second line reads "MacBook Pro is out of reach, so it lists this computer until you remove it there."
Leaving returns this app to its own first launch (`JoinAnotherMac.prompt.md`), and MacBook Pro's feed says "MacBook Air left." when it can.

**Out of reach.**
When contact is lost the dot turns `warn` and the top line reads "MacBook Pro is out of reach · as of 14:32", the time in mono being the last moment this computer heard from it.
One line stands centered under the top bar, a pill (`--bg-1`, `--line-2`, `--radius-pill`, `--text-sm --fg-1`, a `warn` dot) that says why:
- lost contact: "Changes are off until MacBook Pro is back.
  It may be asleep, or on another network."
- Infinitary quit there: "Infinitary is closed on MacBook Pro.
  Changes are off until it opens again."
- a newer Infinitary there: the top line ends "· read only", with no "as of", because news keeps arriving; the pill reads "MacBook Pro has a newer Infinitary.
  Update Infinitary on this computer to make changes."
  This computer's update notice, when its channel offers a newer version, is the way to act on it.

Everything stays readable as it was.
Card buttons are marked off (`../core/Button.prompt.md`): still Tab stops, dimmed, whose description is "Changes are off until MacBook Pro is back", shown on rest as their `note` unless the pill already shows that sentence whole.
The input keeps taking words; sending refuses at once with one `--text-sm --fg-2` line above it, "Not sent.
Your words stay here until MacBook Pro is back.", and nothing is queued or sent later.
When contact returns the dot turns `ok`, this computer catches up, and the pill reads "MacBook Pro is back.
This computer caught up." with an `ok` dot, then fades over `--dur-slow` after about 2.6 s (an opacity cut under reduced motion).

Never the words home, server, host, offline, connection, socket or sync; the computer is named by its own name (`copy/Vocabulary.prompt.md`).
