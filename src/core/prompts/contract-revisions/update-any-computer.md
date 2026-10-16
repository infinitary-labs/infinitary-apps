# Updating Firstmate on any computer that runs work

FI3-879, discovered from multi-machine piece 13 (FI3-692): Settings -> Devices says when a computer that runs work runs another version of Firstmate than this Mac, and Update brings it to this Mac's version.
The `device-update` line now offers its card for every computer that runs work, not only a Mac added by its address: over Remote Login for one added that way, over the network for any other in reach on another version ("I send this Mac's Firstmate to it over your network, and it starts again."), and, for one too old to update from here, a card whose button makes the command to run there once ("Make the command").
It refuses a computer out of reach, whose version the home cannot tell, and one on this Mac's version already, as `app_change`'s answer.
The line's read value now carries each computer's `otherVersion` and whether it is in reach, so the Firstmate can say which run another version; it is read through `app_state`, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-879. device-update offers its card for every computer that runs work - over Remote Login, over the network, or as the command to run there for one too old - and refuses one out of reach or on this Mac's version; its read value carries otherVersion.
