/**
 * Web Worker que codifica a MP3 mientras se graba, para que al tocar "Detener" el audio ya este
 * listo y la interfaz no se trabe.
 *
 * Mensajes que recibe:
 *   {tipo: 'iniciar', tasa, kbps}   tasa de muestreo del microfono y bitrate del MP3
 *   {tipo: 'pcm', muestras}         Float32Array mono entre -1 y 1
 *   {tipo: 'terminar'}              responde {tipo: 'listo', blob, muestras, tasa}
 * Ante cualquier falla responde {tipo: 'error', mensaje}.
 *
 * Usa LAME (lamejs, LGPL), ver vendor/LEAME-LAME.txt.
 */
/* global lamejs */
importScripts('vendor/lame.min.js');

// Frecuencias de muestreo que admite MP3. Si el microfono usa otra, se convierte a 48 kHz.
const FRECUENCIAS_MP3 = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

let codificador = null;
let partes = [];
let tasaDeEntrada = 0;
let tasaDeSalida = 0;
let muestrasCodificadas = 0;
// Estado del remuestreo entre bloques: posicion fraccionaria y ultima muestra del bloque anterior.
let posicionRemuestreo = 0;
let ultimaMuestra = 0;

self.onmessage = (evento) => {
  const mensaje = evento.data;
  try {
    if (mensaje.tipo === 'iniciar') iniciar(mensaje.tasa, mensaje.kbps);
    else if (mensaje.tipo === 'pcm') codificar(mensaje.muestras);
    else if (mensaje.tipo === 'terminar') terminar();
  } catch (error) {
    self.postMessage({ tipo: 'error', mensaje: String((error && error.message) || error) });
  }
};

function iniciar(tasa, kbps) {
  tasaDeEntrada = tasa;
  tasaDeSalida = FRECUENCIAS_MP3.includes(tasa) ? tasa : 48000;
  codificador = new lamejs.Mp3Encoder(1, tasaDeSalida, kbps);
  partes = [];
  muestrasCodificadas = 0;
  posicionRemuestreo = 0;
  ultimaMuestra = 0;
}

function codificar(muestras) {
  if (!codificador) throw new Error('El codificador no se inicio.');
  const entrada = tasaDeSalida === tasaDeEntrada ? muestras : remuestrear(muestras);
  const pcm = new Int16Array(entrada.length);
  for (let i = 0; i < entrada.length; i++) {
    const valor = Math.max(-1, Math.min(1, entrada[i]));
    pcm[i] = valor < 0 ? valor * 0x8000 : valor * 0x7fff;
  }
  muestrasCodificadas += pcm.length;
  agregar(codificador.encodeBuffer(pcm));
}

function terminar() {
  if (!codificador) throw new Error('El codificador no se inicio.');
  agregar(codificador.flush());
  const blob = new Blob(partes, { type: 'audio/mpeg' });
  self.postMessage({ tipo: 'listo', blob, muestras: muestrasCodificadas, tasa: tasaDeSalida });
  codificador = null;
  partes = [];
}

function agregar(datos) {
  // lamejs devuelve Int8Array; se copia a bytes sin signo.
  if (datos && datos.length) partes.push(new Uint8Array(datos.buffer, datos.byteOffset, datos.length).slice());
}

/** Interpolacion lineal continua entre bloques (solo para frecuencias poco comunes, ej. 96 kHz). */
function remuestrear(muestras) {
  if (!muestras.length) return muestras;
  const paso = tasaDeEntrada / tasaDeSalida;
  const salida = [];
  // La posicion -1 corresponde a la ultima muestra del bloque anterior.
  let posicion = posicionRemuestreo;
  while (posicion < muestras.length - 1) {
    const base = Math.floor(posicion);
    const fraccion = posicion - base;
    const a = base < 0 ? ultimaMuestra : muestras[base];
    const b = muestras[base + 1];
    salida.push(a + (b - a) * fraccion);
    posicion += paso;
  }
  posicionRemuestreo = posicion - muestras.length;
  ultimaMuestra = muestras[muestras.length - 1];
  return Float32Array.from(salida);
}
