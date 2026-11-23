---
source: 6298f79a1d1c8bf2
title: Una computadora sin pantalla
description: Inicia Infinitary con un comando en un servidor Linux u otra computadora frente a la que no se sienta nadie, para que tu primer oficial viva ahí, y contrólalo desde tu Mac, tu computadora Linux o tu PC con Windows.
---

Tu primer oficial puede vivir en una computadora frente a la que no se sienta nadie, como un servidor Linux que alquilas o tienes en casa.
Ahí, Infinitary se ejecuta sin ventana, iniciado con un comando.
Controlas a tu primer oficial desde otra computadora: una Mac, una computadora Linux o una PC con Windows.

Son cuatro pasos en la computadora sin pantalla y luego dos en tu otra computadora:

1. Instala Infinitary ahí.
2. Inícialo con un comando.
3. Deja entrar a tu otra computadora.
4. Crea un enlace.
5. Pega el enlace en Infinitary en tu otra computadora.
6. Conecta una suscripción desde tu otra computadora.

## Lo que necesitas {#what-you-need}

- **Una computadora Linux con procesador x64 y systemd**, como Ubuntu o Fedora.
  En Ubuntu 24.04 o 26.04 y en Fedora, el paquete trae todo lo demás que Infinitary necesita ahí.
- **Una cuenta normal ahí, no root.**
  Inicia sesión en esa cuenta por SSH para cada paso de abajo.
- **Una red en la que estén ambas computadoras.**
  Infinitary nunca abre una computadora a internet, así que pon ambas computadoras en la misma red privada, como Tailscale, a menos que compartan una red local.
- **Infinitary en tu otra computadora, todavía sin configurar.**
  Te unes a tu primer oficial desde su primer inicio.
  Si ya configuraste un primer oficial ahí, consulta [Si tu otra computadora ya tiene un primer oficial](#if-your-other-computer-already-has-a-first-mate).
- **Una suscripción de IA.**
  Inicias sesión en ella desde tu otra computadora al final.
  Si usas Claude, instala primero Claude Code en la computadora sin pantalla.

## 1. Instalar Infinitary {#1-install-infinitary}

En la [página de descargas](https://getinfinitary.com/downloads/#linux), copia el enlace del paquete para el sistema de esa computadora.
Luego, en la computadora sin pantalla, descárgalo e instálalo.
En Ubuntu:

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

En Fedora, instala el .rpm de la misma forma, con `sudo dnf install ./infinitary-*.rpm`.
El paquete también instala git y Xvfb, que Infinitary necesita para ejecutarse ahí.

En otro sistema Linux x64, descarga el AppImage y permite que se ejecute con `chmod +x`.
Necesita git, Xvfb y FUSE 2 instalados, y bibliotecas que tiene un escritorio y que a un servidor suelen faltarle, como GTK 3.
Donde esta página dice `infinitary`, escribe en su lugar la ruta del archivo AppImage.

## 2. Iniciarlo {#2-start-it}

Como la cuenta que debe ejecutar a tu primer oficial, ejecuta:

```sh
infinitary start-at-boot
```

Infinitary se inicia ahora, sin ventana, y de nuevo cada vez que esa cuenta inicia sesión.
El comando dice dónde leer lo que informa.

Para que siga ejecutándose después de cerrar sesión, y para que se inicie cada vez que se inicia la computadora, el comando también puede imprimir una línea para que un administrador la ejecute una vez:

```sh
sudo loginctl enable-linger <your account>
```

Ejecuta esa línea si aparece.
Para comprobar que Infinitary se está ejecutando, usa `infinitary status`.

Si Infinitary dice que necesita Xvfb, instala Xvfb con el software de tu sistema y luego vuelve a ejecutar el comando.
Si dice que la computadora no tiene systemd para este usuario, `infinitary help run` muestra otras formas de iniciarlo.

## 3. Dejar entrar a tu otra computadora {#3-let-your-other-computer-in}

Tu otra computadora llega a Infinitary por el puerto 47623.
Si ahí hay un firewall activado, deja entrar ese puerto una vez.
Con ufw, como en Ubuntu:

```sh
sudo ufw allow 47623/tcp
```

Con firewalld, como en Fedora:

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. Crear un enlace {#4-make-a-link}

```sh
infinitary link
```

Imprime un enlace, con las palabras «Paste this link into Infinitary on your other computer, at its first launch.»
El enlace funciona una vez, durante diez minutos.
Vuelve a ejecutar el comando para obtener uno nuevo.

## 5. Unirte desde tu otra computadora {#5-join-from-your-other-computer}

1. Abre Infinitary en tu otra computadora por primera vez.
2. Elige **Pegar su enlace**, pega el enlace y presiona **Continuar**.
3. Infinitary pregunta una vez si quieres controlar a tu primer oficial desde ahí.
   Presiona **Controlarlo desde aquí**.

Tu otra computadora ahora muestra a tu primer oficial.
Sus tarjetas, tareas y conversación se quedan en la computadora sin pantalla.

En lugar de un enlace, puedes elegir **Unirse por su dirección** y escribir la dirección con la que inicias sesión en esa computadora por SSH, como `you@vps`.
Infinitary entonces le pide un enlace por sí solo al Infinitary que se ejecuta ahí.
Desde una PC con Windows, esa computadora debe dejar entrar tu clave SSH, ya que una PC con Windows no pide ninguna contraseña.

## 6. Conectar una suscripción {#6-connect-a-subscription}

Luego la ventana dice «Conecta una para tu primer oficial en» y el nombre de esa computadora, y «Inicia sesión desde aquí.»
Elige tu proveedor e inicia sesión como te lo pida, en la computadora en la que estás.
Cuando una suscripción puede responder, se abre el cuadro de mensaje y tu primer oficial está listo.
Consulta [Primer inicio](/es/first-launch/#connect-a-subscription).

## Si tu otra computadora ya tiene un primer oficial {#if-your-other-computer-already-has-a-first-mate}

Cuando una suscripción responde en una computadora, esta ya no muestra su primer inicio, así que no puede pegar un enlace.
En su lugar, conserva ese primer oficial y múdalo a la computadora sin pantalla:

1. Agrégale la computadora sin pantalla, como en [Agregar una computadora](/es/your-other-computers/#add-a-computer).
2. En el menú de esa computadora, los tres puntos de su fila, elige [Mudar aquí a tu primer oficial](/es/your-other-computers/#move-your-first-mate).

Sus tareas, tarjetas y conversación se van con él.
Vuelves a iniciar sesión ahí en tus suscripciones, y los [Secretos](/es/secrets/) se quedan en la computadora que deja.

## Actualizarlo {#update-it}

Instala el paquete nuevo de la misma forma que en el paso 1.
Infinitary ahí nota la versión nueva, se detiene y vuelve a iniciarse con ella por sí solo.

## Detenerlo {#stop-it}

```sh
infinitary start-at-boot --off
```

Esto detiene Infinitary ahí y evita que vuelva a iniciarse.
El trabajo guardado de tu primer oficial se queda en esa computadora.

## Cuando algo sale mal {#when-something-goes-wrong}

- **`infinitary link` dice «Infinitary is not running here, as this user.»**
  Inícialo como en el paso 2, con la misma cuenta, y luego vuelve a crear el enlace.
- **Dice «Infinitary here controls your first mate on another computer.»**
  Esa computadora ya se unió a otro primer oficial; crea el enlace en aquella computadora en su lugar.
- **Tu otra computadora no puede llegar a la dirección del enlace.**
  Comprueba que ambas computadoras estén en la misma red privada y que el puerto 47623 tenga paso, como en el paso 3.
- **Infinitary se detuvo y no sabes por qué.**
  `infinitary status` dice por qué se detuvo la última vez, y el log que nombró `infinitary start-at-boot` dice el resto.

Consulta también [Tus otras computadoras](/es/your-other-computers/) y [Solución de problemas](/es/troubleshooting/).
