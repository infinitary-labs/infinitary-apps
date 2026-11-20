# Carry tasks on

A device on the list gains three optional fields: `earlier`, the ids of entries out of reach with its name and user that joined before it, `carriesOn`, set on an entry out of reach whose tasks or projects can continue elsewhere, and `carrying`, the id of the computer its tasks are moving to.
A new request, `inf:devices:carry-on`, moves the tasks and projects of a computer out of reach to another computer, then removes the old entry once every task has moved.
A view without this change shows no Carry its tasks on and never sends the request; a home without it lists no such fields.
