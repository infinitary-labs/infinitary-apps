---
source: e0dc8618b3364025
title: Automatización
description: Dale a tu primer oficial una indicación que se ejecuta según un horario o cuando pasa algo, y pausa, cambia o vuelve a leer cualquiera de ellas en Configuración.
---

Una automatización es una indicación que tu primer oficial recibe según un horario.
Tú escribes qué decirle a tu primer oficial, y eliges cuándo.
Cuando llega el momento, tu primer oficial recibe la indicación y actúa como si acabaras de enviarla.

Puedes crear una en Configuración, o decirle a tu primer oficial qué ejecutar y cuándo.

## Dónde viven las automatizaciones {#where-automations-live}

Abre **Configuración** y luego **Automatización**.
También puedes buscar **Abrir Automatización** en la búsqueda de comandos.

La lista de la izquierda muestra cada automatización con su estado:

- **En ejecución** se ejecuta en su próxima hora.
- **Borrador** está guardada pero nunca se ejecuta hasta que la activas.
- **En pausa** conserva sus ajustes pero no se ejecuta.
- **Hecha** es una automatización de una sola vez que ya se ejecutó y espera a que tu primer oficial la atienda.

Elige una automatización para leerla o cambiarla.
**Buscar automatizaciones** encuentra una por su nombre, su indicación o cuándo se ejecuta.

## Crear una automatización {#make-an-automation}

1. Abre **Configuración**, luego **Automatización**, y elige **Nueva automatización**.
2. Dale un **Nombre**, como «Revisión semanal».
3. En **Cuándo**, elige con qué frecuencia se ejecuta.
4. En **Proyecto**, elige el proyecto del que trata, o deja **Sin proyecto**.
5. En **Dile a tu primer oficial**, escribe la indicación.
6. Elige **Guardar borrador** para guardarla para más adelante, o **Activar…** para revisarla y activarla.

**Vista previa** muestra las próximas tres veces que se ejecutará, y la indicación tal como la recibirá tu primer oficial.
No se envía nada.

## Cuándo se ejecuta {#when-it-runs}

- **Se repite** se ejecuta cada cierto número de minutos, como mucho cada 15 minutos.
- **Todos los días** se ejecuta a una hora del día.
- **Los días elegidos** se ejecuta los días de la semana que elijas, a una hora del día.
- **Una vez** se ejecuta en una fecha y hora.
- **Cuando pasa algo** se ejecuta cada vez que pasa algo nuevo, como **Una tarea se cierra**, **El trabajo sale en una versión publicada**, o un evento de algo que conectaste en Configuración.

**El trabajo sale en una versión publicada** ocurre cuando tu tripulación registra por primera vez el trabajo de una tarea en una versión de tu proyecto, lo que hace cuando publica o comprueba una.
Un proyecto que nunca registra versiones nunca lo tiene.

Una automatización diaria o semanal conserva la **Zona horaria** que elijas, así que se ejecuta a la misma hora dondequiera que esté tu computadora.

Cada botón de **Insertar** bajo la indicación pone un dato en ella, como la hora para la que estaba prevista.
Cada dato se completa cuando se envía la indicación.

## Activarla {#turn-it-on}

Una automatización nueva creada en Configuración empieza como borrador.
Un borrador nunca se ejecuta.

Cuando eliges **Activar…**, la página muestra lo que pasará antes de que se ejecute nada:

- cuándo se ejecuta y en qué zona horaria,
- el proyecto y la indicación exactamente como los recibe tu primer oficial,
- las próximas veces que se ejecuta,
- lo que envía: la indicación y sus datos de programación van a tu suscripción de IA y se quedan en la conversación de tu primer oficial, y nada más obtiene acceso nuevo,
- qué pasa con una hora perdida.

Elige **Activar** para iniciarla, o **Atrás** para volver sin cambiar nada.

Tu primer oficial también puede crear automatizaciones.
Una automatización que se repite y que tu primer oficial crea por su cuenta espera como borrador hasta que la activas.

## Pausar, cambiar o eliminar {#pause-change-or-delete}

- **Pausar** detiene una automatización en ejecución.
  Una indicación que todavía no había entregado se retira.
- **Reanudar** la vuelve a iniciar desde su próxima hora.
  No recupera el tiempo que estuvo en pausa.
- **Pausar todas** pausa todas las automatizaciones en ejecución a la vez.
  No toca los borradores.
  También puedes buscar **Pausar todas las automatizaciones** en la búsqueda de comandos.
- **Eliminar**, y luego **Eliminar para siempre**, la quita con su historial.
  Las tareas y tarjetas a las que dio lugar se quedan.

## Cuando Infinitary está cerrado {#when-infinitary-is-closed}

Las automatizaciones solo se ejecutan mientras Infinitary está abierto y la computadora está despierta.
Si pasa una hora mientras está cerrado, la automatización se ejecuta una vez cuando Infinitary vuelve a abrirse, y la indicación dice cuántas veces se perdió.

## Historial {#history}

En la página de una automatización, la pestaña **Historial** enumera sus ejecuciones, la más reciente primero.
Cada ejecución muestra su situación:

- **En espera**: tu primer oficial todavía no la ha atendido.
- **Reintentando**: tu primer oficial todavía no pudo recibirla, y se está intentando de nuevo.
- **Atendida**: tu primer oficial la atendió.
- **Cancelada**: se retiró antes de que tu primer oficial la leyera, por ejemplo porque pausaste la automatización.

Una ejecución atendida muestra lo que encontró tu primer oficial, después de **Encontrado:**, y las tareas y tarjetas a las que **Dio lugar a**.
El historial guarda las ejecuciones durante 30 días.

## Notas {#notes}

Una automatización puede guardar **Notas** que sus ejecuciones escriben para las siguientes, para que la próxima ejecución empiece más rápido.
Un tripulante que inicia una automatización las edita, y tú también puedes editarlas.
Son consejos, nunca instrucciones.
**Versiones anteriores** muestra cada versión pasada y quién la escribió.

## Sigue en marcha {#kept-running}

Debajo de la lista, **Sigue en marcha** muestra los trabajos que un tripulante configuró a petición tuya y que siguen en marcha después de que su tarea se cerró.
**Comprobar** mira si un trabajo sigue en marcha, y **Quitar** lo retira.

## El panel Automatización {#the-automation-panel}

Cuando tienes una automatización, el panel **Automatización** aparece en el costado de la ventana.
Enumera el estado y la próxima ejecución de cada automatización.
Haz clic en una para abrirla en Configuración.
Consulta [Paneles](/es/panels/).
