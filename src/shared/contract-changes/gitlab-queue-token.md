# GitLab queue token

Adds the read `inf:repos:queue-credential`, whether a project keeps the token its shipped queue writes with where its host keeps one (GitLab), and when it ends; it answers null on a host whose queue needs none.
Adds the request `inf:repos:queue-credential-create`, which creates that token where the project lives with the person's own sign-in and keeps it in the project's CI settings; the token itself is never in the answer.
An older side never sends either request, and shows a project on GitLab without the token's state.
