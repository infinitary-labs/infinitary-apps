# The premium wait names an empty level

FI3-848, discovered from FI3-164, which made the empty premium level on the Models board say that premium work waits until a model is added there.
A premium ask, or an escalation's rung, that no model can serve waits on its level's gate, and the `reasoning-wait` wake told the Firstmate it "waits on the premium quota reset".
With no model at that level at all, as for a person signed in to Grok only, there is no reset: the gate clears only once a model is placed there.
The wake now carries that as a typed fact (`empty`) from the route, and says "no model is placed at premium, so no quota reset will start it; it waits until one is placed at premium in Settings → Intelligence → Models" in place of the reset; with a model at that level the words are unchanged.
The prompt and the tools are unchanged, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-848. The reasoning-wait wake says a wait on an empty level ends when a model is placed there, never on a quota reset.
