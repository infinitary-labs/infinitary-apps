---
source: f2b6491db2dbaf8c
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

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Dos cuentas en Suscripciones de IA, Codex y Claude, cada una con un medidor de la sesión y un medidor semanal, y los botones Add account debajo." width="1064" height="532" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Dos cuentas en Suscripciones de IA, Codex y Claude, cada una con un medidor de la sesión y un medidor semanal, y los botones Add account debajo." width="1064" height="532" />

Cada cuenta muestra un pequeño medidor por cada asignación que tiene su proveedor, como una sesión y una semana.
El número es cuánto queda.
Deja el puntero sobre un medidor para ver cuándo se renueva.

- La barra se vuelve ámbar cuando vas por delante del reloj: gastas más rápido de lo que un ritmo parejo duraría hasta la renovación.
- El número se vuelve ámbar por debajo de la mitad, y rojo por debajo de una quinta parte.
- Junto a los medidores, una palabra resume la cuenta: **al ritmo**, **se agota en** un tiempo, o **agotada**.
- **hace 3 h** significa que la última lectura es antigua, así que sus números aparecen atenuados.
- Un guion significa que esa asignación no se leyó.

**Actualizar**, en la parte superior de la lista, vuelve a leer todas las asignaciones.
Infinitary no lee una asignación para OpenRouter ni para una API personalizada, y la fila lo dice.
Amazon Bedrock se factura por uso en tu cuenta de AWS; su fila muestra la estimación de este mes a partir del trabajo que registró Infinitary.

## Elegir qué cuenta hace qué {#choose-which-account-does-what}

Abre el menú de una cuenta, los tres puntos de su fila, para estas opciones.

- **Preferir para el trabajo de la tripulación** hace que tu tripulación use primero esta cuenta.
  Un ✱ la marca.
- **Pausar** detiene todo el trabajo en esta cuenta hasta que elijas **Reanudar**.
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

## Uso {#usage}

Configuración → **Uso** muestra cuánto han usado tu primer oficial y tu tripulación, en todos los proyectos.
Muéstralo en **Tokens** o **$ estimados**, para un **Período** y para el tipo de **Trabajo**.
Los dólares estimados son una guía del valor, no una factura.
**Tareas recientes** enumera lo que usó cada tarea.

En **Inteligencia**, **Preguntar antes de que una tarea gaste más de** fija una cantidad.
Una tarea que la supera se detiene en un punto seguro y te pregunta en una tarjeta antes de gastar más.
