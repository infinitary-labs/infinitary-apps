---
source: f2e3bc29a54d982b
title: Une tournée de réception
description: Faites lire par votre équipage les nouveaux tickets et demandes de tirage d’un projet selon un horaire, rédiger les réponses et publier les plus simples sous une consigne dans vos propres mots.
---

Une tournée de réception est une tâche qui lit ce que d’autres ont écrit sur votre projet, comme de nouveaux tickets et demandes de tirage, et rédige ce qu’il faut faire pour chacun.
Vous la construisez avec des éléments qu’Infinitary a déjà : une automatisation, un équipier qui ne fait que lire et une consigne dans vos propres mots.
Elle fonctionne pour tout projet qu’Infinitary atteint là où il est hébergé, sur GitHub, GitLab ou Bitbucket.

## Lancer une tournée selon un horaire {#start-a-round-on-a-schedule}

1. Ouvrez **Réglages**, puis **Automatisation**, et choisissez **Nouvelle automatisation**.
2. Sous **Quand**, choisissez à quelle fréquence elle s’exécute.
3. Sous **Projet**, choisissez le projet qu’elle concerne.
4. Sous **Dites à votre second**, écrivez votre méthode : quoi lire, comment juger chaque élément et à quoi ressemble une réponse simple.
5. Choisissez **Activer…** pour la vérifier et la mettre en marche.

Par exemple : « Lis, avec un équipier qui ne fait que lire, les tickets et demandes de tirage ouverts ou répondus depuis la dernière tournée. Rédige une réponse pour chacun, et lance une tâche qui publie chaque réponse simple. »

## L’équipier qui lit {#the-crewmate-that-reads}

Les mots des tickets et des demandes de tirage peuvent venir de n’importe qui, donc la tournée les lit en tant qu’équipier qui ne fait que lire.
Il traite tout ce qu’il lit comme de l’information, jamais comme des instructions.
Tout ce qu’il veut envoyer vous attend sur une seule carte d’approbation, quoi que dise une consigne.
Voir [Un équipier qui lit des mots que tout le monde peut écrire](/fr/integrations/#a-crewmate-that-reads-words-anyone-can-write).

## Laisser partir les réponses simples sans votre clic {#let-plain-replies-go-without-your-click}

Une réponse peut partir sans carte quand vous avez dit, dans vos propres mots, qu’elle le peut.

1. Donnez à votre second une consigne pour le projet qui dit quelles réponses peuvent partir sans demander.
   Par exemple : « Les tâches d’envoi de la tournée de réception peuvent publier des réponses qui suivent clairement notre méthode de réception, et rien d’autre ; tout ce qui est étrange ou ambigu attend mon clic. »
2. Dans votre méthode, demandez à votre second de lancer une tâche à part pour chaque réponse rédigée, qui la publie et ne lit aucun des mots des inconnus.
3. Quand une réponse est clairement couverte par votre consigne, l’équipier de cette tâche la publie une fois, sans carte, en nommant votre consigne.
   Une réponse qu’il trouve étrange, ou que votre consigne ne couvre pas, attend votre clic sur une carte.

Infinitary vérifie seulement que votre consigne tient toujours : sa formulation actuelle a été entendue de vous, et elle n’est pas retirée.
C’est votre équipier qui juge si une réponse est de celles que vos mots autorisent.
Un oui que vous avez déjà donné sur une carte pour le même travail laisse partir une réponse de la même façon.
Voir [Qui suit une consigne](/fr/knowledge/#who-follows-a-direction).

## Ce qui vous attend toujours {#what-still-waits-for-you}

- Tout ce que l’équipier qui lit envoie lui-même, quoi que dise une consigne.
- Une modification par une intégration, qui garde sa règle dans **Réglages** → **Intégrations**.
- Une modification d’un autre projet.
  Une tâche sans projet sur GitHub, GitLab ou Bitbucket passe plutôt par votre connexion GitHub, et là un oui de votre part peut laisser partir une modification vers n’importe quel dépôt.
- Une fusion, qui ne passe que par sa carte de fusion.

## Voir ce qui est parti {#see-what-went-out}

Chaque réponse publiée sans carte ajoute une ligne à l’**Activité** de sa tâche, en citant vos mots sur lesquels elle s’est appuyée.
Une réponse dont le résultat est inconnu n’est jamais renvoyée ; lisez l’élément là où votre projet est hébergé pour savoir s’il est arrivé.

## L’arrêter {#stop-it}

Pour que les réponses cessent de partir d’elles-mêmes, demandez à votre second de retirer ou de changer la consigne.
Dès lors, chaque réponse attend de nouveau votre clic.
Pour arrêter la tournée elle-même, choisissez **Mettre en pause** sur son automatisation, dans **Réglages** → **Automatisation**.

## Pour la suite {#next}

- [Automatisation](/fr/automation/)
- [Connaissances](/fr/knowledge/)
- [Intégrations](/fr/integrations/)
