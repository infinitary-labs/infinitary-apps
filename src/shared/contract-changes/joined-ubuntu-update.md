The Devices update request can name a Remote Login address and carry its confirmation line when updating an already joined Ubuntu package computer.
The update can answer with the same address confirmation question as adding by address, before connecting or installing anything.
Older views send no address and receive only the answers they already read.
A device list may name a previously verified update address separately from its pairing address.
A worker with no kept copy may answer the connection update order with `needsPackage` without stopping when its home advertises this change.
A desktop view that supports this change can opt into the package fallback with `packageFallback`, which can answer `package-address` if no verified Remote Login route completes the update.
When it tried a saved or peer address on its own and that address was refused, the answer names that address and carries the refusal's `lines`.
A refused update answer to a request that names an `address` or `packageFallback` may say `uncertain` when the change there may already have happened, so a view offers no retry; other update answers and change-address answers keep `{refused, lines}` alone, as older views read them.
