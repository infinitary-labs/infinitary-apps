# A merge card's risk chart

FI3-1127's plan, approved by the captain with "Approve and build" and built in FI3-1128.
The crewmate's `emit_card` gains a top-level `risk` parameter: on its completion decision, and only there, the crewmate rates seven dimensions - blast radius, behavior, undo, evidence, sensitivity, novelty and dependencies - low, medium or high, each with one line why.
Its description names every dimension and what each level means, from the one table the card's notes read (`RISK_WORDS`), so a Claude crewmate reads it whole.
The crewmate's addendum says the completion decision carries one settle merge action and risk.
The card tool refuses a completion decision without risk, a risk with a dimension missing or a level off the scale, and risk on any other card, each naming the fix.
The host measures the change beside the declaration and draws both as a radar at the card's top right; no overall level exists anywhere.
The Firstmate's own `emit_card`, its prompt and its context are unchanged: its cards carry no risk, so its fixed context costs nothing more.
