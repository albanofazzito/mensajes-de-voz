/**
 * Grabador de "Mensajes de voz".
 *
 * Esta pagina vive fuera de Apps Script porque desde febrero de 2026 Google bloquea el microfono
 * en las paginas de Apps Script (ver README). La abre el complemento de Gmail con:
 *   ?t=<token de un solo uso>&d=<ID del despliegue del web app>
 * Graba, codifica a MP3 mientras se graba (codificador-worker.js) y sube el audio al web app en
 * fragmentos. Sin parametros funciona en "modo prueba": graba y reproduce, pero no envia nada.
 */
(() => {
  'use strict';

  const PROTOCOLO = 1;               // tiene que coincidir con PROTOCOLO_VOZ del complemento
  const KBPS = 64;                   // MP3 mono: ~480 KB por minuto, muy buena calidad para voz
  const INTENTOS_POR_PEDIDO = 4;
  const PEDIDOS_EN_PARALELO = 3;
  const ESPERA_MAXIMA_MS = 60000;
  const DURACION_MINIMA = 0.5;       // segundos
  const DURACION_MAXIMA_EN_PRUEBA = 600;
  const UMBRAL_DE_SONIDO = 0.008;    // pico (~ -42 dBFS) por debajo del cual se considera silencio
  const SEGUNDOS_DE_SILENCIO = 5;    // para avisar que el microfono podria estar silenciado
  const CLAVE_SESION = 'mensajes-de-voz:sesion';
  const CLAVE_MICROFONO = 'mensajes-de-voz:microfono';
  const CODIGOS_DE_ENLACE = ['TOKEN_INVALIDO', 'SESION_VENCIDA', 'SESION_USADA'];

  const $ = (id) => document.getElementById(id);
  const tarjeta = $('app');

  const estado = {
    prueba: false,
    token: '',
    despliegue: '',
    servidor: null,           // respuesta de {accion: 'estado'}
    ventana: '',              // identifica esta ventana ante el web app
    subidaIniciada: false,
    duracionMaxima: DURACION_MAXIMA_EN_PRUEBA,
    captura: null,            // microfono + AudioContext
    codificador: null,        // Web Worker
    alCodificar: null,
    alFallarCodificador: null,
    aceptando: false,         // recibe muestras hasta vaciar el worklet al terminar
    grabando: false,
    pausado: false,
    muestras: 0,
    tasa: 0,
    limiteDeMuestras: 0,
    niveles: [],
    ultimoSonido: 0,
    colores: null,
    animacion: 0,
    audio: null,              // {blob, url, duracion}
    terminado: false,
    esperandoPermiso: false,
    microfono: leerLocal(CLAVE_MICROFONO) || ''
  };

  // ---------------------------------------------------------------- inicio

  function iniciar() {
    conectarEventos();
    const parametros = leerParametros();
    if (parametros.invalido) {
      mostrarError(errorDeEnlace('El enlace del grabador está incompleto o dañado. Volvé a Gmail y tocá ' +
        '«Grabar audio» de nuevo.'));
      return;
    }
    estado.prueba = parametros.prueba;
    estado.token = parametros.token || '';
    estado.despliegue = parametros.despliegue || '';
    if (!navegadorCompatible()) {
      mostrarError({
        titulo: 'Este navegador no puede grabar',
        detalle: 'Abrí Gmail con Chrome, Edge, Firefox o Safari actualizados y volvé a intentarlo.',
        principal: botonCerrar()
      });
      return;
    }
    vigilarPermiso();
    if (estado.prueba) {
      $('avisoPrueba').hidden = false;
      prepararInicio();
      return;
    }
    window.addEventListener('pagehide', avisarCierre);
    conectarConServicio();
  }

  function conectarEventos() {
    $('botonGrabar').addEventListener('click', empezarGrabacion);
    $('botonDetener').addEventListener('click', () => terminarGrabacion(''));
    $('botonPausa').addEventListener('click', alternarPausa);
    $('botonCancelar').addEventListener('click', cancelarGrabacion);
    $('botonRegrabar').addEventListener('click', volverAGrabar);
    $('botonUsar').addEventListener('click', usarAudio);
    $('listaMicrofonos').addEventListener('change', (evento) => {
      estado.microfono = evento.target.value === 'default' ? '' : evento.target.value;
      guardarLocal(CLAVE_MICROFONO, estado.microfono);
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', llenarListaDeMicrofonos);
    }
    window.addEventListener('beforeunload', (evento) => {
      const panel = tarjeta.dataset.panel;
      const sePierdeAlgo = estado.grabando || panel === 'procesando' || panel === 'subiendo' ||
        (panel === 'revisando' && !estado.prueba);
      if (sePierdeAlgo) {
        evento.preventDefault();
        evento.returnValue = '';
      }
    });
  }

  /** Lee el token de la URL (o de sessionStorage si se recargo la ventana) y lo saca de la URL. */
  function leerParametros() {
    const consulta = new URLSearchParams(location.search);
    const fragmento = new URLSearchParams(location.hash.slice(1));
    let token = consulta.get('t') || fragmento.get('t') || '';
    let despliegue = consulta.get('d') || fragmento.get('d') || '';
    const pidioPrueba = consulta.has('prueba');
    if (!token && !despliegue && !pidioPrueba) {
      const guardada = leerSesionGuardada();
      if (guardada) ({ token, despliegue } = guardada);
    }
    if (pidioPrueba || (!token && !despliegue)) return { prueba: true };
    if (!/^[0-9a-f]{64}$/.test(token) || !/^AKfy[A-Za-z0-9_-]{20,200}$/.test(despliegue)) {
      return { invalido: true };
    }
    // Si se pudo guardar para una recarga, el token deja de verse en la barra de direcciones.
    if (guardarSesion({ token, despliegue })) history.replaceState(null, '', location.pathname);
    return { prueba: false, token, despliegue };
  }

  function navegadorCompatible() {
    return !!(window.isSecureContext !== false && navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext) &&
      window.Worker && window.fetch && window.AbortController);
  }

  async function conectarConServicio() {
    mostrarPanel('cargando');
    try {
      const respuesta = await llamar({ accion: 'estado', token: estado.token });
      if (respuesta.protocolo !== PROTOCOLO) {
        mostrarError({
          titulo: 'Hay que actualizar el grabador',
          detalle: 'El complemento y esta página tienen versiones distintas. Avisale a quien ' +
            'administra el complemento.',
          tecnico: `protocolo del servicio ${respuesta.protocolo}, del grabador ${PROTOCOLO}`,
          principal: botonCerrar()
        });
        return;
      }
      estado.servidor = respuesta;
      estado.ventana = respuesta.ventana;
      estado.duracionMaxima = respuesta.duracionMaximaSegundos;
      prepararInicio();
    } catch (error) {
      if (esErrorDeEnlace(error)) {
        mostrarError(errorDeEnlace(error.message));
        return;
      }
      mostrarError({
        titulo: 'No se pudo conectar',
        detalle: 'Revisá tu conexión a internet y volvé a intentarlo. Si el problema sigue, avisale ' +
          'a quien administra el complemento.',
        tecnico: descripcionTecnica(error),
        principal: { texto: 'Reintentar', accion: conectarConServicio },
        secundario: botonCerrar()
      });
    }
  }

  function prepararInicio(aviso) {
    $('textoLimite').textContent = describirDuracion(estado.duracionMaxima);
    $('avisoInicio').textContent = aviso || '';
    $('avisoInicio').hidden = !aviso;
    llenarListaDeMicrofonos();
    mostrarPanel('inicio');
  }

  // ---------------------------------------------------------------- grabacion

  async function empezarGrabacion() {
    const boton = $('botonGrabar');
    if (boton.disabled) return;
    boton.disabled = true;
    $('textoInicio').textContent = 'Esperando el permiso del micrófono…';
    $('avisoInicio').hidden = true;
    let captura = null;
    try {
      captura = await abrirMicrofono();
      estado.codificador = crearCodificador(captura.tasa);
    } catch (error) {
      if (captura) cerrarCaptura(captura);
      if (estado.codificador) {
        estado.codificador.terminate();
        estado.codificador = null;
      }
      mostrarError(captura ? errorDeProcesamiento(error) : errorDeMicrofono(error));
      return;
    } finally {
      boton.disabled = false;
      $('textoInicio').textContent = 'Tocá el micrófono para empezar';
    }

    Object.assign(estado, {
      captura,
      aceptando: true,
      grabando: true,
      pausado: false,
      muestras: 0,
      tasa: captura.tasa,
      limiteDeMuestras: Math.floor(estado.duracionMaxima * captura.tasa),
      niveles: [],
      ultimoSonido: 0,
      colores: leerColoresDelMedidor()
    });
    $('textoMicrofono').textContent = captura.etiqueta ? 'Micrófono: ' + captura.etiqueta : '';
    $('alertaSilencio').hidden = true;
    actualizarPausa();
    actualizarCronometro();
    mostrarPanel('grabando');
    estado.animacion = requestAnimationFrame(dibujarMedidor);
    llenarListaDeMicrofonos();
  }

  async function abrirMicrofono() {
    const opciones = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    let flujo;
    try {
      flujo = await navigator.mediaDevices.getUserMedia({
        audio: estado.microfono ? Object.assign({ deviceId: { exact: estado.microfono } }, opciones) : opciones
      });
    } catch (error) {
      // El microfono elegido la vez anterior ya no esta: se usa el predeterminado.
      if (!estado.microfono || (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError')) throw error;
      estado.microfono = '';
      guardarLocal(CLAVE_MICROFONO, '');
      flujo = await navigator.mediaDevices.getUserMedia({ audio: opciones });
    }

    const Contexto = window.AudioContext || window.webkitAudioContext;
    const contexto = new Contexto();
    try {
      if (contexto.state === 'suspended') await contexto.resume();
      const fuente = contexto.createMediaStreamSource(flujo);
      const silencio = contexto.createGain();
      silencio.gain.value = 0;
      const pista = flujo.getAudioTracks()[0];
      const captura = { contexto, flujo, fuente, silencio, nodo: null, tipo: '', alTerminar: null,
        tasa: contexto.sampleRate, etiqueta: pista ? pista.label : '' };

      if (contexto.audioWorklet && window.AudioWorkletNode) {
        await contexto.audioWorklet.addModule('captura-worklet.js');
        captura.nodo = new AudioWorkletNode(contexto, 'captura-pcm', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'
        });
        captura.nodo.port.onmessage = (evento) => {
          if (evento.data && evento.data.fin) {
            if (captura.alTerminar) captura.alTerminar();
          } else {
            alRecibirMuestras(evento.data);
          }
        };
        captura.tipo = 'worklet';
      } else {
        // Navegadores sin AudioWorklet.
        captura.nodo = contexto.createScriptProcessor(4096, 1, 1);
        captura.nodo.onaudioprocess = (evento) => {
          alRecibirMuestras(new Float32Array(evento.inputBuffer.getChannelData(0)));
        };
        captura.tipo = 'script';
      }
      // El nodo tiene que llegar al destino para que el navegador lo procese; va en silencio.
      fuente.connect(captura.nodo);
      captura.nodo.connect(silencio);
      silencio.connect(contexto.destination);
      if (pista) pista.addEventListener('ended', alDesconectarseElMicrofono);
      return captura;
    } catch (error) {
      flujo.getTracks().forEach((p) => p.stop());
      contexto.close().catch(() => {});
      throw error;
    }
  }

  function crearCodificador(tasa) {
    const trabajador = new Worker('codificador-worker.js');
    trabajador.onerror = (evento) => {
      evento.preventDefault();
      falloElCodificador(evento.message || 'no se pudo cargar el codificador');
    };
    trabajador.onmessage = (evento) => {
      const mensaje = evento.data;
      if (mensaje.tipo === 'error') falloElCodificador(mensaje.mensaje);
      else if (mensaje.tipo === 'listo' && estado.alCodificar) estado.alCodificar(mensaje);
    };
    trabajador.postMessage({ tipo: 'iniciar', tasa, kbps: KBPS });
    return trabajador;
  }

  function falloElCodificador(mensaje) {
    if (estado.alFallarCodificador) {
      estado.alFallarCodificador(new Error(mensaje));
      return;
    }
    if (estado.grabando) {
      descartarGrabacion();
      mostrarError(errorDeProcesamiento(new Error(mensaje)));
    }
  }

  function alRecibirMuestras(bloque) {
    if (!estado.aceptando || estado.pausado || !estado.codificador) return;
    const restantes = estado.limiteDeMuestras - estado.muestras;
    if (restantes <= 0) return;
    const muestras = bloque.length > restantes ? bloque.subarray(0, restantes) : bloque;
    medir(muestras);
    estado.muestras += muestras.length;
    estado.codificador.postMessage({ tipo: 'pcm', muestras }, [muestras.buffer]);
    actualizarCronometro();
    if (estado.muestras >= estado.limiteDeMuestras && estado.grabando) {
      terminarGrabacion(`Se llegó a la duración máxima (${formatearTiempo(estado.duracionMaxima)}).`);
    }
  }

  /** Nivel para el medidor y deteccion de silencio prolongado. */
  function medir(muestras) {
    let suma = 0;
    let pico = 0;
    for (let i = 0; i < muestras.length; i++) {
      const valor = muestras[i];
      suma += valor * valor;
      const absoluto = valor < 0 ? -valor : valor;
      if (absoluto > pico) pico = absoluto;
    }
    const decibeles = 20 * Math.log10(Math.sqrt(suma / muestras.length) + 1e-8);
    estado.niveles.push(Math.min(1, Math.max(0, (decibeles + 55) / 50)));
    if (estado.niveles.length > 600) estado.niveles.splice(0, estado.niveles.length - 600);
    const fin = estado.muestras + muestras.length;
    if (pico >= UMBRAL_DE_SONIDO) estado.ultimoSonido = fin;
    $('alertaSilencio').hidden = (fin - estado.ultimoSonido) / estado.tasa < SEGUNDOS_DE_SILENCIO;
  }

  function alternarPausa() {
    if (!estado.grabando) return;
    estado.pausado = !estado.pausado;
    actualizarPausa();
  }

  function actualizarPausa() {
    $('estadoGrabacion').classList.toggle('pausa', estado.pausado);
    $('textoEstado').textContent = estado.pausado ? 'En pausa' : 'Grabando';
    $('iconoPausa').setAttribute('href', estado.pausado ? '#i-play' : '#i-pause');
    $('textoPausa').textContent = estado.pausado ? 'Seguir' : 'Pausar';
    $('botonPausa').setAttribute('aria-label', estado.pausado ? 'Seguir grabando' : 'Pausar');
  }

  function actualizarCronometro() {
    const segundos = estado.muestras / (estado.tasa || 1);
    const texto = formatearTiempo(segundos);
    const cronometro = $('cronometro');
    if (cronometro.textContent !== texto) cronometro.textContent = texto;
    const restantes = estado.duracionMaxima - segundos;
    cronometro.classList.toggle('poco-tiempo', restantes <= 30);
    $('textoRestante').textContent = restantes <= 30 ?
      `Quedan ${Math.max(0, Math.ceil(restantes))} s` : 'de ' + formatearTiempo(estado.duracionMaxima);
  }

  function leerColoresDelMedidor() {
    const estilos = getComputedStyle(document.documentElement);
    return {
      activo: estilos.getPropertyValue('--medidor').trim() || '#0b57d0',
      pausa: estilos.getPropertyValue('--medidor-pausa').trim() || '#a8b4c7'
    };
  }

  /** Barras con el nivel de los ultimos segundos; la mas nueva a la derecha. */
  function dibujarMedidor() {
    const lienzo = $('medidor');
    const escala = window.devicePixelRatio || 1;
    const ancho = lienzo.clientWidth;
    const alto = lienzo.clientHeight;
    if (lienzo.width !== Math.round(ancho * escala) || lienzo.height !== Math.round(alto * escala)) {
      lienzo.width = Math.round(ancho * escala);
      lienzo.height = Math.round(alto * escala);
    }
    const ctx = lienzo.getContext('2d');
    ctx.setTransform(escala, 0, 0, escala, 0, 0);
    ctx.clearRect(0, 0, ancho, alto);
    ctx.fillStyle = estado.pausado ? estado.colores.pausa : estado.colores.activo;
    const grosor = 4;
    const paso = grosor + 3;
    const cantidad = Math.max(1, Math.floor((ancho + 3) / paso));
    const margen = (ancho - (cantidad * paso - 3)) / 2;
    const niveles = estado.niveles.slice(-cantidad);
    const vacias = cantidad - niveles.length;
    for (let i = 0; i < cantidad; i++) {
      const nivel = i < vacias ? 0 : niveles[i - vacias];
      const barra = Math.max(grosor, nivel * alto);
      const x = margen + i * paso;
      const y = (alto - barra) / 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, grosor, barra, grosor / 2);
      else ctx.rect(x, y, grosor, barra);
      ctx.fill();
    }
    if (estado.grabando) estado.animacion = requestAnimationFrame(dibujarMedidor);
  }

  async function terminarGrabacion(aviso) {
    if (!estado.grabando) return;
    estado.grabando = false;
    cancelAnimationFrame(estado.animacion);
    mostrarPanel('procesando');
    try {
      // Hasta que el worklet entrega su ultimo bloque se siguen aceptando muestras.
      await cerrarCaptura(estado.captura);
      estado.captura = null;
      estado.aceptando = false;
      const resultado = await terminarCodificacion();
      estado.codificador.terminate();
      estado.codificador = null;
      const duracion = resultado.muestras / resultado.tasa;
      if (duracion < DURACION_MINIMA) {
        prepararInicio('La grabación fue demasiado corta. Tocá el micrófono y probá de nuevo.');
        return;
      }
      estado.audio = { blob: resultado.blob, url: URL.createObjectURL(resultado.blob), duracion };
      mostrarRevision(aviso);
    } catch (error) {
      descartarGrabacion();
      mostrarError(errorDeProcesamiento(error));
    }
  }

  function terminarCodificacion() {
    return new Promise((resolver, rechazar) => {
      estado.alCodificar = (resultado) => {
        estado.alCodificar = estado.alFallarCodificador = null;
        resolver(resultado);
      };
      estado.alFallarCodificador = (error) => {
        estado.alCodificar = estado.alFallarCodificador = null;
        rechazar(error);
      };
      estado.codificador.postMessage({ tipo: 'terminar' });
    });
  }

  /** Corta el microfono. Con AudioWorklet espera el ultimo bloque (como mucho 1 s). */
  function cerrarCaptura(captura) {
    if (!captura) return Promise.resolve();
    return new Promise((resolver) => {
      if (captura.tipo !== 'worklet') {
        resolver();
        return;
      }
      captura.alTerminar = resolver;
      captura.nodo.port.postMessage('detener');
      setTimeout(resolver, 1000);
    }).then(() => {
      captura.alTerminar = null;
      try {
        captura.fuente.disconnect();
        captura.nodo.disconnect();
        captura.silencio.disconnect();
      } catch (error) {
        // Ya estaban desconectados.
      }
      captura.flujo.getTracks().forEach((pista) => {
        pista.removeEventListener('ended', alDesconectarseElMicrofono);
        pista.stop();
      });
      return captura.contexto.close().catch(() => {});
    });
  }

  function descartarGrabacion() {
    estado.grabando = false;
    estado.aceptando = false;
    cancelAnimationFrame(estado.animacion);
    if (estado.captura) cerrarCaptura(estado.captura);
    estado.captura = null;
    if (estado.codificador) estado.codificador.terminate();
    estado.codificador = null;
    estado.alCodificar = estado.alFallarCodificador = null;
  }

  function cancelarGrabacion() {
    descartarGrabacion();
    prepararInicio();
  }

  function alDesconectarseElMicrofono() {
    if (estado.grabando) terminarGrabacion('Se desconectó el micrófono: se guardó lo grabado hasta ese momento.');
  }

  // ---------------------------------------------------------------- revision y envio

  function mostrarRevision(aviso) {
    const audio = estado.audio;
    $('reproductor').src = audio.url;
    $('resumenAudio').textContent = `${formatearTiempo(audio.duracion)} · MP3 · ${formatearTamano(audio.blob.size)}`;
    $('avisoRevision').textContent = aviso || '';
    $('avisoRevision').hidden = !aviso;
    $('botonUsar').hidden = estado.prueba;
    const descargar = $('botonDescargar');
    descargar.hidden = !estado.prueba;
    if (estado.prueba) {
      descargar.href = audio.url;
      descargar.download = `Mensaje de voz ${fechaLocal()}.mp3`;
    }
    mostrarPanel('revisando');
  }

  function liberarAudio() {
    if (!estado.audio) return;
    const reproductor = $('reproductor');
    reproductor.pause();
    reproductor.removeAttribute('src');
    reproductor.load();
    URL.revokeObjectURL(estado.audio.url);
    estado.audio = null;
  }

  function volverAGrabar() {
    liberarAudio();
    // Si un envio quedo a medias, se libera lo que llego a subir (no importa si falla).
    if (estado.subidaIniciada) {
      estado.subidaIniciada = false;
      llamar({ accion: 'cancelar', token: estado.token, ventana: estado.ventana }).catch(() => {});
    }
    prepararInicio();
    empezarGrabacion();
  }

  async function usarAudio() {
    if (!estado.audio || estado.prueba) return;
    $('reproductor').pause();
    mostrarProgreso(0);
    mostrarPanel('subiendo');
    try {
      await subirAudio(estado.audio, mostrarProgreso);
      // El enlace guardado se conserva: si se recarga la ventana, el servicio responde que ya se usó.
      estado.terminado = true;
      mostrarPanel('terminado');
      setTimeout(cerrarSola, 1800);
    } catch (error) {
      if (esErrorDeEnlace(error)) {
        mostrarError(errorDeEnlace(error.message));
        return;
      }
      if (error.codigo === 'OTRA_VENTANA') {
        mostrarError({ titulo: 'El grabador está abierto en otra ventana', detalle: error.message,
          principal: botonCerrar() });
        return;
      }
      const sinArreglo = ['AUDIO_DEMASIADO_GRANDE', 'TIPO_NO_ADMITIDO', 'DURACION_INVALIDA'].includes(error.codigo);
      mostrarError({
        titulo: 'No se pudo enviar el audio',
        detalle: error.temporal ? 'Parece un problema de conexión. Tu grabación sigue acá: volvé a intentarlo.' :
          error.message,
        tecnico: descripcionTecnica(error),
        principal: sinArreglo ? { texto: 'Volver a grabar', accion: volverAGrabar } :
          { texto: 'Reintentar', accion: usarAudio },
        secundario: { texto: 'Volver a escuchar', accion: () => mostrarRevision('') }
      });
    }
  }

  /** Parte el MP3 en fragmentos base64, los sube en paralelo y confirma con "finalizar". */
  async function subirAudio(audio, alProgresar) {
    const servicio = estado.servidor;
    if (audio.blob.size > servicio.bytesMaximos) {
      const error = new Error('El audio es demasiado largo para enviarlo. Grabá uno más corto.');
      error.codigo = 'AUDIO_DEMASIADO_GRANDE';
      throw error;
    }
    const base64 = await blobABase64(audio.blob);
    const fragmentos = [];
    for (let i = 0; i < base64.length; i += servicio.tamanoFragmento) {
      fragmentos.push(base64.slice(i, i + servicio.tamanoFragmento));
    }
    const total = fragmentos.length;
    estado.subidaIniciada = true;
    const subirDesde = (inicio, cantidad) => llamar({
      accion: 'subir', token: estado.token, ventana: estado.ventana, inicio,
      fragmentos: fragmentos.slice(inicio, inicio + cantidad)
    });

    const lotes = [];
    for (let i = 0; i < total; i += servicio.fragmentosPorLote) lotes.push(i);
    let enviados = 0;
    await enParalelo(lotes, PEDIDOS_EN_PARALELO, async (inicio) => {
      const cantidad = Math.min(servicio.fragmentosPorLote, total - inicio);
      await subirDesde(inicio, cantidad);
      enviados += cantidad;
      alProgresar(enviados / total * 0.95);
    });

    for (let vuelta = 0; ; vuelta++) {
      try {
        await llamar({ accion: 'finalizar', token: estado.token, ventana: estado.ventana, total,
          tipo: 'audio/mpeg', duracion: Math.round(audio.duracion * 10) / 10, fecha: fechaLocal() });
        break;
      } catch (error) {
        // La cache puede descartar algun fragmento: se vuelven a subir solo esos.
        if (error.codigo !== 'FRAGMENTOS_FALTANTES' || vuelta >= 2) throw error;
        const faltantes = (error.datos.faltantes || []).filter((i) => Number.isInteger(i) && i >= 0 && i < total);
        await enParalelo(faltantes, PEDIDOS_EN_PARALELO, (i) => subirDesde(i, 1));
      }
    }
    alProgresar(1);
  }

  function mostrarProgreso(fraccion) {
    const porcentaje = Math.round(Math.min(1, Math.max(0, fraccion)) * 100);
    $('rellenoProgreso').style.width = porcentaje + '%';
    $('barraProgreso').setAttribute('aria-valuenow', String(porcentaje));
    $('textoProgreso').textContent = porcentaje + ' %';
  }

  function cerrarSola() {
    window.close();
    // Si el navegador no la deja cerrar (por ejemplo, si se abrio a mano), se avisa.
    setTimeout(() => {
      $('textoCierre').textContent = 'Ya podés cerrar esta ventana.';
    }, 500);
  }

  /** Avisa que el grabador se cerro sin terminar, para que el panel de Gmail no lo espere. */
  function avisarCierre() {
    if (estado.prueba || estado.terminado || !estado.token) return;
    try {
      const aviso = { accion: 'cerrar', token: estado.token, ventana: estado.ventana };
      navigator.sendBeacon(urlDelServicio(), new Blob([JSON.stringify(aviso)], { type: 'text/plain;charset=utf-8' }));
    } catch (error) {
      // No es importante: el panel igual permite grabar de nuevo.
    }
  }

  // ---------------------------------------------------------------- comunicacion con el web app

  function urlDelServicio() {
    return `https://script.google.com/macros/s/${estado.despliegue}/exec`;
  }

  /** POST con reintentos para errores de red o temporales del servicio. */
  async function llamar(pedido) {
    for (let intento = 1; ; intento++) {
      try {
        return await llamarUnaVez(pedido);
      } catch (error) {
        if (!error.temporal || intento >= INTENTOS_POR_PEDIDO) throw error;
        await esperar(800 * 2 ** (intento - 1) + Math.random() * 400);
      }
    }
  }

  async function llamarUnaVez(pedido) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), ESPERA_MAXIMA_MS);
    let texto;
    try {
      // text/plain evita el preflight CORS, que Apps Script no responde. Sin cookies: el web app
      // es anonimo y asi no importa con que cuentas de Google se haya iniciado sesion.
      const respuesta = await fetch(urlDelServicio(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(pedido),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: control.signal
      });
      if (!respuesta.ok) throw errorTemporal('el servicio respondió HTTP ' + respuesta.status);
      texto = await respuesta.text();
    } catch (error) {
      if (error.temporal) throw error;
      throw errorTemporal(error.name === 'AbortError' ? 'se agotó el tiempo de espera' :
        'sin conexión con el servicio (' + error.message + ')');
    } finally {
      clearTimeout(reloj);
    }
    let datos;
    try {
      datos = JSON.parse(texto);
    } catch (error) {
      throw errorTemporal('respuesta inesperada del servicio');
    }
    if (datos && datos.ok) return datos;
    const error = new Error((datos && datos.mensaje) || 'El servicio rechazó el pedido.');
    error.codigo = (datos && datos.error) || 'DESCONOCIDO';
    error.datos = datos || {};
    error.temporal = error.codigo === 'ERROR_INTERNO';
    throw error;
  }

  function errorTemporal(mensaje) {
    const error = new Error(mensaje);
    error.codigo = 'RED';
    error.temporal = true;
    return error;
  }

  async function enParalelo(elementos, limite, tarea) {
    let siguiente = 0;
    let falla = null;
    const trabajar = async () => {
      while (!falla && siguiente < elementos.length) {
        const elemento = elementos[siguiente++];
        try {
          await tarea(elemento);
        } catch (error) {
          falla = falla || error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limite, elementos.length) }, trabajar));
    if (falla) throw falla;
  }

  function blobABase64(blob) {
    return new Promise((resolver, rechazar) => {
      const lector = new FileReader();
      lector.onload = () => {
        const url = String(lector.result);
        resolver(url.slice(url.indexOf(',') + 1));
      };
      lector.onerror = () => rechazar(lector.error || new Error('No se pudo leer el audio.'));
      lector.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------- permisos y microfonos

  async function vigilarPermiso() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    let permiso;
    try {
      permiso = await navigator.permissions.query({ name: 'microphone' });
    } catch (error) {
      return; // El navegador no informa el permiso del microfono.
    }
    const aplicar = () => {
      const texto = $('textoPermiso');
      texto.hidden = permiso.state === 'granted';
      texto.textContent = permiso.state === 'denied' ?
        'El micrófono está bloqueado para esta página. Tocá el micrófono para ver cómo habilitarlo.' :
        'La primera vez, el navegador te va a pedir permiso para usar el micrófono.';
      if (permiso.state === 'granted') {
        llenarListaDeMicrofonos();
        // Si estaba mostrando como habilitar el permiso, vuelve solo al inicio.
        if (estado.esperandoPermiso && tarjeta.dataset.panel === 'error') prepararInicio();
      }
    };
    aplicar();
    permiso.addEventListener('change', aplicar);
  }

  /** Muestra el selector solo si hay permiso (si no, no hay nombres) y mas de un microfono. */
  async function llenarListaDeMicrofonos() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    let microfonos;
    try {
      microfonos = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput' && d.label && d.deviceId !== 'communications');
    } catch (error) {
      return;
    }
    const selector = $('selectorMicrofono');
    // "default" es un alias del sistema (Chrome en Windows): no cuenta como otro microfono.
    if (microfonos.filter((m) => m.deviceId !== 'default').length < 2) {
      selector.hidden = true;
      return;
    }
    const lista = $('listaMicrofonos');
    lista.textContent = '';
    microfonos.forEach((microfono) => {
      const opcion = document.createElement('option');
      opcion.value = microfono.deviceId;
      opcion.textContent = microfono.label;
      lista.appendChild(opcion);
    });
    const elegido = microfonos.find((m) => m.deviceId === estado.microfono) ||
      microfonos.find((m) => m.deviceId === 'default') || microfonos[0];
    lista.value = elegido.deviceId;
    selector.hidden = false;
  }

  // ---------------------------------------------------------------- errores

  function errorDeMicrofono(error) {
    const nombre = error && error.name;
    const reintentar = { texto: 'Reintentar', accion: () => { prepararInicio(); empezarGrabacion(); } };
    if (nombre === 'NotAllowedError' || nombre === 'PermissionDeniedError' || nombre === 'SecurityError') {
      estado.esperandoPermiso = true;
      return {
        titulo: 'El navegador bloqueó el micrófono',
        detalle: 'Para grabar hace falta permitir el uso del micrófono en esta página.',
        pasos: pasosParaPermitirElMicrofono(),
        principal: reintentar,
        secundario: botonCerrar()
      };
    }
    if (nombre === 'NotFoundError' || nombre === 'DevicesNotFoundError' || nombre === 'OverconstrainedError') {
      return {
        titulo: 'No encontramos un micrófono',
        detalle: 'Conectá un micrófono (o auriculares con micrófono) y volvé a intentarlo.',
        principal: reintentar
      };
    }
    if (nombre === 'NotReadableError' || nombre === 'TrackStartError' || nombre === 'AbortError') {
      return {
        titulo: 'No se pudo usar el micrófono',
        detalle: 'Puede que otra aplicación lo esté usando (por ejemplo Meet, Zoom o Teams). Cerrala y ' +
          'volvé a intentarlo.',
        tecnico: descripcionTecnica(error),
        principal: reintentar
      };
    }
    return {
      titulo: 'No se pudo empezar a grabar',
      detalle: 'Volvé a intentarlo. Si sigue fallando, probá con otro navegador actualizado.',
      tecnico: descripcionTecnica(error),
      principal: reintentar
    };
  }

  function pasosParaPermitirElMicrofono() {
    const agente = navigator.userAgent;
    const sistema = 'Si ya lo permitiste y sigue bloqueado, revisá la configuración de privacidad de tu ' +
      'computadora: tiene que dejar que el navegador use el micrófono.';
    if (/Firefox\//.test(agente)) {
      return ['Tocá el ícono del micrófono tachado, a la izquierda de la dirección.',
        'Quitá el bloqueo del micrófono y tocá «Reintentar».', sistema];
    }
    if (/Safari\//.test(agente) && !/Chrome\/|Chromium\/|Edg\//.test(agente)) {
      return ['En el menú Safari, abrí «Configuración para este sitio web».',
        'En «Micrófono», elegí «Permitir» y tocá «Reintentar».', sistema];
    }
    return ['Tocá el ícono que está a la izquierda de la dirección (un candado o unos controles).',
      'Activá «Micrófono» o elegí «Permitir».', 'Tocá «Reintentar».', sistema];
  }

  function errorDeProcesamiento(error) {
    return {
      titulo: 'No se pudo procesar el audio',
      detalle: 'Volvé a grabarlo. Si el problema se repite, probá con otro navegador actualizado.',
      tecnico: descripcionTecnica(error),
      principal: { texto: 'Volver a grabar', accion: () => prepararInicio() }
    };
  }

  /** Los mensajes del servicio ya dicen que hacer (por ejemplo "Volvé a Gmail y tocá..."). */
  function errorDeEnlace(mensaje) {
    return {
      titulo: 'Este enlace ya no sirve',
      detalle: mensaje,
      principal: botonCerrar()
    };
  }

  function esErrorDeEnlace(error) {
    return CODIGOS_DE_ENLACE.includes(error && error.codigo);
  }

  function botonCerrar() {
    return { texto: 'Cerrar ventana', accion: () => window.close() };
  }

  function mostrarError(opciones) {
    $('errorTitulo').textContent = opciones.titulo;
    $('errorDetalle').textContent = opciones.detalle || '';
    const pasos = $('errorPasos');
    pasos.textContent = '';
    (opciones.pasos || []).forEach((paso) => {
      const item = document.createElement('li');
      item.textContent = paso;
      pasos.appendChild(item);
    });
    pasos.hidden = !pasos.children.length;
    const tecnico = $('errorTecnico');
    tecnico.textContent = opciones.tecnico ? 'Detalle técnico: ' + opciones.tecnico : '';
    tecnico.hidden = !opciones.tecnico;
    configurarBoton($('botonErrorPrincipal'), opciones.principal);
    configurarBoton($('botonErrorSecundario'), opciones.secundario);
    mostrarPanel('error');
  }

  function configurarBoton(boton, opcion) {
    boton.hidden = !opcion;
    boton.onclick = opcion ? opcion.accion : null;
    boton.textContent = opcion ? opcion.texto : '';
  }

  function descripcionTecnica(error) {
    if (!error) return '';
    return [error.codigo || error.name, error.message].filter(Boolean).join(': ');
  }

  // ---------------------------------------------------------------- utilidades

  const FOCO_POR_PANEL = { inicio: 'botonGrabar', grabando: 'botonDetener', revisando: 'botonUsar',
    error: 'botonErrorPrincipal' };

  function mostrarPanel(nombre) {
    tarjeta.dataset.panel = nombre;
    if (nombre !== 'error') estado.esperandoPermiso = false;
    let id = FOCO_POR_PANEL[nombre];
    if (nombre === 'revisando' && estado.prueba) id = 'botonDescargar';
    const elemento = id && $(id);
    if (elemento && !elemento.hidden) elemento.focus({ preventScroll: true });
  }

  /** 42.7 -> "0:42" */
  function formatearTiempo(segundos) {
    const total = Math.max(0, Math.floor(segundos));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function describirDuracion(segundos) {
    if (segundos % 60) return formatearTiempo(segundos) + ' minutos';
    const minutos = segundos / 60;
    return minutos === 1 ? '1 minuto' : minutos + ' minutos';
  }

  function formatearTamano(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
  }

  /** Hora local para el nombre del archivo: "2026-10-14 13.45". */
  function fechaLocal() {
    const d = new Date();
    const dos = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}.${dos(d.getMinutes())}`;
  }

  function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
  }

  // sessionStorage y localStorage pueden no estar disponibles (navegacion privada, bloqueos).
  function leerSesionGuardada() {
    try {
      const datos = JSON.parse(sessionStorage.getItem(CLAVE_SESION) || 'null');
      return datos && datos.token && datos.despliegue ? datos : null;
    } catch (error) {
      return null;
    }
  }

  function guardarSesion(datos) {
    try {
      sessionStorage.setItem(CLAVE_SESION, JSON.stringify(datos));
      return true;
    } catch (error) {
      return false;
    }
  }

  function leerLocal(clave) {
    try {
      return localStorage.getItem(clave);
    } catch (error) {
      return null;
    }
  }

  function guardarLocal(clave, valor) {
    try {
      localStorage.setItem(clave, valor);
    } catch (error) {
      // Preferencia no esencial.
    }
  }

  iniciar();
})();
