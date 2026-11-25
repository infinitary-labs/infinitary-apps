---
source: ef5bb091529f56f5
title: Actualizar y quitar Infinitary
description: Cómo recibe cada tipo de instalación una nueva versión estable, y cómo quitar Infinitary conservando tu trabajo guardado.
---

Infinitary busca una nueva versión estable cada pocas horas.
Buscar no descarga nada, y no se instala nada hasta que lo eliges.
Una actualización conserva tu trabajo guardado.

## Cuando sale una nueva versión {#when-a-new-version-is-out}

Aparece un botón redondo con una flecha hacia abajo en la esquina superior derecha de la ventana.
Deja el puntero sobre él para leer «Actualización disponible» y el número de la nueva versión, y presiónalo para ver qué hacer a continuación.
Configuración → **General** muestra lo mismo, en **Versión**.

Para buscar tú mismo, usa cualquiera de estas opciones:

- **Buscar actualizaciones** en **Versión**, en Configuración → **General**.
- **Buscar actualizaciones** en la búsqueda de comandos.
- En una Mac, **Buscar actualizaciones…** en el menú Infinitary.

Lo que hay que hacer a continuación depende de cómo instalaste Infinitary.

## Una copia para Mac de la página de descargas {#a-mac-copy-from-the-downloads-page}

1. Presiona **Actualizar y reiniciar**.
2. Infinitary descarga la nueva versión y comprueba su suma de comprobación y su firma de Apple.
3. Guarda el trabajo de tu tripulación.
   El trabajo en curso termina primero lo que está ejecutando, así que no se pierde nada.
4. Infinitary se reinicia en la nueva versión y retoma el trabajo que la actualización pausó.

Mientras espera al trabajo en curso, **Actualizar más tarde** deja la actualización para cuando vuelvas a elegirla.
Tu trabajo sigue adelante.

Si Infinitary no pudo terminar de reiniciarse, el botón dice **Reiniciar**.
Vuelve a presionarlo cuando se detenga tu trabajo en curso.

Infinitary solo se actualiza a sí mismo desde Aplicaciones.
Si se ejecuta desde la imagen de disco, arrástralo a Aplicaciones, expulsa la imagen de disco y abre la copia de Aplicaciones.

## Una copia para Mac de Homebrew {#a-mac-copy-from-homebrew}

Una copia que instalaste con Homebrew se actualiza a través de Homebrew.
El aviso muestra el comando, con **Copiar comando**:

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Ejecútalo en Terminal.
Homebrew cierra Infinitary mientras lo reemplaza, así que vuelve a abrir Infinitary cuando termine.

## Linux {#linux}

- **Ubuntu, Debian y Fedora**, desde el paquete .deb o .rpm: presiona **Instalar**.
  Infinitary descarga la nueva versión, la comprueba, guarda el trabajo de tu tripulación y te pide la contraseña, y luego vuelve a iniciarse.
- **Una AppImage**: presiona **Instalar**.
  Infinitary reemplaza el archivo AppImage por la nueva versión y vuelve a iniciarse, sin contraseña.
  Necesita poder cambiar la carpeta en la que está la AppImage.
- **Arch, Omarchy y NixOS** se actualizan a través de su propio gestor de paquetes.
  El aviso muestra el comando, con **Copiar comando**; ejecútalo en una terminal.

Si la instalación no puede terminar, no cambia nada y el trabajo de tu tripulación sigue adelante.
El aviso muestra entonces un comando que instala la misma versión a mano.

## Windows {#windows}

1. Presiona **Actualizar y reiniciar**.
2. Infinitary descarga el nuevo instalador, comprueba su suma de comprobación y guarda el trabajo de tu tripulación.
3. Infinitary se cierra, el instalador lo reemplaza e Infinitary vuelve a abrirse en la nueva versión.

Si la instalación no puede terminar, no cambia nada y el trabajo de tu tripulación sigue adelante.

## Tus otras computadoras y tu teléfono {#your-other-computers-and-your-phone}

Una computadora que agregaste se actualiza desde la computadora donde vive tu primer oficial.
Cuando se conecta con una versión anterior, recibe la versión de esa computadora por sí sola.
Su trabajo en curso se guarda primero y continúa después.
Cuando no puede actualizarse por sí sola, por ejemplo porque la actualización pide una contraseña ahí, una tarjeta te lo pregunta.
En Configuración → **Dispositivos**, una computadora con otra versión muestra **Igualar** en su fila.
Presiónalo para llevar esa computadora a la versión de esta, sea esa versión más nueva o más antigua.

La app abierta en una computadora que controla a tu primer oficial sigue la misma versión.
Cuando es anterior, obtiene esa versión por sí sola y se reinicia con ella cuando nadie la usa ahí.
Su fila en Configuración → **Dispositivos** dice cuánto lleva, y **Actualizar app** obtiene la versión de inmediato.
Las palabras escritas ahí y aún no enviadas detienen el reinicio hasta que se envían o se borran.
Cuando esa app no puede actualizarse por sí sola, como una copia de Homebrew, su fila y una tarjeta dicen qué hacer ahí.

Desde una computadora que controla a tu primer oficial, también puedes actualizar la computadora donde vive tu primer oficial.
Configuración → **General** tiene una fila para Infinitary en esa computadora.
Cuando esa computadora tiene una actualización lista, presiona **Actualizar** seguido de su nombre.
Infinitary pregunta primero: nombra el trabajo en curso que termina antes del reinicio, y dice que alguien tiene que estar en esa computadora si la nueva versión no se inicia.
Mientras se guarda ese trabajo, **Actualizar más tarde** deja la actualización para después.
Tu teléfono también puede iniciar esa actualización, después de preguntarte primero.
Consulta [Tus otras computadoras](/es/your-other-computers/) y [iPhone y iPad](/es/iphone-and-ipad/).

## Quitar Infinitary {#remove-infinitary}

Quitar la app deja tu trabajo guardado en su lugar, así que al volver a instalar Infinitary sigues donde lo dejaste.
Si esta computadora hace trabajo para otra, presiona primero **Salir** en Configuración → **Dispositivos**.

- **Una copia para Mac de la página de descargas**: cierra Infinitary y muévelo de Aplicaciones a la Papelera.
- **Una copia para Mac de Homebrew**: ejecuta `brew uninstall --cask infinitary` en Terminal.
  Nunca agregues `--zap`: borra tu trabajo guardado.
- **Linux**: quita el paquete con el instalador de software o el gestor de paquetes con el que lo instalaste.
  Para una AppImage, borra el archivo.
- **Windows**: en Configuración de Windows → **Aplicaciones** → **Aplicaciones instaladas**, elige **Desinstalar** en el menú de Infinitary.

Tu trabajo guardado se queda en `~/Library/Application Support/infinitary` en una Mac, en `~/.config/infinitary` en Linux, y en `%APPDATA%\infinitary` en Windows.

### Qué elimina tu trabajo guardado {#what-deletes-your-saved-work}

Esto elimina esa carpeta, y lo que Infinitary guardaba ahí se va con ella:

- `brew uninstall --zap`.
- Una app desinstaladora que también quita los archivos de soporte de una app.
- Mover la propia carpeta a la Papelera, o eliminarla.
- **Restablecer Infinitary**, que está para empezar de nuevo: consulta [Restablecer Infinitary](#reset-infinitary).

En una computadora que hace trabajo para otra, esa carpeta contiene la clave propia de la computadora, sus copias de trabajo y los archivos de sus tareas.
Sin ella, la computadora se vuelve a unir como una entrada nueva, y el trabajo que no había traído se pierde.
Consulta [Una computadora aparece dos veces](/es/troubleshooting/#a-computer-is-listed-twice).

## Restablecer Infinitary {#reset-infinitary}

**Restablecer Infinitary**, una fila de Configuración → **General**, devuelve Infinitary en esta computadora al estado en que quedó al instalarlo, y conserva la app.
Elimina todo lo que Infinitary guarda en esta computadora, incluidas las tareas, los inicios de sesión, los Secretos, la configuración y los dispositivos vinculados.
Los proyectos en tus propias carpetas conservan todos sus archivos y commits.
Para borrar solo las tareas, usa **Eliminar los datos de las tareas**, la fila de arriba.

1. Presiona **Restablecer**.
   Infinitary dice qué elimina y cuántas tareas abiertas se detienen.
2. Presiona **Restablecer Infinitary**, o **Conservar todo** para no cambiar nada.
3. Confirma que eres tú como te lo pida tu computadora, por ejemplo con Touch ID o tu contraseña.
4. Infinitary se cierra y luego se abre en la pantalla de bienvenida, como recién instalado.

Una computadora que hace trabajo para otra sale de esa computadora como parte de su restablecimiento.
En una computadora que controla a tu primer oficial, la fila restablece Infinitary en las dos computadoras: esta y la computadora donde vive tu primer oficial.
Si aquella no responde, no se restablece nada en ninguna de las dos.

Cuando Infinitary no puede abrirse, aún puedes restablecerlo: consulta [Infinitary no pudo iniciarse](/es/troubleshooting/#infinitary-could-not-start).
