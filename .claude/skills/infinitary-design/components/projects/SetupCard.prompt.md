The setup card: the first mate proposes a project, and the captain checks it, sets it up and adds it (captain's direction A on FI3-1531, building the card agreed on FI3-291).
The first mate may propose at any time - on the captain's message, after a crewmate's report, or on its own judgment - and every project it adds comes through this card, typed asks included.
Settings' own Add project (`AddProject.prompt.md`) adds at once and never shows it.

**Contributing from a fork.**
After adding an owned fork, an app-written card asks whether changes contribute to the original project or stay in the fork.
Its buttons read "Contribute to original", "Keep changes in my fork" and "Not now".
Neither destination is inferred from the fork relationship.
Settings → Projects adds a "Target project" row with the "Original project" and "My fork" grouped pills, using the existing row, focus and keyboard treatment.
The row explains that the choice sends changes upstream or keeps them in the fork.
When a sign-in cannot push and no owned fork exists, an app-written card asks "Make your fork of …?", with "Make my fork" and "Not now".
It explains that Infinitary asks once for this project and leaves merging to its maintainers.
The contribution's story is a note, headed "Waiting for the maintainers", with no merge or queue action.
It keeps the upstream change link and follows the maintainers' review, merge or closure.

**Who writes it.**
The app writes the card from what it checked, never the first mate, so the button does exactly what the card says.
It is a host card: the Attention chip with "first mate" as its meta, no reply field, and its id comes from the project, so asking again for the same project revises the one card.
A project already on the list gets no card.

**What it says.**
The title asks "Add dotfiles-private as a project?", with the name the project will get.
The first sentence: "Your first mate asks to add **dotfiles-private** to your projects.
Nothing changes until you click Add project."
When the first mate named waiting work, the next one: "Once it is added, your first mate starts this work: open the pull request for the runner fixes."
A fact strip follows (`.inf-facts`): "From" with the clone's address in mono and "On this computer" saying "Cloned into your projects folder"; for a new project "From: A new project" and "Started in your projects folder"; for a folder, "Folder" with its path in mono, "From" with its remote when it has one, and "Linked where it is" when there is nothing to choose.
When the first mate named the project's task key, the strip ends with "Task key" and the key in mono, such as `INF`; with none it says nothing of keys, and the app derives one from the name.
A plain folder adds one sentence: "It has no git yet, so adding it starts git in that folder with an empty first commit."

**Its rows.**
The settings read as the project's row in Settings → Projects reads (`ProjectsTab`): a hairline above each row, the question on the left in `--fg-1`, the control on the right.
In order, as the approved sketch drew them:
1. "How it lands on this computer", only for a folder that also lives somewhere else: "Link the folder where it is" (selected) or "Clone a fresh copy into your projects folder".
2. "Runs on", when the project has a remote: one select with "Automatic", "This computer", then "Your computers" and "As another user", as `devices/RunsOn.prompt.md` lists them.
3. "Where changes go": "Pull requests" or "Local merge".
4. "Ask before merging": "Asks first" or "Merges on its own".
5. "Care": "Quick", "Default" or "Careful".

A project kept only on this computer offers Local merge, not Pull requests.
Each arrives with the first mate's suggestion selected, or today's default where it suggested nothing: pull requests for a project with a remote and local merge otherwise, asks first, Default care, Automatic for a project with a remote and this computer otherwise.
The rows are plain native radios and a select, so they work from the keyboard like any card question; the name is not edited on the card.

**Its buttons.**
A ghost "Not now" and a primary "Add project", the default.
Add project sets the project up with the rows as they stand - before any task starts there - and the first mate hears once that it was added and starts the work the card named.
Not now declines the offer without adding a project, and the first mate hears that once too.
The shared minus only puts the card aside; its offer remains pending and the first mate receives no setup outcome.
A setup that fails says so in one feed line, "Could not add dotfiles-private: …", and the first mate offers the way out, such as signing in to GitHub.
