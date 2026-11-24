# The conversation's paged read

The new request `inf:conversation:thread` reads one page of the conversation, newest first: the captain's messages with the first mate's reply lines, the captain's presses of a card's own buttons, and the lines the captain typed under cards with the author's answer (`conversationPageSchema`, `src/shared/conversation.ts`).
It takes an optional cursor, the oldest round of the page before, and a page size of at most 100.
A home from before refuses the request, and a desktop window's conversation card then shows the two rounds the last turn holds.
