A task's detail optionally carries, on its `closing`, the delivery facts a close as done recorded (`facts`, each its words and whether the app checked it, the first mate stated it, or it could not be read) and `onWord` when the captain's own word asked the close.
One new request, `inf:task:close-done`, is the task record's Close as done: it closes started work as done on the captain's word and answers with the close's words or a refusal.
An older side ignores the new fields and draws a closed task's line as before, with no facts under it.
An older home does not know the request, so a newer view's Close as done there fails with the home's answer and writes nothing.
