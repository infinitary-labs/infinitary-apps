---
source: c16d193883332656
title: Primer inicio
description: Lo que Infinitary muestra la primera vez que lo abres, cómo elegir dónde vive tu primer oficial, cómo conectar una suscripción y cómo agregar tu primer proyecto.
---

Antes de empezar, revisa [lo que necesitas](/es/install/).
Esta página recorre la primera vez que abres Infinitary y lo que cambia después.

## Lo que muestra la ventana {#what-the-window-shows}

La primera vez que abres Infinitary, tu primer oficial te saluda en el centro de la ventana.
Debajo dice **Te damos la bienvenida a bordo de Infinitary, capitán**, con una frase de tu primer oficial:

> Soy tu primer oficial.
> Te ayudaré a dirigir al resto de la tripulación.

Luego tu primer oficial pregunta dónde debe vivir:

> ¿Dónde debo vivir?
> Elige una computadora que esté encendida el mayor tiempo posible.

Siguen tres opciones, y cada una dice lo que hace:

- **Esta computadora**: inicias sesión aquí en una suscripción, y tu primer oficial vive y trabaja en esta computadora.
- **Otra computadora**: tu primer oficial funciona en otra computadora, y lo controlas desde esta.
- **Una que ya funciona**: te conectas a un primer oficial que ya funciona en otra computadora, y lo controlas desde aquí.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="El primer inicio: el primer oficial en el centro de la ventana, las palabras de bienvenida, la pregunta de dónde debe vivir y las tres opciones Esta computadora, Otra computadora y Una que ya funciona sobre el cuadro de mensaje atenuado." width="1233" height="694" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="El primer inicio: el primer oficial en el centro de la ventana, las palabras de bienvenida, la pregunta de dónde debe vivir y las tres opciones Esta computadora, Otra computadora y Una que ya funciona sobre el cuadro de mensaje atenuado." width="1233" height="694" />

Elige una opción para abrirla.
Con el teclado, Tab llega a cada opción, las teclas de flecha se mueven entre ellas, y Enter o la barra espaciadora abre una.
**‹ Dónde vivo**, encima de una opción abierta, te lleva de vuelta a las tres.
Debajo de las opciones, tu primer oficial dice que puedes mudarlo a otra computadora más tarde, en Configuración → Dispositivos.

El cuadro de mensaje de abajo aparece atenuado y dice «Primero conecta una suscripción».
Nada más funciona hasta que una suscripción pueda responder a tu primer oficial.

## Conectar una suscripción {#connect-a-subscription}

Elige **Esta computadora** para que tu primer oficial se quede aquí.
Aparece un botón para cada proveedor que tu primer oficial puede usar: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock y API personalizada.

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

Si una suscripción está conectada pero aún no puede responder, la ventana dice **Configura tu primer oficial en esta computadora**, se abre en Esta computadora y explica lo que todavía falta.

## Configurarlo en otra computadora {#set-it-up-on-another-computer}

Elige **Otra computadora** para que tu primer oficial viva en una computadora que permanezca encendida, como una computadora de escritorio o un servidor, mientras lo controlas desde esta.
La ventana muestra **Configúrame en otra computadora**.

1. Escribe la cuenta y la computadora tal como inicias sesión en ella con SSH, como `you@mini.local`, y su puerto si no es el 22.
   Sesión remota debe estar activada ahí; en Linux, su servidor SSH.
   Las computadoras de la misma red aparecen en **En esta red**, para que puedas elegir una.
2. Presiona **Continuar**.

Luego Infinitary configura ahí a tu primer oficial, paso a paso, bajo «Configurando tu primer oficial en» y el nombre de esa computadora:

1. **Leer su clave SSH**: muestra la línea de la clave de la computadora y te pide que la confirmes antes de iniciar sesión.
2. **Iniciar sesión con tu clave SSH**: si la computadora no acepta tu clave, pide una vez la contraseña de esa cuenta.
3. **Revisar su sistema**.
4. **Enviar Infinitary**.
5. **Iniciar tu primer oficial allí**, para que vuelva a iniciarse después de cada reinicio.
6. **Conectar desde aquí**.
7. **Conectar una suscripción para él**.

Cada paso terminado dice lo que encontró.
Si un paso se detiene, dice qué lo detuvo y qué probar, con **Volver a pedirlo**, **Configurarlo con comandos** y **Atrás**.
Si Infinitary ya funciona ahí, ofrece **Conectarte a ella**.
Si una computadora Linux te inicia sesión como root, Infinitary ofrece una cuenta normal llamada `infinitary` para tu primer oficial, ya que Infinitary no se ejecuta como root.
**Cancelar** se detiene en el paso siguiente; si tu primer oficial todavía no se ha iniciado ahí, se elimina la copia de Infinitary que envió.

Una vez que se conecta, esta ventana muestra el primer oficial de esa computadora.
Dice **Conecta una suscripción para empezar**: elige un proveedor e inicia sesión desde aquí, como en [Conectar una suscripción](#connect-a-subscription).

### Con comandos {#with-commands}

**Configurarlo con comandos** muestra la misma configuración como comandos para ejecutar en la otra computadora:

1. Instala Infinitary allí.
2. Inicia tu primer oficial allí:

   ```sh
   infinitary start-at-boot
   ```

3. Crea allí un enlace para esta computadora:

   ```sh
   infinitary link
   ```

4. Pega aquí el enlace que muestra: presiona **Pegar su enlace**.

Cada comando tiene su propio **Copiar**.
En una Mac, escribe `/Applications/Infinitary.app/Contents/MacOS/Infinitary` en lugar de `infinitary`.
Consulta [Una computadora sin pantalla](/es/a-computer-with-no-screen/) para un servidor al que solo llegas por SSH.

## Si tu primer oficial ya vive en otra computadora {#if-your-first-mate-already-lives-on-another-computer}

Elige **Una que ya funciona**.
Un grupo dice «Tu primer oficial está en otra computadora» y ofrece estas formas de entrar:

- **Configurar desde la computadora de tu primer oficial**, en una Mac o una computadora Linux x64, aparece primero.
  Muestra la dirección de esta computadora para escribirla en la computadora donde vive tu primer oficial.
  Cuando esa computadora agrega esta, esta ventana abre a tu primer oficial por sí sola, siempre que todavía no se haya configurado nada en ella, como un inicio de sesión o un proyecto.
- **Pegar su enlace**: pega un enlace creado en la computadora donde vive tu primer oficial, en Configuración → Dispositivos o pidiéndoselo a tu primer oficial, y luego presiona **Continuar**.
- **Unirse por su dirección**: escribe la dirección con la que inicias sesión en esa computadora por SSH.
  Si Infinitary no está abierto ahí, **Configurarlo desde aquí** configura en su lugar a tu primer oficial en ella, como en [Configurarlo en otra computadora](#set-it-up-on-another-computer).

Infinitary pregunta una vez si quieres controlar a tu primer oficial desde ahí; presiona **Controlarlo desde aquí**.

Una ventana en la que ya configuraste algo conserva su propio primer oficial: en ese caso, usa **Pegar su enlace** o **Unirse por su dirección** para controlar ese primer oficial desde aquí.
Si Infinitary estaba cerrado cuando esa computadora agregó esta, abre a tu primer oficial la próxima vez que se inicie, sin importar lo que se haya configurado en él.
Una ventana junto a un Infinitary que iniciaste tú mismo desde Terminal conserva el primer oficial de ese Infinitary y no ofrece ninguna de las dos formas; detén primero ese Infinitary para usarlas.
Una PC con Windows y una computadora Linux Arm muestran solo **Pegar su enlace** y **Unirse por su dirección**.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## El aviso de Diagnósticos {#the-diagnostics-notice}

Un aviso debajo del cuadro de mensaje dice qué envía Diagnósticos y que nunca incluye lo que escribes.
Aparece haya o no una suscripción conectada, y se queda hasta que lo respondas.
Elige **Aceptar** para dejarlo activado, o **Desactivar**.
Puedes cambiarlo más adelante en [Configuración](/es/settings/#general).
Consulta [Lo que sale de tu computadora](/es/what-leaves-your-computer/).

## La tarjeta de bienvenida {#the-welcome-card}

Cuando tu primer oficial puede responder, aparece una tarjeta titulada **Cómo trabajamos**.

<img class="picture-dark" src="/pictures/first-launch-welcome-dark.webp" alt="La tarjeta Cómo trabajamos: una pequeña imagen de la ventana con el primer oficial sobre el cuadro de mensaje, cinco puntos con Atrás y Siguiente debajo, las tres sugerencias y Entendido." width="930" height="523" />
<img class="picture-light" src="/pictures/first-launch-welcome-light.webp" alt="La tarjeta Cómo trabajamos: una pequeña imagen de la ventana con el primer oficial sobre el cuadro de mensaje, cinco puntos con Atrás y Siguiente debajo, las tres sugerencias y Entendido." width="930" height="523" />

Es una pequeña imagen de la ventana que muestra una parte a la vez.
Presiona **Siguiente** y **Atrás** para ver el cuadro de mensaje, una tarjeta, Actividad a la izquierda, donde informan los tripulantes, y Tareas a la derecha, donde cada petición tiene un registro.

Debajo de la imagen dice «Para empezar, presiona una y termina la frase:», con tres sugerencias:

- **Clonar un proyecto** pone «Clona el proyecto de» en el cuadro de mensaje.
- **Empezar un proyecto nuevo** pone «Empieza un proyecto nuevo llamado» en el cuadro de mensaje.
- **Trabajar en una carpeta de mi computadora** abre el selector de carpetas de tu computadora.
  La carpeta que elijas se convierte en un proyecto, y una línea debajo del título de la tarjeta la nombra.
  Si la carpeta todavía no usa git, recibe git, con una primera confirmación vacía.

Termina la frase y envíala.
La sugerencia no envía nada por sí sola.
En una computadora que controla un primer oficial en otra computadora, **Trabajar en una carpeta de mi computadora** pone en cambio «Trabaja en la carpeta» en el cuadro de mensaje, ya que el selector de carpetas mostraría las carpetas de esta computadora.

La tarjeta de bienvenida no tiene campo de respuesta: el cuadro de mensaje que está debajo es donde escribes.
Presiona **Entendido** para guardarla cuando quieras.

## Tu primer tripulante {#your-first-crewmate}

La primera vez que tu primer oficial le pasa una petición a un tripulante, aparece una tarjeta titulada **Un tripulante se encarga**.

<img class="picture-dark" src="/pictures/first-launch-crewmate-dark.webp" alt="La tarjeta Un tripulante se encarga: el primer oficial enviando a un tripulante, un recuadro Ahora que dice que un tripulante trabaja y que no hace falta vigilarlo, un recuadro Después que dice que vuelve aquí una tarjeta con una respuesta o una elección, y Entendido." width="1070" height="602" />
<img class="picture-light" src="/pictures/first-launch-crewmate-light.webp" alt="La tarjeta Un tripulante se encarga: el primer oficial enviando a un tripulante, un recuadro Ahora que dice que un tripulante trabaja y que no hace falta vigilarlo, un recuadro Después que dice que vuelve aquí una tarjeta con una respuesta o una elección, y Entendido." width="1070" height="602" />

Dice que el tripulante trabaja en segundo plano, lo que puede llevar un rato, y que no hace falta que lo vigiles.
Cuando el tripulante tiene una respuesta, o necesita que elijas, vuelve como una tarjeta.
Las tarjetas son lo único que te necesita.

Si la tarjeta Cómo trabajamos sigue abierta, esta tarjeta ocupa su lugar.
Aparece una sola vez.
Presiona **Entendido**; el trabajo sigue, y mientras tanto puedes pedir otra cosa.
Consulta [Tu primera tarea](/es/your-first-task/).

## Agregar tu primer proyecto {#add-your-first-project}

Tu primer oficial necesita un proyecto en el que trabajar.
La forma más fácil es una sugerencia de la tarjeta de bienvenida, o las mismas palabras en tu propio mensaje.

**Trabajar en una carpeta de mi computadora** agrega enseguida la carpeta que elijas.
Para las otras sugerencias, tu primer oficial muestra una tarjeta que nombra el proyecto y cómo se configurará.
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
