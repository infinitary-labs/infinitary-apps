A computer that runs work keeps its own signed-in sites, in its own kept profile, and nothing of a sign-in crosses between computers.
It adds the browser orders `inf:task-browser:use-sign-in`, `inf:task-browser:sign-in-failed`, `inf:task-browser:sign-ins`, `inf:task-browser:sign-in-rule`, `inf:task-browser:sign-in-remove` and `inf:task-browser:sign-in-remove-all`, and the optional `rule` on `inf:task-browser:return`.
A browser fact gains the optional `kept`, `rule` and `offer`, a browser request the optional `signIn`, a Return control's options the optional `automatic`, and the Settings list of signed-in sites the optional `computers`.
A computer with the change refuses the retired `inf:task-browser:grant` in words and does nothing on `inf:task-browser:sign-out`.
A home without the change sends none of the new orders, so a browser on that computer keeps no sign-in for later tasks.
A computer without the change gets no sign-in from the home, so its browsers start signed out and keep nothing.
