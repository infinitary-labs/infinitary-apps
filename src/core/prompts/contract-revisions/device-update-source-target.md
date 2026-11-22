# Matching a computer to this computer's code

Settings -> Devices offers one Match for a computer on another build, and a home that runs Infinitary from its code has a Mac build the home's committed code, after asking once for each computer.
The `device-update` catalog line, which the first mate reads through `app_state`, now says what its card does when `otherVersion` names a source commit: a Mac gets the committed code, builds it and starts from it, the card asks once for each computer and then it matches by itself, that computer's running work stays paused through the whole download, install and build, which takes minutes, and a computer that is not a Mac is refused.
Before, the line promised only a moment's pause, which the first mate could repeat for a build that takes minutes.
No tool description, parameter or served prompt changes, so the fixed context is unchanged: the line reaches the first mate only through `app_state`.
