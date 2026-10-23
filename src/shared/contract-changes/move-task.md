# A card can move a started task to another provider

A card action's host effect admits one more op, `move-task`, whose `arg` is a task's id, the provider it moves off and the model the card offered (`provider/id`), joined by colons (INF-849).
The crewmate sign-in card offers it as its default, "Move to" the model the app picked, by its name, when another signed-in provider can take the task.
The home runs it when the captain presses it on any view; nothing else sends it.
An older view draws the action as it draws any host action and sends its click to the home, which runs it; an older home refuses the unknown op, so the task stays where it is.
