# Private sites for task browsers

A computer that runs work may ask its home `inf:work:private-sites` for the captain's private sites list as a task's browser opens a page, and the home answers the list whole.
The core adds `inf:browser:private-sites`, `inf:browser:private-sites:add` and `inf:browser:private-sites:remove` for Settings, and an open effect may carry an optional `privateSite` that Settings → General adds on arrival.
A computer whose home lacks the request reads no list, so its task browsers keep refusing every private site.
The home sends a computer with an open task browser the new list at each change, as the order `inf:task-browser:private-sites`, so a Remove ends what its browsers reach at once.
A computer that lacks the order refuses it and the home only logs that, so a change reaches its browsers at their next open.
An older view draws no Private sites list and ignores `privateSite`, so the Allow button opens Settings and adds nothing.
