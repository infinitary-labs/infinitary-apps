---
source: ef5bb091529f56f5
title: Mettre à jour et supprimer Infinitary
description: Comment chaque type d’installation reçoit une nouvelle version stable, et comment supprimer Infinitary en gardant votre travail enregistré.
---

Infinitary recherche une nouvelle version stable toutes les quelques heures.
La recherche ne télécharge rien, et rien ne s’installe tant que vous ne l’avez pas choisi.
Une mise à jour garde votre travail enregistré.

## Quand une nouvelle version est disponible {#when-a-new-version-is-out}

Un bouton rond avec une flèche vers le bas apparaît en haut à droite de la fenêtre.
Laissez le pointeur dessus pour lire « Mise à jour disponible » et le numéro de la nouvelle version, et appuyez dessus pour voir quoi faire ensuite.
Réglages → **Général** affiche la même chose, sous **Version**.

Pour vérifier vous-même, utilisez l’un de ces moyens :

- **Rechercher les mises à jour** sous **Version** dans Réglages → **Général**.
- **Rechercher les mises à jour** dans la recherche de commandes.
- Sur un Mac, **Rechercher les mises à jour…** dans le menu Infinitary.

La suite dépend de la façon dont vous avez installé Infinitary.

## Une copie pour Mac depuis la page de téléchargement {#a-mac-copy-from-the-downloads-page}

1. Appuyez sur **Mettre à jour et redémarrer**.
2. Infinitary télécharge la nouvelle version et vérifie sa somme de contrôle et sa signature Apple.
3. Il enregistre le travail de votre équipage.
   Le travail en cours termine d’abord ce qu’il exécute, donc rien n’est perdu.
4. Infinitary redémarre sur la nouvelle version et reprend le travail que la mise à jour a mis en pause.

Pendant qu’il attend le travail en cours, **Mettre à jour plus tard** laisse la mise à jour de côté jusqu’à ce que vous la choisissiez de nouveau.
Votre travail continue.

Si Infinitary n’a pas pu finir de redémarrer, le bouton indique **Redémarrer**.
Appuyez de nouveau dessus une fois votre travail en cours arrêté.

Infinitary ne se met à jour que depuis Applications.
S’il s’exécute depuis l’image disque, faites-le glisser dans Applications, éjectez l’image disque et ouvrez la copie dans Applications.

## Une copie pour Mac depuis Homebrew {#a-mac-copy-from-homebrew}

Une copie installée avec Homebrew se met à jour avec Homebrew.
L’avis affiche la commande, avec **Copier la commande** :

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Exécutez-la dans Terminal.
Homebrew quitte Infinitary pendant qu’il le remplace, alors rouvrez Infinitary quand il a terminé.

## Linux {#linux}

- **Ubuntu, Debian et Fedora**, depuis le paquet .deb ou .rpm : appuyez sur **Installer**.
  Infinitary télécharge la nouvelle version, la vérifie, enregistre le travail de votre équipage et demande votre mot de passe, puis redémarre.
- **Une AppImage** : appuyez sur **Installer**.
  Infinitary remplace le fichier AppImage par la nouvelle version et redémarre, sans mot de passe.
  Il doit pouvoir modifier le dossier où se trouve l’AppImage.
- **Arch, Omarchy et NixOS** se mettent à jour avec leur propre gestionnaire de paquets.
  L’avis affiche la commande, avec **Copier la commande** ; exécutez-la dans un terminal.

Si l’installation ne peut pas aboutir, rien ne change et le travail de votre équipage continue.
L’avis affiche alors une commande qui installe la même version à la main.

## Windows {#windows}

1. Appuyez sur **Mettre à jour et redémarrer**.
2. Infinitary télécharge le nouveau programme d’installation, vérifie sa somme de contrôle et enregistre le travail de votre équipage.
3. Infinitary se ferme, le programme d’installation le remplace, et Infinitary se rouvre sur la nouvelle version.

Si l’installation ne peut pas aboutir, rien ne change et le travail de votre équipage continue.

## Vos autres ordinateurs et votre téléphone {#your-other-computers-and-your-phone}

Un ordinateur que vous avez ajouté se met à jour depuis l’ordinateur où vit votre second.
Quand il se connecte sur une version plus ancienne, il reçoit de lui-même la version de cet ordinateur.
Son travail en cours est d’abord enregistré, puis reprend.
Quand il ne peut pas se mettre à jour de lui-même, par exemple parce que la mise à jour demande un mot de passe là-bas, une carte vous le demande à la place.
Dans Réglages → **Appareils**, un ordinateur sur une autre version affiche **Aligner** sur sa ligne.
Appuyez dessus pour l’amener à la version de cet ordinateur-ci, qu’elle soit plus récente ou plus ancienne.

L’app ouverte sur un ordinateur qui pilote votre second suit la même version.
Quand elle est plus ancienne, elle récupère cette version d’elle-même, et redémarre dessus dès que personne ne l’utilise là-bas.
Sa ligne dans Réglages → **Appareils** indique où elle en est, et **Mettre à jour l’app** récupère la version tout de suite.
Les mots tapés là-bas et pas encore envoyés retiennent le redémarrage jusqu’à ce qu’ils soient envoyés ou effacés.
Quand cette app ne peut pas se mettre à jour d’elle-même, comme une copie venue de Homebrew, sa ligne et une carte disent quoi faire là-bas.

Depuis un ordinateur qui pilote votre second, vous pouvez aussi mettre à jour l’ordinateur où vit votre second.
Réglages → **Général** comporte une ligne pour Infinitary sur cet ordinateur.
Quand cet ordinateur a une mise à jour prête, appuyez sur **Mettre à jour** suivi de son nom.
Infinitary demande d’abord : il nomme le travail en cours qui se termine avant le redémarrage, et précise que quelqu’un doit se trouver devant cet ordinateur si la nouvelle version ne démarre pas.
Pendant que ce travail s’enregistre, **Mettre à jour plus tard** laisse la mise à jour de côté.
Votre téléphone peut aussi lancer cette mise à jour, après vous avoir demandé d’abord.
Voir [Vos autres ordinateurs](/fr/your-other-computers/) et [iPhone et iPad](/fr/iphone-and-ipad/).

## Supprimer Infinitary {#remove-infinitary}

Supprimer l’app laisse votre travail enregistré en place, donc réinstaller Infinitary reprend là où vous vous étiez arrêté.
Si cet ordinateur exécute le travail d’un autre, appuyez d’abord sur **Quitter** dans Réglages → **Appareils**.

- **Une copie pour Mac depuis la page de téléchargement** : quittez Infinitary et déplacez-le d’Applications vers la Corbeille.
- **Une copie pour Mac depuis Homebrew** : exécutez `brew uninstall --cask infinitary` dans Terminal.
  N’ajoutez jamais `--zap` : cela supprime votre travail enregistré.
- **Linux** : supprimez le paquet avec l’installateur de logiciels ou le gestionnaire de paquets qui a servi à l’installer.
  Pour une AppImage, supprimez le fichier.
- **Windows** : dans Paramètres Windows → **Applications** → **Applications installées**, choisissez **Désinstaller** dans le menu d’Infinitary.

Votre travail enregistré reste dans `~/Library/Application Support/infinitary` sur un Mac, dans `~/.config/infinitary` sous Linux, et dans `%APPDATA%\infinitary` sous Windows.

### Ce qui supprime votre travail enregistré {#what-deletes-your-saved-work}

Ces actions suppriment ce dossier, et ce qu’Infinitary y gardait disparaît avec lui :

- `brew uninstall --zap`.
- Une app de désinstallation qui supprime aussi les fichiers de support d’une app.
- Placer le dossier lui-même dans la Corbeille, ou le supprimer.
- **Réinitialiser Infinitary**, qui sert à repartir de zéro : voir [Réinitialiser Infinitary](#reset-infinitary).

Sur un ordinateur qui exécute le travail d’un autre, ce dossier contient la clé propre à l’ordinateur, ses copies de travail et les fichiers de ses tâches.
Sans lui, l’ordinateur rejoint de nouveau comme une nouvelle entrée, et le travail qu’il n’avait pas rapporté reste perdu.
Voir [Un ordinateur apparaît deux fois](/fr/troubleshooting/#a-computer-is-listed-twice).

## Réinitialiser Infinitary {#reset-infinitary}

**Réinitialiser Infinitary**, une ligne de Réglages → **Général**, remet Infinitary sur cet ordinateur dans l’état où il était juste après l’installation, et garde l’app.
Il supprime tout ce qu’Infinitary garde sur cet ordinateur, y compris les tâches, les connexions, les Secrets, les réglages et les appareils jumelés.
Les projets dans vos propres dossiers gardent tous leurs fichiers et commits.
Pour effacer seulement les tâches, utilisez **Effacer les données des tâches**, la ligne juste au-dessus.

1. Appuyez sur **Réinitialiser**.
   Infinitary indique ce qu’il supprime et combien de tâches ouvertes s’arrêtent.
2. Appuyez sur **Réinitialiser Infinitary**, ou sur **Tout garder** pour ne rien changer.
3. Confirmez que c’est bien vous, comme votre ordinateur le demande, par exemple avec Touch ID ou votre mot de passe.
4. Infinitary se ferme, puis s’ouvre sur l’écran d’accueil comme s’il venait d’être installé.

Un ordinateur qui exécute le travail d’un autre quitte cet autre ordinateur lors de sa réinitialisation.
Sur un ordinateur qui pilote votre second, la ligne réinitialise Infinitary sur les deux ordinateurs : celui-ci, et l’ordinateur où vit votre second.
Si ce dernier ne répond pas, rien n’est réinitialisé, ni sur l’un ni sur l’autre.

Quand Infinitary ne peut pas s’ouvrir, vous pouvez quand même le réinitialiser : voir [Infinitary n’a pas pu démarrer](/fr/troubleshooting/#infinitary-could-not-start).
