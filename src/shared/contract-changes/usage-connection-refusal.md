Adds the optional `connectionRefusal` field to `inf:usage:reporting`: why the reporting connection's last send did not get through, as `unreachable`, `secure-connection` or `refused`.
An older side leaves it out, so the Usage view keeps naming the connection's host without a warning.
