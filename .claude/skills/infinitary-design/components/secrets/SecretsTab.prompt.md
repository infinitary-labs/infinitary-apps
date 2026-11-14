# Secrets

Settings → Secrets follows Settings' shared column, row gaps, type and tokens.
It sits after Integrations and before Devices, with a command-search entry and no conflicting default key.
A build without protected storage has neither the tab nor the command: nothing a person can open and not use.
That command focuses the section heading, which stays present while loading, when storage is locked or unavailable, and when the list is empty; Tab reaches its controls.
The page is built around the two things a person does: keeping a secret here, and deciding a use on the exact-use card.
Everything rarer sits in quiet rows under the list.

## The first line

The first line counts the secrets kept on this computer and says the crew uses them but never sees them.
On Linux, where any program the person runs can read the unlocked secret store, it says instead that the crew uses them only with the person's approval and that such a program can reach them.
A badge appears only when something is wrong (storage locked, unavailable or needing recovery), beside a notice that says what to do; a working store says nothing about itself.
Needing recovery, the notice says Infinitary can no longer read what this computer keeps, so no use is allowed, and offers Recovery options, which opens Keep a copy, beside Start over.
A muted line under the buttons, full width, says what Start over clears and that it cannot be undone.
Start over asks for fresh system confirmation, then leaves an empty list with saved decisions and phone approvals cleared and history kept; it is never offered while the store works.
Nothing calls an unavailable value protected.
A request waiting for an answer is one line naming its secrets, with Review request, which opens the host's exact-use card.

## Secret rows and secure entry

A search field searches names, places and the task that last used each secret, beside Add secret.
Each row leads with the secret's name and its place (the optional environment) as a tag, and ends with what last happened, in muted words: Used today by Deploy the site, Used Nov 3, Not used yet, Waiting for your answer or In use now.
The task is named by its own title; a request no task made names only when.
A request timestamp is never called proof that a value was used.
A reference appears only when another secret has the same name and place; the row never shows a saved version or a raw timestamp.
Opening a row offers Replace, Forget and that secret's saved decisions.
Forget asks on the row, never on a card, and the window stays on Settings: Replace and Forget turn into the question, "Forget the Website deployment secret?", its two sentences ("Infinitary removes it from this computer, and no task can use it after this." and "This does not turn it off where it was made, and it cannot take back a copy a program already received.") in `--fg-2`, then a small secondary Keep secret, which has focus so Enter never forgets, and a small danger Forget secret.
Keep secret changes nothing and returns focus to Forget; Forget secret removes that exact secret, the status line says "Secret forgotten locally." and focus moves to the next secret, or Add secret when none is left.
Remove, Stop approvals and Delete history ask the same way on their own rows, with their own words; one question is open at a time, and closing its row or area, leaving Settings or starting another Secrets action drops it.
Each answer is a one-time pass the app made for that question, so the page never forgets or removes by itself.
A sign-in the app keeps for one of its own services, such as Google's, opens to one line saying Infinitary keeps it for a sign-in made in Integrations and uses it without asking, and one secondary button, Manage in Integrations, reached with Tab after the row; it has no Replace, Forget or decisions.
A temporary read shows on the secret's own row as Reading until a time, beside End access; there is no separate temporary-access section.
Discovery is global: crew can find the names without receiving the values or permission to use them.
There is no project/computer linking control.
Add and Replace open an app-authored inline form, never an agent card or contributed frame.
The form asks for a name, the masked value and an optional place, and never for a reference: saving creates a readable, stable reference from the name.
The value field is a password input with no reveal button, autocomplete or clipboard action; submission clears the field before awaiting the response.
The form labels every field, explains that the value stays hidden, and keeps Cancel beside Save.
Opening focuses Name; closing returns focus after the saved list has rendered, to the original control or Add secret if a renamed row no longer matches the search.
Nothing shows an existing value, prefix or encoded substitute.

## Quiet rows

Four rows under the list open in place, each a disclosure with its name on the left and a short muted summary on the right: Saved decisions (how many), Approve from your phone (the phone's name, or Not set up), What happened (how many uses and the newest) and Keep a copy.
Saved decisions are the existing Never, Ask and Allow rules, each in one plain sentence that names its secret and the run it covers, such as Always give Website deployment (Staging) to /bin/sh deploy.sh --staging. or Never give Planning calendar to anyone., with Remove.
Remove asks on that decision's row, quoting that sentence, with Keep it and Remove decision, and Remove decision needs fresh system confirmation; a click alone grants nothing.
The page has no rule editor, dropdowns or program rehearsal form: a decision is made only on a request's approval card, and the crew checks a run before asking.
Approve from your phone lists each enrolled device with the code compared when it enrolled, beside Stop approvals; with none, it says to turn on Approves secret uses beside the phone in Settings → Devices, where approvals are set up (`components/devices/DevicesTab`, "Approving secret uses").
What happened reports metadata, storage use and export, with explicit deletion asked in place, Delete Secrets history? with Keep history and Delete history, and no automatic retention cutoff; each record names its secrets, state, time, reason and recipient.
History labels imported records as recovered history, with their source and recovery time under a disclosure, never as live approvals.
Keep a copy uses native file choices; a separately held recovery key never enters a card, a conversation or an agent-readable reply.
It says in short sentences that the copy and the key are kept apart, that there is no key reset, and that restoring replaces values, clears saved decisions, phone approvals and temporary access, and keeps history.
Each operation requires fresh system confirmation after file choice, and cancellation grants nothing.
An interrupted save reports partial files without deleting an earlier working pair; an unknown restore asks the person to inspect the selected entries rather than replaying it.

## Website sign-ins

The page ends with the website sign-ins task browsers saved (`components/cards/TaskBrowser`, "Saved sign-ins"), after the quiet rows and in every storage state: loading, locked, unavailable, needing recovery and empty.
Its lead adds that they stay on this computer in their own storage, not in protected storage, so nothing reads them as secrets.
Its rows, Remove, permission and empty line are the same as anywhere else; a build with no task browsers draws nothing there.

## The exact-use card

The title asks in one sentence: Give the Website deployment (Staging) secret to “Deploy the site”?, naming one or two secrets (or a count) and the task that asked in quotes, or Infinitary when no task asked.
Every card names a secret as the page does: its place only when another saved secret shares its name, and its reference only when name and place both repeat.
The body is labelled rows, one fact per row, label on the left in muted small type and value on the right, at one width of at most 44rem so it has one right edge.
Secret names each secret and the variable it goes in as; Runs shows the command in a dark code well as a shell reads it (the checked program's own path, so a look-alike script shows where it is, then its arguments, in single quotes and never with backslashes); In folder gives the working folder; a service shows Sends to and Request instead.
Its reason quotes the requester's reason in secondary color, with a muted line under it saying who wrote it, so it reads apart from the checked facts.
Every checked fact (each secret's environment, reference and saved version, then each check in words: the program, interpreter and files by path with how each is bound and a short fingerprint, the arguments, the folder, which variable gets which secret, that output stays private, and what is not checked) folds under one quiet Everything that was checked disclosure, whose rows stack on a narrow card.
Under a hairline, one row per allow button gives its name and what it covers: Allow once, only this secret and this run; Always allow this, the exact run it saves; or Allow for 10 minutes, the exact read it repeats on this computer.
A muted line ends the body: what receives the secret can keep it, allowing approves no separate action, and each allow asks for confirmation first.
On a card 480 pixels wide or less, each label sits above its value and nothing scrolls sideways.
The person fills in nothing: the crew checked the run before asking.
The shared approval body describes confirmation without naming a device, and clearly labels temporary access as computer-only; an enrolled phone keeps its own pinned identities and confirmation instructions.
Its answers are Allow once, Always allow this (Allow for 10 minutes and twenty uses for an eligible read instead) and Don't allow, drawn left to right as Don't allow, the second allow, then Allow once as the default; every allow needs fresh system confirmation.
Always allow this runs the shown use and saves that exact run as a decision under the same confirmation.
Don't allow sends nothing and saves nothing, raises no other card, and the next run asks again.
No card asks for a secret value.

## Availability and keyboard

An unavailable store shows its reason and refuses use rather than offering a plaintext fallback.
Locked storage leaves approval cards waiting and does not change the system's locking policy.
Each control is a Tab stop with the shared focus ring; labels, status and errors are read by assistive technology.
Disabled actions use the shared off state and explain why; enabled actions carry no stale disabled-reason label.
Narrow windows wrap rows without horizontal scrolling.
Use `settingRows.tsx`'s section, row and label gaps rather than inventing spacing.
