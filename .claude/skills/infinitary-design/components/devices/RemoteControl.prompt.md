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
Voice, panels the person added and Observe stay on the computer that holds the first mate and do not appear here.
The update notice at the top bar's right is this computer's own, the same notice and panel the computer that holds the first mate shows for itself, naming this computer's version.

**Settings** shows the first mate's own sections, read and changed on MacBook Pro, but Secrets and Observe, beside this computer's Appearance, Keyboard and Devices.
Appearance holds this computer's own size, theme, window wash and crew model names (captain's pick), starting from the other computer's when it joins, under the line "Set on this computer only.
MacBook Pro keeps its own."
Devices holds the micro label `CONTROLLING`, the line "What you do here happens on MacBook Pro.
Its Secrets and voice stay there.", and one row in the Devices list's shape: a `StatusDot`, the name, the mono line "joined today 14:06 · 192.168.1.20", and a small secondary "Leave".
Under it, a section gap below, is MacBook Pro's own Devices tab, as MacBook Pro shows it: its computers and phones, its ways to add one, and each row's Update and Remove, read and changed there.
Its intro says "Your first mate lives on MacBook Pro.
Its tasks and conversation stay there.
From any computer you add you can control it, and any computer you add can run a project's work.
Running as another user on MacBook Pro only runs work.
Like every user on MacBook Pro, it can read the files your home folder lets other users read.", the sentence that holds on each system, since this computer does not know MacBook Pro's.
MacBook Pro's own row reads "Your first mate lives there", and every sentence MacBook Pro says of itself as "this computer" names MacBook Pro instead.

**A card button that opens Settings.**
A card's button whose click opens a Settings section - Sign in, a project's Sign in again, Open settings, and MacBook Pro's Devices with Make a link, Make the command, Add it, Update it, Remove - is sent and opens that section here, doing what it asks on arrival.
While changes are off, these buttons are marked off like the rest.

**A first mate on an older version.**
Where MacBook Pro is too old to answer what a view asks, a Settings section shows the one line "Update Infinitary on MacBook Pro to do this from here." in place of its rows, and a card's button that opens Settings stays in its place, sends nothing and says the same.
Appearance, Keyboard and Automation are unchanged; Devices keeps its `CONTROLLING` row and Leave, and shows the same line under it in place of MacBook Pro's list.

**A crewmate's request to take over its browser.**
A task's browser shows its page here as on MacBook Pro, so a request card's button that hands it to the captain - `Open browser and sign in`, `Sign in myself`, `Open browser and pay` - works from here: the card is answered on both computers and the browser view opens here, its pictures sent from MacBook Pro, with Take control and the captain's typing going back to the page there.
`Use my saved aurora.example sign-in` needs no one at the page, so it works from here too: the browser on MacBook Pro signs in and goes back to its crewmate, the card is answered on both computers, and the browser view opens here.
Only while Infinitary on MacBook Pro is too old to send its pictures does the take-over button stay enabled and in its place with a click that sends nothing; its `note` says before the click, on rest, and the card's inline line says after it: "Update Infinitary on MacBook Pro to show this task's browser here."
`Leave waiting` works from here as before.
The view's words name MacBook Pro where they would say this computer: `Remember my aurora.example sign-in on MacBook Pro`, `saved on MacBook Pro`.
While changes are off, the view's Take control, Return control, Stop browser, Open again, Back, Forward, Reload, other pages' tabs and a card's project-page button are marked off like every other card button, their `note` the same reason, and the page takes no input, the line under it saying why.
The card's door, `Open browser`, and the record's `Open` show the task browser's view with its live page, as on MacBook Pro; only while Infinitary there is too old do they show its stopped shape (`../cards/TaskBrowser.prompt.md`): "Update Infinitary on MacBook Pro to show this task's browser here." over "Until then, only a window on MacBook Pro can show it.", with no page and no Open again.

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
  For an older MacBook Pro that answers its own update from afar (`home-update`, `docs/view.md` "Updating the first mate's computer"), Settings → General carries one more row under Update channel, "Infinitary on MacBook Pro": its description says where that update stands ("MacBook Pro has 0.7.2-alpha.590 ready."), and its control is a small secondary Update MacBook Pro.
  Update arms the row in place rather than opening a dialog: the description becomes "Update MacBook Pro to 0.7.2-alpha.590?", a `--text-sm --fg-2` list beneath names the running work that finishes first, the background jobs that stop and that it cannot be undone from here, and the control becomes Not now (ghost) beside Update MacBook Pro (primary), both small.
  While it saves the control is Update later; while MacBook Pro restarts the row reads "Restarting MacBook Pro." and offers nothing.
  A Settings section that waits for that update shows the same row under its words; on MacBook Pro the update panel opens by itself and says "Mac mini asked for this update."
  (`../core/UpdatePanel.prompt.md`).
- a version apart, while MacBook Pro still hears words (`messages-while-reading`, `docs/view.md` "Read only"): the pill reads "MacBook Pro has a newer Infinitary.
  Your first mate still hears your messages, and buttons come back once Infinitary on this computer is updated.", or "MacBook Pro has an older Infinitary.
  Your first mate still hears your messages, and buttons come back once Infinitary there is updated." when MacBook Pro is the older side.
  The input sends words alone, as the captain's message; a message with pictures or files stays in the box with one `--text-sm --fg-2` line above it, "Only words can go until Infinitary is updated.
  Remove the pictures and files to send this."

Everything stays readable as it was.
Card buttons are marked off (`../core/Button.prompt.md`): still Tab stops, dimmed, whose description is "Changes are off until MacBook Pro is back", shown on rest as their `note` unless the pill already shows that sentence whole.
The input keeps taking words; except where MacBook Pro still hears words, sending refuses at once with one `--text-sm --fg-2` line above it, "Not sent.
Your words stay here until MacBook Pro is back.", and nothing is queued or sent later.
When contact returns the dot turns `ok`, this computer catches up, and the pill reads "MacBook Pro is back.
This computer caught up." with an `ok` dot, then fades over `--dur-slow` after about 2.6 s (an opacity cut under reduced motion).

Never the words home, server, host, offline, connection, socket or sync; the computer is named by its own name (`copy/Vocabulary.prompt.md`).
