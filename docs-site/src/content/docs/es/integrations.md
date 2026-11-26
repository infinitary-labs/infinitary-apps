---
source: 1ce217aea874fab1
title: Integraciones
description: Conecta GitHub, GitLab, Bitbucket, Google y servidores MCP para que tu primer oficial y tu tripulación puedan alcanzarlos, y elige lo que cada uno puede hacer sin preguntarte.
---

Una integración es una conexión con algo fuera de tus proyectos, como GitHub, Gmail o un servicio propio.
Cada una tiene la sesión iniciada como tú.
Tu primer oficial, tu tripulación, tus automatizaciones y tus paneles la alcanzan de la misma forma, con el mismo inicio de sesión y las mismas reglas.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Configuración, sección Integraciones: un servidor Notes conectado con cada una de sus lecturas y su cambio en Asks you junto a un interruptor activado, luego botones para agregar GitHub, Google, un servidor MCP, Notion, Linear, Bitbucket, GitLab o GitHub Enterprise, el comando Infinitary desactivado y una lista Private sites vacía." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Configuración, sección Integraciones: un servidor Notes conectado con cada una de sus lecturas y su cambio en Asks you junto a un interruptor activado, luego botones para agregar GitHub, Google, un servidor MCP, Notion, Linear, Bitbucket, GitLab o GitHub Enterprise, el comando Infinitary desactivado y una lista Private sites vacía." width="1180" height="709" />

## Dónde viven las integraciones {#where-integrations-live}

Abre **Configuración** y luego **Integraciones**.
También puedes buscar **Abrir Integraciones** en la búsqueda de comandos.

Cada fila es una conexión.
Muestra el nombre de la conexión, como quién tiene la sesión iniciada o qué ejecuta, y cuántas de sus acciones están activadas.
Abre una fila para ver sus acciones, y lo que puede avisar a tus automatizaciones.

El menú al final de una fila tiene:

- **En pausa**: mientras su interruptor está activado, nadie la alcanza.
- **Comprobar ahora**, que comprueba que la conexión sigue funcionando.
- **Cerrar sesión y quitar**, o **Quitar** para un servidor MCP.

Los botones debajo de la lista conectan algo nuevo, como **GitHub**, **Google** o **Servidor MCP**.
También puedes pedirle a tu primer oficial que conecte algo.
Un inicio de sesión siempre te corresponde a ti, así que tu primer oficial te trae una tarjeta que abre esta pestaña.

## GitHub, GitLab, GitHub Enterprise y Bitbucket {#github-gitlab-github-enterprise-and-bitbucket}

Tu inicio de sesión en el sitio donde se alojan tus proyectos se guarda aquí.
Consulta [Proyectos](/es/projects/#your-github-gitlab-or-bitbucket-sign-in) para ver cómo lo usa Infinitary para clonar un proyecto y ofrecer sus cambios.

- **GitHub**: escribes un código en la página de GitHub en tu navegador.
  Si GitHub CLI está en esta computadora y tu organización bloquea apps como Infinitary, **Usar GitHub CLI** usa el inicio de sesión que ya tiene GitHub CLI.
- **GitLab**: inicias sesión en tu navegador o pegas una clave, en gitlab.com o en tu propio servidor de GitLab.
- **GitHub Enterprise**: creas una clave en tu propio servidor y la pegas aquí.
- **Bitbucket**: creas un token de API en tu cuenta de Atlassian y lo pegas aquí, para bitbucket.org.
  Para tu propio servidor de Bitbucket Data Center, versión 8.19 o posterior, escribes su dirección y pegas un token de acceso HTTP que creas en él, con los permisos Project read y Repository write.
  Una fila de Data Center ofrece las mismas acciones de lectura y escritura, en las rutas propias del servidor, y **Permitir durante el resto de esta tarea** abarca un repositorio.

Cada fila tiene dos acciones: una que lee y otra que cambia algo, como **Cambiar algo en GitHub**.
Son las que usan tu primer oficial y tu tripulación para consultar cosas o actuar ahí más allá del trabajo propio de una tarea.
La rama de una tarea, su solicitud de incorporación de cambios, sus comprobaciones y su fusión siguen en cambio los ajustes de tu proyecto.

Si otra computadora hace trabajo para ti, su propio inicio de sesión de GitHub, para clonar e insertar ahí, también tiene una fila aquí.
Consulta [Tus otras computadoras](/es/your-other-computers/).

Cerrar sesión en GitHub detiene los clones privados y las solicitudes de incorporación de cambios hasta que vuelvas a iniciar sesión.

## Google: Gmail y Calendar {#google-gmail-and-calendar}

Google es un solo inicio de sesión para Gmail y Calendar.
Infinitary los alcanza mediante tu propia conexión con Google: un cliente que creas en tu propio proyecto de Google Cloud, en el modo personal de Google.
Google no lo revisa, no muestra ninguna advertencia y no cierra su sesión a los 7 días.

1. Presiona **Google**, que abre **Configura tu propia conexión con Google**.
2. Presiona **Abrir la página de Google**, e inicia sesión ahí con la cuenta de Google que vas a conectar.
   Ponle nombre al proyecto, acepta la política de Google y presiona Continue.
3. Descarga el archivo de cliente que muestra Google, con Download JSON.
4. Suelta ese archivo en **Suelta aquí el archivo de cliente**, elígelo con **Elegir archivo**, o pega su contenido en **Archivo de cliente**.
5. Presiona **Guardar e iniciar sesión**.
6. Lee **Antes de conectar Google**: lo que Infinitary usa de tu cuenta, adónde va y cuánto tiempo se queda.
7. Presiona **Aceptar y continuar a Google**, o **Cancelar** para no pedirle nada a Google.
8. Termina de iniciar sesión en la página de Google en tu navegador, con la cuenta de Google que creó tu cliente, y permite todos los permisos que enumera.

Infinitary guarda el secreto del cliente en [Secretos](/es/secrets/) en esta computadora, y tu primer oficial y tu tripulación nunca lo ven.
Tu cliente solo sirve para la cuenta de Google que lo creó.
Lo configuras una sola vez: después, iniciar sesión en Google empieza en el aviso.
Si dejas un permiso sin marcar, Infinitary no guarda nada y puedes volver a iniciar sesión.
Cada vez que inicias sesión en Google, el aviso aparece primero.

La fila de Google dice cuándo la conexión te necesita:

- **Configura tu propia conexión**: este inicio de sesión todavía pasa por un cliente que Infinitary comparte con todos, y que se retirará.
  Sigue funcionando hasta entonces; presiona **Configurar** para seguir conectado.
- **Deja de funcionar**, con una fecha: tu cliente no está en modo personal, así que Google cerrará su sesión en esa fecha.
  Presiona **Volver a configurar**, y crea un cliente en modo personal.
- **Tu cliente de Google dejó de funcionar**: Google ya no acepta tu cliente, quizá porque se eliminó en Google Cloud.
  Presiona **Volver a configurar**.

En tu iPhone o iPad, la fila de Google se configura de la misma forma: eliges el archivo de cliente, o pegas su contenido.

Con Google conectado, tu primer oficial y tu tripulación pueden buscar y leer tu correo, guardar un adjunto en la carpeta de una tarea, etiquetar o archivar un mensaje, redactar un mensaje y enviar uno.
En Calendar pueden enumerar tus calendarios y eventos, leer un evento, ver cuándo estás ocupado, y crear o actualizar un evento.
Ninguna acción elimina un evento del calendario.

Lo que leen tu primer oficial y tu tripulación se queda en sus conversaciones guardadas durante 30 días.
Luego una nota ocupa su lugar.
Para eliminarlo antes, presiona **Eliminar** en la fila **Eliminar el contenido de Gmail y Calendar**, en **Datos**, al pie de la pestaña.
Un adjunto guardado se queda en la carpeta de su tarea hasta que la tarea se cierra o pasan 30 días.
Las palabras que un tripulante leyó dentro de un adjunto guardado se quedan en su conversación después de los 30 días.
Lo que tu primer oficial y tu tripulación escribieron ellos mismos, en tarjetas, notas y archivos, se queda hasta que eliminas la tarea.
Quitar Google no elimina nada de lo que ya leyeron.

Cualquiera puede enviarte palabras escritas para manipular a una IA.
Infinitary entrega tu correo y tus eventos a tu primer oficial y a tu tripulación marcados como información de fuera, nunca como instrucciones.
Aun así, un mensaje puede engañar a un modelo de IA.
Un tripulante puede llegar a internet sin preguntarte, así que un tripulante engañado podría enviar a otro lugar lo que leyó.

## Servidores MCP {#mcp-servers}

Un servidor MCP es un programa o una dirección web que ofrece acciones a las apps de IA.

1. Presiona **Servidor MCP**.
2. Dale un **Nombre**.
3. En **Ejecuta**, escribe un programa y sus argumentos, o la dirección https del servidor.
4. Presiona **Conectar**.

Un programa se inicia en esta computadora cuando alguien lo usa.
Infinitary se conecta enseguida y abre la nueva fila en la propia lista de acciones del servidor.
Si no puede conectarse, el formulario dice por qué.

Si el servidor necesita una clave, ponla tú mismo al principio de la línea **Ejecuta**, como `EXAMPLE_KEY=your-key npx -y @example/mcp-server`.
Infinitary pasa la clave a [Secretos](/es/secrets/), y la línea solo conserva una referencia a ella.
El servidor recibe la clave cada vez que se inicia, sin preguntarte.
Tu primer oficial y tu tripulación nunca la ven.
Quitar el servidor olvida sus claves.

### Un servidor que te pide iniciar sesión {#a-server-that-asks-you-to-sign-in}

Algunos servidores en una dirección piden un inicio de sesión, no una clave.
Para estos, **Conectar** abre la página de inicio de sesión del servidor en tu navegador.
El formulario dice que termines de iniciar sesión ahí y nombra la dirección de la página, con **Abrir la página otra vez** y **Cancelar**.
Cuando terminas en tu navegador, la nueva fila se abre en las acciones del servidor.
Si cancelas, Infinitary no guarda ninguna fila ni ninguna clave.

**Notion**, **Linear** y **Atlassian**, junto a **Servidor MCP**, conectan esos tres servicios con solo presionarlos.

Infinitary guarda el inicio de sesión en [Secretos](/es/secrets/) y lo renueva por sí mismo.
Cuando el servicio le pone fin, la fila dice **necesita volver a iniciar sesión**, con **Volver a iniciar sesión** en la fila y en su menú.
Volver a iniciar sesión conserva el interruptor de cada acción, y devuelve todas las acciones a **Te pregunta**.
Quitar el servidor olvida el inicio de sesión, y le pone fin en el servicio cuando el servicio lo permite.
Un servidor que necesita tu propia app todavía no se puede conectar, y el formulario lo dice.

Tu primer oficial no puede abrir tu navegador.
Para un servidor que pide un inicio de sesión, te trae una tarjeta con **Abrir Integraciones**, que abre el formulario ya completo.
Lo que responde un servidor en una dirección llega a tu primer oficial y a tu tripulación marcado como información de fuera, nunca como instrucciones.

## Lo que cada acción puede hacer sin preguntarte {#what-each-action-may-do-without-asking-you}

Una fila abierta enumera cada acción con lo que hace: **lee**, **cambia** o **envía**.
Cada acción empieza en **Te pregunta**, incluidas las lecturas.
Presiona su regla para alternar entre **Te pregunta** y **Siempre permitida**.
Solo tú puedes cambiar una regla.
El interruptor junto a una acción la desactiva, y entonces nadie puede ejecutarla.

Cuando tu primer oficial o un tripulante usa una acción que te pregunta, Infinitary pone su propia tarjeta de aprobación.
La tarjeta muestra exactamente lo que se ejecutaría, y el motivo que se dio.

- **Permitir siempre** la ejecuta, y esa acción se ejecuta desde entonces sin preguntar hasta que la cambies en Configuración, reemplaces la conexión o la acción cambie.
- **Permitir durante el resto de esta tarea**, en la petición de un tripulante, la ejecuta y deja que ese tripulante ejecute la misma acción en el mismo lugar sin preguntar hasta que se cierre su tarea.
  La tarjeta dice cuál es el lugar, como un repositorio en GitHub o los destinatarios de un mensaje.
- **Solo esta vez** la ejecuta una vez.
- **Ahora no** no ejecuta nada.

Cuando un tripulante pregunta varias veces en una misma conexión, las peticiones comparten una tarjeta, con una fila para cada una y una casilla **Permitir** marcada.
Desmarca una fila, y nunca se ejecuta.
Apartar la tarjeta deja sus peticiones en espera.

Si Infinitary no puede saber si un cambio llegó, nunca vuelve a enviarlo.
Lo que responde una integración es información para tu primer oficial y tu tripulación, nunca una instrucción.

Un panel también puede usar las integraciones que nombra.
Sus peticiones abren la misma tarjeta, que nombra el panel.
Consulta [Paneles](/es/panels/).

## Un tripulante que lee palabras que cualquiera puede escribir {#a-crewmate-that-reads-words-anyone-can-write}

Algunas tareas leen palabras que un desconocido pudo haber escrito, como las incidencias y las solicitudes de incorporación de cambios de un proyecto público.
Para una tarea así, tu primer oficial puede iniciar un tripulante que solo lee.
No ejecuta programas, no cambia archivos y no tiene navegador.
Solo lee su propio proyecto y páginas web públicas, y no alcanza nada más en tu computadora ni en tu red privada.
Abre una página web sin iniciar sesión, solo como texto.

Todo lo que lee va marcado como palabras de fuera, nunca como instrucciones, y su informe a tu primer oficial también.
Cada una de sus tarjetas dice «Este tripulante lee palabras que cualquiera puede escribir, así que un enlace o una petición en esta tarjeta puede venir de un desconocido».

Cualquier cambio o llamada que quiera hacer espera tu decisión, como una fila marcada en una sola tarjeta de aprobación, por ejemplo «¿Permitir estas llamadas?».
Esa tarjeta solo ofrece **Solo esta vez** y **Ahora no**.
Una lectura a través de una integración se ejecuta sin preguntar solo cuando pusiste esa acción en **Siempre permitida**, y nunca en un servidor MCP.
Una tarea que propone a partir de una incidencia también espera en la tarjeta, con **Empezar ahora**, **Guardar para después** y **No anotar**.

Mientras no tiene nada tuyo, abre cualquier página web pública enseguida.
Tiene algo tuyo en cuanto ha leído un proyecto que no es público, o la respuesta de una integración.
A partir de entonces, una página que nombra su tarea se sigue abriendo enseguida.
Cualquier otra dirección espera como una fila en la tarjeta, «¿Abrir páginas web?», que muestra la dirección completa, porque una dirección puede llevar lo que leyó a quien gestiona el sitio.

## Lo que puede avisar una integración {#what-an-integration-can-tell}

Algunas conexiones avisan cuando pasa algo, y una automatización puede esperarlo.
Una fila abierta los enumera marcados como **avisa**.

- GitHub: **Falla una ejecución de un flujo de trabajo** y **Termina una ejecución de un flujo de trabajo**, en un repositorio que nombras.
- Gmail: **Llega un mensaje**.
- Calendar: **Cambia un evento del calendario**.
- Un servidor MCP que lo ofrezca: **Cambió un recurso**.

Elige uno en **Cuando pasa algo**, en Automatización.
Consulta [Automatización](/es/automation/#when-it-runs).

## El comando Infinitary {#the-infinitary-command}

El recuadro **Comando Infinitary** es para los programas que ejecutas en esta computadora, y para tus propios agentes de IA.
Con un comando, pueden leer tus tarjetas y tareas y actuar sobre ellas, y hablar con tu primer oficial como tú.
Un tripulante nunca lo recibe.

Está desactivado hasta que lo activas.
Cuando está activado, el recuadro muestra la línea que hay que ejecutar, con **Copiar**, y **Enlazarlo** ofrece un nombre más corto donde puede.
La primera vez que lo activas, también activa una automatización, **Eventos de la bandeja de Infinitary**, para que tu primer oficial reciba aviso de cada nota que envía un programa.
Una nota es información, nunca una instrucción.

Desactívalo, y el comando responde con un error mientras las notas guardadas se quedan.
**Eliminar las notas de la bandeja de Infinitary**, en **Datos**, quita las notas y lo desactiva.

## Sitios privados {#private-sites}

El recuadro **Sitios privados** enumera los sitios de la red de tu oficina, de tu casa o de tu VPN que pueden abrir los navegadores de las tareas.
La lista se aplica en todas tus computadoras.
Presiona **Sitio** para agregar uno, o **Quitar** para retirar uno.
Tu primer oficial nunca agrega un sitio por sí mismo: te pregunta en una tarjeta, y solo tu **Permitir** lo agrega.
Consulta [El navegador de la tripulación](/es/the-crews-browser/#private-sites).

## Siguiente {#next}

- [Secretos](/es/secrets/)
- [Automatización](/es/automation/)
