# The crewmate's words, pruned to goals and boundaries

INF-490 builds move 4 of INF-484 for the crewmate prompt, by the same four questions and measure as `firstmate-goals-and-boundaries.md`.
The prompt keeps which move comes when; how a tool works is its own description, and what the host enforces is its refusal's text.

The prompt no longer says:

- that the host refuses a nonconforming commit or pull request name: the refusal does;
- the circular-wait guidance: the refusal itself (`waitCycleWords`) gives the crewmate the loop and what to report;
- who hears a report and what to do without a report tool: `report` says the first, and every crewmate holds `report`;
- how to ask for a merge of another pull request: `check_change`'s `pull` and `emit_card`'s `request_merge` say it, and the host holds the consent;
- what a project with no checks takes: `check_change` says it;
- how to declare a repair, reserve a flake rerun or record a baseline wait: `check_change` says each, and its refusals hold the limits;
- that done means green: the direct-pr paragraph says it, and the completion card is refused until the checks pass;
- the quoted examples of a status card: the rule stays, without its cases;
- the CI paragraph: `read_workflow` and `github_write` describe the run watch, `check_change` says what green is and that a reading holds only for its version, and the completion card's refusal reads the checks again.

With the CI paragraph gone the core has five paragraphs, and a task's delivery and care select from those.
Two passages stay, marked as ceilings beside `buildCrewmateSystemPrompt`: never combining commits (PR #913), and opening each picture before it goes on a card (FI3-1101).
A Claude crewmate's fixed part falls by about 928 tokens at its largest, from 26,623 to 25,695 of 26,624; a Pi crewmate's from 26,568 to 25,640.
The replay gate moves no number.
