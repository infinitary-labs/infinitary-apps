# Any first mate or crewmate writes on a shared card

INF-2214 found the fleet's communication on cards "pretty broken" in the captain's words: a required action named a remover path the captain could not find, and the crewmate that knew the path could neither correct the card nor answer under it.
The captain approved shared cards ("Any crewmate or first mate, without a per-card permission grant.") and responses by default, and INF-2225 carries that piece out.

The first mate is now told:

- `emit_card` takes four new top-level parameters for a write on someone else's card, all served bare: `expected_revision`, the revision of that card it read, which makes the call a revision that keeps the card's author, task and answerer; `contribution_reason`; `operation_id`; and `answers_message`, the captain message a reply answers and ends.
  A call on someone else's card with neither a revision nor a reply is refused in words that say a reply alone writes only its thread, and a resent `operation_id` answers with its first result and says so, so neither the parameters nor the core repeat those rules.
- `tasks` reads one card alone with `card`: its words, revision, choices and thread with message ids; the refusals of a write on someone else's card say to read it first.
- `update_task` takes `revise_required_action` to correct a required action's wrong words once a crewmate verified the right ones, and it reopens nothing, unlike `correct_required_action`; its refusals name the filing's source and action id when they do not match, and refuse a correction that is not the same action.
- The core's card line no longer says words about someone else's card are a steer to its author, nor that only a card's author closes it: any other card takes the first mate's words, and `close_card`'s own text and refusal say whose card it withdraws.
- `close_card` no longer says to steer the author of someone else's card: its refusal says only the author withdraws it, and names revising it or replying on it.
- The refusal of a second card beside a crewmate's card says to write on that card with its id, and the answer-delivery retry names that card to write on.

The captain then chose "Only a line that says it answers it; a handoff stays open": a line ends a captain question only when it names it in `answers_message`, the card's own answerer included, so the first mate's closing words and any author line naming none leave the question open.
The first mate's about line for a card reply now names the captain's message and says to answer it with an `emit_card` reply naming it, since the closing words alone leave it open; the stuck alert's guide no longer calls the closing words its answer.
The crewmate's `reply` description, its thread-reply wake, the idle nudge and the receipts say the same.

The receipt of a write on someone else's card is read from the typed result the host saved (`cardMutationText`): created, revised, reply-only, unchanged or refused, with the revision, what stayed as it was and when the captain sees it.

The new words, net of the trims below, cost the first mate's fixed part nothing by the app's count: it measures 19,771 beside the main line's 19,772, at the 19,772 boundary.
A crewmate's grows by at most 360, to 26,615 for a Careful pull request on Claude, under the 26,624 boundary.
To fit, a rule the host already says in its own words is said only there: a stale card revision, a closed card's dated clarification, a line on a question someone already answered, a stale or completed required action, closing someone else's card with `close_card`, the revision a write on someone else's card names, which its refusal says, and the captain message a line answers, which every refusal, wake and receipt about a waiting question names.
The other rules the first mate was told twice keep one home each, recorded in the fixed-context test's ledger: `emit_card`'s descriptor says what `body` and `id` are and when to pass `task_id`, so the first mate's three parameters are served bare; `spawn_crewmate`'s `origin` and `priority` and `update_task`'s `priority` point at `create_task`'s; `update_task`'s description says a drop takes a reason, so `drop` is served bare and `reason` no longer repeats it; and `flag_duplicate`'s description names both card ids, so its two parameters are served bare.
On the crewmate's side, `reply`'s description says a line ends a captain question only when `answers_message` names it, and its `response` points at `report`'s.
`revise_required_action`'s description says to verify the right words on the target first, to read its card first, whose read lists the generation and each filing's source and action id, and that a different action is never a correction, so those parameters, the patch and the reason are served bare.
