# An event rule can say why it stopped, and a save can point it again

An Automation rule admits an optional `stopped`: why an event rule waits though its integration's id is connected, because that id now stands for another connection or the rule was saved before the app could tell (INF-947).
`inf:automation:save` admits an optional `reconnect`: the person picked the rule's integration again, so it listens to what that id stands for now.
An older view shows a stopped rule without the reason and cannot point it again; an older home refuses a save that carries `reconnect`, while a save without it works as before.
