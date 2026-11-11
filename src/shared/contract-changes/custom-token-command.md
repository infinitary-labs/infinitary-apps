Custom connections accept an optional Settings-approved token command and refresh interval instead of a fixed key.
Their views return the command settings and an optional failure flag, never its output token.
A computer without this change cannot accept token-command connections; forwarding waits for this change before sending one.
