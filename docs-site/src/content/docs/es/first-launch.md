---
source: 714fca51d75af858
title: Primer inicio
description: Lo que Infinitary muestra la primera vez que lo abres, cómo conectar una suscripción y cómo agregar tu primer proyecto.
---

Antes de empezar, revisa [lo que necesitas](/es/install/).
Esta página recorre la primera vez que abres Infinitary y lo que cambia después.

## Lo que muestra la ventana {#what-the-window-shows}

La primera vez que abres Infinitary, tu primer oficial te saluda en el centro de la ventana.
Encima dice **Te damos la bienvenida a bordo de Infinitary, capitán**, con una frase de tu primer oficial:

> Soy tu primer oficial.
> Te ayudaré a dirigir al resto de la tripulación.
> Configúrame en una computadora que permanezca encendida tanto como sea posible.
> Tus otros dispositivos me necesitan despierto.

Debajo hay un botón para cada proveedor que tu primer oficial puede usar: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock y API personalizada.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="El primer inicio: el primer oficial en el centro de la ventana, las palabras de bienvenida y un botón para cada proveedor." width="1280" height="652" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="El primer inicio: el primer oficial en el centro de la ventana, las palabras de bienvenida y un botón para cada proveedor." width="1280" height="652" />

El cuadro de mensaje de abajo aparece atenuado y dice «Primero conecta una suscripción».
Nada más funciona hasta que una suscripción pueda responder a tu primer oficial.

## Conectar una suscripción {#connect-a-subscription}

1. Elige el botón de tu proveedor.
2. Inicia sesión como te lo pida ese proveedor.
   Algunos abren la página de inicio de sesión en tu navegador.
   Copilot y Kimi Code muestran un código: presiona **Copiar código** y luego escríbelo en el sitio del proveedor.
   OpenRouter recibe una clave de API que pegas.
   Con Amazon Bedrock, elige una región y usa un perfil de AWS de esta computadora o pega una clave de API de Bedrock.
   Un proveedor que ofrece ambas opciones pregunta si quieres **Iniciar sesión con tu navegador** o pegar una **Clave de API**.
3. Espera mientras la ventana dice que se está conectando.
   Cuando la suscripción puede responder, la pantalla de bienvenida se desvanece y se abre el cuadro de mensaje.

Si usas Claude, Infinitary usa el Claude Code que instalaste en esta computadora.
Sin él, el botón de Claude dice que primero instales Claude Code.

Si una suscripción está conectada pero aún no puede responder, la ventana dice **Configura tu primer oficial en esta computadora** y explica lo que todavía falta.

## Si tu primer oficial ya vive en otra computadora {#if-your-first-mate-already-lives-on-another-computer}

Debajo de los botones de los proveedores, un segundo grupo dice «Tu primer oficial está en otra computadora».
En una Mac o una computadora Linux x64, **Configurar desde la computadora de tu primer oficial** aparece primero: muestra la dirección de esta computadora para escribirla en la computadora donde vive tu primer oficial.
Cuando esa computadora agrega esta, esta ventana abre a tu primer oficial por sí sola, siempre que todavía no se haya configurado nada en ella, como un inicio de sesión o un proyecto.
Una ventana en la que ya configuraste algo conserva su propio primer oficial: en ese caso, usa **Pegar su enlace** o **Unirse por su dirección** para controlar ese primer oficial desde aquí.
Si Infinitary estaba cerrado cuando esa computadora agregó esta, abre a tu primer oficial la próxima vez que se inicie, sin importar lo que se haya configurado en él.
Una ventana junto a un Infinitary que iniciaste tú mismo desde Terminal conserva el primer oficial de ese Infinitary y no ofrece ninguna de las dos formas; detén primero ese Infinitary para usarlas.
Una PC con Windows y una computadora Linux Arm muestran solo las otras dos formas.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## El aviso de Diagnósticos {#the-diagnostics-notice}

Un aviso debajo del cuadro de mensaje dice qué envía Diagnósticos y que nunca incluye lo que escribes.
Elige **Aceptar** para dejarlo activado, o **Desactivar**.
Puedes cambiarlo más adelante en [Configuración](/es/settings/#general).
Consulta [Lo que sale de tu computadora](/es/what-leaves-your-computer/).

## La tarjeta de bienvenida {#the-welcome-card}

Cuando tu primer oficial puede responder, aparece una tarjeta titulada **Cómo trabajamos**.
Es una pequeña imagen de la ventana que muestra una parte a la vez.
Presiona **Siguiente** y **Atrás** para ver el cuadro de mensaje, una tarjeta, Actividad a la izquierda y Tareas a la derecha.

Debajo de la imagen hay tres sugerencias:

- **Clonar un proyecto**
- **Empezar un proyecto nuevo**
- **Trabajar en una carpeta de mi computadora**

Presionar una pone el comienzo de una frase en el cuadro de mensaje, como «Clona el proyecto en ».
Termina la frase y envíala.
La sugerencia no envía nada por sí sola.

La tarjeta de bienvenida no tiene campo de respuesta: el cuadro de mensaje que está debajo es donde escribes.
Ciérrala cuando quieras.

## Agregar tu primer proyecto {#add-your-first-project}

Tu primer oficial necesita un proyecto en el que trabajar.
La forma más fácil es una sugerencia de la tarjeta de bienvenida, o las mismas palabras en tu propio mensaje.

Cuando lo pides, tu primer oficial muestra una tarjeta que nombra el proyecto y cómo se configurará.
Revisa las opciones de la tarjeta y luego presiona **Agregar proyecto**, o **Ahora no** para dejarlo.
No se agrega nada hasta que presionas **Agregar proyecto**.

También puedes agregar un proyecto tú mismo en Configuración → Proyectos con **Agregar proyecto**.
Consulta [Proyectos](/es/projects/) para ver las opciones que hay ahí.

## Inicios posteriores {#later-launches}

Cuando una suscripción puede responder, Infinitary se abre directamente en el cuadro de mensaje.
Tus tarjetas, tareas y tripulación están donde las dejaste.

Después de que Infinitary se actualiza, una tarjeta nombra la nueva versión y lo que cambió.
Puedes volver a leerla más adelante desde [Configuración → General](/es/settings/#general), en Versión.
En una Mac, **Novedades de Infinitary** en el menú Ayuda también la abre.

Si tu última suscripción deja de funcionar, por ejemplo porque cerraste sesión, la pantalla de bienvenida vuelve hasta que una pueda responder de nuevo.
Si se agota la asignación de tu plan, tu primer oficial muestra en cambio una tarjeta que lo dice, y guarda tus mensajes hasta que pueda responder.
Consulta [Suscripciones y asignación](/es/subscriptions-and-quota/).

Para abrir Infinitary cuando inicias sesión en tu computadora, activa **Abrir al iniciar sesión** en Configuración → General.
