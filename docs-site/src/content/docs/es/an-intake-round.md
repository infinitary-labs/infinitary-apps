---
source: f2e3bc29a54d982b
title: Una ronda de recepción
description: Haz que tu tripulación lea las nuevas incidencias y solicitudes de incorporación de cambios de un proyecto según un horario, redacte las respuestas y publique las sencillas bajo una directriz con tus propias palabras.
---

Una ronda de recepción es una tarea que lee lo que otras personas escribieron en tu proyecto, como nuevas incidencias y solicitudes de incorporación de cambios, y redacta qué hacer con cada una.
La construyes con piezas que Infinitary ya tiene: una automatización, un tripulante que solo lee y una directriz con tus propias palabras.
Funciona con cualquier proyecto al que Infinitary llegue donde vive, en GitHub, GitLab o Bitbucket.

## Iniciar una ronda según un horario {#start-a-round-on-a-schedule}

1. Abre **Configuración**, luego **Automatización**, y elige **Nueva automatización**.
2. En **Cuándo**, elige con qué frecuencia se ejecuta.
3. En **Proyecto**, elige el proyecto del que trata.
4. En **Dile a tu primer oficial**, escribe tu método: qué leer, cómo juzgar cada elemento y cómo es una respuesta sencilla.
5. Elige **Activar…** para revisarla y activarla.

Por ejemplo: «Lee, con un tripulante que solo lee, las incidencias y solicitudes de incorporación de cambios abiertas o respondidas desde la última ronda. Redacta una respuesta para cada una e inicia una tarea que publique cada respuesta sencilla.»

## El tripulante que lee {#the-crewmate-that-reads}

Las palabras de las incidencias y solicitudes de incorporación de cambios pueden venir de cualquiera, así que la ronda las lee como un tripulante que solo lee.
Trata todo lo que lee como información, nunca como instrucciones.
Todo lo que quiera enviar te espera en una sola tarjeta de aprobación, diga lo que diga una directriz.
Consulta [Un tripulante que lee palabras que cualquiera puede escribir](/es/integrations/#a-crewmate-that-reads-words-anyone-can-write).

## Dejar que las respuestas sencillas salgan sin tu clic {#let-plain-replies-go-without-your-click}

Una respuesta puede salir sin tarjeta cuando dijiste, con tus propias palabras, que puede hacerlo.

1. Dile a tu primer oficial una directriz para el proyecto que diga qué respuestas pueden salir sin preguntar.
   Por ejemplo: «Las tareas de envío de la ronda de recepción pueden publicar respuestas que sigan claramente nuestro método de recepción, y nada más; todo lo raro o ambiguo espera mi clic.»
2. En tu método, pide a tu primer oficial que inicie una tarea propia para cada respuesta redactada, que la publique y no lea ninguna de las palabras de los desconocidos.
3. Cuando una respuesta es claramente una que tu directriz cubre, el tripulante de esa tarea la publica una vez, sin tarjeta, nombrando tu directriz.
   Una respuesta que le parezca rara, o que tu directriz no cubra, espera tu clic en una tarjeta.

Infinitary solo comprueba que tu directriz sigue vigente: su redacción actual se te oyó a ti y no está retirada.
Si una respuesta es una que tus palabras permiten lo juzga tu tripulante.
Un sí que ya diste en una tarjeta para el mismo trabajo deja salir una respuesta de la misma manera.
Consulta [Quién sigue una directriz](/es/knowledge/#who-follows-a-direction).

## Lo que sigue esperándote {#what-still-waits-for-you}

- Todo lo que el tripulante que lee envíe por sí mismo, diga lo que diga una directriz.
- Un cambio a través de una integración, que mantiene su regla en **Configuración** → **Integraciones**.
- Un cambio en otro proyecto.
  Una tarea sin proyecto en GitHub, GitLab o Bitbucket trabaja en cambio con tu inicio de sesión de GitHub, y ahí un sí tuyo puede dejar salir un cambio a cualquier repositorio.
- Una fusión, que solo se hace desde su tarjeta de fusión.

## Ver lo que salió {#see-what-went-out}

Cada respuesta publicada sin tarjeta añade una línea a la **Actividad** de su tarea, citando las palabras tuyas en las que se apoyó.
Una respuesta cuyo resultado se desconoce nunca se vuelve a enviar; lee el elemento donde vive tu proyecto para ver si llegó.

## Detenerla {#stop-it}

Para que las respuestas dejen de salir solas, dile a tu primer oficial que retire o cambie la directriz.
Desde entonces, cada respuesta vuelve a esperar tu clic.
Para detener la ronda en sí, elige **Pausar** en su automatización, en **Configuración** → **Automatización**.

## Siguiente {#next}

- [Automatización](/es/automation/)
- [Conocimiento](/es/knowledge/)
- [Integraciones](/es/integrations/)
