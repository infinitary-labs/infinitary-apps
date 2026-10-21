# A kept merge's repair is judged by its declared impact, not its kind

INF-493, INF-484 move 3's E6 piece, from the captain's approval of INF-484's plan: a repair of a change the captain approved is any new version after it, and its crewmate declares what it did to the approved work.
Until now a repair had to bring the change up to date, and the host refused one that took in no newer work, such as a reworded commit title, as changed work, so the captain was asked again for the same change.
The impact `conflict-only` is now `none`, the same word captainGuidance uses: the approved work is as it was, and the approval stands; `changed-work` and `unknown` are unchanged, and changed work still needs the captain's new click.
The settle wake's kept note now says the crewmate declares any new version it pushes, brought up to date or a fix for what stopped the merge, and that impact none keeps the approval, where it said only bringing the branch up to date was a repair and conflict-only kept it.
The fixed Firstmate context does not grow: no Firstmate tool or prompt changed.
