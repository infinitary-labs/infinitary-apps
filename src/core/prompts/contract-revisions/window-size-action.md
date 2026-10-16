# Firstmate changes the whole-window size when asked

FI3-524, discovered from action catalog piece 4 (FI3-459, the captain's "Approve and build" on the action catalog plan): the whole-window size that Settings → Appearance added had no catalog line, so a change of size left no trail and Firstmate could not make one.
`app_change` gains the asked action `window-size`, whose value is `size`: 100, 110, 125 or 150 percent, the same choices as the Size picker.
It claims only the appearance row's size, so asking for it changes nothing else, and a theme change keeps the size.
The Size picker, the size keys, the View menu and command search now make the same change, each leaving one feed line and one operation attributed to whoever made it, as Firstmate's does.
The new action name costs the fixed part about 4 tokens by the app's count; with it the fixed part measures 19,581, under the 19,600 budget.

The ledger entry that comes with it:

FI3-524. app_change gains window-size (asked): the whole-window size, 100, 110, 125 or 150 percent, the same change the Size picker, the size keys and the View menu make, with one attributed trail each.
