# A pull request a card names is a link to its page

FI3-1307, filed from FI3-1159 ("Rethink the task card's information layout").
On that plan card the captain asked "can / should we make the PR a link that can open it? i feel that should be a consistent experience whenever we render a PR number?", and ticked "Also file a separate task so Firstmate and the crew link the pull request numbers they write on their cards. It changes their instructions, so it gets its own measured check."
FI3-1159 linked every pull request number the app itself draws; a number an agent types in a card body was still plain text unless the author wrote a link.

`CARD_AUTHORING` now tells both personas that a pull request a body names by its number is a link to its page, written `<a class="fm-mono" href="its page">PR #N</a>`.
A task's pull request page is the `change` on its `tasks` row; a number whose page no tool answer gave stays plain mono, never a guessed address.
A crewmate is also told its own pull request's page is in the `open_change` and `check_change` answers, and any other's in a `github_read` answer.
The `tasks` query's rows gain `change`, the task's change label and its page where the project lives has one, so the Firstmate, which holds no forge tool, has the page to link.
The rule is the author's; the host reads no number out of a body.
The frame stylesheet draws a link in mono as every pull request link the app draws: the accent, underlined only while the pointer rests on it.

The Firstmate's fixed context grows by 64 tokens in the app's count, from 19,043 to 19,107, inside the 19,401 budget (`tests/firstmate-fixed-context.test.ts`); a crewmate's prompt grows by about 95.
The replay gate gains `pr_link_share`, a third hand reading of the recorded cards (`docs/replay-harness.md`); its starting line is 0 on the two sessions that show a card naming a pull request.

The ledger entry that comes with it:

FI3-1307. A pull request a card body names by its number is a link to its page, `<a class="fm-mono" href>`; the page comes from a tool answer, a task's from the new `change` on its tasks row, never a guess; `pr_link_share` scores it on recorded cards.
