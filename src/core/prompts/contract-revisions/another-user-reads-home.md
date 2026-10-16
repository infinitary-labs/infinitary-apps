# Work run as another user on this Mac can read the captain's home folder

FI3-959, filed from FI3-862, which ran the command on a Mac with two real macOS users.
macOS opens every home folder to every user on the Mac, outside private folders such as Desktop, Documents and Library, so the other user read the first user's project files.
The captain chose words only: nothing changes what that user may read.
The `device-invite` line no longer says that `how: "another-user"` work cannot read the captain's files.
It now says that work runs as that user with sign-ins of its own and cannot control the Firstmate, and that like every user on a Mac it can still read files in his home folder outside private folders such as Documents.
The host's card for it says the same to the captain.
The line is read through `app_state`, offered only where this build offers devices, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-959, the captain's words-only pick on FI3-862. device-invite's another-user line drops "cannot read his files": that work cannot control the Firstmate, and like every macOS user it can read his home folder outside private folders such as Documents.
