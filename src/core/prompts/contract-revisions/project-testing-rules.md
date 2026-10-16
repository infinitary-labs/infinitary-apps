# A project's development practices go in its own instructions

Task FI3-1776, piece 3 of the plan FI3-1756 that the captain approved ("alright, approve and build"), corrected twice on its completion card.
First: "shouldn't testing rules always be documented into the repo's AGENTS.md / CLAUDE.md instead?"
Then: "Rules about development practices for a particular project should all follow this same rule, right?"
A project's own instruction files already load at every crewmate's start and, with piece 2, win on how tests are written and run.
A captain who states such a rule to Firstmate had no rule for where it goes: Firstmate saved it as a direction, or an aside reached only the tasks of the ask it came with.

- One standing rule: a development practice the captain states for a project (tests, style, structure, commits) goes in its own instructions.
  Firstmate spawns a crewmate to write it into the project's `AGENTS.md`, or the `CLAUDE.md` it keeps instead.
  The rule then travels with the code, is reviewed like any change, and reaches every agent that works there, not only this app's crew.
- How Firstmate runs a project's work (merges, starts, models) stays a direction, because only Firstmate acts on it.
- Three phrases the core said twice are gone: what the tools are for, which the classification list and each tool already say; "Lessons and panels use personal_ui true", which `spawn_crewmate`'s description and its `personal_ui` parameter both say; and who is standalone, which `emit_card`'s `standalone` parameter says.
- Cost: about 65 tokens for the rule, less about 45 for the three phrases, so the fixed context measures 19,599 of its unchanged 19,600 budget.
