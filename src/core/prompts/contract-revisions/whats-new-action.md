# Firstmate reopens a release note through What's new

FI3-932's build, grounded on its plan (the captain's "Approve and build", direction B, with "Yes, through the same door" for Firstmate).
The app now keeps a way back to the release notes it showed: the Help menu's What's New, command search's Show what's new, Settings → General → Version and Firstmate all take one door, `fm:release-notes:show`.
`app_change` gains the asked action `show-whats-new`: with no value it brings forward the newest note that listed changes, and with `version` the note shown for that version, which `app_state` lists in its current value.
An open note comes to the front of the stack and a closed one comes back read-only, so Firstmate needs no card id and makes no card; its use leaves one feed line, as `show-card` does.
The new action name costs the fixed part about 5 tokens by the app's count; with it the fixed part measures 17,816, under the 18,500 budget.

The ledger entry that comes with it:

FI3-932's build, grounded on its plan (the captain's Approve and build). app_change gains show-whats-new, the one door that brings a shown release note forward: the newest that listed changes, or a named version's from app_state. It makes no card and needs no card id.
