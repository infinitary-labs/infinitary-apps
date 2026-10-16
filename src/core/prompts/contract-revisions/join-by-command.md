# Adding a computer that runs work by a command, and removing one with its work

FI3-691, multi-machine piece 12, built on the design the captain agreed on FI3-682 (`components/devices/DevicesTab` and `AddAMac`): a computer joins by one command run once in Terminal, on another Mac or as another macOS user on this Mac, and Remove brings its unmerged work home first.
The `device-invite` line takes `how`: `link` (the default, a Mac that controls this Firstmate), `command` (a Mac with no screen, which gets Firstmate from this Mac and runs a project's work) or `another-user` (work run as another user on this Mac).
`app_change` answers by filing one card the host writes: "Connect your MacBook Air" with Make a link, "Add a Mac by a command" with Make the command, or "Run work as another user on this Mac" with Make the command; only the captain's click makes the link or the command, in Settings -> Devices, and the Firstmate never sees either.
The `device-remove` line now says that a computer that runs work has its tasks stopped and its unmerged work brought here first, then removes what was set up there, and its projects run on this Mac; its card names the task it stops.
Like every device line, both are offered only where this build offers devices (`multiMachineEnabled`), and both are read through `app_state`, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-691, multi-machine piece 12. device-invite gains how (link, command, another-user), each a host-built card whose click makes that link or command in Settings -> Devices; device-remove says a computer that runs work brings its unmerged work home and removes what was set up there before it goes.
