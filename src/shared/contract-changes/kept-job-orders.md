A home lists the jobs its closes kept running, and checks or removes one, on the computer it runs on.
A new order, `inf:computer:kept-job`, asks a computer that runs work to run one kept job's check or remove command there, in the job's kept folder; a remove that ran cleanly takes the folder with it, and a folder outside that computer's own kept folder is refused.
New requests, `inf:automation:kept`, `inf:automation:kept-check`, `inf:automation:kept-remove` and `inf:automation:kept-forget`, read the kept jobs, run one's check or remove, or take one off the list without running anything, and reach views.
A home asks the order only of a computer that lists this change; a job on a computer without it reads as out of reach.
A view without the change never asks the new requests, and an older home refuses them, which a newer view shows as a list it cannot read.
