---
source: b49e11a26445efba
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
- Si la consulta no encuentra ningún cambio, la tarjeta también ofrece intentarlo de nuevo con tu proveedor, como **Try Claude again**: tus palabras se envían una vez y, si la asignación sigue agotada, el primer oficial se vuelve a pausar.
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

Si una computadora que agregaste por su dirección tiene una dirección nueva, abre su menú, los tres puntos de su fila, y elige **Cambiar dirección**.
En una Mac, macOS puede mantener a Infinitary fuera de la red local hasta que alguien en esa Mac lo permita.
Su fila ofrece entonces **Agregar por su dirección**.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## Una computadora aparece dos veces {#a-computer-is-listed-twice}

Configuración → **Dispositivos** muestra el mismo nombre dos veces: una fila al alcance, y otra fuera de alcance que todavía tiene tareas.
Esto ocurre cuando una computadora que hace trabajo se vuelve a unir después de que se eliminó su trabajo guardado, o después de instalar Infinitary desde cero ahí.
La fila al alcance dice «Una entrada anterior con este nombre y este usuario está fuera de alcance».

1. En la fila al alcance, presiona **Continuar sus tareas aquí**.
2. Lee lo que continúa y lo que se queda atrás, y luego presiona **Continuarlas**.
3. Cada tarea continúa desde la última confirmación que trajo la computadora donde vive tu primer oficial.
   La fila anterior sale de tu lista cuando todas las tareas se han movido.

Las confirmaciones posteriores a esa, los cambios sin confirmar y los archivos de las carpetas de tareas anteriores se quedan con la entrada anterior.
Para una fila fuera de alcance sin coincidencia, presiona **Mover sus tareas a…** y elige una computadora.
Consulta [Qué elimina tu trabajo guardado](/es/update-and-remove/#what-deletes-your-saved-work).

## La ventana deja de responder {#the-window-stops-answering}

Espera un momento primero.
Si sigue atascada, cierra Infinitary y vuelve a abrirlo.
Los mensajes que tu primer oficial o un tripulante no habían terminado se retoman cuando se abre.

## Infinitary no pudo iniciarse {#infinitary-could-not-start}

Después de dos inicios que se detuvieron antes de que Infinitary terminara de iniciarse, muestra una pantalla titulada «Infinitary no pudo iniciarse».
La pantalla dice «Se detuvo dos veces antes de terminar de iniciarse. Tu trabajo guardado no ha cambiado».

- **Reintentar** inicia Infinitary una vez más.
- **Restablecer Infinitary** empieza de nuevo como recién instalado.
  Pregunta primero, con **Conservar todo** para volver, y después tu computadora confirma que eres tú.
  Elimina todo lo que Infinitary guarda en esta computadora, mientras que los proyectos en tus propias carpetas conservan todos sus archivos y commits.
- **Salir** cierra la pantalla, que vuelve a aparecer la próxima vez que se inicia Infinitary.

Las pantallas que Infinitary muestra cuando no puede abrir tu trabajo guardado también ofrecen **Restablecer Infinitary**.
Consulta [Restablecer Infinitary](/es/update-and-remove/#reset-infinitary) para saber qué elimina un restablecimiento.

### Restablecer desde una terminal {#reset-from-a-terminal}

Cuando no se abre ninguna ventana, cierra Infinitary y ejecuta esto en una terminal:

```sh
infinitary reset
```

En una Mac, escribe `/Applications/Infinitary.app/Contents/MacOS/Infinitary` en lugar de `infinitary`, y para una AppImage, escribe la ruta del archivo.
Tu computadora confirma que eres tú, y el comando responde «Infinitary se restableció. La próxima vez se abre en la pantalla de bienvenida».
Mientras Infinitary está abierto en esta computadora, o cuando no lo confirmas, el comando dice que no se restableció nada.

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
