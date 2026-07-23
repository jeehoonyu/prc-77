// audio.js — the handset.
//
// Everything here is generated, not sampled, and each element corresponds to
// something the handbook tells the operator to listen for:
//
//   [S2] 3.06(a)  "A rushing noise should be heard in the handset."
//   [S2] 4.09(d)(2) "There should be a low growl heard when the PTT is
//                    pressed. This is the sub-tone."   <- the 150 Hz tone
//   [S2] 4.09(d)(3) "When transmitting, you can hear yourself in the earpiece.
//                    This is called sidetone."
//   [S2] 4.09(d)(4) "You can hear the receive/transmit relay inside the radio
//                    clicking as you press and release the PTT."
//
// The receive-noise level is driven by the link margin from propagation.js, so
// a marginal path really does sound marginal.

import { SQUELCH_TONE_HZ, VOLUME_MAX } from './config.js';

export class HandsetAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.nodes = {};
    this.micStream = null;
  }

  /** Must be called from a user gesture — browsers require it. */
  async start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const ctx = this.ctx;

    // Master out.
    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);

    // --- Receiver noise ------------------------------------------------------
    // Band-limited white noise: the "rushing noise" of an open squelch.
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;

    // Shape it like a communications receiver's audio: 300 Hz - 3 kHz.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;

    noise.connect(hp); hp.connect(lp); lp.connect(noiseGain); noiseGain.connect(master);
    noise.start();

    // --- 150 Hz sub-tone -----------------------------------------------------
    // The "low growl" on transmit. A square wave through a low-pass sounds far
    // closer to the real thing than a sine.
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = SQUELCH_TONE_HZ;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass'; subLp.frequency.value = 400;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    sub.connect(subLp); subLp.connect(subGain); subGain.connect(master);
    sub.start();

    // --- Sidetone ------------------------------------------------------------
    const side = ctx.createOscillator();
    side.type = 'sine';
    side.frequency.value = 700;
    const sideGain = ctx.createGain();
    sideGain.gain.value = 0;
    side.connect(sideGain); sideGain.connect(master);
    side.start();

    // --- Received signal -----------------------------------------------------
    // Stands in for voice on a received carrier. Mic input replaces it when
    // the operator grants permission.
    const sig = ctx.createOscillator();
    sig.type = 'sawtooth';
    sig.frequency.value = 220;
    const sigLp = ctx.createBiquadFilter();
    sigLp.type = 'lowpass'; sigLp.frequency.value = 2800;
    const sigGain = ctx.createGain();
    sigGain.gain.value = 0;
    sig.connect(sigLp); sigLp.connect(sigGain); sigGain.connect(master);
    sig.start();

    this.nodes = { master, noise, noiseGain, sub, subGain, side, sideGain, sig, sigGain, sigLp };
    this.started = true;
  }

  get running() { return this.started && this.ctx?.state === 'running'; }

  /** VOLUME control, 1..10 on the panel. */
  setVolume(v) {
    if (!this.started) return;
    // Roughly logarithmic, as a real volume control is.
    const norm = Math.pow(v / VOLUME_MAX, 1.8);
    this.nodes.master.gain.setTargetAtTime(0.75 * norm, this.ctx.currentTime, 0.02);
  }

  /**
   * Drive the handset from a Net.receptionFor() result.
   * @param {object} rx  reception state
   */
  update(rx) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const set = (node, value, tau = 0.05) => node.gain.setTargetAtTime(value, t, tau);

    if (!rx || rx.state === 'off') {
      set(this.nodes.noiseGain, 0);
      set(this.nodes.subGain, 0);
      set(this.nodes.sideGain, 0);
      set(this.nodes.sigGain, 0);
      return;
    }

    if (rx.state === 'transmitting') {
      // Sidetone plus the 150 Hz growl, no receiver audio.
      set(this.nodes.noiseGain, 0);
      set(this.nodes.subGain, 0.05);
      set(this.nodes.sideGain, 0.04);
      set(this.nodes.sigGain, 0);
      return;
    }

    if (rx.state === 'keyed-dead') {
      // Keyed but not radiating. [S2] 4.09 describes a buzz, and crucially NO
      // sidetone — the absence is what tells the operator the battery is done.
      // The buzz is the sub-tone oscillator detuned and driven hard, which is
      // what a starved PA modulating its own supply actually sounds like.
      this.nodes.sub.frequency.setTargetAtTime(120, t, 0.02);
      set(this.nodes.subGain, 0.06);
      set(this.nodes.sideGain, 0);   // no sidetone — the diagnostic
      set(this.nodes.noiseGain, 0);  // deaf: the antenna relay has thrown
      set(this.nodes.sigGain, 0);
      return;
    }
    // Restore the true 150 Hz sub-tone frequency after any buzz.
    this.nodes.sub.frequency.setTargetAtTime(SQUELCH_TONE_HZ, t, 0.02);

    set(this.nodes.subGain, 0);
    set(this.nodes.sideGain, 0);

    if (rx.state === 'silent') {           // squelch closed
      set(this.nodes.noiseGain, 0);
      set(this.nodes.sigGain, 0);
      return;
    }
    if (rx.state === 'rushing') {          // open squelch, nothing on the air
      set(this.nodes.noiseGain, 0.18);
      set(this.nodes.sigGain, 0);
      return;
    }

    // Receiving. Noise falls as the link margin improves — a strong signal
    // quiets the receiver completely, which is what FM does.
    const noise = rx.noise ?? 0;
    set(this.nodes.noiseGain, 0.18 * noise);
    set(this.nodes.sigGain, rx.state === 'garbled' ? 0.02 : 0.05 * (1 - noise * 0.5));

    // A garbled, contested channel sounds rough: drop the top end.
    this.nodes.sigLp.frequency.setTargetAtTime(
      rx.state === 'garbled' ? 900 : 2800, t, 0.05);
  }

  /**
   * The receive/transmit relay. [S2] 4.09(d)(4) — a short, dry click.
   * Generated as a filtered noise burst rather than a sample.
   */
  relayClick() {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.02);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0.35;
    src.connect(bp); bp.connect(g); g.connect(this.nodes.master);
    src.start(t);
  }

  /** Short burst of noise as the squelch gate closes. */
  squelchTail() {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.nodes.noiseGain.cancelScheduledValues(t);
    this.nodes.noiseGain.setValueAtTime(0.14, t);
    this.nodes.noiseGain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    this.nodes.noiseGain.setValueAtTime(0, t + 0.13);
  }

  async stop() {
    if (!this.started) return;
    if (this.micStream) {
      this.micStream.getTracks().forEach((tr) => tr.stop());
      this.micStream = null;
    }
    for (const k of ['noise', 'sub', 'side', 'sig']) {
      try { this.nodes[k].stop(); } catch { /* already stopped */ }
    }
    await this.ctx.close();
    this.ctx = null;
    this.started = false;
    this.nodes = {};
  }
}
