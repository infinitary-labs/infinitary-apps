---
source: 6298f79a1d1c8bf2
title: Un ordinateur sans écran
description: Démarrez Infinitary par une commande sur un serveur Linux ou un autre ordinateur devant lequel personne ne s’assoit, pour que votre second y vive, et pilotez-le depuis votre Mac, votre ordinateur Linux ou votre PC Windows.
---

Votre second peut vivre sur un ordinateur devant lequel personne ne s’assoit, comme un serveur Linux que vous louez ou gardez chez vous.
Là-bas, Infinitary s’exécute sans fenêtre, démarré par une commande.
Vous pilotez votre second depuis un autre ordinateur : un Mac, un ordinateur Linux ou un PC Windows.

Il faut quatre étapes sur l’ordinateur sans écran, puis deux sur votre autre ordinateur :

1. Y installer Infinitary.
2. Le démarrer par une commande.
3. Laisser entrer votre autre ordinateur.
4. Créer un lien.
5. Coller le lien dans Infinitary sur votre autre ordinateur.
6. Connecter un abonnement depuis votre autre ordinateur.

## Ce qu’il vous faut {#what-you-need}

- **Un ordinateur Linux avec un processeur x64 et systemd**, comme Ubuntu ou Fedora.
  Sous Ubuntu 24.04 ou 26.04 et sous Fedora, le paquet apporte tout le reste dont Infinitary a besoin là-bas.
- **Un compte ordinaire là-bas, pas root.**
  Connectez-vous à ce compte par SSH pour chaque étape ci-dessous.
- **Un réseau commun aux deux ordinateurs.**
  Infinitary n’ouvre jamais un ordinateur à Internet : placez donc les deux ordinateurs sur le même réseau privé, comme Tailscale, sauf s’ils partagent un réseau local.
- **Infinitary sur votre autre ordinateur, pas encore configuré.**
  Vous rejoignez votre second depuis son premier lancement.
  Si vous y avez déjà configuré un second, voir [Si votre autre ordinateur a déjà un second](#if-your-other-computer-already-has-a-first-mate).
- **Un abonnement d’IA.**
  Vous vous y connectez depuis votre autre ordinateur, à la fin.
  Si vous utilisez Claude, installez d’abord Claude Code sur l’ordinateur sans écran.

## 1. Installer Infinitary {#1-install-infinitary}

Sur la [page des téléchargements](https://getinfinitary.com/downloads/#linux), copiez le lien du paquet pour le système de cet ordinateur.
Puis, sur l’ordinateur sans écran, téléchargez-le et installez-le.
Sous Ubuntu :

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

Sous Fedora, installez le .rpm de la même façon, avec `sudo dnf install ./infinitary-*.rpm`.
Le paquet installe aussi git et Xvfb, dont Infinitary a besoin pour s’y exécuter.

Sur un autre système Linux x64, téléchargez l’AppImage et autorisez son exécution avec `chmod +x`.
Elle a besoin de git, de Xvfb et de FUSE 2, ainsi que de bibliothèques qu’un ordinateur de bureau possède et qui manquent souvent à un serveur, comme GTK 3.
Partout où cette page indique `infinitary`, tapez plutôt le chemin du fichier AppImage.

## 2. Le démarrer {#2-start-it}

Sous le compte qui doit exécuter votre second, exécutez :

```sh
infinitary start-at-boot
```

Infinitary démarre maintenant, sans fenêtre, puis chaque fois que ce compte ouvre une session.
La commande indique où lire ce qu’il écrit.

Pour qu’il continue de s’exécuter après votre déconnexion, et qu’il démarre chaque fois que l’ordinateur démarre, la commande peut aussi afficher une ligne qu’un administrateur doit exécuter une fois :

```sh
sudo loginctl enable-linger <your account>
```

Exécutez cette ligne si elle apparaît.
Pour vérifier qu’Infinitary s’exécute, utilisez `infinitary status`.

Si Infinitary indique qu’il a besoin de Xvfb, installez Xvfb avec les logiciels de votre système, puis exécutez de nouveau la commande.
S’il indique que l’ordinateur n’a pas de systemd pour cet utilisateur, `infinitary help run` liste d’autres façons de le démarrer.

## 3. Laisser entrer votre autre ordinateur {#3-let-your-other-computer-in}

Votre autre ordinateur joint Infinitary sur le port 47623.
Si un pare-feu y est activé, laissez entrer ce port une fois.
Avec ufw, comme sous Ubuntu :

```sh
sudo ufw allow 47623/tcp
```

Avec firewalld, comme sous Fedora :

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. Créer un lien {#4-make-a-link}

```sh
infinitary link
```

La commande affiche un lien, avec les mots « Paste this link into Infinitary on your other computer, at its first launch. »
Le lien fonctionne une fois, pendant dix minutes.
Exécutez de nouveau la commande pour en obtenir un nouveau.

## 5. Rejoindre depuis votre autre ordinateur {#5-join-from-your-other-computer}

1. Ouvrez Infinitary pour la première fois sur votre autre ordinateur.
2. Choisissez **Coller son lien**, collez le lien et appuyez sur **Continuer**.
3. Infinitary demande une fois s’il faut piloter votre second depuis là.
   Appuyez sur **Le contrôler d’ici**.

Votre autre ordinateur affiche maintenant votre second.
Ses cartes, ses tâches et sa conversation restent sur l’ordinateur sans écran.

Au lieu d’un lien, vous pouvez choisir **Rejoindre par son adresse** et taper l’adresse avec laquelle vous vous connectez à cet ordinateur par SSH, comme `you@vps`.
Infinitary demande alors de lui-même un lien à l’Infinitary qui s’y exécute.
Depuis un PC Windows, cet ordinateur doit laisser entrer votre clé SSH, car un PC Windows ne demande aucun mot de passe.

## 6. Connecter un abonnement {#6-connect-a-subscription}

La fenêtre indique ensuite « Connectez-en un pour votre second sur » suivi du nom de cet ordinateur, et « La connexion se fait depuis ici. »
Choisissez votre fournisseur et connectez-vous de la façon qu’il demande, sur l’ordinateur devant lequel vous êtes.
Quand un abonnement peut répondre, la zone de message s’ouvre et votre second est prêt.
Voir [Premier lancement](/fr/first-launch/#connect-a-subscription).

## Si votre autre ordinateur a déjà un second {#if-your-other-computer-already-has-a-first-mate}

Une fois qu’un abonnement répond sur un ordinateur, celui-ci n’affiche plus son premier lancement, et ne peut donc pas coller de lien.
Gardez plutôt ce second et déplacez-le vers l’ordinateur sans écran :

1. Ajoutez-lui l’ordinateur sans écran, comme dans [Ajouter un ordinateur](/fr/your-other-computers/#add-a-computer).
2. Dans le menu de cet ordinateur, les trois points sur sa ligne, choisissez [Déplacer votre second ici](/fr/your-other-computers/#move-your-first-mate).

Ses tâches, ses cartes et sa conversation le suivent.
Vous vous reconnectez là-bas à vos abonnements, et les [Secrets](/fr/secrets/) restent sur l’ordinateur qu’il quitte.

## Le mettre à jour {#update-it}

Installez le nouveau paquet de la même façon qu’à l’étape 1.
Infinitary y remarque la nouvelle version, s’arrête et redémarre dessus de lui-même.

## L’arrêter {#stop-it}

```sh
infinitary start-at-boot --off
```

Cela arrête Infinitary là-bas et l’empêche de redémarrer.
Le travail enregistré de votre second reste sur cet ordinateur.

## En cas de problème {#when-something-goes-wrong}

- **`infinitary link` indique « Infinitary is not running here, as this user. »**
  Démarrez-le comme à l’étape 2, sous le même compte, puis créez de nouveau le lien.
- **Il indique « Infinitary here controls your first mate on another computer. »**
  Cet ordinateur a déjà rejoint un autre second ; créez plutôt le lien sur cet ordinateur-là.
- **Votre autre ordinateur ne parvient pas à joindre l’adresse du lien.**
  Vérifiez que les deux ordinateurs sont sur le même réseau privé, et que le port 47623 est autorisé, comme à l’étape 3.
- **Infinitary s’est arrêté et vous ne savez pas pourquoi.**
  `infinitary status` indique pourquoi il s’est arrêté la dernière fois, et le journal nommé par `infinitary start-at-boot` dit le reste.

Voir aussi [Vos autres ordinateurs](/fr/your-other-computers/) et [Dépannage](/fr/troubleshooting/).
