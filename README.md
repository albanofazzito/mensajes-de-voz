# Grabador de "Mensajes de voz"

Página que usa el complemento **Mensajes de voz** de Gmail para grabar audios. Desde febrero de 2026
Google no permite usar el micrófono dentro de las páginas de Apps Script, por eso el grabador se
publica aparte.

- Se abre desde el panel del complemento en Gmail, con un enlace de un solo uso.
- Graba y codifica el audio a MP3 en el navegador, y lo entrega al complemento. No guarda nada.
- Sin enlace funciona en **modo prueba** (graba y reproduce, no envía nada): agregá `?prueba=1`.

El codificador MP3 es [LAME](https://lame.sourceforge.io/) (lamejs, LGPL), sin modificar: ver
`vendor/LEAME-LAME.txt`.

Este repositorio se actualiza automáticamente con `npm run publicar-grabador` desde el proyecto del
complemento: no lo edites a mano.
