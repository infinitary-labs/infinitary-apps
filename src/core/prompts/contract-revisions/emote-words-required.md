# An emote always says what happened

FI3-798's answer, the captain's words under its card: "actually let's make the words required. it should concisely express what the captain should know about what happened."
FI3-798 found that the Firstmate had added words to none of its own emotes since they arrived, because nothing said when to.
`emote`'s top-level `text` is now required, and its description says the words concisely say what the captain should know about what happened, at most 40 characters and never an answer.
The tool's own description says an emote comes with a few words.
Empty or whitespace-only words refuse the call as words past 40 characters do: nothing plays, the tool text says why, and the turn takes no action by it.
`emoteWords` (`src/shared/emotes.ts`) and the 40-character limit are unchanged, and words under a card still pass unseen and are never replayed, as the captain chose on FI3-622.
The app's own reactions carry no words, so the `firstmate_emote` event's `text` stays optional.
The new words cost the fixed part about 22 tokens by the app's count; with them it measures 17,738, under the 18,000 budget.

The ledger entry that comes with it:

FI3-798, the captain's words under its card. The emote's text is required and says what the captain should know about what happened, at most 40 characters; empty words are refused like over-long ones, and the app's own reactions stay wordless.
