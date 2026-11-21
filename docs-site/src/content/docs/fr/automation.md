---
source: 3ada960e24611905
title: Automatisation
description: Donnez à votre second une consigne qui s’exécute selon un horaire ou quand quelque chose se produit, et mettez en pause, modifiez ou relisez chacune dans les Réglages.
---

Une automatisation est une consigne que votre second reçoit selon un horaire.
Vous écrivez ce qu’il faut dire à votre second, et vous choisissez quand.
Le moment venu, votre second reçoit la consigne et agit comme si vous veniez de l’envoyer.

Vous pouvez en créer une dans les Réglages, ou dire à votre second quoi lancer et quand.

## Où se trouvent les automatisations {#where-automations-live}

Ouvrez **Réglages**, puis **Automatisation**.
Vous pouvez aussi chercher **Ouvrir Automatisation** dans la recherche de commandes.

La liste de gauche affiche chaque automatisation avec son état :

- **Active** s’exécute à sa prochaine heure.
- **Brouillon** est enregistrée mais ne s’exécute jamais tant que vous ne l’activez pas.
- **En pause** garde ses réglages mais ne s’exécute pas.
- **Terminée** est une automatisation ponctuelle qui s’est exécutée et attend que votre second la traite.

Choisissez une automatisation pour la lire ou la modifier.
**Rechercher des automatisations** en trouve une par son nom, sa consigne ou le moment où elle s’exécute.

## Créer une automatisation {#make-an-automation}

1. Ouvrez **Réglages**, puis **Automatisation**, et choisissez **Nouvelle automatisation**.
2. Donnez-lui un **Nom**, comme « Revue hebdomadaire ».
3. Sous **Quand**, choisissez à quelle fréquence elle s’exécute.
4. Sous **Projet**, choisissez le projet qu’elle concerne, ou laissez **Aucun projet**.
5. Sous **Dites à votre second**, écrivez la consigne.
6. Choisissez **Enregistrer le brouillon** pour la garder pour plus tard, ou **Activer…** pour la vérifier et la mettre en marche.

**Aperçu** affiche les trois prochaines exécutions, et la consigne telle que votre second la recevra.
Rien n’est envoyé.

## Quand elle s’exécute {#when-it-runs}

- **Se répète** s’exécute toutes les tant de minutes, au plus toutes les 15 minutes.
- **Tous les jours** s’exécute à une heure de la journée.
- **Les jours choisis** s’exécute les jours de la semaine que vous choisissez, à une heure de la journée.
- **Une fois** s’exécute à une date et une heure.
- **Quand quelque chose se produit** s’exécute chaque fois que quelque chose de nouveau se produit, comme **Une tâche se ferme**, ou un événement venant de quelque chose que vous avez connecté dans les Réglages.

Une automatisation quotidienne ou hebdomadaire garde le **Fuseau horaire** que vous choisissez, pour s’exécuter à la même heure où que se trouve votre ordinateur.

**Insérer un détail de planification** place un détail dans votre consigne, comme l’heure prévue.
Chaque détail est rempli au moment où la consigne est envoyée.

## La mettre en marche {#turn-it-on}

Une nouvelle automatisation créée dans les Réglages commence comme brouillon.
Un brouillon ne s’exécute jamais.

Quand vous choisissez **Activer…**, la fiche montre ce qui va se passer avant que rien ne s’exécute :

- quand elle s’exécute et dans quel fuseau horaire,
- le projet et la consigne exactement telle que votre second la reçoit,
- ses prochaines exécutions,
- ce qu’elle envoie : la consigne et les détails de sa planification vont à votre abonnement d’IA et restent dans la conversation de votre second, et rien d’autre n’obtient de nouvel accès,
- ce qu’il advient d’une exécution manquée.

Choisissez **Activer** pour la lancer, ou **Retour** pour revenir sans rien changer.

Votre second peut aussi créer des automatisations.
Une automatisation récurrente que votre second crée de lui-même attend comme brouillon jusqu’à ce que vous l’activiez.

## Mettre en pause, modifier ou supprimer {#pause-change-or-delete}

- **Mettre en pause** arrête une automatisation active.
  Une consigne qu’elle n’avait pas encore remise est retirée.
- **Reprendre** la relance à partir de sa prochaine heure.
  Elle ne rattrape pas le temps passé en pause.
- **Tout mettre en pause** met en pause toutes les automatisations actives d’un coup.
  Elle laisse les brouillons tels quels.
  Vous pouvez aussi chercher **Mettre en pause toutes les automatisations** dans la recherche de commandes.
- **Supprimer**, puis **Supprimer définitivement**, la retire avec son historique.
  Les tâches et les cartes auxquelles elle a mené restent.

## Quand Infinitary est fermé {#when-infinitary-is-closed}

Les automatisations ne s’exécutent que lorsqu’Infinitary est ouvert et que l’ordinateur est éveillé.
Si une heure passe pendant qu’il est fermé, l’automatisation s’exécute une fois à la réouverture d’Infinitary, et la consigne indique combien de fois elle a été manquée.

## Historique {#history}

Sous la fiche d’une automatisation, **Historique** liste ses exécutions, les plus récentes en premier.
Chaque exécution indique où elle en est :

- **En attente** : votre second ne l’a pas encore traitée.
- **Nouvel essai** : votre second n’a pas encore pu la prendre, et un nouvel essai est en cours.
- **Traitée** : votre second l’a traitée.
- **Annulée** : elle a été retirée avant que votre second ne la lise, par exemple parce que vous avez mis l’automatisation en pause.

Une exécution traitée montre ce qu’a trouvé votre second, après **Trouvé :**, et les tâches et cartes auxquelles elle **A mené**.
L’historique garde les exécutions 30 jours.

## Notes {#notes}

Une automatisation peut garder des **Notes** que ses exécutions écrivent pour les suivantes, pour que la prochaine démarre plus vite.
Un équipier lancé par une automatisation les modifie, et vous pouvez les modifier aussi.
Ce sont des conseils, jamais des instructions.
**Versions précédentes** affiche chaque version passée et qui l’a écrite.

## Toujours en marche {#kept-running}

Sous la liste, **Toujours en marche** affiche les programmes qu’un équipier a mis en place à votre demande et qui continuent de tourner après la fermeture de leur tâche.
**Vérifier** regarde si un programme tourne encore, et **Retirer** le supprime.

## Le panneau Automatisation {#the-automation-panel}

Dès que vous avez une automatisation, le panneau **Automatisation** s’affiche sur le côté de la fenêtre.
Il liste l’état et la prochaine exécution de chaque automatisation.
Cliquez sur l’une d’elles pour l’ouvrir dans les Réglages.
Voir [Panneaux](/fr/panels/).
