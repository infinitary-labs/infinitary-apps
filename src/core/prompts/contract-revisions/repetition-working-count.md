# Repeats that worked wake the first mate later

INF-6091's finding 4, which the captain chose to build: twelve possible-repetition wakes in one day reached the first mate for three identical calls that had all worked, and it acted on none of them.
The `possible-repetition` wake now goes out at the third identical completion only when the calls failed, or when the work computer does not say whether they failed.
Calls that worked wake the first mate at their tenth identical completion.
This changes INF-1996's count of three for working calls only.
The wake's words are unchanged; its one home is the `possible-repetition` wake in `turnWakes.ts`.
This adds no fixed-context words.
