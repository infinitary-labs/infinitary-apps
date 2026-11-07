# Frame parts

A device that lists this change in its hello gets any frame the home writes longer than one piece as parts (`docs/connection.md`, "Pacing and liveness").
The home first sends `{"t":"parts","bytes":N}`, then whole text messages, each one piece of the frame's JSON text cut between characters, whose UTF-8 bytes add up to N.
The device joins them into the frame and reads it as if it had come whole; nothing else comes between the parts.
So a device that hears the home only once a message has arrived hears every part of a long answer, and does not give up on one that takes longer than its wait to arrive.
A device that does not list the change, such as an older phone or computer, gets every frame whole, written in pieces of one message as before.
An older home never sends parts, and a device with the change reads its whole frames as before.
A device never sends parts to the home.
