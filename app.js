/**
 * Grabador de "Mensajes de voz".
 *
 * Esta pagina vive fuera de Apps Script porque desde febrero de 2026 Google bloquea el microfono
 * en las paginas de Apps Script (ver README). La abre el complemento de Gmail con:
 *   ?t=<token de un solo uso>&d=<ID del despliegue del web app>
 * Graba, codifica a MP3 mientras se graba (codificador-worker.js) y sube el audio al web app en
 * fragmentos. Un mensaje puede tener varias partes (por ejemplo, una por tema): cada parte se
 * guarda al tocar «Otra parte» o «Listo» y se transcribe en segundo plano mientras se graba la
 * siguiente. «Listo» cierra el mensaje y lo deja en el panel de Gmail.
 * Sin parametros funciona en "modo prueba": graba y reproduce, pero no envia nada.
 */
(() => {
  'use strict';

  const PROTOCOLO = 2;               // tiene que coincidir con PROTOCOLO_VOZ del complemento
  const KBPS = 64;                   // MP3 mono: ~480 KB por minuto, muy buena calidad para voz
  const INTENTOS_POR_PEDIDO = 4;
  const PEDIDOS_EN_PARALELO = 3;
  const ESPERA_MAXIMA_MS = 60000;
  // "transcribir" responde recien cuando termina, asi que puede tardar mucho mas que un pedido comun.
  const ESPERA_TRANSCRIBIR_MS = 330000;
  const ESPERA_TOTAL_TRANSCRIPCION_MS = 420000;
  const INTERVALO_DE_CONSULTA_MS = 3000;
  const CONSULTAS_POR_PEDIDO = 20;   // si sigue en curso tras ~1 minuto se vuelve a pedir (por si se corto)
  const DURACION_MINIMA = 0.5;       // segundos
  const DURACION_MAXIMA_EN_PRUEBA = 600;
  const SEGUNDOS_POR_TRAMO = 150;    // igual que SEGUNDOS_POR_TRAMO_ en Transcripcion.gs
  const MARGEN_DE_CORTE = 30;        // segundos alrededor de cada corte donde se busca un silencio (< 25 % del tramo)
  const UMBRAL_DE_SONIDO = 0.008;    // pico (~ -42 dBFS) por debajo del cual se considera silencio
  const SEGUNDOS_DE_SILENCIO = 5;    // para avisar que el microfono podria estar silenciado
  const CLAVE_SESION = 'mensajes-de-voz:sesion';
  const CLAVE_MICROFONO = 'mensajes-de-voz:microfono';
  const CODIGOS_DE_ENLACE = ['TOKEN_INVALIDO', 'SESION_VENCIDA', 'SESION_USADA'];
  const TRANSCRIPCION_PENDIENTE = ['ninguna', 'en-curso'];

  const $ = (id) => document.getElementById(id);
  const tarjeta = $('app');

  const estado = {
    prueba: false,
    token: '',
    despliegue: '',
    servidor: null,           // respuesta de {accion: 'estado'}
    ventana: '',              // identifica esta ventana ante el web app
    duracionMaxima: DURACION_MAXIMA_EN_PRUEBA,   // del mensaje entero, sumando todas las partes
    partesMaximas: 1,
    partes: [],               // partes guardadas: {n, duracion, bytes, transcripcion, siguiendo}
    ocupado: false,           // guardando una parte o terminando el mensaje
    captura: null,            // microfono + AudioContext
    codificador: null,        // Web Worker
    alCodificar: null,
    alFallarCodificador: null,
    aceptando: false,         // recibe muestras hasta vaciar el worklet al terminar
    grabando: false,
    pausado: false,
    muestras: 0,
    tasa: 0,
    limiteDeSegundos: 0,      // lo que puede durar la parte que se esta grabando
    limiteDeMuestras: 0,
    niveles: [],              // para el medidor (ultimos segundos)
    energias: [],             // nivel de cada bloque grabado, para elegir donde partir el audio
    finales: [],              // muestra en la que termina cada bloque
    ultimoSonido: 0,
    colores: null,
    animacion: 0,
    audio: null,              // grabacion en revision: {blob, url, duracion, cortes, parte}
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
    $('botonOtraParte').addEventListener('click', () => guardarAudio(false));
    $('botonUsar').addEventListener('click', () => guardarAudio(true));
    $('botonListoInicio').addEventListener('click', terminarMensaje);
    $('botonNoEsperar').addEventListener('click', () => mostrarTerminado(true));
    $('listaMicrofonos').addEventListener('change', (evento) => {
      estado.microfono = evento.target.value === 'default' ? '' : evento.target.value;
      guardarLocal(CLAVE_MICROFONO, estado.microfono);
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', llenarListaDeMicrofonos);
    }
    window.addEventListener('beforeunload', (evento) => {
      const panel = tarjeta.dataset.panel;
      // Las partes guardadas no llegan a Gmail hasta tocar «Listo»: tambien se avisa en ese caso.
      const sePierdeAlgo = estado.grabando || panel === 'procesando' || panel === 'subiendo' ||
        (panel === 'revisando' && !estado.prueba) || (panel === 'inicio' && estado.partes.length > 0);
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
    $('textoCargando').textContent = 'Preparando el grabador…';
    mostrarPanel('cargando');
    try {
      const respuesta = await llamar({ accion: 'estado', token: estado.token, protocolo: PROTOCOLO });
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
      estado.partesMaximas = respuesta.partesMaximas || 1;
      // Si se recargo la ventana (o se volvio a abrir el grabador), se sigue con lo ya grabado.
      estado.partes = (respuesta.partes || []).map((parte) => ({ n: parte.n, duracion: parte.duracion,
        bytes: parte.bytes, transcripcion: parte.transcripcion || { estado: 'ninguna' } }));
      estado.partes.forEach(seguirTranscripcion);
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
    const textos = textosDeInicio();
    $('botonGrabar').hidden = !puedeGrabarOtraParte();
    $('textoInicio').textContent = textos.titulo;
    $('textoDisponible').textContent = textos.detalle;
    $('avisoInicio').textContent = aviso || '';
    $('avisoInicio').hidden = !aviso;
    dibujarPartes($('listaPartes'), true);
    $('accionesInicio').hidden = !estado.partes.length;
    llenarListaDeMicrofonos();
    mostrarPanel('inicio');
  }

  function textosDeInicio() {
    const cantidad = estado.partes.length;
    if (!cantidad) {
      const varias = estado.partesMaximas > 1 && !estado.prueba;
      return { titulo: 'Tocá el micrófono para empezar',
        detalle: `Podés grabar hasta ${describirDuracion(estado.duracionMaxima)}${varias ? ', en una o varias partes' : ''}.` };
    }
    if (puedeGrabarOtraParte()) {
      return { titulo: `Tocá el micrófono para grabar la parte ${cantidad + 1}`,
        detalle: `Te quedan ${formatearTiempo(segundosDisponibles())} para este mensaje.` };
    }
    return {
      titulo: cantidad >= estado.partesMaximas ? `Llegaste al máximo de ${estado.partesMaximas} partes` :
        'Ya usaste todo el tiempo del mensaje',
      detalle: 'Tocá «Listo» para usarlo en Gmail.'
    };
  }

  /** Segundos que quedan para el mensaje (descontando las partes ya guardadas). */
  function segundosDisponibles() {
    if (estado.prueba) return DURACION_MAXIMA_EN_PRUEBA;
    const usados = estado.partes.reduce((suma, parte) => suma + parte.duracion, 0);
    return Math.max(0, estado.duracionMaxima - usados);
  }

  function puedeGrabarOtraParte() {
    return estado.prueba || (estado.partes.length < estado.partesMaximas &&
      segundosDisponibles() >= DURACION_MINIMA + 1);
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
      $('textoInicio').textContent = textosDeInicio().titulo;
    }

    const limiteDeSegundos = segundosDisponibles();
    Object.assign(estado, {
      captura,
      aceptando: true,
      grabando: true,
      pausado: false,
      muestras: 0,
      tasa: captura.tasa,
      limiteDeSegundos,
      limiteDeMuestras: Math.floor(limiteDeSegundos * captura.tasa),
      niveles: [],
      energias: [],
      finales: [],
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
      terminarGrabacion(estado.partes.length ?
        `Se terminó el tiempo del mensaje (${formatearTiempo(estado.duracionMaxima)} en total).` :
        `Se llegó a la duración máxima (${formatearTiempo(estado.limiteDeSegundos)}).`);
    }
  }

  /** Nivel para el medidor, deteccion de silencio prolongado y registro para elegir cortes. */
  function medir(muestras) {
    let suma = 0;
    let pico = 0;
    for (let i = 0; i < muestras.length; i++) {
      const valor = muestras[i];
      suma += valor * valor;
      const absoluto = valor < 0 ? -valor : valor;
      if (absoluto > pico) pico = absoluto;
    }
    const rms = Math.sqrt(suma / muestras.length);
    const decibeles = 20 * Math.log10(rms + 1e-8);
    estado.niveles.push(Math.min(1, Math.max(0, (decibeles + 55) / 50)));
    if (estado.niveles.length > 600) estado.niveles.splice(0, estado.niveles.length - 600);
    const fin = estado.muestras + muestras.length;
    estado.energias.push(rms);
    estado.finales.push(fin);
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
    const restantes = estado.limiteDeSegundos - segundos;
    cronometro.classList.toggle('poco-tiempo', restantes <= 30);
    $('textoRestante').textContent = restantes <= 30 ?
      `Quedan ${Math.max(0, Math.ceil(restantes))} s` : 'de ' + formatearTiempo(estado.limiteDeSegundos);
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
      estado.audio = { blob: resultado.blob, url: URL.createObjectURL(resultado.blob), duracion,
        cortes: calcularCortes(duracion), parte: null };
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

  /**
   * Silencios donde conviene partir el audio para transcribirlo, en segundos. Sigue la misma regla
   * que partirMp3_ (Transcripcion.gs): cada ~2,5 minutos, el momento mas silencioso cerca de ese
   * punto. Asi ningun tramo empieza o termina en medio de una palabra.
   */
  function calcularCortes(duracion) {
    const cortes = [];
    let anterior = 0;
    while (duracion - anterior > SEGUNDOS_POR_TRAMO * 1.2) {
      const objetivo = anterior + SEGUNDOS_POR_TRAMO;
      const desde = objetivo - MARGEN_DE_CORTE;
      const hasta = Math.min(objetivo + MARGEN_DE_CORTE, duracion - 2);
      let elegido = -1;
      let menor = Infinity;
      for (let i = 1; i < estado.finales.length - 1; i++) {
        const segundo = estado.finales[i] / estado.tasa;
        if (segundo < desde || segundo > hasta) continue;
        // Tres bloques seguidos (~1/4 s): una pausa de verdad y no el instante entre dos silabas.
        const nivel = estado.energias[i - 1] + estado.energias[i] + estado.energias[i + 1];
        if (nivel < menor) {
          menor = nivel;
          elegido = i;
        }
      }
      if (elegido === -1) {
        anterior = objetivo;
        continue;
      }
      const corte = Math.round((estado.finales[elegido - 1] + estado.finales[elegido]) / 2 / estado.tasa * 100) / 100;
      cortes.push(corte);
      anterior = corte;
    }
    return cortes;
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

  // ---------------------------------------------------------------- revision y guardado

  function mostrarRevision(aviso) {
    const audio = estado.audio;
    const cantidad = estado.partes.length;
    const otraParte = !estado.prueba && cantidad + 1 < estado.partesMaximas &&
      segundosDisponibles() - audio.duracion >= DURACION_MINIMA + 1;
    $('reproductor').src = audio.url;
    $('resumenAudio').textContent = (cantidad ? `Parte ${cantidad + 1} · ` : '') +
      `${formatearTiempo(audio.duracion)} · MP3 · ${formatearTamano(audio.blob.size)}`;
    $('avisoRevision').textContent = aviso || '';
    $('avisoRevision').hidden = !aviso;
    $('botonOtraParte').hidden = !otraParte;
    $('botonUsar').hidden = estado.prueba;
    $('ayudaRevision').textContent = otraParte && !cantidad ?
      'Con «Otra parte» guardás este audio y grabás otro en el mismo mensaje (por ejemplo, para otro tema).' : '';
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

  /** Descarta la grabacion en revision. Si se llego a subir una parte de ella, se borra lo subido. */
  function descartarAudio() {
    const audio = estado.audio;
    liberarAudio();
    if (audio && audio.parte !== null) {
      llamar({ accion: 'eliminarParte', token: estado.token, ventana: estado.ventana, parte: audio.parte })
        .catch(() => {});  // No es importante: lo subido vence solo.
    }
  }

  function volverAGrabar() {
    descartarAudio();
    prepararInicio();
    empezarGrabacion();
  }

  /** Guarda la grabacion en revision como una parte del mensaje. Con «Listo» tambien lo termina. */
  async function guardarAudio(terminar) {
    const audio = estado.audio;
    if (!audio || estado.prueba || estado.ocupado) return;
    estado.ocupado = true;
    $('reproductor').pause();
    $('tituloSubiendo').textContent = terminar && !estado.partes.length ? 'Guardando el audio…' :
      `Guardando la parte ${estado.partes.length + 1}…`;
    mostrarProgreso(0);
    mostrarPanel('subiendo');
    let parte;
    try {
      parte = await subirParte(audio, mostrarProgreso);
    } catch (error) {
      mostrarErrorAlGuardar(error, () => guardarAudio(terminar));
      return;
    } finally {
      estado.ocupado = false;
    }
    liberarAudio();
    estado.partes.push(parte);
    seguirTranscripcion(parte);
    if (terminar) terminarMensaje();
    else prepararInicio();
  }

  function mostrarErrorAlGuardar(error, reintentar) {
    if (mostrarErrorDeSesion(error)) return;
    let principal = { texto: 'Reintentar', accion: reintentar };
    if (['AUDIO_DEMASIADO_GRANDE', 'TIPO_NO_ADMITIDO', 'DURACION_INVALIDA'].includes(error.codigo)) {
      principal = { texto: 'Volver a grabar', accion: volverAGrabar };
    } else if (error.codigo === 'DEMASIADAS_PARTES') {
      principal = estado.partes.length ? {
        texto: 'Terminar sin esta parte',
        accion: () => {
          descartarAudio();
          terminarMensaje();
        }
      } : botonCerrar();
    }
    mostrarError({
      titulo: 'No se pudo guardar el audio',
      detalle: error.temporal ? 'Parece un problema de conexión. Tu grabación sigue acá: volvé a intentarlo.' :
        error.message,
      tecnico: descripcionTecnica(error),
      principal,
      secundario: { texto: 'Volver a escuchar', accion: () => mostrarRevision('') }
    });
  }

  /**
   * Sube la grabacion como una parte del mensaje: reserva un numero, parte el MP3 en fragmentos
   * base64, los sube en paralelo y confirma con "finalizar". Un reintento usa el mismo numero.
   */
  async function subirParte(audio, alProgresar) {
    const servicio = estado.servidor;
    const usados = estado.partes.reduce((suma, parte) => suma + parte.bytes, 0);
    if (audio.blob.size > servicio.bytesMaximos - usados) {
      const error = new Error('El audio es demasiado largo para enviarlo. Grabá uno más corto.');
      error.codigo = 'AUDIO_DEMASIADO_GRANDE';
      throw error;
    }
    if (audio.parte === null) {
      audio.parte = (await llamar({ accion: 'reservarParte', token: estado.token, ventana: estado.ventana })).parte;
    }
    const parte = audio.parte;
    const base64 = await blobABase64(audio.blob);
    const fragmentos = [];
    for (let i = 0; i < base64.length; i += servicio.tamanoFragmento) {
      fragmentos.push(base64.slice(i, i + servicio.tamanoFragmento));
    }
    const total = fragmentos.length;
    const subirDesde = (inicio, cantidad) => llamar({
      accion: 'subir', token: estado.token, ventana: estado.ventana, parte, inicio,
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

    const duracion = Math.round(audio.duracion * 10) / 10;
    for (let vuelta = 0; ; vuelta++) {
      try {
        await llamar({ accion: 'finalizar', token: estado.token, ventana: estado.ventana, parte, total,
          tipo: 'audio/mpeg', duracion, fecha: fechaLocal(), cortes: audio.cortes });
        break;
      } catch (error) {
        // La cache puede descartar algun fragmento: se vuelven a subir solo esos.
        if (error.codigo !== 'FRAGMENTOS_FALTANTES' || vuelta >= 2) throw error;
        const faltantes = (error.datos.faltantes || []).filter((i) => Number.isInteger(i) && i >= 0 && i < total);
        await enParalelo(faltantes, PEDIDOS_EN_PARALELO, (i) => subirDesde(i, 1));
      }
    }
    alProgresar(1);
    return { n: parte, duracion, bytes: audio.blob.size, transcripcion: { estado: 'ninguna' } };
  }

  function mostrarProgreso(fraccion) {
    const porcentaje = Math.round(Math.min(1, Math.max(0, fraccion)) * 100);
    $('rellenoProgreso').style.width = porcentaje + '%';
    $('barraProgreso').setAttribute('aria-valuenow', String(porcentaje));
    $('textoProgreso').textContent = porcentaje + ' %';
  }

  // ---------------------------------------------------------------- partes del mensaje

  /** Lista de partes guardadas. En el inicio cada una tiene su boton para eliminarla. */
  function dibujarPartes(lista, conBotones) {
    lista.textContent = '';
    estado.partes.forEach((parte, i) => {
      const item = crear('li', 'parte');
      item.dataset.parte = String(parte.n);
      const numero = crear('span', 'parte-numero', String(i + 1));
      numero.setAttribute('aria-hidden', 'true');
      const datos = crear('span', 'parte-datos');
      datos.append(crear('span', 'parte-titulo', `Parte ${i + 1} · ${formatearTiempo(parte.duracion)}`),
        crear('span', 'parte-estado'));
      item.append(numero, datos);
      if (conBotones) item.appendChild(botonParaEliminar(parte, i + 1));
      lista.appendChild(item);
    });
    lista.hidden = !estado.partes.length;
    estado.partes.forEach(actualizarEstadoDeParte);
  }

  function actualizarEstadoDeParte(parte) {
    const { texto, clase } = describirTranscripcion(parte.transcripcion);
    document.querySelectorAll(`.parte[data-parte="${parte.n}"] .parte-estado`).forEach((linea) => {
      linea.textContent = texto;
      linea.title = texto;
      linea.className = 'parte-estado' + (clase ? ' ' + clase : '');
    });
  }

  function describirTranscripcion(transcripcion) {
    if (!transcripcionActiva()) return { texto: 'Guardada', clase: 'lista' };
    switch (transcripcion.estado) {
      case 'lista':
        return { texto: transcripcion.resumen || transcripcion.vistaPrevia || 'Transcripción lista', clase: 'lista' };
      case 'sin-voz': return { texto: 'No se detectó voz para transcribir', clase: 'problema' };
      case 'limite': return { texto: 'Sin transcripción: se alcanzó el límite por ahora', clase: 'problema' };
      case 'error': return { texto: 'No se pudo transcribir (el audio va igual)', clase: 'problema' };
      case 'demorada': return { texto: 'La transcripción está tardando más de lo normal', clase: 'problema' };
      case 'desactivada': return { texto: 'Guardada', clase: 'lista' };
      default: return { texto: 'Transcribiendo…', clase: '' };
    }
  }

  /** Papelera con confirmacion: el primer toque pide confirmar y el segundo elimina. */
  function botonParaEliminar(parte, numero) {
    const boton = crear('button', 'boton-icono');
    boton.type = 'button';
    let espera = 0;
    const restaurar = () => {
      boton.classList.remove('confirmar');
      boton.textContent = '';
      boton.appendChild(icono('i-trash'));
      boton.setAttribute('aria-label', `Eliminar la parte ${numero}`);
      boton.title = `Eliminar la parte ${numero}`;
    };
    restaurar();
    boton.addEventListener('click', () => {
      if (boton.disabled) return;
      if (!boton.classList.contains('confirmar')) {
        boton.classList.add('confirmar');
        boton.textContent = 'Eliminar';
        boton.setAttribute('aria-label', `Confirmar: eliminar la parte ${numero}`);
        boton.removeAttribute('title');
        espera = setTimeout(restaurar, 4000);
        return;
      }
      clearTimeout(espera);
      eliminarParte(parte, boton);
    });
    return boton;
  }

  async function eliminarParte(parte, boton) {
    boton.disabled = true;
    boton.textContent = 'Eliminando…';
    try {
      await llamar({ accion: 'eliminarParte', token: estado.token, ventana: estado.ventana, parte: parte.n });
    } catch (error) {
      if (mostrarErrorDeSesion(error)) return;
      if (tarjeta.dataset.panel === 'inicio') prepararInicio('No se pudo eliminar la parte. Volvé a intentarlo.');
      return;
    }
    estado.partes = estado.partes.filter((otra) => otra !== parte);
    // Si mientras tanto se empezo a grabar, la lista se actualiza al volver al inicio.
    if (tarjeta.dataset.panel === 'inicio') prepararInicio();
  }

  // ---------------------------------------------------------------- transcripcion y final

  function transcripcionActiva() {
    return !!(estado.servidor && estado.servidor.transcripcion && estado.servidor.transcripcion.activa);
  }

  /** Mientras se sigue una parte, cuenta como pendiente aunque haya fallado (todavia se reintenta). */
  function pendiente(parte) {
    return !!parte.siguiendo || TRANSCRIPCION_PENDIENTE.includes(parte.transcripcion.estado);
  }

  /**
   * Transcripcion de una parte, en segundo plano. "transcribir" responde cuando termina (o enseguida
   * si ya hay una en curso); mientras siga en curso, se consulta el estado cada pocos segundos.
   * Un error se reintenta una vez: suele ser pasajero (por ejemplo, el modelo saturado).
   */
  async function seguirTranscripcion(parte) {
    if (!transcripcionActiva() || parte.siguiendo) return;
    parte.siguiendo = true;
    const limite = Date.now() + ESPERA_TOTAL_TRANSCRIPCION_MS;
    let pedidos = 0;
    let consultas = 0;
    let reintentado = false;
    try {
      while (estado.partes.includes(parte)) {
        const actual = parte.transcripcion.estado;
        const reintentar = actual === 'error' && !reintentado;
        if (actual === 'ninguna' || reintentar || (actual === 'en-curso' && consultas >= CONSULTAS_POR_PEDIDO)) {
          if (pedidos >= 4) break;
          if (reintentar) {
            reintentado = true;
            await esperar(2000);
          }
          pedidos++;
          consultas = 0;
          await pedirTranscripcion(parte);
        } else if (actual === 'en-curso') {
          if (Date.now() > limite) break;
          await esperar(INTERVALO_DE_CONSULTA_MS);
          consultas++;
          await consultarTranscripcion(parte);
        } else {
          break;  // lista, sin voz, limite, desactivada o error despues de reintentar
        }
      }
    } finally {
      parte.siguiendo = false;
    }
    if (estado.partes.includes(parte) && pendiente(parte)) {
      actualizarTranscripcion(parte, { estado: 'demorada' });
    } else {
      revisarEspera();
    }
  }

  async function pedirTranscripcion(parte) {
    try {
      const respuesta = await llamar({ accion: 'transcribir', token: estado.token, ventana: estado.ventana,
        parte: parte.n }, { intentos: 1, espera: ESPERA_TRANSCRIBIR_MS });
      actualizarTranscripcion(parte, respuesta.transcripcion);
    } catch (error) {
      // Si se corto la conexion, el servicio puede estar transcribiendo igual: se consulta el estado.
      actualizarTranscripcion(parte, error.temporal ? { estado: 'en-curso' } :
        { estado: 'error', mensaje: error.message });
    }
  }

  async function consultarTranscripcion(parte) {
    try {
      const respuesta = await llamar({ accion: 'transcripcion', token: estado.token, parte: parte.n });
      actualizarTranscripcion(parte, respuesta.transcripcion);
    } catch (error) {
      // Con un problema de conexion se vuelve a consultar en unos segundos.
      if (!error.temporal) actualizarTranscripcion(parte, { estado: 'error', mensaje: error.message });
    }
  }

  function actualizarTranscripcion(parte, transcripcion) {
    parte.transcripcion = transcripcion && transcripcion.estado ? transcripcion : { estado: 'ninguna' };
    actualizarEstadoDeParte(parte);
    revisarEspera();
  }

  /** Si se estaba esperando la transcripcion y ya no falta ninguna, termina. */
  function revisarEspera() {
    if (tarjeta.dataset.panel === 'transcribiendo' && !estado.partes.some(pendiente)) mostrarTerminado(false);
  }

  /** Cierra el mensaje: desde ahora el panel de Gmail lo muestra listo para usar. */
  async function terminarMensaje() {
    if (estado.ocupado || !estado.partes.length) return;
    estado.ocupado = true;
    if (tarjeta.dataset.panel !== 'subiendo') {
      $('textoCargando').textContent = 'Guardando el mensaje…';
      mostrarPanel('cargando');
    }
    try {
      await llamar({ accion: 'terminar', token: estado.token, ventana: estado.ventana });
    } catch (error) {
      if (mostrarErrorDeSesion(error)) return;
      mostrarError({
        titulo: 'No se pudo terminar el mensaje',
        detalle: error.temporal ? 'Parece un problema de conexión. Lo que grabaste está guardado: volvé a ' +
          'intentarlo.' : error.message,
        tecnico: descripcionTecnica(error),
        principal: { texto: 'Reintentar', accion: terminarMensaje },
        secundario: { texto: 'Volver', accion: () => prepararInicio() }
      });
      return;
    } finally {
      estado.ocupado = false;
    }
    // El enlace guardado se conserva: si se recarga la ventana, el servicio responde que ya se usó.
    estado.terminado = true;
    if (!transcripcionActiva() || !estado.partes.some(pendiente)) {
      mostrarTerminado(false);
      return;
    }
    dibujarPartes($('listaPartesEspera'), false);
    mostrarPanel('transcribiendo');
  }

  /** @param {boolean} sinEsperar se toco «No esperar»: la transcripcion sigue en el servicio. */
  function mostrarTerminado(sinEsperar) {
    if (tarjeta.dataset.panel === 'terminado') return;
    estado.terminado = true;
    const problemas = transcripcionActiva() && estado.partes.some((parte) =>
      ['error', 'limite', 'demorada'].includes(parte.transcripcion.estado));
    let texto = `Volvé a Gmail: ${estado.partes.length > 1 ? 'el mensaje' : 'el audio'} ya está en el ` +
      'panel «Mensajes de voz». Desde ahí elegís responder o crear un correo nuevo.';
    if (sinEsperar) texto += ' La transcripción sigue sola: si todavía no aparece, tocá «Actualizar» en el panel.';
    else if (problemas) texto += ' Hubo partes sin transcripción, pero los audios van adjuntos igual.';
    $('textoTerminado').textContent = texto;
    mostrarPanel('terminado');
    setTimeout(cerrarSola, problemas && !sinEsperar ? 5000 : 1800);
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

  /**
   * POST con reintentos para errores de red o temporales del servicio.
   * @param {{intentos: number, espera: number}=} opciones espera: milisegundos por intento.
   */
  async function llamar(pedido, opciones) {
    const intentos = (opciones && opciones.intentos) || INTENTOS_POR_PEDIDO;
    const espera = (opciones && opciones.espera) || ESPERA_MAXIMA_MS;
    for (let intento = 1; ; intento++) {
      try {
        return await llamarUnaVez(pedido, espera);
      } catch (error) {
        if (!error.temporal || intento >= intentos) throw error;
        await esperar(800 * 2 ** (intento - 1) + Math.random() * 400);
      }
    }
  }

  async function llamarUnaVez(pedido, espera) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), espera);
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

  /**
   * Muestra el selector solo si hay permiso (si no, no hay nombres), mas de un microfono y todavia
   * se puede grabar otra parte.
   */
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
    if (microfonos.filter((m) => m.deviceId !== 'default').length < 2 || !puedeGrabarOtraParte()) {
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

  /** Errores que dejan esta ventana sin uso: enlace vencido o grabador abierto en otra ventana. */
  function mostrarErrorDeSesion(error) {
    if (esErrorDeEnlace(error)) {
      mostrarError(errorDeEnlace(error.message));
      return true;
    }
    if (error && error.codigo === 'OTRA_VENTANA') {
      mostrarError({ titulo: 'El grabador está abierto en otra ventana', detalle: error.message,
        principal: botonCerrar() });
      return true;
    }
    return false;
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

  // Lo que recibe el foco al mostrar cada panel: el primero de la lista que este visible.
  const FOCO_POR_PANEL = {
    inicio: ['botonGrabar', 'botonListoInicio'],
    grabando: ['botonDetener'],
    revisando: ['botonUsar', 'botonDescargar'],
    transcribiendo: ['botonNoEsperar'],
    error: ['botonErrorPrincipal']
  };

  function mostrarPanel(nombre) {
    tarjeta.dataset.panel = nombre;
    if (nombre !== 'error') estado.esperandoPermiso = false;
    const id = (FOCO_POR_PANEL[nombre] || []).find((candidato) => !$(candidato).hidden);
    if (id) $(id).focus({ preventScroll: true });
  }

  function crear(etiqueta, clase, texto) {
    const elemento = document.createElement(etiqueta);
    if (clase) elemento.className = clase;
    if (texto) elemento.textContent = texto;
    return elemento;
  }

  function icono(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    uso.setAttribute('href', '#' + id);
    svg.appendChild(uso);
    return svg;
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
