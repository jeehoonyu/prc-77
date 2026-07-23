// radio.js — Receiver-Transmitter, Radio RT-841/PRC-77.
//
// A faithful state machine for the set itself: the band switch, the two
// tuning controls and their detents, the mechanical PRESET levers, the
// FUNCTION switch, VOLUME, the battery, and push-to-talk.
//
// No DOM, no dependencies, so it runs in the browser and under Node for the
// test suite. Everything that determines whether this thing is "correct"
// lives here and in propagation.js.
//
// Frequencies are held as integer kilohertz throughout. The set tunes in
// 50 kHz steps, so integer kHz is exact and avoids the floating-point dust
// that decimal megahertz would leave behind (30.05 + 0.05 !== 30.1).

import {
  BANDS, MHZ_DETENTS_PER_BAND, KHZ_DETENTS, KHZ_STEP_KHZ, TOTAL_CHANNELS,
  FUNCTION_POSITIONS, VOLUME_MIN, VOLUME_MAX, VOLUME_DEFAULT,
  BATTERY_CAPACITY_AH, CURRENT_TX_A, CURRENT_RX_A, BATTERY_NOMINAL_V,
  BATTERY_MIN_V, WARMUP_S, ANTENNAS, RETRANS_MIN_SEPARATION_MHZ,
} from './config.js';

const FUNCTION_IDS = FUNCTION_POSITIONS.map((p) => p.id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Frequency helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a (band, mhzIndex, khzIndex) detent triple to integer kilohertz.
 *
 * mhzIndex is the ROTATIONAL POSITION of the MHz control, 0..22, not the
 * megahertz value. The control has 23 positions and the BAND switch decides
 * which 23 megahertz they land on. This is not a modelling convenience — it
 * is how the set is built, and it is the reason for the cross-band preset
 * rule in setPreset() below.
 */
export function detentsToKHz(band, mhzIndex, khzIndex) {
  const spec = BANDS[band];
  if (!spec) throw new Error(`Unknown band: ${band}`);
  if (!Number.isInteger(mhzIndex) || mhzIndex < 0 || mhzIndex >= MHZ_DETENTS_PER_BAND) {
    throw new Error(`MHz detent out of range: ${mhzIndex}`);
  }
  if (!Number.isInteger(khzIndex) || khzIndex < 0 || khzIndex >= KHZ_DETENTS) {
    throw new Error(`kHz detent out of range: ${khzIndex}`);
  }
  return (spec.mhzLow + mhzIndex) * 1000 + khzIndex * KHZ_STEP_KHZ;
}

/** Inverse of detentsToKHz. Returns null if the frequency is not tunable. */
export function khzToDetents(freqKHz) {
  if (!Number.isInteger(freqKHz)) return null;
  if (freqKHz % KHZ_STEP_KHZ !== 0) return null; // not on a 50 kHz boundary
  for (const band of Object.keys(BANDS)) {
    const { mhzLow, mhzHigh } = BANDS[band];
    const mhz = Math.floor(freqKHz / 1000);
    if (mhz < mhzLow || mhz > mhzHigh) continue;
    return {
      band,
      mhzIndex: mhz - mhzLow,
      khzIndex: (freqKHz % 1000) / KHZ_STEP_KHZ,
    };
  }
  return null;
}

/** 0-based channel number across all 920, band A first. */
export function channelNumber(band, mhzIndex, khzIndex) {
  const base = band === 'A' ? 0 : MHZ_DETENTS_PER_BAND * KHZ_DETENTS;
  return base + mhzIndex * KHZ_DETENTS + khzIndex;
}

/** Every tunable frequency, in order. Length must be TOTAL_CHANNELS. */
export function enumerateChannels() {
  const out = [];
  for (const band of ['A', 'B']) {
    for (let m = 0; m < MHZ_DETENTS_PER_BAND; m++) {
      for (let k = 0; k < KHZ_DETENTS; k++) {
        out.push({ band, mhzIndex: m, khzIndex: k, freqKHz: detentsToKHz(band, m, k) });
      }
    }
  }
  return out;
}

/** "53.45" — the two dial windows joined the way an operator reads them. */
export function formatFrequency(freqKHz) {
  const mhz = Math.floor(freqKHz / 1000);
  const khz = freqKHz % 1000;
  return `${mhz}.${String(khz / 10).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// RT-841
// ---------------------------------------------------------------------------

export class RT841 {
  constructor(opts = {}) {
    this.callsign = opts.callsign || 'UNKNOWN';

    // --- Controls -----------------------------------------------------------
    this.band = opts.band || 'A';
    this.mhzIndex = opts.mhzIndex ?? 0;   // rotational position 0..22
    this.khzIndex = opts.khzIndex ?? 0;   // rotational position 0..19
    this.func = 'OFF';
    this.volume = VOLUME_DEFAULT;

    // PRESET levers. Each tuning control carries two coaxial sections, each
    // with a stop. With the lever forward, turning the control fully
    // counter-clockwise lands on the LOW preset and fully clockwise on the
    // HIGH preset. [S2] paras 3.04-3.05
    this.presetLever = false;
    this.presets = {
      low:  { band: 'A', mhzIndex: 0, khzIndex: 0, set: false },
      high: { band: 'A', mhzIndex: 0, khzIndex: 0, set: false },
    };

    // --- Physical fit-out ---------------------------------------------------
    this.antenna = opts.antenna || 'AT-892';
    this.antennaConnected = opts.antennaConnected ?? true;
    this.handsetConnected = opts.handsetConnected ?? true;

    // --- Battery ------------------------------------------------------------
    this.batteryCapacityAh = opts.batteryCapacityAh ?? BATTERY_CAPACITY_AH;
    this.batteryRemainingAh = opts.batteryRemainingAh ?? this.batteryCapacityAh;

    // --- Dynamic state ------------------------------------------------------
    // pttHeld = the operator is pressing the switch, which throws the antenna
    // changeover relay whatever the battery is doing.
    // ptt     = the set is actually radiating.
    // They differ on a flat battery, and that difference IS the symptom
    // [S2] 4.09 describes.
    this.pttHeld = false;
    this.ptt = false;
    this.secondsOn = 0;      // since the FUNCTION switch left OFF
    this.lite = false;       // dial lamp, momentary
    this.retransPartner = null; // another RT841, wired via MK-456/GRC

    // Siting. Feeds the propagation model; not a control on the set.
    this.antennaHeightM = opts.antennaHeightM ?? 1.5; // manpack, on the back
    this.position = opts.position ?? { x: 0, y: 0 };  // metres
    this.terrain = opts.terrain ?? 'open';
    // Man-made noise at THIS set's location. Separate from terrain on purpose:
    // a valley can be electrically quiet and an open field beside a power line
    // can be very noisy. [S2] 2.03 treats them as separate siting concerns.
    this.noiseEnv = opts.noiseEnv ?? 'quietRural';
  }

  // -- Derived state --------------------------------------------------------

  // Measured under the receive load, so this does not depend on whether the
  // set happens to be keyed — that would be circular, since keying is only
  // possible when powered.
  get powered() {
    return this.func !== 'OFF' && this.voltageUnderLoad(CURRENT_RX_A) >= BATTERY_MIN_V;
  }

  /** True once the set has had the 30 s the handbook asks for. [S2] 4.09 */
  get warmedUp() { return this.secondsOn >= WARMUP_S; }

  get freqKHz() { return detentsToKHz(this.band, this.mhzIndex, this.khzIndex); }
  get freqMHz() { return this.freqKHz / 1000; }
  get channel() { return channelNumber(this.band, this.mhzIndex, this.khzIndex); }
  get displayFrequency() { return formatFrequency(this.freqKHz); }

  get batteryFraction() {
    return clamp(this.batteryRemainingAh / this.batteryCapacityAh, 0, 1);
  }

  /**
   * Open-circuit terminal voltage. A magnesium primary (10 D cells, 15 V
   * nominal [S2] 1.06) holds a fairly flat plateau then collapses at the end.
   */
  get openCircuitVoltage() {
    const frac = this.batteryFraction;
    if (frac <= 0) return 0;
    const plateau = BATTERY_NOMINAL_V - 1.2 * (1 - frac);
    const collapse = 14 * Math.max(0, 0.01 - frac) / 0.01; // final cliff
    return Math.max(0, plateau - collapse);
  }

  /**
   * Internal resistance, which climbs as the cells deplete. This is the whole
   * mechanism behind [S2] 4.09's warning that a tired battery "will provide
   * enough power for the radio to receive but not transmit": transmit draws
   * 780 mA against receive's 60 mA, so as the internal resistance rises the
   * transmit load drags the terminal voltage under the 12.5 V floor [S1] while
   * the receive load is still comfortably above it.
   *
   * The curve is shaped so that a simulated 9:1 mission stays transmit-capable
   * for very nearly the published 30 hours and only then falls into the
   * receive-only window. An earlier, steeper curve killed transmit at 21 h with
   * 28% of the battery unused, which contradicted the published life — the
   * formula said 30 h while the simulation said 21 h. Those must agree.
   */
  get internalResistance() {
    const spent = 1 - this.batteryFraction;
    return 0.5
      + 1.5 * Math.pow(spent, 6)                                  // gradual rise
      + 8 * Math.max(0, 0.03 - this.batteryFraction) / 0.03;      // end-of-life knee
  }

  voltageUnderLoad(amps) {
    return Math.max(0, this.openCircuitVoltage - amps * this.internalResistance);
  }

  /**
   * Terminal voltage right now, under whatever load the set is drawing.
   * Keyed means the PA is drawing whether or not it can make full output, so
   * the load follows pttHeld rather than whether transmission is succeeding.
   */
  get batteryVoltage() {
    const load = (this.pttHeld && this.func !== 'OFF') ? CURRENT_TX_A : CURRENT_RX_A;
    return this.voltageUnderLoad(load);
  }

  /**
   * Enough left to key up? Asks what the voltage WOULD be under the transmit
   * load, not what it is while receiving — that distinction is the bug this
   * models around and the reason the symptom exists at all.
   */
  get canTransmit() {
    return this.powered
      && this.antennaConnected
      && this.voltageUnderLoad(CURRENT_TX_A) >= BATTERY_MIN_V;
  }

  get antennaSpec() { return ANTENNAS[this.antenna]; }

  // -- Controls -------------------------------------------------------------

  /**
   * FUNCTION switch. Turning it away from OFF starts the warm-up clock.
   * LITE is momentary: it lights the dial window and otherwise behaves as ON.
   */
  setFunction(id) {
    if (!FUNCTION_IDS.includes(id)) throw new Error(`Unknown FUNCTION position: ${id}`);
    const wasOff = this.func === 'OFF';
    this.func = id;
    if (id === 'OFF') { this.secondsOn = 0; this.ptt = false; this.pttHeld = false; }
    else if (wasOff) this.secondsOn = 0;
    this.lite = id === 'LITE';
    return this;
  }

  setVolume(v) { this.volume = clamp(Math.round(v), VOLUME_MIN, VOLUME_MAX); return this; }

  /**
   * BAND switch. The tuning controls do not move: their rotational positions
   * are preserved and simply map onto the other band's 23 megahertz.
   */
  setBand(band) {
    if (!BANDS[band]) throw new Error(`Unknown band: ${band}`);
    this.band = band;
    return this;
  }

  /**
   * Turn the MHz control. With the PRESET lever forward the stops limit
   * travel to the range between the two preset positions.
   */
  tuneMHz(delta) {
    const [lo, hi] = this.mhzTravelLimits();
    this.mhzIndex = clamp(this.mhzIndex + delta, lo, hi);
    return this;
  }

  tuneKHz(delta) {
    const [lo, hi] = this.khzTravelLimits();
    this.khzIndex = clamp(this.khzIndex + delta, lo, hi);
    return this;
  }

  mhzTravelLimits() {
    if (!this.presetLever || !this.presets.low.set || !this.presets.high.set) {
      return [0, MHZ_DETENTS_PER_BAND - 1];
    }
    return [this.presets.low.mhzIndex, this.presets.high.mhzIndex];
  }

  khzTravelLimits() {
    if (!this.presetLever || !this.presets.low.set || !this.presets.high.set) {
      return [0, KHZ_DETENTS - 1];
    }
    return [this.presets.low.khzIndex, this.presets.high.khzIndex];
  }

  /** Swing the PRESET levers forward (engaged) or back (free running). */
  setPresetLever(engaged) {
    this.presetLever = !!engaged;
    if (engaged) {
      // The stops physically capture the controls the moment the lever goes
      // forward, so a control sitting outside the preset span is dragged in.
      const [ml, mh] = this.mhzTravelLimits();
      const [kl, kh] = this.khzTravelLimits();
      this.mhzIndex = clamp(this.mhzIndex, ml, mh);
      this.khzIndex = clamp(this.khzIndex, kl, kh);
    }
    return this;
  }

  /**
   * Store two preset channels.
   *
   * The interesting part is which one gets the counter-clockwise stop. The
   * stops are rotational positions on the tuning controls, and the controls
   * do not know what the BAND switch is doing. So the ordering is by
   * POSITION WITHIN THE BAND, not by frequency:
   *
   *   [S2] 3.04(b)(3) "always set the lower section to that MHz frequency
   *   that is lower in its band ... 54 is [2nd position in band B]; thus,
   *   54 MHz would be set on the lower section and 33 MHz would be set on
   *   the upper section"
   *
   * 54 MHz is the 2nd detent of band B; 33 MHz is the 4th detent of band A.
   * 2 < 4, so 54 takes the counter-clockwise stop even though it is the
   * higher frequency of the two. This method enforces that automatically.
   */
  setPresets(first, second) {
    const a = this.#normalisePreset(first);
    const b = this.#normalisePreset(second);

    // Order each control independently — they ARE separate mechanisms. The
    // MHz control's two stops know nothing about the kHz control's two stops.
    const mhzLow  = Math.min(a.mhzIndex, b.mhzIndex);
    const mhzHigh = Math.max(a.mhzIndex, b.mhzIndex);
    const khzLow  = Math.min(a.khzIndex, b.khzIndex);
    const khzHigh = Math.max(a.khzIndex, b.khzIndex);

    // Selecting a preset means turning BOTH controls hard against the SAME
    // side. So the only two frequencies the mechanism can actually produce
    // are (mhzLow, khzLow) and (mhzHigh, khzHigh).
    //
    // That is a genuine limitation of the hardware, not of this model: if one
    // frequency is lower on the MHz control but higher on the kHz control
    // than the other, the pair simply cannot be preset. Turning both controls
    // counter-clockwise would land on a third frequency that is neither of
    // them. The handbook's own worked examples happen to be compatible pairs
    // and it never mentions the case, so the model reports it rather than
    // silently storing something the set could not hold.
    const aIsMhzLow = a.mhzIndex <= b.mhzIndex;
    const aIsKhzLow = a.khzIndex <= b.khzIndex;
    const representable =
      (a.mhzIndex === b.mhzIndex) || (a.khzIndex === b.khzIndex) ||
      (aIsMhzLow === aIsKhzLow);

    const lowSource  = aIsMhzLow ? a : b;
    const highSource = aIsMhzLow ? b : a;

    this.presets.low  = { band: lowSource.band,  mhzIndex: mhzLow,  khzIndex: khzLow,  set: true };
    this.presets.high = { band: highSource.band, mhzIndex: mhzHigh, khzIndex: khzHigh, set: true };

    return {
      ok: representable,
      representable,
      low: { ...this.presets.low, freqKHz: detentsToKHz(this.presets.low.band, mhzLow, khzLow) },
      high: { ...this.presets.high, freqKHz: detentsToKHz(this.presets.high.band, mhzHigh, khzHigh) },
      warning: representable ? null
        : 'These two frequencies cannot both be preset: one is lower on the MHz '
          + 'control but higher on the kHz control. The stops would produce two '
          + 'different frequencies. Choose another pair.',
    };
  }

  #normalisePreset(p) {
    if (typeof p === 'number') {
      const d = khzToDetents(p);
      if (!d) throw new Error(`Not a tunable frequency: ${p} kHz`);
      return d;
    }
    if (p && p.freqKHz != null) {
      const d = khzToDetents(p.freqKHz);
      if (!d) throw new Error(`Not a tunable frequency: ${p.freqKHz} kHz`);
      return d;
    }
    if (p && p.band && p.mhzIndex != null && p.khzIndex != null) return { ...p };
    throw new Error('Preset must be a frequency in kHz or a detent triple');
  }

  /**
   * Select a preset by turning both controls hard against one set of stops.
   * [S2] 3.05: the operator must still set the BAND switch by hand if the
   * preset lives in the other band — the stops cannot do that for them.
   */
  selectPreset(which) {
    if (!this.presetLever) return { ok: false, reason: 'PRESET levers are back' };
    const p = this.presets[which];
    if (!p || !p.set) return { ok: false, reason: `No ${which} preset stored` };
    this.mhzIndex = p.mhzIndex;
    this.khzIndex = p.khzIndex;
    const bandWrong = this.band !== p.band;
    return {
      ok: true,
      bandWrong,
      // The dial now reads a frequency, but if the BAND switch is on the
      // other band it is the WRONG frequency, exactly as 3.05(e) describes.
      reason: bandWrong ? `Set BAND switch to ${BANDS[p.band].label}` : null,
    };
  }

  // -- Operation ------------------------------------------------------------

  /**
   * Push-to-talk.
   *
   * Pressing the switch throws the antenna changeover relay mechanically, so
   * the receiver goes deaf whether or not the transmitter can actually produce
   * output. On a tired battery that is exactly what the operator meets:
   * [S2] 4.09 "It may also give a buzzing sound when the PTT is pressed" and
   * "You should hear yourself in the earpiece when you speak. If not, the
   * battery has insufficient power left."  Deaf, buzzing, and no sidetone.
   */
  key(down) {
    this.pttHeld = !!down && this.powered;
    this.ptt = this.pttHeld && this.canTransmit;
    return this;
  }

  /**
   * Advance the clock. Drains the battery at the documented currents and
   * runs the warm-up timer.
   */
  tick(seconds) {
    if (this.func === 'OFF') return this;
    // Keyed draws the transmit current whether or not full output results.
    const amps = this.pttHeld ? CURRENT_TX_A : CURRENT_RX_A;
    this.batteryRemainingAh = Math.max(0, this.batteryRemainingAh - amps * (seconds / 3600));
    this.secondsOn += seconds;
    return this;
  }

  /**
   * Predicted battery life in hours at a given receive:transmit duty ratio.
   * At the published 9:1 this reproduces the 30 h on the data sheet.
   */
  batteryLifeHours(rxToTxRatio = 9) {
    const txFraction = 1 / (rxToTxRatio + 1);
    const mean = (1 - txFraction) * CURRENT_RX_A + txFraction * CURRENT_TX_A;
    return this.batteryRemainingAh / mean;
  }

  // -- Retransmission -------------------------------------------------------

  /**
   * Wire two sets back to back with the MK-456/GRC cable.
   * [S2] 5.09: the two frequencies must be at least 3 MHz apart.
   */
  linkRetrans(other) {
    const sep = Math.abs(this.freqMHz - other.freqMHz);
    this.retransPartner = other;
    other.retransPartner = this;
    return {
      ok: sep >= RETRANS_MIN_SEPARATION_MHZ,
      separationMHz: sep,
      reason: sep >= RETRANS_MIN_SEPARATION_MHZ
        ? null
        : `Frequencies must be at least ${RETRANS_MIN_SEPARATION_MHZ} MHz apart (currently ${sep.toFixed(2)})`,
    };
  }

  unlinkRetrans() {
    if (this.retransPartner) this.retransPartner.retransPartner = null;
    this.retransPartner = null;
    return this;
  }

  get retransActive() {
    return this.func === 'RETRANS' && this.retransPartner?.func === 'RETRANS';
  }

  // -- Diagnostics ----------------------------------------------------------

  /** The operational checklist from [S2] 4.08-4.09, as machine-checkable faults. */
  faults() {
    const f = [];
    if (!this.antennaConnected) f.push('No antenna connected — always have an antenna connected');
    if (!this.handsetConnected) f.push('Handset H-189/GR not connected');
    if (this.func === 'OFF') f.push('FUNCTION switch at OFF');
    else if (this.batteryVoltage < BATTERY_MIN_V) f.push('Battery too weak to operate the radio');
    else if (!this.canTransmit) f.push('Battery will receive but not transmit — replace the battery');
    if (this.powered && !this.warmedUp) {
      f.push(`Warming up — allow ${WARMUP_S} s for the battery to develop full operating voltage`);
    }
    if (this.volume >= VOLUME_MAX) f.push('Full volume can cause feedback and squealing');
    return f;
  }

  snapshot() {
    return {
      callsign: this.callsign,
      band: this.band,
      bandLabel: BANDS[this.band].label,
      freqKHz: this.freqKHz,
      freqMHz: this.freqMHz,
      display: this.displayFrequency,
      channel: this.channel,
      func: this.func,
      volume: this.volume,
      ptt: this.ptt,
      powered: this.powered,
      warmedUp: this.warmedUp,
      antenna: this.antenna,
      batteryV: Number(this.batteryVoltage.toFixed(2)),
      batteryPct: Math.round(100 * this.batteryRemainingAh / this.batteryCapacityAh),
    };
  }
}
