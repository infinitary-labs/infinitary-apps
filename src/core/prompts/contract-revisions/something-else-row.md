# Every question with options ends with Something else

FI3-1002's answer, the captain's Approve and build, with his choices: each author writes its own row and the app checks for it, worded "Something else", its field shown only once picked, on radio buttons, dropdowns and checkbox groups, an opt-out allowed with a mark on that question, and previews left out.
He asked that every card choice give a way to write something that is none of the provided options.
`CARD_AUTHORING`'s questions paragraph now says that outside a preview every radio group, select and group of two or more checkboxes ends with the author's own row worded Something else and marked `data-fm-write-in` - one more input with the question's name, or the select's last `<option>` - and that the app opens a text field under it once picked.
A question whose options are the only possible answers carries `data-fm-options-only` on its `<fieldset>` or `<select>` instead, which the app shows the captain, and a card with neither is refused at emit time.
An answer marked written in is the captain's own words: the author follows them like a reply, and asks on the card only when they cannot be followed.
In the host, the card lint refuses such a decision (`writeInGaps`), the frame bridge draws the field and reads its words as the answer's `written`, and `cardAnswerLines` words them `written in: "…"`.
The new words cost the fixed part about 156 tokens by the app's count; with them it measures 17,977, under the 18,500 budget.

The ledger entry that comes with it:

FI3-1002's answer, the captain's Approve and build (way B).
CARD_AUTHORING: every radio group, select and group of two or more checkboxes outside a preview ends with the author's own Something else row marked data-fm-write-in, whose field the app opens once picked; data-fm-options-only on the fieldset or select opts a question out, and the app shows it.
An answer written in is the captain's own words, followed like a reply.
