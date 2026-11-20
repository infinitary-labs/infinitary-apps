# The quit is the pause

INF-1272's accepted plan (direction A) teaches the first mate that an update needs no pause.
On October 24 the captain said "pause all active work. i'll restart and update the app", and the first mate interrupted five tasks, which ended a kept merge approval and counted each message in flight as handled; the quit alone would have paused every turn and carried it on at the next launch.
The captain chose that a stop the captain or the first mate makes still ends a kept approval: only quits and updates keep it.
The core gains one standing rule: a quit, restart or update, here or on a computer that runs work, pauses each turn, the next launch carries it on with kept approvals standing, so the first mate stops no task for one and steers none after.
`interrupt_crewmate`'s description now says an interrupt ends a kept merge approval and the crewmate waits until steered; its one home is that tool.
A new `model-unasked` wake tells the first mate once per pair of models when a task answers on a model its routing did not choose: both models by their Settings names, whether Claude Code fell back after a refusal or the conversation opened on another model, and whether the captain named the asked one.
At launch, one feed line names the tasks that carry on by themselves; it wakes no one.
To keep the fixed context inside its budget (`tests/firstmate-fixed-context.test.ts`), `emote`'s description drops the sentence the core already says (an emote never replaces a card or work) and `steer_crewmate`'s drops the one `interrupt_crewmate` already says (lifecycle control is never a steer), and `interrupt_crewmate`'s own words are shorter.
