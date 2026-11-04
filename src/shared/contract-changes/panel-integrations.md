# Panel integrations

Adds the request `inf:plugins:integrations`, a panel drawing's list, show or call on the captain's integrations over what its own manifest names.
Adds the request `inf:plugins:ask-again`, the captain's Ask again on a panel's integration call that waits on him or that he turned down.
Adds the optional field `integrationAsks` to each panel of the `inf:plugins:personal` snapshot, the panel's integration calls waiting on the captain or turned down.
An older side never sends the requests, and an older reader ignores the field, so its panels draw no ask line.
