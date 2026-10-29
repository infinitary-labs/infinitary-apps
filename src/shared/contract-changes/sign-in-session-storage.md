# Session storage in saved website sign-ins

A held website sign-in (`heldSignInSchema`) carries optional `session`, the session storage of the site's own origins, beside its cookies and local storage.
It rides the `inf:task-browser:grant` order, the `inf:task-browser:return` answer, the `inf:work:browser-event` sign-in event and the `inf:work:browser-sign-in` answer.
A side without the change drops the field, so a browser there uses and copies back cookies and local storage only.
A missing field reads as none on a grant, and as no change to the saved session storage on a copy back.
