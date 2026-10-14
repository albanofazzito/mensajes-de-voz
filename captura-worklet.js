/**
 * AudioWorklet que entrega el audio del microfono (mono, Float32) al hilo principal en bloques de
 * 4096 muestras (~85 ms a 48 kHz), para no mandar un mensaje cada 128 muestras.
 *
 * Mensajes que recibe: 'detener' -> entrega lo que tenga acumulado, avisa {fin: true} y termina.
 */
class CapturaPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bloque = new Float32Array(4096);
    this.posicion = 0;
    this.activo = true;
    this.port.onmessage = (evento) => {
      if (evento.data === 'detener') {
        this.entregar();
        this.port.postMessage({ fin: true });
        this.activo = false;
      }
    };
  }

  entregar() {
    if (!this.posicion) return;
    const salida = this.bloque.slice(0, this.posicion);
    this.port.postMessage(salida, [salida.buffer]);
    this.posicion = 0;
  }

  process(entradas) {
    const canal = entradas[0] && entradas[0][0];
    if (this.activo && canal) {
      for (let i = 0; i < canal.length; i++) {
        this.bloque[this.posicion++] = canal[i];
        if (this.posicion === this.bloque.length) this.entregar();
      }
    }
    return this.activo;
  }
}

registerProcessor('captura-pcm', CapturaPcm);
