// propagation.test.js — the physics, checked against closed-form textbook
// results first, then against the manuals' planning figures.
//
// The order matters. If the antenna and path-loss maths did not reproduce
// values that can be looked up in an antenna textbook, no amount of agreement
// with "8 km" would mean anything — it would just mean the fudge factors had
// been tuned until the answer came out. So the textbook checks come first and
// are tight; the field-figure checks come second and are loose, because the
// field figures are themselves loose ("varies with siting").

import {
  radiationResistance, horizonDirectivityDBi, antennaGainDBi,
  freeSpaceLossDB, planeEarthLossDB, radioHorizonM, breakpointM,
  sensitivityDBm, linkBudget, maxRangeM, readability, dBm,
  externalNoiseDBm, effectiveSensitivityDBm,
} from '../js/propagation.js';
import { PLANNING_RANGE_KM } from '../js/config.js';

let passed = 0, failed = 0;
function near(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) { passed++; console.log(`  ✓ ${name} (${actual.toFixed(3)})`); }
  else {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      expected: ${expected} +/- ${tol}`);
    console.log(`      actual:   ${actual}`);
  }
}
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`); }
}
function inRange(name, actual, lo, hi) {
  assert(name, actual >= lo && actual <= hi, `${actual.toFixed(2)}, expected ${lo}..${hi}`);
}

const C = 299792458;

console.log('\nPropagation model test suite');
console.log('============================\n');

// ---------------------------------------------------------------------------
console.log('1) Antenna theory against closed-form results');
{
  // Quarter-wave monopole over a perfect ground plane. Both of these are
  // standard textbook constants, not fitted parameters.
  const h = 1.0, f = C / (4 * h);
  near('quarter-wave monopole radiation resistance = 36.5 ohm',
    radiationResistance(h, f), 36.5, 0.15);
  near('quarter-wave monopole directivity = 5.15 dBi',
    horizonDirectivityDBi(h, f), 5.15, 0.05);

  // A short monopole tends to D = 3 (4.77 dBi) as its length goes to zero.
  const fShort = C / (100 * h); // h = lambda/100
  near('short monopole directivity -> 4.77 dBi',
    horizonDirectivityDBi(h, fShort), 4.77, 0.05);

  // Radiation resistance of a short monopole follows 40*pi^2*(h/lambda)^2.
  //
  // Careful: that textbook figure is referred to the BASE current, whereas
  // radiationResistance() is referred to the current MAXIMUM. On a short
  // antenna the base sits far down the sine, so the two differ by sin^2(kh).
  // That transformation is not a bookkeeping detail — it is what produces the
  // anti-resonance the 10 ft whip hits near half-wave, and antennaGainDBi()
  // depends on it. So check it explicitly.
  const hOverL = 0.01;
  const fTiny = C / (h / hOverL);
  const kh = 2 * Math.PI * hOverL;
  const rBase = radiationResistance(h, fTiny) / Math.sin(kh) ** 2;
  near('short monopole base Rr follows 40*pi^2*(h/lambda)^2',
    rBase, 40 * Math.PI ** 2 * hOverL ** 2, 0.0005);

  // Same identity at quarter wave, where base and maximum coincide.
  const fQ = C / (4 * h);
  const khQ = Math.PI / 2;
  near('at quarter wave the base and maximum references coincide',
    radiationResistance(h, fQ) / Math.sin(khQ) ** 2, radiationResistance(h, fQ), 1e-9);
}

// ---------------------------------------------------------------------------
console.log('\n2) Path loss against closed-form results');
{
  // FSPL(dB) = 32.45 + 20log10(f_MHz) + 20log10(d_km)
  const expected = 32.45 + 20 * Math.log10(50) + 20 * Math.log10(1);
  near('free-space loss, 1 km at 50 MHz', freeSpaceLossDB(1000, 50e6), expected, 0.02);
  near('free-space loss is 6 dB per distance doubling',
    freeSpaceLossDB(2000, 50e6) - freeSpaceLossDB(1000, 50e6), 6.02, 0.01);

  // Plane-earth loss goes as the fourth power of distance and is independent
  // of frequency — the classic and slightly counter-intuitive result.
  near('plane-earth loss is 12 dB per distance doubling',
    planeEarthLossDB(2000, 1.5, 1.5) - planeEarthLossDB(1000, 1.5, 1.5), 12.04, 0.01);
  near('plane-earth loss falls 6 dB per doubling of either antenna height',
    planeEarthLossDB(1000, 1.5, 1.5) - planeEarthLossDB(1000, 3.0, 1.5), 6.02, 0.01);

  // Radio horizon over a 4/3 earth: d_km = 4.12*(sqrt(h1)+sqrt(h2)), h in m.
  const expectedHorizonKm = 4.12 * (Math.sqrt(30) + Math.sqrt(1.5));
  near('radio horizon matches the 4.12 rule',
    radioHorizonM(30, 1.5) / 1000, expectedHorizonKm, 0.05);

  // Two-ray breakpoint: 4*pi*h1*h2/lambda.
  near('two-ray breakpoint', breakpointM(1.5, 1.5, 50e6),
    4 * Math.PI * 1.5 * 1.5 / (C / 50e6), 0.01);
}

// ---------------------------------------------------------------------------
console.log('\n3) Receiver sensitivity [S3]');
{
  // 0.5 uV into 50 ohm.
  near('0.5 uV into 50 ohm = -113 dBm', sensitivityDBm(), -113.01, 0.02);
  near('2 W transmitter = +33 dBm', dBm(2.0), 33.01, 0.02);
}

// ---------------------------------------------------------------------------
console.log('\n4) The two issued antennas [S1]');
{
  // [S1] the AT-271A is "used when maximum range is required" and the AT-892
  // is for "general short range service". The model must agree, and it must
  // do so because of the physics, not because it was told to.
  for (const mhz of [30, 40, 50, 60, 70]) {
    const hz = mhz * 1e6;
    const short = antennaGainDBi('AT-892', hz);
    const long = antennaGainDBi('AT-271A', hz);
    assert(`10 ft whip beats 3 ft tape at ${mhz} MHz`, long > short,
      `${long.toFixed(1)} vs ${short.toFixed(1)} dBi`);
  }

  // A documented PREDICTION of the model, not something taken from a manual:
  // at the very top of band B the 10 ft whip is 0.77 wavelengths, its pattern
  // lifts off the horizon, and it loses its advantage. Fixed-length whips do
  // this; it is why the long whip works best low in the band.
  const topShort = antennaGainDBi('AT-892', 75.95e6);
  const topLong = antennaGainDBi('AT-271A', 75.95e6);
  assert('at 75.95 MHz the 10 ft whip pattern lifts and it loses its edge',
    topLong < topShort, `${topLong.toFixed(1)} vs ${topShort.toFixed(1)} dBi`);

  // The 3 ft tape is electrically tiny at the bottom of band A and it shows.
  assert('3 ft tape is much worse at 30 MHz than at 76 MHz',
    antennaGainDBi('AT-892', 75.95e6) - antennaGainDBi('AT-892', 30e6) > 5);
}

// ---------------------------------------------------------------------------
console.log('\n5) Range against the published planning figure');
{
  // [S1] "Distance range: 5 miles (8 kilometers) (varies with conditions)."
  // [S2] "Distance range: 8 km. Varies with siting."
  //
  // 8 km is NOT an input to the model. This checks that the physics lands on
  // it for the configuration the figure describes: manpack to manpack, the
  // long whip, open ground.
  const r = maxRangeM({
    freqHz: 50e6, txAntenna: 'AT-271A', rxAntenna: 'AT-271A',
    txHeightM: 1.5, rxHeightM: 1.5, clutter: 'open',
  }) / 1000;
  inRange(`long whip, manpack, open ground reaches the ${PLANNING_RANGE_KM} km planning figure`,
    r, 5, 12);

  // The short antenna is for "general short range service" — roughly half.
  const rShort = maxRangeM({
    freqHz: 50e6, txAntenna: 'AT-892', rxAntenna: 'AT-892',
    txHeightM: 1.5, rxHeightM: 1.5, clutter: 'open',
  }) / 1000;
  assert('3 ft tape gives materially less range', rShort < r * 0.75,
    `${rShort.toFixed(1)} km vs ${r.toFixed(1)} km`);
  inRange('and still a useful short-range distance', rShort, 1.5, 6);
}

// ---------------------------------------------------------------------------
console.log('\n6) Siting advice [S2] 2.02-2.03 comes out of the model');
{
  const base = { freqHz: 50e6, txAntenna: 'AT-271A', rxAntenna: 'AT-271A' };
  const open = maxRangeM({ ...base, clutter: 'open' });

  // "Valleys, densely wooded areas, and low places are poor sites."
  const order = ['open', 'rolling', 'lightWoods', 'denseWoods', 'urban', 'valley'];
  let previous = Infinity;
  let monotonic = true;
  for (const c of order) {
    const rng = maxRangeM({ ...base, clutter: c });
    if (rng > previous) monotonic = false;
    previous = rng;
  }
  assert('range degrades monotonically through worse siting', monotonic);

  // "Location on a hilltop or a tower will increase the operating distance."
  const hill = maxRangeM({ ...base, txHeightM: 30 });
  assert('a 30 m hilltop greatly increases range', hill > open * 2,
    `${(hill / 1000).toFixed(1)} km vs ${(open / 1000).toFixed(1)} km`);

  // And that gain is horizon-limited, not unlimited.
  const horizon = radioHorizonM(30, 1.5);
  assert('hilltop range is bounded by the radio horizon', hill < horizon * 1.15,
    `${(hill / 1000).toFixed(1)} km vs horizon ${(horizon / 1000).toFixed(1)} km`);
}

// ---------------------------------------------------------------------------
console.log('\n7) External noise, ITU-R P.372');
{
  // Fam = c - d*log10(f_MHz); N = -174 + Fam + 10log10(B)
  const expectedRural = -174 + (67.2 - 27.7 * Math.log10(50)) + 10 * Math.log10(25000);
  near('rural man-made noise floor at 50 MHz',
    externalNoiseDBm(50e6, 'rural'), expectedRural, 0.02);

  // Noise falls with frequency across the band — the whole reason low VHF is
  // noisier than high VHF.
  assert('noise falls as frequency rises',
    externalNoiseDBm(75e6, 'rural') < externalNoiseDBm(30e6, 'rural'));

  // Ordering of environments.
  const envs = ['quietRural', 'rural', 'residential', 'urban'];
  let rising = true;
  for (let i = 1; i < envs.length; i++) {
    if (externalNoiseDBm(50e6, envs[i]) <= externalNoiseDBm(50e6, envs[i - 1])) rising = false;
  }
  assert('noisier environments have higher noise floors', rising);

  // In quiet country the receiver's own noise still dominates, so the set
  // performs close to its published specification. This is what keeps the
  // 8 km validation below honest.
  const quietPenalty = effectiveSensitivityDBm(50e6, 'quietRural') - sensitivityDBm();
  assert('quiet rural costs only a couple of dB', quietPenalty < 4,
    `${quietPenalty.toFixed(1)} dB`);

  // In town the environment sets the sensitivity, not the radio.
  const urbanPenalty = effectiveSensitivityDBm(50e6, 'urban') - sensitivityDBm();
  assert('urban noise dominates the receiver outright', urbanPenalty > 15,
    `${urbanPenalty.toFixed(1)} dB`);

  // Which means range collapses for reasons that are not path loss.
  const quiet = maxRangeM({ freqHz: 50e6, txAntenna: 'AT-271A', rxAntenna: 'AT-271A', noiseEnv: 'quietRural' });
  const town = maxRangeM({ freqHz: 50e6, txAntenna: 'AT-271A', rxAntenna: 'AT-271A', noiseEnv: 'urban' });
  assert('a noisy site cuts range sharply on its own', town < quiet * 0.5,
    `${(town / 1000).toFixed(1)} km vs ${(quiet / 1000).toFixed(1)} km, same terrain`);
}

// ---------------------------------------------------------------------------
console.log('\n8) Link budget and readability');
{
  const close = linkBudget({ distanceM: 100, freqHz: 50e6, txAntenna: 'AT-271A', rxAntenna: 'AT-271A' });
  assert('a 100 m link is loud and clear', close.readability.level === 5, close.readability.label);
  assert('and well inside line of sight', close.lineOfSight);

  const far = linkBudget({ distanceM: 60000, freqHz: 50e6 });
  assert('a 60 km manpack link is nothing heard', far.readability.level === 0, far.readability.label);
  assert('and beyond the radio horizon', !far.lineOfSight);

  // Readability boundaries.
  assert('negative margin is no copy', !readability(-1).copy);
  assert('20 dB margin copies', readability(20).copy);
  assert('30 dB margin is full quieting', readability(30).noise === 0);

  // Margin must fall as distance grows.
  let last = Infinity, mono = true;
  for (const d of [100, 500, 1000, 2000, 4000, 8000, 16000]) {
    const m = linkBudget({ distanceM: d, freqHz: 50e6 }).marginDB;
    if (m > last) mono = false;
    last = m;
  }
  assert('margin decreases monotonically with distance', mono);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
