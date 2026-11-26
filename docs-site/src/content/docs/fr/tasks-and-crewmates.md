---
source: 7a56385e256eae30
title: Tâches et équipiers
description: Ce qu’est une tâche, comment elle passe de la réserve à terminée, où la suivre et comment orienter l’équipier qui s’en charge.
---

Une tâche est un travail que suit votre second, avec une clé comme `WEB-12`.
Un équipier est l’assistant d’IA qui fait le travail d’une tâche, dans sa propre copie de travail de votre projet.
Chaque tâche garde une fiche de ce que vous avez demandé, de ce qui a changé, des éléments et de ce que vous avez décidé.

## Où en est une tâche {#where-a-task-stands}

Tâches, à droite de la fenêtre, classe vos tâches selon leur état :

- **En attente de vous** : une carte de la tâche demande votre décision.
- **En cours** : un équipier s’en occupe maintenant.
- **En attente** : elle démarre d’elle-même une fois terminé ce qu’elle attend, comme une autre tâche.
- **Réserve** : elle attend que vous la démarriez.
  Appuyez sur **Démarrer** sur sa ligne quand vous voulez qu’elle commence.
- **Terminées · 7 j** : finies cette semaine.

Une ligne peut ajouter un mot après son titre, comme « bloquée », « retenue », « vérifications » ou « n’a pas pu démarrer ».
Une tâche qui n’a pas pu démarrer propose **Réessayer**.

Cliquez sur une ligne pour ouvrir la tâche.
Si une carte de la tâche vous attend, cette carte passe d’abord au premier plan.

### La marque à côté de chaque tâche {#the-mark-beside-each-task}

Chaque ligne de Tâches commence par une petite marque.
Sa forme dit où en est la tâche, et sa couleur le confirme.

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **Réserve** : elle attend que vous appuyiez sur **Démarrer**.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **En attente** : elle démarre d’elle-même dès qu’elle le peut.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **Démarrage** : Infinitary prépare son équipier.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **En cours** : un équipier y travaille maintenant.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **En cours, sur un travail de fond** : quelque chose que son équipier a lancé, comme une longue compilation ou une série de tests, tourne encore.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **En cours, en attente des vérifications** : son équipier attend la fin des vérifications sur son changement.
  La ligne ajoute « vérifications ».
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **En cours, en attente du lot** : son changement approuvé attend les vérifications du lot qu’il a rejoint.
  La ligne ajoute « groupe ».
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Inactive** : elle a démarré, mais son équipier ne travaille pas pour le moment, et son travail est gardé.
  Quand elle attend une autre tâche, la ligne ajoute « en attente ».
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Interrompue** : le tour de son équipier s’est arrêté avant la fin.
  Dites-lui quoi faire ensuite.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **En attente de vous** : une carte de la tâche demande votre décision.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **Terminée** : elle est finie.
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **Écartée** : elle a été écartée.
  Le travail écarté s’affiche sur le tableau des tâches, pas dans Tâches.

Quand l’ordinateur sur lequel s’exécute une tâche est hors de portée, sa marque garde sa forme et devient orange, et la ligne se termine par « hors de portée » ([Vos autres ordinateurs](/fr/your-other-computers/#a-computer-that-runs-work)).
Par exemple, une tâche de la réserve sur cet ordinateur affiche <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>.

Une tâche découpée en parties liste ses parties en dessous.
Dès que l’une de ses parties démarre, la tâche se range sous En cours, avec ses parties ouvertes en dessous.
La tâche y garde sa propre marque, si bien qu’une tâche dont les parties font le travail peut afficher la marque Réserve ou En attente sous En cours.

Pour lire en toutes lettres l’état d’une tâche et sa raison, laissez le pointeur sur sa ligne, ou placez-vous sur la ligne avec le clavier.

## Le tableau des tâches {#the-task-board}

Pour une vue plus complète, appuyez sur **Ouvrir le tableau des tâches** dans l’en-tête de Tâches.
Le tableau affiche En attente de vous en haut, puis trois colonnes : Réserve, En attente et En cours.

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="Le tableau des tâches : une rangée des étiquettes du projet, une tâche en attente de vous en haut, puis les colonnes Réserve, En attente et En cours." width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="Le tableau des tâches : une rangée des étiquettes du projet, une tâche en attente de vous en haut, puis les colonnes Réserve, En attente et En cours." width="876" height="493" />

Ses vues listent aussi toute la réserve, Terminées · 7 j et le travail écarté cette semaine.
Tapez une clé ou un titre dans **Rechercher une tâche** pour restreindre chaque colonne, y compris le travail terminé plus ancien.
Quand votre projet a des étiquettes, le tableau en affiche une rangée, et appuyer sur l’une d’elles restreint le tableau à ses tâches ; voir [Étiquettes](#tags).

Pour déplacer une tâche, faites glisser sa vignette vers une autre colonne, ou utilisez son menu ⋯ :

- Vers **En attente**, elle démarre d’elle-même dès qu’elle le peut.
- Vers **En cours**, elle démarre maintenant.
- De retour dans **Réserve**, elle attend de nouveau votre feu vert.
  Une tâche déjà démarrée garde son travail.
- Vers le bac **Écarter la tâche**, elle est écartée.

Un déplacement qui lancerait le travail ou l’écarterait demande d’abord une fois.
Le tableau ne fusionne jamais rien : une fusion n’a lieu que sur la carte de fusion de la tâche.

## La carte d’une tâche {#a-tasks-card}

Ouvrez une tâche pour voir sa carte.
Sous son titre se trouve une rangée d’onglets :

- **Infos** : ce que vous avez demandé, où elle en est, ses étiquettes et comment elle est livrée.
- **Cartes** : les cartes que la tâche vous a montrées, avec leur nombre.
- **Activité** : chaque ligne qu’a écrite la tâche, dans l’ordre.
- **Équipier** : la conversation de l’équipier lui-même, ligne par ligne, pendant qu’il travaille.
- **Navigateur** : une page que l’équipier a ouverte dans son propre navigateur, quand il en a une.
  Voir [Le navigateur de l’équipage](/fr/the-crews-browser/).

Un onglet n’apparaît qu’une fois que la tâche a quelque chose à y montrer.

## Une tâche découpée en parties {#a-task-split-into-parts}

Dans l’onglet **Infos** d’une tâche découpée en parties, la ligne **Parties** compte les parties closes et liste chaque partie avec son statut, dans l’ordre où elles ont été créées.
Appuyez sur le décompte pour replier la liste, et appuyez de nouveau pour l’ouvrir.
Au-delà de huit parties, les parties closes se replient derrière une ligne que vous pouvez ouvrir.
Pour ouvrir la carte d’une partie, cliquez dessus, ou atteignez-la au clavier et appuyez sur Entrée ; démarrez-la ou répondez-y là.

Une tâche de votre réserve dont les parties font le travail ne vous demande jamais son propre **Démarrer**.
Le haut de son onglet **Infos** dit plutôt ce qu’attendent ses parties, par exemple « Sa dernière partie attend que vous appuyiez sur Démarrer », et la tâche se ferme d’elle-même une fois ses parties closes.

## Étiquettes {#tags}

Une tâche peut porter une ou plusieurs des étiquettes de son projet, comme bogue ou fonctionnalité.
Vous créez les étiquettes d’un projet dans Réglages → Projets ; voir [Projets](/fr/projects/#tags).

Pour étiqueter une tâche, ouvrez son onglet **Infos** et appuyez sur **Modifier les étiquettes** sur la ligne **Étiquettes**.
Un menu liste les étiquettes du projet, et chaque coche est enregistrée aussitôt.
La ligne **Étiquettes** apparaît dès que le projet a des étiquettes.
Vous pouvez aussi demander à votre second d’étiqueter une tâche.

Vous pouvez retrouver des tâches par étiquette à trois endroits :

- **Rechercher des tâches**, dans l’en-tête de Tâches, affiche une rangée des étiquettes du projet.
  Appuyez sur une étiquette pour ne lister que les tâches qui la portent, sur **Sans étiquette** pour celles qui n’en portent aucune, ou sur **Toutes les étiquettes** pour revoir toutes les tâches.
- **Grouper les tâches**, juste à côté, liste vos tâches **Par étiquette** au lieu de **Par état**.
  Chaque étiquette forme un groupe, replié jusqu’à ce que vous l’ouvriez.
  Une tâche **En attente de vous** apparaît en tête du groupe de chacune de ses étiquettes, et reste visible même quand ce groupe est replié.
- Le tableau des tâches a sa propre rangée d’étiquettes, et sa vue **Par étiquette** compte les tâches de chaque étiquette selon leur état.

Les étiquettes s’affichent pour un seul projet à la fois : le projet qui a le focus, ou votre seul projet à avoir des étiquettes.
Pour vous concentrer sur un projet, voir [Projets](/fr/projects/#focus-on-one-project).

## Orienter un équipier {#steering-a-crewmate}

Vous pouvez dire quelque chose à un équipier de trois façons :

1. Tapez sous l’une de ses cartes, et appuyez sur **Discuter**.
2. Tapez dans la zone au pied de son onglet **Équipier**.
   Un équipier en cours de travail prend en compte vos mots tout en travaillant ; un équipier inactif repart de ces mots.
3. Dites-le à votre second, dans la zone de message.

Pour arrêter le tour d’un équipier, appuyez sur **Arrêter** dans son onglet Équipier.
La tâche reste ouverte, et vous pouvez lui dire quoi faire ensuite.

## Soin {#rigor}

Le soin est le degré de vérification du travail avant qu’il ne vous parvienne.
Il a trois niveaux :

- **Rapide** : les vérifications réussissent, et guère plus.
- **Par défaut** : l’équipier montre le changement en marche, avec des images, et exécute les tests qui comptent.
- **Minutieux** : Par défaut, puis une revue indépendante et la preuve que le changement fonctionne, avant la carte de fusion.

Chaque projet a son propre Soin, dans Réglages → Projets.
Pour une seule tâche, dites avec quel soin travailler quand vous la demandez, par exemple « sois minutieux avec celle-ci ».
Sur une carte de fusion, **Revoir minutieusement** fait passer cette tâche à Minutieux.

## Demander avant de fusionner {#asking-before-merging}

Chaque projet soit demande avant de fusionner, soit fusionne seul.
L’interrupteur **Demander avant de fusionner** dans Réglages → Projets en décide.
Quand il est activé, le travail terminé attend votre carte de fusion.
Quand il est désactivé, le travail qui réussit les vérifications peut fusionner sans vous demander, et vous recevez ensuite une carte avec son récit.
Pour le changer pour une seule tâche, dites-le à votre second.

## Une étape qui attend du travail {#a-step-that-waits-on-work}

Quand vous demandez quelque chose hors de votre projet une fois le travail fini, comme fermer un ticket ou publier une nouvelle, votre second enregistre cette étape comme une tâche à part.
Elle attend chaque tâche qui fait le travail, y compris les parties ajoutées plus tard.

- Elle ne démarre qu’une fois que chacune de ces tâches a fusionné son changement, ou s’est terminée sans rien à fusionner.
- Si l’une d’elles est abandonnée, l’étape ne fait rien et votre second vous prévient.
- Si vous avez demandé l’étape pour quand le travail sera dans une version publiée, elle attend que votre équipage enregistre une version qui contient le travail ; voir [Automatisation](/fr/automation/#when-it-runs).

Infinitary n’ajoute à un changement fusionné aucun mot qui ferme un ticket, donc un ticket se ferme par la tâche propre à cette étape.

## Fermer une tâche {#closing-a-task}

La plupart des tâches se ferment d’elles-mêmes :

- Fusionner son changement ferme la tâche.
- **Abandonner** sur sa carte de fusion écarte le travail.
- **Terminé** sur une note qui répond à votre question la ferme comme traitée.

Vous pouvez aussi en fermer une depuis sa carte :

- **Écarter la tâche** y met fin.
  Un équipier en cours de travail s’arrête, et son travail inachevé est gardé.
- **Fermer comme terminée**, sur une tâche qui a démarré, indique que le travail est fait.

Une tâche fermée garde sa fiche.
Le travail écarté reste une semaine sur le tableau, en lecture seule.
