---
source: 3e64699c942fc0e5
title: Solución de problemas
description: Problemas comunes en Infinitary, las palabras que muestra la app para cada uno y qué hacer.
---

Cada problema de abajo empieza con las palabras que te muestra Infinitary.

## Una suscripción necesita que vuelvas a iniciar sesión {#a-subscription-needs-you-to-sign-in-again}

Puede que veas una tarjeta titulada «Tu primer oficial necesita que vuelvas a iniciar sesión», o una suscripción en Configuración → **Inteligencia** que dice «vuelve a iniciar sesión».
El trabajo en esa suscripción espera: «El trabajo está en pausa hasta que vuelvas a iniciar sesión».

1. Presiona **Iniciar sesión** en la tarjeta, o abre Configuración → **Inteligencia**.
2. Inicia sesión en esa suscripción como te lo pida tu proveedor.
3. El trabajo en espera sigue solo.

Una tarea que se ejecuta en otra computadora usa el propio inicio de sesión de esa computadora, así que vuelve a iniciar sesión para esa computadora, bajo su nombre.

## Se agotó la asignación de tu plan {#your-plans-allowance-ran-out}

Tu primer oficial muestra una tarjeta titulada «Tu primer oficial agotó su asignación».
Una respuesta a un tripulante en esa suscripción dice «Guardada, todavía sin enviar», con cuándo se renueva la asignación.
El trabajo sigue solo cuando se renueva.

Para seguir antes:

- Presiona **Volver a consultar la asignación** si cambiaste algo del lado de tu proveedor.
- Presiona **Pasar a** otro proveedor, cuando la tarjeta ofrezca uno.
- Pide a tu primer oficial que pase el trabajo a otro modelo.

Configuración → **Inteligencia** muestra cuánto queda de la asignación de cada plan, y cuándo se renueva.
Para Claude y Codex, **Seguir con créditos** deja que una cuenta continúe con créditos configurados con tu proveedor.

## Tu primer oficial no responde {#your-first-mate-is-not-answering}

Si un mensaje no trajo nada de vuelta, una tarjeta dice «Tu primer oficial no ha respondido a tu mensaje».
Presiona **Volver a preguntar** para enviarlo otra vez, o **Dejarlo**.

Si el propio proveedor no responde, una tarjeta dice que «no está respondiendo a tu primer oficial en este momento».
Presiona **Volver a intentar con Claude**, o el mismo botón con el nombre de tu proveedor, o **Abrir Configuración** para elegir otra suscripción.
Cuando un proveedor tiene un problema breve, Actividad lo dice, y la app vuelve a intentarlo por su cuenta.

## Un tripulante está esperando {#a-crewmate-is-waiting}

Una tarea que dice **Esperándote** tiene una tarjeta para ti.
Abre la tarea y presiona **Mostrar la tarjeta**, y luego decide.

Otras palabras en una tarea dicen qué la retiene:

- «Esperando las comprobaciones»: su tripulante espera las comprobaciones de su solicitud de incorporación de cambios.
- «Reintentando en su proveedor»: el proveedor falló, y la app vuelve a intentarlo por su cuenta.
- «Atascada en su proveedor»: el proveedor rechazó la misma petición tres veces, y tu primer oficial está eligiendo qué hacer.
- «Bloqueada por otra tarea»: empieza cuando esa tarea termine.

## Las comprobaciones fallaron en una solicitud de incorporación de cambios {#the-checks-failed-on-a-pull-request}

Cuando las comprobaciones fallan, el tripulante que hizo la solicitud de incorporación de cambios las corrige y trae una nueva versión.
Una tarjeta de fusión ofrece entonces **Fusionar tras corregir los errores**.
Si la presionas, tu fusión se guarda: «Tu fusión espera una corrección: sus comprobaciones fallaron».
Se ejecuta cuando se superan las comprobaciones de la corrección, o el tripulante vuelve a preguntarte en una tarjeta nueva si la corrección cambió el trabajo.

## Otra computadora está fuera de alcance {#another-computer-is-out-of-reach}

Una ventana en otra computadora dice «Los cambios están desactivados hasta que» la otra computadora «vuelva. Puede que esté en reposo, o en otra red».
O bien: «Infinitary está cerrado en» esa computadora.

1. Despierta la computadora donde vive tu primer oficial, y abre Infinitary ahí.
2. Pon las dos computadoras en la misma red, o en la misma red privada.
3. En Configuración → **Dispositivos**, presiona **Volver a intentar** en su fila.

Si una computadora que agregaste por su dirección tiene una dirección nueva, presiona **Cambiar dirección** en su fila.
En una Mac, macOS puede mantener a Infinitary fuera de la red local hasta que alguien en esa Mac lo permita.
Su fila ofrece entonces **Agregar por su dirección**.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## La ventana deja de responder {#the-window-stops-answering}

Espera un momento primero.
Si sigue atascada, cierra Infinitary y vuelve a abrirlo.
Los mensajes que tu primer oficial o un tripulante no habían terminado se retoman cuando se abre.

## macOS pregunta por los datos de otras apps {#macos-asks-about-other-apps-data}

macOS puede preguntar «Infinitary quiere acceder a datos de otras apps».
Esto pasa cuando la búsqueda de un tripulante llega a archivos que guarda otra app.
El trabajo de Infinitary rara vez los necesita, así que **No permitir** suele estar bien.
El registro de la tarea dice que está «Esperando a macOS» hasta que respondas, y luego la búsqueda sigue.

## Falta Claude Code {#claude-code-is-missing}

Para usar una suscripción de Claude, instala primero Claude Code en esa computadora.
Sin él, Infinitary dice «Claude Code no está instalado en esta computadora. Instálalo para usar Claude aquí».
Si el tuyo es demasiado antiguo, nombra la versión necesaria y dice que ejecutes `claude update`.
En otra computadora, Claude Code inicia sesión ahí por sí mismo: inicia sesión en él ahí una vez, e Infinitary usa ese inicio de sesión.

## Sigues atascado {#still-stuck}

Consulta [Obtener ayuda](/es/get-help/).
Di qué hiciste, qué esperabas y qué pasó en cambio.
