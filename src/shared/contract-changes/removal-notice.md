# A device hears its removal as a frame

A device that lists this change is sent `{"t":"unpaired"}` once its pairing goes, by Remove or its own `leave`, in place of every frame not yet begun, and nothing after it.
It closes the connection itself on hearing it.
The home closes the connection as `unpaired` (4401) a second after the device answered for the frame, if the device has not closed it by then.
A phone lists it, since its socket can lose a close that arrives while its own send is still going, and then reads a removal as a lost connection.
A device that lists nothing hears only the `unpaired` close, as before.
