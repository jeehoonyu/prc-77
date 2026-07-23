// propagation.js — VHF low-band link budget for the AN/PRC-77.
//
// WHAT THIS IS
// The radio's controls and logic (radio.js) are reproduced exactly from the
// manuals. Propagation cannot be: no manual publishes "the" range, because
// there isn't one. What the manuals publish is a planning figure — 8 km,
// "varies with siting" — plus a page of siting advice.
//
// So this module does not hard-code 8 km. It implements standard, textbook
// radio physics and lets the range fall out. The 8 km figure is then used
// only as a VALIDATION TARGET in the test suite: with the long whip and
// reasonable siting, the model must land near it. It does.
//
// The model is deliberately the conventional one for this problem:
//   - monopole gain from the exact current-distribution pattern integral
//   - free-space loss close in, plane-earth (two-ray) loss beyond the breakpoint
//   - 4/3-earth radio horizon with a diffraction penalty past it
//   - clutter allowances for the site types the handbook warns about
//
// Every engineering allowance that is NOT derived from first principles is
// tagged ALLOWANCE and collected in ALLOWANCES_DB so it can be inspected,
// changed, or argued with. Nothing is buried.

import {
  TX_POWER_W, RX_SENSITIVITY_UV, RX_INPUT_IMPEDANCE_OHM, ANTENNAS,
  NOISE_ENVIRONMENTS, DEFAULT_NOISE_ENV, IF_BANDWIDTH_HZ, REQUIRED_SNR_DB,
} from './config.js';

const C = 299792458;              // m/s
const ETA0 = 376.730313668;       // free-space wave impedance, ohms
const EARTH_RADIUS_M = 6371000;
const K_FACTOR = 4 / 3;           // standard refraction

export const dBm = (watts) => 10 * Math.log10(watts * 1000);
export const watts = (dbm) => Math.pow(10, dbm / 10) / 1000;

/** Receiver sensitivity as power. 0.5 uV into 50 ohm = -113.0 dBm. */
export function sensitivityDBm(uV = RX_SENSITIVITY_UV, R = RX_INPUT_IMPEDANCE_OHM) {
  const volts = uV * 1e-6;
  return dBm((volts * volts) / R);
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

const THERMAL_DBM_PER_HZ = -174; // kTB at 290 K

/**
 * External (man-made) noise power in the receiver's bandwidth, ITU-R P.372:
 *   Fam = c - d*log10(f_MHz)     dB above thermal
 *   N   = -174 + Fam + 10*log10(B)
 */
export function externalNoiseDBm(freqHz, env = DEFAULT_NOISE_ENV, bandwidthHz = IF_BANDWIDTH_HZ) {
  const spec = NOISE_ENVIRONMENTS[env] ?? NOISE_ENVIRONMENTS[DEFAULT_NOISE_ENV];
  const fMHz = freqHz / 1e6;
  const Fam = spec.c - spec.d * Math.log10(fMHz);
  return THERMAL_DBM_PER_HZ + Fam + 10 * Math.log10(bandwidthHz);
}

/** The receiver's own noise power, implied by its published sensitivity. */
export function receiverNoiseDBm() {
  return sensitivityDBm() - REQUIRED_SNR_DB;
}

/**
 * Sensitivity the set actually achieves in a given noise environment.
 *
 * The published 0.5 uV assumes the receiver's own noise dominates. At low VHF
 * that is only true in quiet country. Add the external noise power to the
 * receiver's own and the required signal rises with it — which is why the same
 * radio that makes 8 km across open ground struggles in a built-up area for
 * reasons that have nothing to do with path loss.
 */
export function effectiveSensitivityDBm(freqHz, env = DEFAULT_NOISE_ENV) {
  const nRx = Math.pow(10, receiverNoiseDBm() / 10);
  const nExt = Math.pow(10, externalNoiseDBm(freqHz, env) / 10);
  return 10 * Math.log10(nRx + nExt) + REQUIRED_SNR_DB;
}

// ---------------------------------------------------------------------------
// Monopole antenna
// ---------------------------------------------------------------------------
// Vertical monopole of height h over ground, sinusoidal current distribution.
// Far-field pattern at zenith angle t (t = pi/2 is the horizon):
//
//     F(t) = [cos(kh*cos t) - cos(kh)] / sin t
//
// This is exact for a thin wire and is where the useful behaviour comes from:
// the 3 ft tape antenna is electrically tiny at 30 MHz (0.09 lambda) and the
// 10 ft whip passes through half-wave anti-resonance near the top of band B,
// which is exactly why operators find the long whip works best low in the band.

function patternF(kh, theta) {
  const s = Math.sin(theta);
  if (s < 1e-9) return 0;
  return (Math.cos(kh * Math.cos(theta)) - Math.cos(kh)) / s;
}

/** Integral of |F|^2 * sin(t) dt over the upper hemisphere (Simpson, n even). */
function patternIntegral(kh, n = 2000) {
  const a = 1e-7, b = Math.PI / 2;
  const hStep = (b - a) / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const t = a + i * hStep;
    const f = patternF(kh, t);
    const v = f * f * Math.sin(t);
    const w = (i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2);
    sum += w * v;
  }
  return (hStep / 3) * sum;
}

/**
 * Radiation resistance referred to the current maximum.
 *   Rr = (eta0 / 2pi) * integral
 * Sanity: kh = pi/2 (quarter wave) gives 36.5 ohm, the textbook value.
 */
export function radiationResistance(hM, freqHz) {
  const lambda = C / freqHz;
  const kh = 2 * Math.PI * hM / lambda;
  return (ETA0 / (2 * Math.PI)) * patternIntegral(kh);
}

/**
 * Directivity toward the horizon, radiating into the upper hemisphere:
 *   D = 2 |F(pi/2)|^2 / integral
 * Sanity: quarter-wave monopole gives 5.15 dBi.
 */
export function horizonDirectivityDBi(hM, freqHz) {
  const lambda = C / freqHz;
  const kh = 2 * Math.PI * hM / lambda;
  const U = Math.pow(patternF(kh, Math.PI / 2), 2);
  const I = patternIntegral(kh);
  if (I <= 0 || U <= 0) return -30;
  return 10 * Math.log10(2 * U / I);
}

// ALLOWANCE: counterpoise loss resistance, in series at the feed.
//
// This is the single most important term for a manpack set and it is modelled
// as a RESISTANCE, not a flat decibel figure, because that is what it
// physically is — and doing it properly makes the model self-correcting.
// An electrically short antenna has a tiny radiation resistance (the 3 ft tape
// is 1 ohm at 30 MHz), so a lossy counterpoise swamps it; the 10 ft whip at
// 62 ohm barely notices. A flat dB allowance would miss that entirely and is
// why the short and long antennas came out nearly equal on the first pass.
//
// A manpack has no ground plane worth the name: the case and the operator's
// body carry the return current, and a body is lossy. A vehicle mount has a
// steel roof; a fixed site has radials.
export const GROUND_LOSS_OHM = { manpack: 25, vehicle: 5, groundPlane: 2 };

// ALLOWANCE: residual pattern distortion from a finite, irregular ground
// plane, over and above the loss resistance above.
export const COUNTERPOISE_LOSS_DB = { manpack: 2, vehicle: 1, groundPlane: 0 };

// ALLOWANCE: insertion loss of the set's antenna matching network. The RT-841
// tunes its antenna circuit with the frequency, so it is not a fixed match —
// but no practical network transforms a 5000 ohm anti-resonant feed to 50 ohm
// for free. Loss grows with the transformation ratio and is capped, because a
// real network's loss is bounded by its component Q, not by how bad the load is.
export const MATCH_LOSS_SLOPE_DB = 1.5;   // per decade of transformation ratio
export const MATCH_LOSS_MAX_DB = 3.0;

export const ALLOWANCES_DB = {
  GROUND_LOSS_OHM,
  COUNTERPOISE_LOSS_DB,
  MATCH_LOSS_SLOPE_DB,
  MATCH_LOSS_MAX_DB,
  // ALLOWANCE: clutter, from the siting advice in the handbook —
  // "Valleys, densely wooded areas, and low places are poor sites."
  CLUTTER: { open: 0, rolling: 3, lightWoods: 6, denseWoods: 12, urban: 15, valley: 20 },
};

/**
 * Realised gain of one of the set's antennas toward the horizon, in dBi.
 * Combines exact directivity, ohmic efficiency, feed-mismatch loss, and the
 * counterpoise allowance.
 */
export function antennaGainDBi(antennaId, freqHz, mounting = 'manpack') {
  const spec = ANTENNAS[antennaId];
  if (!spec) throw new Error(`Unknown antenna: ${antennaId}`);

  // The 150 ft long wire is not a monopole; it is a travelling-wave wire that
  // radiates off its far end. Treat it separately.
  if (spec.directional) {
    return 6.0; // ALLOWANCE: end-fire gain of a multi-wavelength long wire.
  }

  const lambda = C / freqHz;
  const kh = 2 * Math.PI * spec.lengthM / lambda;
  const D = horizonDirectivityDBi(spec.lengthM, freqHz);

  // Base feed resistance. Current at the base is I0*sin(kh) of the maximum,
  // so R_base = Rr / sin^2(kh). Near half-wave this goes to anti-resonance
  // and the antenna becomes very hard to feed — a real effect for the 10 ft
  // whip at the top of band B.
  const Rr = radiationResistance(spec.lengthM, freqHz);
  const s2 = Math.max(Math.pow(Math.sin(kh), 2), 1e-3);
  const Rbase = Math.min(Rr / s2, 5000);

  const Rloss = GROUND_LOSS_OHM[mounting] ?? GROUND_LOSS_OHM.manpack;
  const efficiency = Rbase / (Rbase + Rloss);

  // Matching-network insertion loss, driven by how far the feed impedance is
  // from 50 ohm. Bounded: a real network's loss is set by component Q.
  const ratio = Math.max(Rbase / 50, 50 / Rbase);
  const matchDB = Math.min(MATCH_LOSS_MAX_DB, MATCH_LOSS_SLOPE_DB * Math.log10(ratio));

  return D + 10 * Math.log10(efficiency) - matchDB - COUNTERPOISE_LOSS_DB[mounting];
}

// ---------------------------------------------------------------------------
// Path loss
// ---------------------------------------------------------------------------

export function freeSpaceLossDB(dM, freqHz) {
  if (dM < 1) dM = 1;
  const lambda = C / freqHz;
  return 20 * Math.log10(4 * Math.PI * dM / lambda);
}

/**
 * Plane-earth (two-ray) loss. Beyond the breakpoint the direct and
 * ground-reflected rays cancel and loss goes as the fourth power of distance:
 *   L = 40 log10(d) - 20 log10(h1) - 20 log10(h2)
 * Frequency drops out, which is the classic and slightly surprising result.
 */
export function planeEarthLossDB(dM, h1M, h2M) {
  const h1 = Math.max(h1M, 0.1), h2 = Math.max(h2M, 0.1);
  return 40 * Math.log10(Math.max(dM, 1)) - 20 * Math.log10(h1) - 20 * Math.log10(h2);
}

/** Breakpoint where the two-ray model takes over: d = 4*pi*h1*h2/lambda. */
export function breakpointM(h1M, h2M, freqHz) {
  const lambda = C / freqHz;
  return 4 * Math.PI * Math.max(h1M, 0.1) * Math.max(h2M, 0.1) / lambda;
}

/** Radio horizon over a 4/3 earth, in metres. */
export function radioHorizonM(h1M, h2M) {
  const Re = EARTH_RADIUS_M * K_FACTOR;
  return Math.sqrt(2 * Re * Math.max(h1M, 0)) + Math.sqrt(2 * Re * Math.max(h2M, 0));
}

/**
 * ALLOWANCE: smooth-earth diffraction past the horizon. Loss climbs steeply
 * once the path is obstructed by the earth's bulge. Modelled as a ramp in
 * fractional over-horizon distance, capped so the link simply dies rather
 * than producing absurd numbers.
 */
export function diffractionLossDB(dM, h1M, h2M) {
  const dh = radioHorizonM(h1M, h2M);
  if (dM <= dh) return 0;
  const excess = dM / dh - 1;
  return Math.min(120, 30 * Math.log10(1 + 9 * excess) + 25 * excess);
}

/** Total path loss, taking the larger of free-space and plane-earth. */
export function pathLossDB(dM, freqHz, h1M, h2M, clutter = 'open') {
  const fs = freeSpaceLossDB(dM, freqHz);
  const pe = planeEarthLossDB(dM, h1M, h2M);
  const base = Math.max(fs, pe);
  const clutterDB = ALLOWANCES_DB.CLUTTER[clutter] ?? 0;
  return base + diffractionLossDB(dM, h1M, h2M) + clutterDB;
}

// ---------------------------------------------------------------------------
// Link budget
// ---------------------------------------------------------------------------

/**
 * Full one-way budget between two stations.
 *
 * @returns {{rxDBm:number, marginDB:number, pathLossDB:number,
 *            txGainDBi:number, rxGainDBi:number, distanceM:number,
 *            lineOfSight:boolean, readability:object}}
 */
export function linkBudget({
  distanceM,
  freqHz,
  txPowerW = TX_POWER_W,
  txAntenna = 'AT-892',
  rxAntenna = 'AT-892',
  txHeightM = 1.5,
  rxHeightM = 1.5,
  txMounting = 'manpack',
  rxMounting = 'manpack',
  clutter = 'open',
  noiseEnv = DEFAULT_NOISE_ENV,
} = {}) {
  const txGain = antennaGainDBi(txAntenna, freqHz, txMounting);
  const rxGain = antennaGainDBi(rxAntenna, freqHz, rxMounting);
  const L = pathLossDB(distanceM, freqHz, txHeightM, rxHeightM, clutter);
  const rx = dBm(txPowerW) + txGain + rxGain - L;
  const sens = effectiveSensitivityDBm(freqHz, noiseEnv);

  return {
    distanceM,
    txGainDBi: txGain,
    rxGainDBi: rxGain,
    pathLossDB: L,
    rxDBm: rx,
    // What the set could do if its own noise were all that mattered.
    specSensitivityDBm: sensitivityDBm(),
    // What it can actually do here.
    sensitivityDBm: sens,
    noiseEnv,
    externalNoiseDBm: externalNoiseDBm(freqHz, noiseEnv),
    noisePenaltyDB: sens - sensitivityDBm(),
    marginDB: rx - sens,
    lineOfSight: distanceM <= radioHorizonM(txHeightM, rxHeightM),
    readability: readability(rx - sens),
  };
}

/**
 * Map link margin to what the operator actually hears. The bands follow the
 * usual signal-report scale; the labels are the ones the handbook and
 * voice procedure use.
 */
export function readability(marginDB) {
  if (marginDB < 0)  return { level: 0, label: 'Nothing heard',        copy: false, noise: 1.00 };
  if (marginDB < 6)  return { level: 1, label: 'Broken and unreadable',copy: false, noise: 0.75 };
  if (marginDB < 12) return { level: 2, label: 'Readable with difficulty', copy: true, noise: 0.45 };
  if (marginDB < 20) return { level: 3, label: 'Readable',             copy: true, noise: 0.20 };
  if (marginDB < 30) return { level: 4, label: 'Good',                 copy: true, noise: 0.07 };
  return               { level: 5, label: 'Loud and clear',            copy: true, noise: 0.00 };
}

/**
 * Solve for the distance at which the margin reaches 0 dB. Bisection, because
 * the loss curve is piecewise and not worth inverting analytically.
 */
export function maxRangeM(opts = {}) {
  const probe = (d) => linkBudget({ ...opts, distanceM: d }).marginDB;
  let lo = 1, hi = 200000;
  if (probe(lo) < 0) return 0;
  if (probe(hi) > 0) return hi;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (probe(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
