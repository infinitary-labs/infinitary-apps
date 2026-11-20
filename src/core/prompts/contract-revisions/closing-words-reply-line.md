# The closing sentence is the reply line

INF-772's plan, the captain's Approve and build: the first mate's closing words of each turn become its line beside the captain's message, with the app's typed line as the fallback, about 40 characters by instruction alone.
The captain asked to "lean on the firstmate agent's text response, the final text response in each turn", restricted in length "by instruction only", so that every ask ends with a response that explains what the first mate actually did.

The close sentence in `FIRSTMATE_PROMPT_CORE` now asks for one plain sentence of about 40 characters after the tool calls, saying what took effect this turn in the words the tools answered with and the card vocabulary.
A refused call did not happen, and an answer goes on a card, never in the sentence.
The captain reads it beside their message, and in the first mate's own card thread when the turn answers a reply under that card, so the thread answer is one sentence too.
The output contract's first line now names the closing sentence as the third thing the captain sees, and an operational wake's sentence is never read.
The rule's one home is the core; the host cuts none of the words, and a line too long for the message box keeps today's ellipsis with the whole text on rest.

`emote` loses its `text` parameter: the emote is motion only, and the closing sentence carries what FI3-798 asked the words to say.
The tool's description says motion only, and the core's emote sentence says the same.

The changes cost the fixed part about 15 tokens by the app's count; with them it measures 19,325, under the 19,772 boundary.

The ledger entry that comes with it:

INF-772, the captain's Approve and build. The closing sentence, about 40 characters, says what took effect and becomes the reply line and the own-card thread answer; the emote carries no words.
