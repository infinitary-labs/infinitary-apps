# Claude tool names

INF-3718 found why the first mate on Claude sometimes called a tool by its short name: Claude offers each app tool only by its full name, while everything the first mate reads names the tools short and never says how the two match.
The captain chose direction A: give the first mate the same sentence Claude crewmates already read.

- The core, on Claude only: "Wherever these instructions name an app tool by a short name, call it as mcp__infinitary__<name>." follows the served prompt, the same constant the Claude crewmate note ends with. The prompt on every other backend is unchanged, so the fixed context the local-window budget measures does not grow; a Claude request grows by about 25 tokens.
- The contract stamp's prompt sha is the served prompt's on each backend, so a Claude seat recorded before this change starts its session over once.
- spawn_crewmate's shape.review_of description: a review runs on its builder's computer, so omit runs_on_ask. Its refusal now names that computer and says the same call without runs_on_ask starts the review.
- spawn_crewmate's branch_from description: the task's last commit must be held on this computer; for work still on another computer, name its pushed version in the brief instead. The refusal for work on another computer now names that step, with the task's pull request or branch.
- steer_crewmate's response_context description: pass it as a refusal names it, and omit it otherwise. Its refusal now names the card's current lifecycle and captain messages, or says to leave it out.
