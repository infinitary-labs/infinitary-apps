---
source: 24d50cb6fd4f7420
title: Manuales
description: La guía escrita que siguen tu primer oficial y tu tripulación para tipos de trabajo, y cómo activarla o desactivarla, leerla y crear o agregar la tuya.
---

Un manual es una guía escrita que tu primer oficial y tu tripulación siguen para un tipo de trabajo, como planear un cambio, dar una lección o nombrar confirmaciones.
Contiene palabras, ejemplos e imágenes, y no ejecuta nada en tu computadora.
Infinitary trae sus propios manuales, y puedes crear o agregar más.

<img class="picture-dark" src="/pictures/runbooks-dark.webp" alt="Configuración, sección Manuales: la lista Built in con Common workflows, Delivery judgment, Testing rules, Rigor levels, Commit and PR naming, Programs y Casual projects, cada uno con una descripción corta, un botón View y un interruptor activado." width="1168" height="618" />
<img class="picture-light" src="/pictures/runbooks-light.webp" alt="Configuración, sección Manuales: la lista Built in con Common workflows, Delivery judgment, Testing rules, Rigor levels, Commit and PR naming, Programs y Casual projects, cada uno con una descripción corta, un botón View y un interruptor activado." width="1168" height="618" />

## Dónde viven los manuales {#where-runbooks-live}

Abre **Configuración** y luego **Manuales**.
También puedes buscar **Abrir Manuales** en la búsqueda de comandos.

La sección tiene tres grupos:

- **Incluidos** enumera los manuales que vienen con Infinitary.
- **Tuyos** enumera los manuales que agregaste o hiciste con tu primer oficial.
- **Crea los tuyos** tiene **Tu carpeta de manuales** y ejemplos de lo que puedes pedir.

Cada fila muestra el nombre de un manual, para qué sirve y su interruptor.

## Activar o desactivar un manual {#turn-a-runbook-on-or-off}

Usa el interruptor de un manual para activarlo o desactivarlo.
También puedes pedírselo a tu primer oficial, como «desactiva Lessons».

Tu primer oficial sigue el cambio cuando termina lo que está haciendo, y también cada tripulante que empieza después.
Un tripulante que ya está trabajando conserva la guía con la que empezó.

Un manual desactivado no guía a nadie, pero se queda en la lista, para que puedas volver a activarlo.

## Los manuales incluidos {#the-built-in-runbooks}

La mayoría de los manuales incluidos empiezan activados.
Cuatro empiezan desactivados hasta que los activas: **Batched pull requests**, **Pull request comments**, **Heartbeat** y **Advanced architecture**.

- **Common workflows**: cómo aborda tu primer oficial la planificación, la construcción, las correcciones y la investigación.
- **Delivery judgment**: cómo juzgan los tripulantes las comprobaciones, las reparaciones y cuándo un cambio está listo para fusionarse, en el trabajo que pasa por una solicitud de incorporación de cambios.
- **Testing rules**: qué probar cuando un tripulante planea o cambia un proyecto.
- **Rigor levels**: lo que cada nivel pide de un cambio: **Rápido**, **Predeterminado** y **Cuidadoso**.
  Consulta [Cuidado](/es/tasks-and-crewmates/#rigor).
- **Commit and PR naming**: cómo se nombran las confirmaciones, las solicitudes de incorporación de cambios y las ramas de trabajo.
  Si está desactivado, y ningún manual tuyo las nombra, Infinitary no comprueba ningún nombre.
- **Programs**: para el trabajo que un script puede dividir, un tripulante escribe un script corto que anota cada parte como una tarea propia.
- **Casual projects**: cómo configura tu primer oficial proyectos pequeños por diversión o para uso personal.
  Consulta [Lo que puedes pedir](/es/what-you-can-ask-for/#a-small-project-for-fun).
- **Lessons**: guía y piezas de tarjeta para aprender un tema a lo largo de días.
  Consulta [Lo que puedes pedir](/es/what-you-can-ask-for/#a-subject-learned-across-days).
- **Batched pull requests**: fusiona juntos tus cambios aprobados como una solicitud de incorporación de cambios del lote, para que sus comprobaciones se ejecuten una sola vez.
  Actívalo para elegir solicitudes de incorporación de cambios por lotes para un proyecto en Configuración → **Proyectos**.
  Consulta [Proyectos](/es/projects/#how-changes-reach-your-project).
- **Pull request comments**: un tripulante responde los comentarios de su solicitud de incorporación de cambios hasta que se fusiona.
  Hace por sí mismo las correcciones claras, y te trae las dudosas como una elección.
- **Outside work items**: cuando un trabajo responde a una incidencia, un ticket o una solicitud guardada fuera de Infinitary, una tarea propia responde a ese elemento y lo cierra cuando el trabajo se publica.
  Cada respuesta o cierre espera tu clic, salvo que lo hayas permitido.
  Consulta [Un paso que espera al trabajo](/es/tasks-and-crewmates/#a-step-that-waits-on-work).
- **Heartbeat**: cuando un trabajo empieza a esperar sin nada que lo mencione, o tras un largo rato de calma, tu primer oficial revisa el trabajo en espera, lo hace avanzar o te pregunta una vez.
  Trae una automatización que puedes pausar en Configuración → **Automatización**, y desactivar el manual la quita.
- **Computer cleanup**: una revisión que solo lee, después de que aceptas, y una tarjeta para elegir qué restos detener.
  Consulta [Lo que puedes pedir](/es/what-you-can-ask-for/#a-look-at-a-computer-under-strain).
- **Moving secrets in**: cómo un tripulante pasa secretos de otra herramienta a **Secretos** sin que ningún agente vea un valor.
  Un tripulante solo lo lee durante ese traslado.
  Consulta [Secretos](/es/secrets/).
- **Feedback**: escribe `/feedback` y unas palabras en cualquier cuadro de mensaje, y un tripulante redacta una incidencia para el creador de Infinitary que tú lees y publicas.
  Lleva datos sobre la app y tu sistema, nunca tus nombres, rutas ni proyectos.
- **Advanced architecture**: traza un mapa de las partes de un proyecto y de cómo se conectan, y muestra lo que un cambio mueve en ese mapa.
  Es un experimento.

Infinitary no te deja desactivar **Batched pull requests** mientras un proyecto usa solicitudes de incorporación de cambios por lotes, y nombra ese proyecto.

## Leer un manual {#read-a-runbook}

Presiona **Ver** junto a un manual incluido.
Abre una copia de solo lectura de la carpeta del manual en tu computadora.
Para cambiar cómo funciona un manual incluido, pide a tu primer oficial que lo haga tuyo, como se explica abajo.

## Crea los tuyos {#make-your-own}

Pídeselo a tu primer oficial, con tus propias palabras.
**Crea los tuyos** en Configuración da ejemplos, como:

- «Dale a cada tripulante una habilidad para escribir notas de versión con palabras sencillas».
- «Haz un manual que le diga al primer oficial que prefiero respuestas cortas».

Un tripulante escribe el nuevo manual en **Tu carpeta de manuales**.
Aparece en **Tuyos** y se activa enseguida, a menos que pidieras que empezara desactivado.

**Abrir carpeta** abre **Tu carpeta de manuales** en tu computadora.
Un cambio en un manual de esa carpeta llega a tu primer oficial y a tu tripulación de la misma forma que un interruptor.

## Hacer tuyo un manual incluido {#make-a-built-in-runbook-yours}

Pide a tu primer oficial que copie un manual incluido, como «Copia Common workflows y haz que siempre planee antes de construir».

1. Tu primer oficial copia el manual entero en **Tu carpeta de manuales**, con un nombre nuevo.
2. La copia aparece en **Tuyos** y empieza desactivada, así que todavía no cambia nada.
3. Cambia la copia tú mismo, o pide a tu primer oficial que la cambie.
4. Activa la copia.
   El manual incluido se desactiva al mismo tiempo.

El manual incluido se queda como estaba.
Para volver atrás, desactiva tu copia y activa el incluido.

## Agregar un manual que alguien compartió {#add-a-runbook-someone-shared}

Pide a tu primer oficial que agregue un manual desde una dirección web o una carpeta, como «Agrega el manual de una dirección web o carpeta que alguien compartió».

No se agrega nada hasta que respondes su tarjeta, titulada con el nombre del manual, como «¿Agregar Release notes?».
La tarjeta nombra de dónde viene el manual, quién lo hizo, a qué llega y cualquier manual incluido que desactiva.

- **Agregar** agrega el manual y lo activa.
- **No agregar** lo rechaza y borra lo que se obtuvo.

Una tarjeta que apartas deja la oferta en espera.
Una actualización de un manual agregado vuelve a preguntarte en el mismo tipo de tarjeta.

Para quitar un manual agregado, pide a tu primer oficial que lo quite por su nombre.
Un manual incluido que desactivó se queda desactivado hasta que lo vuelvas a activar.

Un manual de **Tuyos** que Infinitary no puede leer muestra por qué, sin interruptor, y no guía a nadie hasta que se corrija.

## Desde otra computadora {#from-another-computer}

En una computadora que controla a tu primer oficial desde otro lugar, los interruptores cambian los manuales donde vive tu primer oficial.
**Ver** y **Abrir carpeta** solo funcionan en esa computadora, y la fila de la carpeta la nombra.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## Usar el teclado {#use-the-keyboard}

Tab llega a cada botón **Ver** y a cada interruptor.
La búsqueda de comandos tiene **Abrir Manuales** y **Abrir tu carpeta de manuales**, y puedes asignar una tecla a cualquiera de los dos en Configuración → **Teclado**.
Consulta [Teclado](/es/keyboard/).
