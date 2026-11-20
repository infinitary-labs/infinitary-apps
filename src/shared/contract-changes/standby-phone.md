# Taking over from a phone

A phone that cannot reach the home asks a computer that keeps a copy to take over (docs/devices.md, "Taking over from a phone").
The welcome a phone hears carries `standbys`: each computer that keeps a copy, with its id, name, the pin of its own key and where it listens for the other copies.
The live frame `inf:home:routes` carries the same list, so a phone that connected before a copy was kept hears it at once.
A device from before ignores both, and a home from before lists none, so its phones offer no Take over.
A computer that keeps a copy and lists this change answers a phone on `/phone`, beside the copies' own `/copies`, pinned to its own key, and admits only a phone its copy of the record lists.
On that link the phone asks `inf:standby:offer`, what Take over is based on there, and `inf:standby:take-over`, which takes over as the computer's own window does.
A computer from before answers `/phone` with 404, and the phone says it needs an update before it can take over.
