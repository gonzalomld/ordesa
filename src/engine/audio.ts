// audio.ts — SFX procedimentales, sin assets y sin red. Web Audio puro.
//
// Tres efectos, un solo AudioContext creado en el gesto del visitante (la
// creación va DENTRO del clic de la puerta, o el navegador lo deja suspendido):
//   · viento de la intro (ruido rosa por paso bajo, con rachas lentas),
//   · pasos (golpe corto de ruido + cuerpo grave, alterna pie, ligera
//     variación de tono para que no suene a metralleta),
//   · campanilla de hito (arpegio mayor suave, timbre de campana).
//
// Reglas del proyecto que este módulo respeta:
//   · ningún assets sin hash → aquí no hay assets: todo se sintetiza.
//   · un solo rAF → no usa ninguno: la envolvente vive en el reloj del
//     AudioContext (setTargetAtTime / rampas exponenciales), no en el frame.
//   · el suavizado temporal del viento es una aproximación exponencial
//     (setTargetAtTime), equivalente a 1 − exp(−k·dt), nunca un salto.
//
// El motor es opcional: si el navegador no da AudioContext, devuelve un
// handle inerte y la pieza sigue igual.

export interface AudioEngine {
  /** true si hay AudioContext vivo. */
  readonly ok: boolean;
  /** Viento continuo, 0..1 (el motor lo escala y lo suaviza). */
  setWind(level: number): void;
  /** Un paso. strength 0..1 (volumen/cuerpo). */
  step(strength: number): void;
  /** Campanilla de hito. rank = índice del hito (1 = cota, 2 = cola). */
  milestone(rank: number): void;
  /** Baja y cierra el contexto. */
  dispose(): void;
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

/** Ruido rosa (aprox. Voss-McCartney) en un AudioBuffer. */
function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    d[i] = pink * 0.11;
  }
  return buf;
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  try {
    const AC = window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) ctx = new AC();
  } catch {
    ctx = null;
  }
  if (!ctx) {
    return { ok: false, setWind() {}, step() {}, milestone() {}, dispose() {} };
  }
  const ac = ctx;
  void ac.resume();

  // Cadena maestra: master → compresor → salida. El compresor evita que la
  // campanilla + los pasos + el viento se sumen y disparen.
  const master = ac.createGain();
  master.gain.value = 0.85;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 24;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.25;
  master.connect(comp);
  comp.connect(ac.destination);

  const windBus = ac.createGain();
  windBus.gain.value = 1;
  windBus.connect(master);
  const sfxBus = ac.createGain();
  sfxBus.gain.value = 1;
  sfxBus.connect(master);

  const noiseBuf = makeNoiseBuffer(ac, 4);
  const clickBuf = makeNoiseBuffer(ac, 0.2);

  // --- viento: ruido rosa → paso alto → paso bajo → gain(0) ---
  const windSrc = ac.createBufferSource();
  windSrc.buffer = noiseBuf;
  windSrc.loop = true;
  const windHP = ac.createBiquadFilter();
  windHP.type = "highpass";
  windHP.frequency.value = 130;
  windHP.Q.value = 0.4;
  const windLP = ac.createBiquadFilter();
  windLP.type = "lowpass";
  windLP.frequency.value = 520;
  windLP.Q.value = 0.6;
  const windGain = ac.createGain();
  windGain.gain.value = 0;
  windSrc.connect(windHP);
  windHP.connect(windLP);
  windLP.connect(windGain);
  windGain.connect(windBus);
  // Rachas: un LFO lento mueve el corte (0,08 Hz ≈ 12 s de ciclo).
  const lfo = ac.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.08;
  const lfoDepth = ac.createGain();
  lfoDepth.gain.value = 260;
  lfo.connect(lfoDepth);
  lfoDepth.connect(windLP.frequency);
  try {
    windSrc.start();
    lfo.start();
  } catch {
    /* programa ya arrancado o contexto cerrado: el viento queda mudo */
  }
  const WIND_MAX = 0.22;

  let stepParity = 0;

  /** Un golpe de paso: cuerpo grave (seno corto) + click de ruido con banda.
   *  Alterna el pie por paneo estéreo. Nada de transitorios duros. */
  function fireStep(strength: number): void {
    const t = ac.currentTime + 0.001;
    const s = clamp(strength, 0, 1);
    const pan = ac.createStereoPanner();
    pan.pan.value = stepParity ? -0.16 : 0.16;

    const osc = ac.createOscillator();
    osc.type = "sine";
    const f0 = (stepParity ? 86 : 96) + Math.random() * 14;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.1);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.14 * (0.55 + 0.45 * s), t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(og);
    og.connect(pan);

    const n = ac.createBufferSource();
    n.buffer = clickBuf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500 + Math.random() * 700;
    bp.Q.value = 0.8;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.05 * (0.55 + 0.45 * s), t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(pan);

    pan.connect(sfxBus);
    osc.start(t);
    osc.stop(t + 0.18);
    n.start(t);
    n.stop(t + 0.1);
    stepParity ^= 1;
  }

  /** Nota de campana: triángulo + un armónico de seno, decaída larga y suave. */
  function bell(freq: number, t: number, dur: number, gain: number): void {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + dur);
    lp.connect(sfxBus);

    const o1 = ac.createOscillator();
    o1.type = "triangle";
    o1.frequency.value = freq;
    const o2 = ac.createOscillator();
    o2.type = "sine";
    o2.frequency.value = freq * 2;
    const g2 = ac.createGain();
    g2.gain.value = 0.35;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(lp);
    o1.start(t);
    o2.start(t);
    o1.stop(t + dur + 0.05);
    o2.stop(t + dur + 0.05);
  }

  return {
    ok: true,
    setWind(level: number): void {
      const target = clamp(level, 0, 1) * WIND_MAX;
      windGain.gain.setTargetAtTime(target, ac.currentTime, 0.9);
    },
    step(strength: number): void {
      fireStep(strength);
    },
    milestone(rank: number): void {
      const t0 = ac.currentTime + 0.02;
      // Arpegio mayor en Do5; la cota (1) sube a Sol, la cola (2) remata en Do6.
      const base = 523.25;
      const semis = rank >= 2 ? [0, 4, 7, 12, 16] : [0, 4, 7, 12];
      semis.forEach((semi, i) => {
        const f = base * Math.pow(2, semi / 12);
        bell(f, t0 + i * 0.1, 1.5 + i * 0.15, 0.12 - i * 0.012);
      });
    },
    dispose(): void {
      try {
        void ac.close();
      } catch {
        /* ya cerrado */
      }
    },
  };
}
