The vocabulary: the words the app says, and the words it never says (roadmap 1.5, the plain-language pass; captain round six, revised when the captain adopted the wording).
Every string the app shows is written for someone who has never opened a terminal, and the same rule reaches the text the models write: `CARD_AUTHORING` and the persona prompts carry this page's rule and its table, so a card follows it too.
This page is the one home.
Extend it first, then implement; never keep a second list in code.

**The rule.**
Say what happened and what it means for the person, in the words they would use about their own project.
A word the person will meet in git or on GitHub is said as git and GitHub say it.
A word that names something only this app has stays plain.
A technical name of the app's own machinery is allowed exactly where the person chose it (a model, a provider, a plan), where it is the thing itself on screen (a PR number in mono, a key in mono, a file in a record), or one click deeper than the sentence (the record pane's evidence rows, Observe).
A sentence never leans on a word from the table's left column to be understood.
There is no "show technical names" switch: one vocabulary for everyone, and the detail is one click away rather than a second copy of every string.

**The table.**
Left, the word that does not reach a card or a string the app shows; right, what the app says instead.
The right column is the whole list of allowed forms; pick the one the sentence needs.

| Never say | Say |
| --- | --- |
| repo, as the app's noun | your project, the project. "repository" is allowed when the sentence points at GitHub, and in text only the models read |
| worktree, working tree, checkout | a working copy (the isolated copy this app makes). A git branch is "branch" |
| land, landing, landed, ship, put it in | merge; "merge the pull request", "merge the branch", "merge when checks pass", "merge after fixing errors", "Merged #N on GitHub", "Merged \"title\" into main", "Cannot merge" |
| save point | commit; "commit subject" |
| sent up | push; "pushed the branch", "deleted the pushed branch" |
| tidy-up | lint; "the lint found something", "the lint refused it" |
| rebase, conflict | bring up to date; "could not bring it up to date". Neither word is restored |
| quota, rate limit, window, usage | your plan's allowance; "allowance left", "resets Fri" |
| token (the credential), OAuth, credential, credential helper, keychain item, keyring, refresh token, on screen | sign-in; "your sign-in", "your GitHub sign-in", "sign in again". "OAuth app" or "token" only one click deeper, where the person must revoke it |
| remote (a git remote), origin, upstream, on screen | where the project lives; "where it lives", "the project's host". Name the host when known. "remote" in this sense only in text the models read, and one click deeper |
| CLI, command line tool, tool, gh, binary, search path, PATH | never named; say what could not be done: "something it needed is missing on this computer" |
| gh (GitHub's own program, where the person chose its sign-in) | GitHub CLI, GitHub's product by its name, only on the Integrations sign-in that uses it: "Use GitHub CLI", "through GitHub CLI", "Sign in to GitHub CLI again, then Check now." The command itself only in mono, one click deeper |
| video, clip, movie, MP4, GIF, animation, on screen | a demo, for what it shows; its recording, for the file, an MP4 or a GIF alike. "Play the demo, 12 seconds", "This recording could not be played." |
| device code, user code | the code |
| pair, pairing, unpair, grant, invite, client, view, mirror, window, remote control (as a list), for a device that uses this computer's first mate | Your devices: the Devices list's name. A computer on it "can control your first mate" while Infinitary is open there, and "can run its work"; its row reads "Controlling your first mate now"; on that computer the top line reads "Controlling your first mate on MacBook Pro". Say "add a computer", "joined", "Control it from here" (`components/devices/`) |
| revoke, disconnect, unlink, kick, forget, unregister, deprovision (a device) | Remove, for every device, at the computer where the first mate lives: "It is cut off at once", or for one that runs work "Its unmerged work comes here first". Leave, at a computer that controls it: "This computer stops controlling it" |
| home, home Mac, home computer, server, host, primary, for the computer where the first mate lives or any other | the computer by its own name ("MacBook Pro"), and "this computer" on itself |
| offline, away, disconnected, connection lost, unreachable, timed out (another computer, or another user) | out of reach; "as of 14:32"; "Changes are off until MacBook Pro is back"; "Not sent. Your words stay here until MacBook Pro is back."; for work there "Mac mini is out of reach. Its work on website catches up here when it is back." |
| helper, runner, agent, daemon, worker, service, for what Infinitary runs on another computer | never named; "Your first mate runs work there", "what Infinitary set up there" |
| machine, node, box, pool, for a device | the device by its own name ("Mac mini"), "another computer", "Running as Builder" |
| Mac, Linux computer, PC, iPhone, for what a device is | "computer" for every computer, Macs, Linux and Windows computers alike, and "phone" for a phone: "this computer" on itself, "another computer", "+ A computer", "Computers nearby", a row's "a computer" or "a phone" (the captain's choice for the Linux app, FI3-1432). One owner says them in code (`src/shared/deviceNames.ts`). A device's own name stays as it is, "Mac mini" included, and so do macOS's own names for its own settings where the sentence points at macOS: Remote Login, System Settings, a macOS user; on Linux the sentence points at "your desktop's settings" instead |
| assign, place, placement, schedule, a project on a device | Runs on; "website runs on Mac mini", "runs as Builder" (`components/devices/RunsOn.prompt.md`) |
| install, uninstall, provision, deploy, for Infinitary on another computer | "set it up", "Preparing Infinitary for Mac mini"; Remove "removes what it set up there" |
| macOS account, user account, login session, launch agent, background service | running as another user on this computer; "while Builder is logged in"; "Log in as Builder once, then switch back" |
| credential, secret, token, for what the person types to sign in on another computer | the code, your key: "It goes to Mac mini once. This computer keeps no copy." |
| secret, token, API key, credential, for what an integration signs in with | a key, named by its place: "Linear key", "Kept on this computer". "Your first mate and your crew use it but never see it." |
| token, personal access token, PAT, for what the person makes on their own GitHub Enterprise to sign in there | a key: "Make a key on github.example.com, then paste it here. It stays on this computer." The host is named by its own address in mono where it is the thing itself |
| version skew, incompatible, out of date, for Infinitary on another computer | "has an older Infinitary, so it takes no new work", "Has Infinitary 0.1.20, older than this computer's.", "It takes no new work until it is updated.", "Updating it from this computer", "Updated Infinitary on Mac mini", "too old to update from here" |
| SSH key, Remote Login | allowed: the key is the person's own, and Remote Login is what macOS calls the setting. An address such as `sam@mini.local` stays in mono |
| socket, port, TLS, certificate, key, pin, fingerprint, handshake, tailnet, IP, interface, listener | never named; say what happened: "Could not reach 192.168.1.20", "not the computer that made this link". An address stays in mono where it is the thing itself |
| pairing link, join URL, invite code, deep link, join command, install script | the link, the command; "works once", "ten minutes", "Copy link", "Copy command", "Stop it" |
| QR code | a code to scan; the A phone panel shows one beside its link |
| protocol version, contract, major version, read access | "MacBook Pro has a newer Infinitary", "Update Infinitary on this computer to make changes", "read only" |
| session, session file, transcript, JSONL | the conversation; a crewmate's "notes" |
| SHA, hash, head, in the sentence | the version; "at the latest version", "the checks failed on 3 versions" (the SHA itself stays in mono where it is the thing) |
| supervisor, orchestrator, harness, backend, transport, runtime, placement | never named; the app "sends", "checks", "runs" |
| posture, delivery posture, direct-pr, local-only | how it is delivered: "as a pull request", "merged locally, no pull request" (pill "local merge"), "built in place". The record label is "Delivery" |
| rigor, tier, quick / standard / reviewed (internal values) | care labels: "Quick", "Default", "Careful"; the reviewer's pass is "review" |
| autonomy | "Merges on its own" / "Asks first"; the switch is "Ask before merging" |
| settle (as a verb about a task) | merge it, discard it, stop it - discard and drop are plain words and stay |
| escalation, escalate, stronger model | "a stronger model", "try a stronger model" |
| inbox, wake, [fm-op], steer, drain, tick | never shown; "told", "asked", "nudged" |
| plugin, extension, add-on, package, install, uninstall, npm, manifest, capability, grant | a panel; one someone else made is "a panel by <name>", brought in with "add" / "added" and taken back with "remove" / "take it away"; what it may see is "it can read ...", in the words this table gives each thing (the exact name stays in mono beside it, one click deeper) |
| spawn, dispatch, commission | "started", "asked a helper to" |
| error, exception, stack, 401, 403, ENOENT | what happened and what to do: "the sign-in has lapsed - sign in again", "could not reach the provider - try again" |
| UTC, GMT, Z, an ISO timestamp, for a time of day | the person's local time: "since about 9:05 AM", "resets at 1:10 PM"; a time a source gives in UTC is converted first, and the zone is named only when the person asks for another |
| provider, model, plan, account | allowed: the person chose them, and they are the names on the bill |
| a model's level: premium, high, medium, low | allowed: the words Settings → Models gives the places the person put each model. Where the level is named it is "Intelligence" (the fact strip's label, FI3-439), and it is never a bare word that could be read as the reasoning; "slot", "bucket" and "rule" stay unsaid |
| thinking level, effort (minimal, low, medium, high, xhigh) | "Reasoning", with the words None, Minimal, Low, Medium, High, Extra high, and "Model's own" where the app sets none; why it is lower is "one step lower for Quick care" or "at the most this model offers" |
| Firstmate 3000, FM3000, Firstmate, for the app | Infinitary, the app's name: the app, the program, its window, its version, what is installed, updated, opened and quit, and what sends notifications. "Launch Infinitary when you sign in", "Update Infinitary on Mac mini". No other name for the app is said |
| Firstmate, FirstMate, First Mate mid-sentence, the Firstmate, for the agent the person talks to | first mate, a common noun in lowercase, never a name: "your first mate" in words a person reads ("Tell your first mate about yourself"), "Your first mate" at the start of a sentence, "my first mate" in the person's own voice ("Notify me when my first mate needs me"), "the first mate" where "your" reads wrong (a role, a list of who did what, text the models read), and "First mate" as a short label (a column, a row, a tag, a menu item, a card's author). The person and the app both say it: "Welcome to Infinitary, captain. I'm your first mate." |
| crew, crewmate | allowed: the app's own words for the first mate's helpers, the metaphor the character carries |
| project key (FM3K-9) | allowed, in mono: it is how the person refers to the row |
| clone | allowed: the word for bringing a project to this computer from where it lives; "cloned", never "copied" |
| pull request, PR | allowed: "pull request"; "PR #N" in mono, a link to its page wherever the surface takes a click (`components/cards/TaskRecord`, "Pull request links"). On a plain Git host the change is the pushed branch; a project kept on this computer has a local branch |
| the checks; CI, green, red beside them | allowed: "the checks passed", "the checks failed", "the checks are running". "CI", "green" and "red" may sit beside "the checks"; they do not replace it |
| Continue: | allowed as a filing's title prefix, the app's own convention. Only the verb around it changes: "starts once it is merged" |
| where a project lives, by name (GitHub, GitLab, git.example.com) | allowed after "on", for a project whose changes are offered there: "on GitHub", "merged on GitHub", "on git.example.com" - the provider's name is the person's, a host's address is the thing itself. Never on a project kept on this computer or one whose changes merge locally, and never as a stand-in for "where it lives" in a sentence about a host in general |

In Settings → Projects, “Ask before merging” is on for “Asks first” and off for “Merges on its own”; the persisted `autonomy` flag keeps its opposite polarity.
The collapsed badge and feed describe that flag, not the visual switch position.

**How a line reads.**
Lead with what happened, then what it means or what to do, in one sentence each: "The checks failed on the pull request.
Your first mate is fixing it."
Never a bare noun phrase ("CI red" with no "checks"), never a code or a path where a sentence would do, never an exclamation, never an apology.
The thing named is the person's: "your project", "your plan's allowance", "your sign-in".
A number is mono and carries its unit.

**Five sentence habits** (contract 4.58, FI3-542; `CARD_AUTHORING` carries them to every card author).
They were taken from a controlled-English standard for technical manuals after a side-by-side trial on five real cards, and they are written here in this project's own words.
The standard's dictionary was not adopted: it has no "pass", "fail", "fix", "now" or "why", so it would have replaced the words the table above asks for.

1. One fact per sentence, in at most 25 words.
2. One thing keeps one name.
   Where two things share a number, each takes its full name: "stable 1.4" and "alpha 1.4-alpha.2", never "1.4" for both.
3. A sentence names who or what did the work: "I updated three tests", not "three tests were updated".
   A state ("the pull request is merged") is not a hidden doer.
4. Say the thing literally.
   No figure of speech: "the third number is higher", not "27 beats 26".
5. Three or more actions in a row are a numbered list.

**Brand words.**
Use: your own, craftsmanship, made with care, a record of every task, and studio in a sentence ("your own AI studio"), never as a name.
Never use: factory, autopilot, replace, 10x, "AI Studio" as a name, or words that make the crew sound small or limited.

**Where the table does not apply.**
Observe (a developer surface in development and alpha builds only), the record pane's evidence rows and the fact strip's identifiers, a crewmate's own report to the first mate (it is read by a model), the corpus and the exporters, and everything under `docs/`.
Code comments and the AGENTS file keep their technical names; they are not the app.
Text only the models read may say "repository" and "remote"; a card still does not, except "repository" when the sentence points at GitHub.

**Evidence, never a filter.**
The rule is measured by a hand-scored sample in the replay gate (`tests/fixtures/plain-language/labels.jsonl`, scored by `scripts/interaction-metrics.ts`), not by a banned-word lint: "the checks failed" needs the word "checks", and a word list would fight honest text.
The five sentence habits are measured the same way, as a second reading of the same cards (`clear_copy_share`), and no lint counts words or hunts for passives.

Developer-facing commit subjects and pull request titles use conventional `type(scope): summary` or `type: summary` names (types: `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, `perf`; open-ended scope).
This does not change the captain-facing words above: still say “commit” and “pull request”.
