# Asking which way to add a computer when the captain did not say

FI3-1342, from the captain's question after asking to set up his "mac-home" as another machine that can run workers: the Firstmate picked `how: "command"` on its own, so its card offered only a command, while Settings -> Devices also offered adding it by its address.
His words: "i want you to start a fix now - probably a light instruction tweak so we offer all options in this case".
The `device-invite` line now tells the Firstmate that when the captain has not said which way, it never picks one for him: it first asks on one decision card, with every way as an option - a link, a command, the Mac's address over Remote Login, or another user on this Mac - recommending the address, with a field for it, when he can name the Mac's address, and then passes his choice.
The host's own card for each way is unchanged.
The line is read through `app_state`, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-1342. device-invite asks the captain which way to add a computer, on one decision card with every way, when he has not said, instead of picking one; the host's cards are unchanged.
