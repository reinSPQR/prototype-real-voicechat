// Same worklet as Path A — 48kHz Float32 mic → 16kHz Int16 PCM, 80ms chunks.
class Recorder extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.targetRate = opts.processorOptions.targetRate;
    this.ratio = sampleRate / this.targetRate;
    this.buf = [];
    this.flushEvery = this.targetRate * 0.08;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += this.ratio) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(i)]));
      this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    if (this.buf.length >= this.flushEvery) {
      const out = new Int16Array(this.buf);
      this.buf = [];
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('recorder', Recorder);
