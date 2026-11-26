---
source: 0f80b78b2636fcc9
title: Tareas y tripulantes
description: Qué es una tarea, cómo pasa de pendiente a terminada, dónde seguirla y cómo orientar al tripulante que la hace.
---

Una tarea es una pieza de trabajo que sigue tu primer oficial, con una clave como `WEB-12`.
Un tripulante es el ayudante de IA que hace el trabajo de una tarea, en su propia copia de trabajo de tu proyecto.
Cada tarea guarda un registro de lo que pediste, lo que cambió, las pruebas y lo que decidiste.

## En qué punto está una tarea {#where-a-task-stands}

Tareas, a la derecha de la ventana, enumera tus tareas según en qué punto están:

- **Esperándote**: una tarjeta de la tarea necesita tu decisión.
- **Trabajando**: un tripulante está en ella ahora.
- **En cola**: empieza sola cuando termina aquello que espera, como otra tarea.
- **Pendientes**: espera a que la inicies.
  Presiona **Iniciar** en su fila cuando quieras que empiece.
- **Terminadas · 7 d**: terminadas esta semana.

Una fila puede agregar una palabra después de su título, como «bloqueada», «retenida», «comprobaciones» o «no pudo iniciarse».
Una tarea que no pudo iniciarse ofrece **Volver a intentar**.

Haz clic en una fila para abrir la tarea.
Si una tarjeta de ella te espera, esa tarjeta pasa primero al frente.

### La marca junto a cada tarea {#the-mark-beside-each-task}

Cada fila de Tareas empieza con una pequeña marca.
Su forma dice en qué punto está la tarea, y su color lo respalda.

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **Pendientes**: espera a que presiones **Iniciar**.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **En cola**: empieza sola cuando puede.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **Iniciando**: Infinitary está preparando a su tripulante.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Trabajando**: un tripulante está trabajando en ella ahora.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Trabajando, en trabajo de fondo**: algo que empezó su tripulante, como una compilación o una ejecución de pruebas larga, sigue en marcha.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Trabajando, esperando las comprobaciones**: su tripulante espera a que terminen las comprobaciones de su cambio.
  La fila agrega «comprobaciones».
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Trabajando, esperando el lote**: su cambio aprobado espera las comprobaciones del lote al que se unió.
  La fila agrega «lote».
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **En reposo**: empezó, pero su tripulante no está trabajando ahora mismo, y su trabajo se guarda.
  Cuando espera otra tarea, la fila agrega «esperando».
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Interrumpida**: el turno de su tripulante se detuvo antes de terminar.
  Dile qué hacer a continuación.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Esperándote**: una tarjeta de la tarea necesita tu decisión.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **Terminada**: está terminada.
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **Abandonada**: se abandonó.
  El trabajo abandonado aparece en el tablero de tareas, no en Tareas.

Cuando la computadora en la que se ejecuta una tarea está fuera de alcance, su marca conserva su forma y se vuelve naranja, y la fila termina con «fuera de alcance» ([Tus otras computadoras](/es/your-other-computers/#a-computer-that-runs-work)).
Por ejemplo, una tarea Pendiente en esa computadora muestra <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>.

Una tarea dividida en partes enumera sus partes debajo.
Cuando una de sus partes empieza, la tarea aparece en Trabajando, con sus partes abiertas debajo.
Una tarea en cola conserva ahí la marca de En cola, mientras que una tarea de Pendientes cuyas partes hacen el trabajo toma la marca de su parte abierta más urgente, como Esperándote mientras la tarjeta de una parte espera.

Para leer en palabras el estado de una tarea y su motivo, deja el puntero sobre su fila, o ve a la fila con el teclado.

## El tablero de tareas {#the-task-board}

Para una vista más completa, presiona **Abrir el tablero de tareas** en el encabezado de Tareas.
El tablero muestra Esperándote arriba, y luego tres columnas: Pendientes, En cola y Trabajando.

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="El tablero de tareas: una fila con las etiquetas del proyecto, una tarea que te espera arriba, y luego las columnas Backlog, Queued y Working." width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="El tablero de tareas: una fila con las etiquetas del proyecto, una tarea que te espera arriba, y luego las columnas Backlog, Queued y Working." width="876" height="493" />

Sus vistas también enumeran todos los pendientes, Terminadas · 7 d y el trabajo abandonado esta semana.
Escribe una clave o un título en **Buscar una tarea** para filtrar todas las columnas, incluido el trabajo terminado más antiguo.
Cuando tu proyecto tiene etiquetas, el tablero muestra una fila con ellas, y presionar una limita el tablero a sus tareas; consulta [Etiquetas](#tags).

Para mover una tarea, arrastra su ficha a otra columna, o usa su menú ⋯:

- A **En cola**, empieza sola cuando puede.
- A **Trabajando**, empieza ahora.
- De vuelta a **Pendientes**, vuelve a esperar tu palabra.
  Una tarea que ya empezó conserva su trabajo.
- A la bandeja **Abandonar tarea**, se abandona.

Un movimiento que iniciaría trabajo o lo abandonaría pregunta primero una vez.
El tablero nunca fusiona nada: una fusión solo ocurre en la tarjeta de fusión de la tarea.

## La tarjeta de una tarea {#a-tasks-card}

Abre una tarea para ver su tarjeta.
Debajo de su título hay una fila de pestañas:

- **Info**: lo que pediste, en qué punto está, sus etiquetas y cómo se entrega.
- **Tarjetas**: las tarjetas que la tarea te ha mostrado, con cuántas son.
- **Actividad**: cada línea que la tarea ha escrito, en orden.
- **Tripulante**: la propia conversación del tripulante, línea por línea, mientras trabaja.
- **Navegador**: una página que el tripulante abrió en su propio navegador, cuando tiene una.
  Consulta [El navegador de la tripulación](/es/the-crews-browser/).

Una pestaña solo aparece cuando la tarea tiene algo que mostrar en ella.

## Una tarea dividida en partes {#a-task-split-into-parts}

En la pestaña **Info** de una tarea dividida en partes, la fila **Partes** cuenta las partes cerradas y lista cada parte con su estado, en el orden en que se registraron.
Presiona el recuento para plegar la lista, y presiónalo otra vez para abrirla.
Con más de ocho partes, las cerradas se pliegan tras una línea que puedes abrir.
Para abrir la tarjeta de una parte, haz clic en ella, o llega a ella con el teclado y presiona Enter; iníciala o respóndela allí.

Una tarea de tus pendientes cuyas partes hacen el trabajo nunca te pide su propio **Iniciar**.
En su lugar, lo alto de su pestaña **Info** dice qué esperan sus partes, como «Su última parte espera que presiones Iniciar», y la tarea se cierra sola cuando se cierran sus partes.

## Etiquetas {#tags}

Una tarea puede llevar cualquiera de las etiquetas de su proyecto, como error o función.
Creas las etiquetas de un proyecto en Configuración → Proyectos; consulta [Proyectos](/es/projects/#tags).

Para etiquetar una tarea, abre su pestaña **Info** y presiona **Editar etiquetas** en la fila **Etiquetas**.
Un menú enumera las etiquetas del proyecto, y cada una que marcas se guarda de inmediato.
La fila **Etiquetas** aparece cuando el proyecto tiene etiquetas.
También puedes pedirle a tu primer oficial que etiquete una tarea.

Puedes encontrar tareas por etiqueta en tres lugares:

- **Buscar tareas**, en el encabezado de Tareas, muestra una fila con las etiquetas del proyecto.
  Presiona una etiqueta para ver solo las tareas que la llevan, **Sin etiqueta** para las tareas que no llevan ninguna, o **Todas las etiquetas** para volver a ver todas las tareas.
- **Agrupar tareas**, a su lado, enumera tus tareas **Por etiqueta** en lugar de **Por estado**.
  Cada etiqueta es un grupo, contraído hasta que lo abres.
  Una tarea **Esperándote** aparece primero en el grupo de cada etiqueta que lleva, y sigue a la vista aunque ese grupo esté contraído.
- El tablero de tareas tiene su propia fila de etiquetas, y su vista **Por etiqueta** cuenta las tareas de cada etiqueta según en qué punto están.

Las etiquetas se muestran para un proyecto a la vez: el proyecto que está en el centro, o tu único proyecto con etiquetas.
Para centrarte en un proyecto, consulta [Proyectos](/es/projects/#focus-on-one-project).

## Orientar a un tripulante {#steering-a-crewmate}

Puedes decirle algo a un tripulante de tres formas:

1. Escribe debajo de una de sus tarjetas y presiona **Conversar**.
2. Escribe en el cuadro al pie de su pestaña **Tripulante**.
   Un tripulante que está trabajando recibe tus palabras mientras trabaja; uno en reposo vuelve a empezar a partir de ellas.
3. Díselo a tu primer oficial, en el cuadro de mensaje.

Para detener el turno de un tripulante, presiona **Detener** en su pestaña Tripulante.
La tarea sigue abierta, y puedes decirle qué hacer a continuación.

## Cuidado {#rigor}

El cuidado es la minuciosidad con que se comprueba el trabajo antes de que te llegue.
Tiene tres niveles:

- **Rápido**: las comprobaciones se superan, y poco más.
- **Predeterminado**: el tripulante muestra el cambio funcionando, con imágenes, y ejecuta las pruebas que importan.
- **Cuidadoso**: lo Predeterminado, y luego una revisión independiente y la prueba de que el cambio funciona, antes de la tarjeta de fusión.

Cada proyecto tiene su propio Cuidado, en Configuración → Proyectos.
Para una tarea, di con cuánto cuidado hacerla cuando la pidas, como «ten cuidado con esta».
En una tarjeta de fusión, **Revisar con cuidado** sube esa tarea a Cuidadoso.

## Preguntar antes de fusionar {#asking-before-merging}

Cada proyecto pregunta antes de fusionar o fusiona por su cuenta.
El interruptor **Preguntar antes de fusionar** de Configuración → Proyectos lo define.
Cuando está activado, el trabajo terminado espera tu tarjeta de fusión.
Cuando está desactivado, el trabajo que supera las comprobaciones puede fusionarse sin preguntarte, y después recibes una tarjeta con su historia.
Para cambiarlo en una tarea, díselo a tu primer oficial.

## Un paso que espera al trabajo {#a-step-that-waits-on-work}

Cuando pides algo fuera de tu proyecto para cuando el trabajo termine, como cerrar una incidencia o publicar una novedad, tu primer oficial registra ese paso como una tarea propia.
Espera a cada tarea que hace el trabajo, incluidas las partes que se añadan después.

- Empieza solo cuando cada una de esas tareas ha fusionado su cambio, o ha terminado sin nada que fusionar.
- Si una de ellas se abandona, el paso no hace nada y tu primer oficial te avisa.
- Si pediste el paso para cuando el trabajo esté en una versión publicada, espera hasta que tu tripulación registre una versión que contenga el trabajo; consulta [Automatización](/es/automation/#when-it-runs).

Infinitary no añade a un cambio fusionado palabras que cierren una incidencia, así que una incidencia se cierra mediante la tarea propia de ese paso.

## Cerrar una tarea {#closing-a-task}

La mayoría de las tareas se cierran solas:

- Fusionar su cambio cierra la tarea.
- **Descartar** en su tarjeta de fusión abandona el trabajo.
- **Hecho** en una nota que responde tu pregunta la cierra como respondida.

También puedes cerrar una desde su tarjeta:

- **Abandonar tarea** la termina.
  Un tripulante que está trabajando se detiene, y su trabajo sin terminar se guarda.
- **Cerrar como terminada**, en una tarea que empezó, dice que el trabajo está hecho.

Una tarea cerrada conserva su registro.
El trabajo abandonado se queda en el tablero una semana, solo para leer.
