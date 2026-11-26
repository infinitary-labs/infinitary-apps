---
source: 91a924b8c4a1a2d6
title: Secretos
description: Guarda las contraseñas y claves que necesita tu tripulación, permite cada uso en una tarjeta y mira qué las usó.
---

Secretos guarda las contraseñas y claves que tu tripulación necesita para su trabajo, como la clave que publica tu sitio web.
Un tripulante usa un secreto por su nombre, y solo después de que permites ese uso.
Cada valor va directamente a Secretos en tu computadora: ni el primer oficial ni la tripulación lo reciben, y se queda oculto salvo que lo copies tú mismo.

<img class="picture-dark" src="/pictures/secrets-dark.webp" alt="Configuración, sección Secretos: tres secretos protegidos, la clave de correo del boletín para Production, la contraseña de la base de datos de la tienda para Staging y la clave del servicio del tiempo para Personal, ninguno usado todavía, la fila de la contraseña de la base de datos de la tienda abierta en Copy value, Replace y Forget, con Search secrets, Add secret, Move from another tool y Access, history &amp; recovery, y una lista Signed-in sites vacía debajo." width="1164" height="596" />
<img class="picture-light" src="/pictures/secrets-light.webp" alt="Configuración, sección Secretos: tres secretos protegidos, la clave de correo del boletín para Production, la contraseña de la base de datos de la tienda para Staging y la clave del servicio del tiempo para Personal, ninguno usado todavía, la fila de la contraseña de la base de datos de la tienda abierta en Copy value, Replace y Forget, con Search secrets, Add secret, Move from another tool y Access, history &amp; recovery, y una lista Signed-in sites vacía debajo." width="1164" height="596" />

## Dónde viven tus secretos {#where-your-secrets-live}

Abre **Configuración** y luego **Secretos**, o busca **Abrir Secretos** en la búsqueda de comandos.

**Secretos protegidos** enumera cada secreto por su nombre y su lugar, y dice qué tarea lo usó por última vez, y cuándo.
**Buscar secretos** encuentra uno por su nombre, su lugar o la tarea que lo usó por última vez.

En una Mac, la línea debajo de la lista dice «Se guardan en esta computadora. Tu tripulación los usa pero nunca los ve, salvo que copies uno».
En Linux y Windows, dice que tu tripulación solo los usa con tu aprobación, pero que cualquier programa que ejecutes puede alcanzarlos mientras el almacén de secretos de tu sistema esté desbloqueado.

Los secretos se quedan en la computadora donde vive tu primer oficial.
Una computadora que controla a tu primer oficial desde otro lugar no tiene una sección Secretos propia.

## Guardar un secreto {#keep-a-secret}

1. Elige **Agregar secreto**.
2. Dale un **Nombre**, como «Despliegue del sitio web».
3. Pega el valor en **Valor del secreto**.
4. Si guardas dos secretos con el mismo nombre, distínguelos con **Lugar (opcional)**, como staging o production.
5. Elige **Guardar secreto**.

El valor se queda oculto después de guardarlo.
Solo lo recibe un uso que permitas, salvo que lo copies tú mismo.
Abre la fila de un secreto para [copiar su valor](#copy-a-value), **Reemplazarlo** u **Olvidarlo**.
Olvidar lo quita de esta computadora, pero no desactiva la clave donde se creó.

### Cuando un tripulante necesita uno que no has guardado {#when-a-crewmate-needs-one-you-have-not-kept}

Un tripulante que necesita un secreto que no has guardado lo pide por su nombre, nunca por su valor.
Infinitary pone entonces su propia tarjeta, como «¿Añadir Despliegue del sitio web a Secretos?», con el motivo del tripulante en sus propias palabras.
Cuando tienes que crear o encontrar el secreto tú mismo, la tarjeta también muestra **Cómo conseguirlo**: los pasos, nombres o lugares que el tripulante preparó para este caso, y una línea que dice quién los escribió.
Revisa cada dirección que muestra antes de iniciar sesión ahí.

Escribe o pega cada valor en el campo oculto que Infinitary dibuja en la tarjeta, y luego elige **Guardar secreto**.
**No guardar** no guarda nada.
El tripulante recibe el nombre del secreto, nunca su valor, y cada uso sigue preguntándote.

Escribe un secreto solo en un campo que dibuje Infinitary, nunca en el campo de respuesta de una tarjeta ni en tu cuadro de mensaje.

## Copiar un valor {#copy-a-value}

Cuando necesitas tú mismo un valor, por ejemplo para pegar una clave en un sitio web, abre la fila del secreto y elige **Copiar valor**.
Cada vez, tu computadora te pide confirmar que eres tú: en una Mac con Touch ID o tu contraseña, en Linux con tu contraseña, y en Windows con Windows Hello o tu contraseña de Windows.

El valor va al portapapeles de esta computadora, y a ningún otro.
En una Mac y en Windows, no viaja a tus otros dispositivos.
En Linux, una herramienta de historial del portapapeles podría conservarlo de todos modos, y la fila lo dice.

La fila dice entonces «Copiado. Sale del portapapeles a las» y una hora, 90 segundos después de la copia.
Infinitary lo borra entonces, o cuando eliges **Borrar ahora**, o cuando sales de Infinitary.
Si desde entonces copiaste otra cosa, deja tu portapapeles como está.

La fila del secreto dice entonces **Copiado por ti** y cuándo, y [Historial de uso](#use-history-and-backups) enumera la copia de la misma forma.
Si tu computadora no puede confirmar que eres tú, el botón está desactivado y la fila dice por qué.

Tu primer oficial nunca copia un valor.
Pídele uno, y te trae una tarjeta, como «Abrir Despliegue del sitio web en Secretos», cuyo botón **Abrir Secretos** te abre la fila de ese secreto.

## Permitir un uso {#allow-a-use}

Cuando un tripulante quiere usar un secreto, Infinitary pone una tarjeta, como «¿Dar el secreto Despliegue del sitio web a «Publicar el sitio»?».
La tarjeta dice exactamente qué lo recibiría:

- **Secreto**: cada secreto, y el nombre con el que lo recibe el programa.
- **Ejecuta**: el comando exacto.
- **En la carpeta**: dónde se ejecuta.
- **Su motivo**: el motivo del tripulante, con sus propias palabras.

**Todo lo que se comprobó** enumera lo que Infinitary comprobó sobre el programa, y lo que no pudo comprobar.
Luego elige:

- **Permitir una vez** da el secreto solo a esta ejecución.
- **Permitir siempre** lo da a esta ejecución y guarda esta ejecución exacta: el mismo programa, archivos, argumentos y carpeta.
  Cualquier diferencia vuelve a preguntar.
- **No permitir** lo rechaza, y la próxima ejecución vuelve a preguntar.

Cada permiso te pide confirmar primero: en una Mac con Touch ID o tu contraseña, en Linux con tu contraseña, y en Windows con Windows Hello o tu contraseña de Windows.
Lo que recibe un secreto puede guardarlo.
Permitir nunca aprueba una acción aparte, como desplegar o enviar algo.
El tripulante solo se entera de si la ejecución terminó, no de lo que imprimió.

Mientras una petición espera, Configuración → Secretos la muestra arriba, con **Revisar la petición** para abrir su tarjeta.

## Decisiones guardadas {#saved-decisions}

Abre **Acceso, historial y recuperación** debajo de la lista de secretos, y luego **Decisiones guardadas**.
Cada decisión que guardaste con **Permitir siempre** aparece como una frase.

Solo guardas una decisión en la tarjeta de una petición.
Aquí puedes **Quitar** una: tu computadora te pide confirmar, y la tripulación vuelve a preguntarte antes de su próximo uso.

## Aprobar desde tu teléfono {#approve-from-your-phone}

Puedes permitir un uso desde tu iPhone o iPad mientras estás lejos de tu computadora.

1. En Configuración → **Dispositivos**, activa **Aprueba usos de secretos** en la fila de tu teléfono.
2. Abre Infinitary en el teléfono, que entonces muestra su código.
3. Elige **Comparar códigos**, y comprueba que el código de la tarjeta de tu computadora coincide con el de la Configuración del teléfono.
4. Elige **Confirmar y permitir** en tu computadora, que te pide confirmar.

A partir de entonces, la tarjeta de una petición en el teléfono ofrece **Permitir una vez** y **No permitir**.
Cada permiso pide Face ID, Touch ID o el código del teléfono.
Una decisión que siempre permite una ejecución solo se guarda en tu computadora.
Una Mac que controla a tu primer oficial desde otro lugar también puede aprobar usos, configurada de la misma forma desde su fila.

Para dejar de hacerlo, desactiva el interruptor, o elige **Dejar de aprobar** en **Dispositivos que aprueban**, en **Acceso, historial y recuperación**.

## Traer secretos de otra herramienta {#move-secrets-from-another-tool}

Si guardas secretos en otra herramienta, como Automic Vault, un archivo .env o el Llavero de tu Mac, un tripulante puede traerlos a Secretos sin ver ningún valor.

1. Elige **Traer de otra herramienta** en Configuración → Secretos, o **Traer secretos de otra herramienta** en la búsqueda de comandos.
2. Tu cuadro de mensaje empieza la petición a tu primer oficial; nombra la herramienta y envíala.
3. El tripulante pone una tarjeta, como «¿Traer 3 secretos de Automic Vault?», que nombra el comando que ejecuta o el archivo que lee, y por qué.
4. Marca cada secreto que quieras guardar, y luego elige **Traer a Secretos**, o **No traer**.

Infinitary ejecuta el comando o lee el archivo por sí mismo, y solo guarda lo que marcas.
Para un archivo como un .env, **Leerlo** enumera primero los nombres que contiene.
El tripulante recibe nombres, nunca un valor, y la copia de la otra herramienta se queda como está.
Eliges los secretos en la ventana de Infinitary de la computadora donde vive tu primer oficial, no en tu teléfono.

Si la herramienta está en otra de tus computadoras que hacen trabajo, nombra esa computadora en tu petición, y un tripulante que trabaja allí trae los secretos desde ella.
La tarjeta sigue apareciendo en la computadora donde vive tu primer oficial, con una línea **En la computadora** que nombra la computadora donde se ejecuta el comando.
Cuando eliges **Traer a Secretos**, esa computadora ejecuta el comando y envía solo los secretos que marcaste, una vez, por la conexión entre tus computadoras.
**Leerlo** envía una vez cada valor que contiene el archivo, para que la tarjeta pueda enumerar sus nombres, y Secretos sigue guardando solo lo que marcas.

## Claves de tus integraciones {#keys-for-your-integrations}

Cuando inicias sesión en Google o en un servidor MCP, o agregas un servidor MCP con claves, en Configuración → **Integraciones**, Infinitary guarda esas claves en Secretos.
También guarda el secreto del cliente de Google que configuras ahí.
Secretos las enumera con **Gestionar en Integraciones** en lugar de Reemplazar y Olvidar.
La clave de un servidor también ofrece **Copiar valor**; la entrada de un inicio de sesión, no.
Infinitary las usa sin preguntar, porque iniciar sesión, o agregar el servidor con sus claves, fue tu consentimiento.
Tu tripulación no puede verlas ni pedir usarlas.
Cierra sesión, o quita el servidor, en Integraciones para olvidarlas.
Consulta [Integraciones](/es/integrations/).

## Historial de uso y copias de seguridad {#use-history-and-backups}

**Historial de uso** enumera cada uso: qué secretos, el motivo, el programa, cómo se permitió y cómo terminó, nunca un valor.
Se queda hasta que lo eliminas, con **Exportar historial** y **Eliminar historial**.

**Copia de seguridad y restauración** tiene **Guardar copia de seguridad cifrada**, que guarda una copia cifrada y una clave de recuperación aparte.
Guárdalas por separado: cualquiera que tenga las dos puede leer los valores guardados, y la clave no se puede restablecer.
**Restaurar desde una copia de seguridad** reemplaza tus valores guardados, y borra las decisiones guardadas, las aprobaciones de teléfonos y el acceso temporal.

## Cuando Secretos no puede abrirse {#when-secrets-cannot-open}

Si el almacén de secretos de tu computadora está bloqueado, Secretos muestra **Almacenamiento bloqueado**, con **Desbloquear o volver a revisar**.
Las peticiones siguen esperando hasta que se abra.

Si Infinitary ya no puede leer lo que guardó, Secretos muestra **Se necesita recuperación** y no permite ningún uso.
**Opciones de recuperación** abre **Copia de seguridad y restauración**, para restaurar desde una copia de seguridad.
**Empezar de nuevo** borra tus secretos guardados, las decisiones guardadas, las aprobaciones de teléfonos y el acceso temporal, y no se puede deshacer.

## Sitios con sesión iniciada {#signed-in-sites}

El pie de Secretos enumera **Sitios con sesión iniciada**: los sitios en los que iniciaste sesión en el navegador de una tarea.
Se quedan en el perfil del navegador de esa computadora, no en el almacenamiento protegido.
Consulta [El navegador de la tripulación](/es/the-crews-browser/#signed-in-sites).

## Cuando tu primer oficial se muda {#when-your-first-mate-moves}

Cuando tu primer oficial se muda a otra computadora, tus secretos se quedan en la computadora que deja, y vuelves a agregarlos en la nueva.

Una computadora que [guarda una copia de tu primer oficial](/es/your-other-computers/#keep-a-copy-on-another-computer) también puede guardar tus secretos.
Elige **Guardar los Secretos allí** en su lista **Listo para tomar el relevo**, en Configuración → **Dispositivos**, y luego confirma en esa misma computadora.
Si más adelante tu primer oficial se muda ahí, o [empieza desde esa copia](/es/your-other-computers/#take-over), se lleva los valores.
Si esa computadora ya guarda secretos propios, una tarjeta ahí pregunta qué conjunto usar.
No se lleva decisiones guardadas ni dispositivos que aprueban, así que cada uso vuelve a preguntarte y cada teléfono se vuelve a configurar.

Consulta también [Tus otras computadoras](/es/your-other-computers/#move-your-first-mate) y [Lo que sale de tu computadora](/es/what-leaves-your-computer/#secrets).
