The Models board (Settings → Intelligence → Models): one lane per level - premium, high, medium, low - and a Not in use lane under them, each model a pill in every level it is used at.
A pill reads provider then model label in mono (the provider is dropped where the label already starts with it: "Claude Opus 5.5", "Grok 4.7"), a `new` micro label on a model this install has not seen, and `✱` on a model set to always use.
An empty level says where its work goes instead: high and low run on medium, medium on high.
An empty premium level never says its work runs lower, because an ask for premium waits: its hint says the work waits until a model is added there or the person chooses to run it lower.
Where a control sits says how far it reaches (captain's pick from the three-way prototype review, 2026-10-02):

- **Inside a lane, a control changes that one level.**
  The × on a pill removes the model from that level only, never from the others.
  "Add model" adds one here.
  Each used model sits in a full-width row, its existing draggable pill on the left and a mono reasoning menu beside it.
  The row wraps naturally on narrow layouts, never clipping the menu.
  Each lane names its default reasoning under its unchanged work hint.
  The menu includes Use level default and only the backend's supported choices from Low through Extra high.
  Beside it, muted mono words name the effective level and whether it is inherited or chosen, including Quick care.
  Fixed models show None or Model's own without a menu; unknown support says reasoning choices are unavailable.
  A saved choice that lost support stays visible beside its effective value, and Use level default can clear it.
  A refused save shows a short inline explanation and keeps the saved choice; keyboard focus returns after saving.
  Reasoning reaches only new crew conversations, never the first mate or Decisions.
- **Dragging a pill moves it.**
  A plain drop on another lane moves the model there; ⌥ held at the drop keeps it at both; a drop on Not in use removes it from every level.
  While a pill is over a lane the lane carries a dashed drop pill saying what the drop will do - "Move to low", "Also use at low", "Use at high", "Remove from high and medium", "Already at medium" - so nothing surprises.
  The dragged pill stays under the pointer where it was grabbed, at its own width; the pill it left dims to 35 percent until the drop.
  Escape cancels.
  Every drag has a click path: the × and Add model, or the panel.
- **The model panel changes the model as a whole.**
  It is absent until a pill's name is clicked, then opens beside the lanes (296 px, sticky; stacked under them in a narrow column) and closes with its × or a second click on the name.
  It carries provider and label, one line on where the model is used, all four levels as checkboxes drawn with the `SlotBadge`, "Always use ✱" as a `Switch` (the routing pin: all crew work goes to this model, levels are skipped), and "Remove from all levels" naming the levels it leaves.
  A Codex model also carries a native Crew speed menu, initially Standard, shared across accounts that support the chosen speed.
  Fast and Ultrafast appear only as selectable choices when fresh account metadata advertises them; an unavailable saved choice remains visible and can be cleared to Standard.
  Muted text beside the menu explains that Ultrafast uses 8× included allowance or 6× purchased credits, and that the first mate and Decisions stay Standard.
  A refused save keeps the previous choice, shows an inline explanation, and returns keyboard focus to the menu.
  Existing level controls do not need a scope label; the panel is their scope.
- **A model set to always use** also puts one banner above the lanes: "All crew work goes to <model>.
  Levels are skipped while always use is on." with a ghost "Turn off", or, while Dynamic routing is off, that it applies when Dynamic routing is on.
  A second always-use model is named as the fallback.
- No row menu, and no action that reaches past the lane it sits in.

One pill per LISTED model per level, never one per catalog id.
A provider can serve hundreds of ids (OpenRouter's 47 vendors; Claude's re-listed older generations), so the board lists the newest generation of each family the app tracks, the starter rows, and whatever the person placed in a level, set to always use, or chose as the first mate's model (`docs/model-lists.md`).
Pills keep the board's order: provider A-Z, family by newest generation, newest generation first, then tier - a newcomer always lands at the top of its family, and a generation the person kept sits right beneath the one that replaced it.

Everything else a subscription serves is reachable by name, never as pills:
- Each level's "Add model" picker opens with a search `Input` (`mono`, placeholder "Find a model by name", focused on open).
  Typing filters the listed models first; below them, under the micro label "More from your subscriptions", matching unlisted models - at most 12, in board order, each the same row button as a listed one (provider label, then the model's label in mono, then where else it sits).
  Choosing one places it in that level, which keeps it listed from then on.
- With nothing typed the picker shows only listed models; the unlisted list never renders on its own.
- A query that matches nothing reads "No model by that name" in `--fg-3`, `--text-xs`.
- An empty Not in use lane never claims every model is placed while unlisted ones exist.
  It reads "Every model shown is in a level." followed by "Find more from your subscriptions by name under Add model."
  With nothing unlisted it reads "Every model sits in a level."

The first mate's model picker (Settings → Intelligence) is a native `select` over the listed models plus "Another model by name…", which swaps in the same mono `Input` with a `datalist` of the unlisted models that can run the first mate; Enter or a pick sets the model, and Escape returns to the select.
Beside it in the same row sits the first mate's account picker, a second mono `select` labeled "First mate account", 8px to its right and narrower (two `--space-9`), shown only when two or more accounts here of the provider of the first mate's model can answer (not paused, not needing a sign-in, ready); the two stay side by side at every window width, and the row's words wrap beside them.
With it the row is titled "First mate model and account", and its description names the provider and says it is apart from crew work: "The model your first mate itself answers with, and the Codex account it answers on; crew work keeps its own preferred account.
Auto tries high, medium, premium, then low across your subscriptions; a change applies at the next idle moment."
Its options are the accounts by their labels; one that cannot run the first mate stays listed as "Old team · paused" (the row's own word) and cannot be picked, and with nothing chosen yet it opens on "Not chosen yet".
Crew work's preferred account stays in the account row's menu, "Prefer for crew work", and its ✱ says "Crew work prefers this account" on rest and in its name, so the two choices never share a word.

No count of unlisted models, no "show all" switch, and no newcomer badge on an unlisted model: what is not listed is not news.
Decisions is its own setting under the lanes, not a fifth level (`docs/decision-models.md`).
