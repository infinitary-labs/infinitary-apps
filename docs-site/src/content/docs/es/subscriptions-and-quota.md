---
source: 9c71f435cc6524a0
title: Suscripciones y asignación
description: Cómo agregar tus suscripciones de IA, leer cuánto queda de la asignación de tu plan y qué hace tu tripulación cuando se agota.
---

Tu primer oficial y tu tripulación trabajan a través de las suscripciones de IA que ya tienes.
Las gestionas en Configuración, en **Inteligencia**, en la lista **Suscripciones de IA**.

## Agregar una suscripción {#add-a-subscription}

1. Abre Configuración y elige **Inteligencia**.
2. Al pie de **Suscripciones de IA**, en **Agregar cuenta**, elige tu proveedor: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter o Amazon Bedrock.
3. Inicia sesión como te lo pida el proveedor.
   Algunos abren tu navegador, algunos muestran un código para escribir en su sitio, y algunos reciben una clave que pegas.
4. Cuando termina el inicio de sesión, la nueva cuenta aparece en la lista.

Puedes agregar más de una cuenta del mismo proveedor.
Su botón dice entonces **Agregar otra cuenta de Codex**, por ejemplo.

## Ponerles nombre a tus cuentas {#name-your-accounts}

Cada cuenta tiene una etiqueta, para que puedas distinguir una cuenta personal de una de trabajo.
Cuando el inicio de sesión no nombra la cuenta, se abre un cuadro de nombre para que escribas uno.
Para cambiarlo más adelante, abre el menú de la cuenta y elige **Cambiar nombre**.

Una cuenta de Claude es distinta.
Sigue el inicio de sesión de Claude Code en tu computadora, así que su fila muestra a quien tenga la sesión iniciada ahí ahora.
No tiene **Cambiar nombre**, y si cambias el inicio de sesión de Claude Code, la fila lo sigue.

## Leer la asignación de tu plan {#read-your-plans-allowance}

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Configuración, sección Inteligencia: dos cuentas en Suscripciones de IA, Codex y Claude, cada una con un medidor de la sesión y un medidor semanal, y un restablecimiento guardado en la cuenta de Codex, luego los botones Add account, la fila del archivo de conexiones y el modelo del primer oficial." width="1048" height="524" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Configuración, sección Inteligencia: dos cuentas en Suscripciones de IA, Codex y Claude, cada una con un medidor de la sesión y un medidor semanal, y un restablecimiento guardado en la cuenta de Codex, luego los botones Add account, la fila del archivo de conexiones y el modelo del primer oficial." width="1048" height="524" />

Cada cuenta muestra un pequeño medidor por cada asignación que tiene su proveedor, como una sesión y una semana.
El número es cuánto queda.
Deja el puntero sobre un medidor para ver cuándo se renueva.

- La barra se vuelve ámbar cuando vas por delante del reloj: gastas más rápido de lo que un ritmo parejo duraría hasta la renovación.
- El número se vuelve ámbar por debajo de la mitad, y rojo por debajo de una quinta parte.
- Junto a los medidores, una palabra resume la cuenta: **al ritmo**, **se agota en** un tiempo, o **agotada**.
- **hace 3 h** significa que la última lectura es antigua, así que sus números aparecen atenuados.
- Un guion significa que esa asignación no se leyó.
- Una cuenta de Codex que tiene [restablecimientos guardados](#saved-codex-resets) dice cuántos debajo de sus medidores.

**Actualizar**, en la parte superior de la lista, vuelve a leer todas las asignaciones.
Infinitary no lee una asignación para OpenRouter ni para una API personalizada, y la fila lo dice.
Amazon Bedrock se factura por uso en tu cuenta de AWS; su fila muestra la estimación de este mes a partir del trabajo que registró Infinitary.

## Elegir qué cuenta hace qué {#choose-which-account-does-what}

Abre el menú de una cuenta, los tres puntos de su fila, para estas opciones.
Sus ajustes van primero, cada uno con un interruptor que muestra si está activado; al elegir uno se activa o desactiva y el menú sigue abierto.

- **Preferir para el trabajo de la tripulación** hace que tu tripulación use primero esta cuenta.
  Un ✱ la marca.
- **En pausa** detiene todo el trabajo en esta cuenta mientras su interruptor está activado.
- **Desconectar** quita la cuenta de Infinitary.

Cuando tienes dos o más cuentas del proveedor que usa tu primer oficial, Configuración te deja elegir en cuál responde tu primer oficial.
Una etiqueta **primer oficial** marca esa cuenta.

## Cuando se agota una asignación {#when-an-allowance-runs-out}

Tu tripulación sigue adelante por sí misma.
El trabajo nuevo va a un modelo al que le queda asignación.
Si no queda ninguno en ese nivel, el trabajo de la tripulación baja a un modelo menos potente o espera hasta que la asignación se renueve.

Cuando se agota la propia cuenta de tu primer oficial, primero pasa a otra cuenta del mismo proveedor a la que todavía le quede algo.
Si no hay ninguna, una tarjeta dice **Tu primer oficial agotó su asignación**.
Tus palabras esperan, y no se pierde nada.
En la tarjeta puedes elegir **Volver a consultar la asignación**, pasar a tu primer oficial a otro proveedor, o **Abrir Configuración**.
Si la consulta no encuentra ningún cambio, la tarjeta también ofrece intentarlo de nuevo con tu proveedor, como **Try Claude again**, para cuando tu primer oficial llegue a él con otro inicio de sesión; si la asignación sigue agotada, se vuelve a pausar.

Algunos proveedores pueden seguir respondiendo con créditos que configuras con ellos.
Para una cuenta de Claude o de Codex, el menú tiene **Seguir con créditos**.
Tu tripulación solo gasta créditos después de toda asignación incluida.
Infinitary nunca compra créditos ni fija su límite; lo hace el propio sitio del proveedor.

### Restablecimientos guardados de Codex {#saved-codex-resets}

ChatGPT puede dar restablecimientos guardados a una cuenta de Codex.
Cada uno renueva una asignación antes de que se renueve por sí sola.
La fila de la cuenta dice cuántos tiene y dónde usar uno, como «1 restablecimiento guardado · úsalo en chatgpt.com».

Mientras se puede usar uno ahora, el menú de la cuenta tiene **Usar un restablecimiento guardado**.
La tarjeta que dice que una asignación se agotó también lo dice, con el mismo botón y un enlace a la página de uso en chatgpt.com.
Infinitary hace entonces que Codex, en tu computadora, use el restablecimiento que vence primero.
Esto necesita Codex 0.143 o posterior, y la primera vez Codex te pide iniciar sesión en esa cuenta de ChatGPT.
Un restablecimiento usado no se puede recuperar.
Actividad dice qué pasó, y cuántos quedan.

Infinitary también puede usarlos sin que hagas clic.
Activa **Usar restablecimientos guardados por sí solo** en el menú de la cuenta, o en esa tarjeta; está desactivado hasta que lo activas.
Entonces Infinitary solo usa uno cuando hay trabajo en espera y ninguna cuenta tiene asignación, y solo cuando esperar a que la asignación se renueve llevaría mucho tiempo.
Las cuentas a las que les queda asignación siempre van primero.
Actividad dice cada vez que usa uno.

## Volver a iniciar sesión {#sign-in-again}

Un inicio de sesión puede caducar.
Cuando pasa, la fila de la cuenta dice **vuelve a iniciar sesión** y muestra un botón **Iniciar sesión**.
Elígelo e inicia sesión como lo hiciste la primera vez.
Esto renueva la misma cuenta, conservando su etiqueta y sus opciones.

## API personalizada {#custom-api}

Si tu organización tiene su propio servidor de IA, elige **API personalizada** en **Agregar cuenta**.
Dale un nombre, la dirección del servidor, una clave si la necesita y los modelos que usar.
**Guardar** comprueba cada modelo antes de que tu tripulación pueda usarlo.
Luego eliges en el tablero **Modelos** si tu tripulación usa estos modelos.

### Conexiones desde un archivo {#connections-from-a-file}

Si ya guardas tus conexiones en un archivo en el formato `models.json` de Pi, Infinitary puede leerlas desde él.
En la fila **Archivo de conexiones**, debajo de **Suscripciones de IA**, presiona **Elegir archivo** y elige el archivo.
Infinitary solo lee el archivo: nunca lo cambia, y nunca usa una clave escrita en él.

Cada conexión que define el archivo aparece marcada como **De tu archivo** y **Aún sin aprobar**.
Presiona **Aprobar**, escribe la clave propia de esta computadora y cualquier tamaño de modelo que el archivo omita, y luego **Guardar**, que comprueba cada modelo.

Después de eso, Infinitary sigue el archivo.
Un nombre o un precio nuevo se aplica enseguida, y un límite que cambia hace que ese modelo se compruebe de nuevo.
Un cambio de dirección, de protocolo o de encabezado pone la conexión en pausa hasta que presiones **Aprobar de nuevo**.
Una conexión que sale del archivo queda en pausa, nunca se elimina.
**Dejar de leer** deja de seguir el archivo, y las conexiones que aprobaste se quedan.

### En tus otras computadoras {#on-your-other-computers}

Cuando otra computadora hace trabajo para ti, la fila de una conexión personalizada ofrece **Usar**, con el nombre de esa computadora.
Escribes la clave propia de esa computadora, que comprueba cada modelo y guarda ella misma la clave; esta computadora no guarda ninguna copia.
Los cambios posteriores en la conexión la siguen hasta ahí.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## Uso {#usage}

Configuración → **Uso** muestra cuánto han usado tu primer oficial y tu tripulación, en todos los proyectos.
Se abre en **$ estimados**; en **Mostrar el uso en** puedes cambiar a **Tokens**.
Elige un **Período** y el tipo de **Trabajo** que quieres contar.
Los dólares estimados son una guía del valor, no una factura.

**Costo por tarea** muestra en un gráfico lo que cuesta una tarea terminada, incluidas sus revisiones.
Cada punto es la mediana de las tareas que terminaron en los siete días anteriores, y la franja contiene la mitad central de ellas.
Una línea que sube significa que las tareas requieren más trabajo que antes.
**Proyectos** y **Tipos** lo limitan al trabajo que quieres comparar.

**Tareas recientes** enumera lo que usó cada tarea.

En **Inteligencia**, **Preguntar antes de que una tarea gaste más de** fija una cantidad.
Una tarea que la supera se detiene en un punto seguro y te pregunta en una tarjeta antes de gastar más.

## Conversaciones largas {#long-conversations}

Cuando una conversación se alarga, tu primer oficial y tu tripulación la resumen y siguen a partir del resumen, para que cada mensaje cueste menos y siga cabiendo en el modelo.
En **Inteligencia**, **Resumir conversaciones largas a los** fija dónde ocurre.

- **Automático** resume a los 300.000 tokens, o antes si un modelo cobra más a partir de un punto más bajo.
- **150.000 tokens**, **200.000 tokens**, **300.000 tokens** o **500.000 tokens** resume en ese número, o en el límite propio del modelo si es menor.
- **El límite de cada modelo** resume solo cerca del límite propio de cada modelo, que puede ser un millón de tokens.

Un número más bajo cuesta menos; uno más alto conserva completa una parte mayor de la conversación.
Cuando el número que eliges deja que un modelo pase de un punto en el que sus solicitudes cuestan más, la fila nombra ese modelo y ese punto.
Una conversación ya abierta sigue un cambio en su siguiente mensaje, también en tus otras computadoras; una conversación con Claude lo sigue cuando vuelve a empezar.
