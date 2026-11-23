Setting the first mate up on another computer from this app's first launch (captain's approval of INF-6207, part 2): the welcome screen's Another computer signs in there with the person's own SSH, sends Infinitary, starts the first mate there and connects to it, so the person never opens a terminal.
```jsx
<SetUpThere state="address" value="kun@studio"/>                // the address form
<SetUpThere state="key" address="kun@studio"/>                  // the key line to compare
<SetUpThere state="working" step="send" sent={42}/>             // the steps, one under way
<SetUpThere state="stopped" step="sign-in"/>                    // a stop at a step
<SetUpThere state="runs" name="studio"/>                        // Infinitary already runs there
```
**The address.**
Another computer opens the stage's framed aside (`--line-1`, `--radius-m`, `--bg-1`): "Set me up on another computer" at `--text-base --fg-1` weight 500, then Join by its address's own line, field, narrow "Port" field, small primary "Continue", "Your account" and `ON THIS NETWORK` rows (`JoinAnotherMac.prompt.md`, "By its address"), with no Cancel: "‹ Where I live" above leaves it.
Under it a ghost "Set it up with commands" opens the commands route.

**Questions.**
The key line, the password once and a root sign-in's question take the aside as Join by its address's do: the key line with "This is the computer" and a ghost "Cancel" holding focus; on Linux root, "studio signs you in as root, and Infinitary does not run as root." over "Make an account named infinitary there for your first mate?", a small primary "Make it" and a ghost "Cancel".
Infinitary already open there reads "Infinitary already runs on studio." over "Connect to it from here instead?", a small primary "Connect to it instead" and a ghost "Back".

**The steps.**
"Setting up your first mate on studio" at `--text-base --fg-1` weight 500, the address under it in mono `--fg-2`, then seven rows at `--text-sm`, each a 6px `StatusDot` and its name, with what the step found beside it in mono `--text-xs --fg-3`:
1. "Read its SSH key on port 2222" where a port was typed, otherwise "Read its SSH key"
2. "Sign in with your SSH key" - the address it signed in to
3. "Check its system" - the computer's own name
4. "Send Infinitary" - "42 MB sent" while it sends
5. "Start your first mate there" - "on after a restart"
6. "Connect from here" - "port 47623"
7. "Connect a subscription for it" - "signs in from here"

A done row has an `ok` dot, the row under way a `busy` dot and `aria-current="step"`, a row not started an `idle` dot with its name at `--fg-3`.
A ghost "Cancel" under the rows holds focus while it works.
While a Mac account waits for its login, a `--fg-2` line says "Log in on studio once.
Your first mate starts then, and this goes on."; a Linux account that does not linger shows "To keep your first mate running after a restart, an administrator runs this on studio once:" over the `sudo loginctl enable-linger` line in a mono box with Copy.

**A stop.**
The row it stopped at takes a `warn` dot, and under the rows one `warn` line says what stopped it, with a `--fg-2` line of what to try and a mono box with Copy where there is one command to run there.
Then a small primary "Ask again", a small secondary "Set it up with commands" and a ghost "Back", Ask again holding focus, and a `--text-sm --fg-3` footer: "5 more steps not started · nothing changed on studio", or "1 more step not started · your first mate keeps running on studio" once it started; no footer once an account was made or the Ubuntu package went in.
Cancel's stop says "Stopped.
Nothing was started on studio." or, once connecting, "Stopped.
Your first mate keeps running on studio."
Every control is reached with Tab and draws the focus ring; no spinner.
