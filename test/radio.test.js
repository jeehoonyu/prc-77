// radio.test.js — the RT-841 against the figures printed in the manuals.
// Run with:  node test/radio.test.js   (or: npm test)
//
// No test framework: a tiny assert harness keeps the project dependency-free.

import {
  RT841, detentsToKHz, khzToDetents, enumerateChannels, channelNumber,
  formatFrequency,
} from '../js/radio.js';
import {
  TOTAL_CHANNELS, PUBLISHED_BATTERY_LIFE_H, PUBLISHED_DUTY_RX_TX,
  MHZ_DETENTS_PER_BAND, KHZ_DETENTS,
} from '../js/config.js';

let passed = 0, failed = 0;
function check(name, actual, expected) {
  if (Object.is(actual, expected)) { passed++; console.log(`  ✓ ${name}`); }
  else {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      expected: ${expected}`);
    console.log(`      actual:   ${actual}`);
  }
}
function assert(name, cond) { check(name, !!cond, true); }
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

console.log('\nRT-841/PRC-77 test suite');
console.log('========================\n');

// ---------------------------------------------------------------------------
console.log('1) Frequency plan — 920 channels in two bands [S1], 23x20 detents [S2]');
{
  const all = enumerateChannels();
  check('total channel count', all.length, TOTAL_CHANNELS);
  check('detent grid multiplies out', MHZ_DETENTS_PER_BAND * KHZ_DETENTS * 2, TOTAL_CHANNELS);

  const freqs = all.map((c) => c.freqKHz);
  check('all channels distinct', new Set(freqs).size, TOTAL_CHANNELS);

  check('band A starts at 30.00 MHz', freqs[0], 30000);
  check('band A ends at 52.95 MHz', freqs[459], 52950);
  check('band B starts at 53.00 MHz', freqs[460], 53000);
  check('band B ends at 75.95 MHz', freqs[919], 75950);

  const everyStepIs50 = all.every((c, i) => i === 0 || i === 460 || c.freqKHz - freqs[i - 1] === 50);
  assert('every step is exactly 50 kHz', everyStepIs50);

  // No gap at the band seam: 52.95 -> 53.00 is also 50 kHz.
  check('bands are contiguous across the seam', freqs[460] - freqs[459], 50);
}

// ---------------------------------------------------------------------------
console.log('\n2) Tuning controls');
{
  check('A/0/0 -> 30.00 MHz', detentsToKHz('A', 0, 0), 30000);
  check('B/22/19 -> 75.95 MHz', detentsToKHz('B', 22, 19), 75950);
  check('A/9/14 -> 39.70 MHz', detentsToKHz('A', 9, 14), 39700); // handbook example
  check('B/6/7 -> 59.35 MHz', detentsToKHz('B', 6, 7), 59350);   // handbook example

  const d = khzToDetents(59350);
  check('round trip band', d.band, 'B');
  check('round trip mhzIndex', d.mhzIndex, 6);
  check('round trip khzIndex', d.khzIndex, 7);

  check('off-grid frequency rejected', khzToDetents(59360), null);
  check('out-of-band frequency rejected', khzToDetents(29950), null);
  check('gap above band B rejected', khzToDetents(76000), null);

  check('dial reads 39.70', formatFrequency(39700), '39.70');
  check('dial reads 53.00', formatFrequency(53000), '53.00');
  check('dial reads 30.05', formatFrequency(30050), '30.05');

  check('channel numbering starts at 0', channelNumber('A', 0, 0), 0);
  check('channel numbering ends at 919', channelNumber('B', 22, 19), 919);
}

// ---------------------------------------------------------------------------
console.log('\n3) Band switch does not move the tuning controls');
{
  const r = new RT841({ band: 'A', mhzIndex: 4, khzIndex: 6 });
  check('band A reading', r.displayFrequency, '34.30');
  r.setBand('B');
  // Same rotational positions, other band: 53 + 4 = 57.
  check('band B reading, controls untouched', r.displayFrequency, '57.30');
  check('mhz detent unchanged', r.mhzIndex, 4);
}

// ---------------------------------------------------------------------------
console.log('\n4) PRESET levers — the cross-band rule from [S2] 3.04(b)(3)');
{
  // The handbook's own worked example: "54 is lower (second position) in [its]
  // band; thus, 54 MHz would be set on the lower section and 33 MHz would be
  // set on the upper section." 54 MHz is detent 1 of band B; 33 MHz is detent
  // 3 of band A. So the HIGHER frequency takes the counter-clockwise stop.
  const r = new RT841();
  const res = r.setPresets(54000, 33000);
  assert('pair is representable', res.representable);
  check('counter-clockwise stop holds 54 MHz', res.low.freqKHz, 54000);
  check('counter-clockwise stop is in band B', res.low.band, 'B');
  check('clockwise stop holds 33 MHz', res.high.freqKHz, 33000);
  check('clockwise stop is in band A', res.high.band, 'A');
}
{
  // Both handbook examples together: 39.70 and 59.35.
  const r = new RT841();
  const res = r.setPresets(39700, 59350);
  assert('39.70 / 59.35 is representable', res.representable);
  // 59 is detent 6 of band B, 39 is detent 9 of band A -> 59.35 goes CCW.
  check('CCW stop holds 59.35', res.low.freqKHz, 59350);
  check('CW stop holds 39.70', res.high.freqKHz, 39700);
}
{
  // The case the handbook never mentions. 39.35 and 59.70: 59 is lower on the
  // MHz control (detent 6 vs 9) but .70 is higher on the kHz control than .35.
  // Turning both controls counter-clockwise lands on 59.35, which is neither
  // requested frequency. The mechanism cannot hold this pair.
  const r = new RT841();
  const res = r.setPresets(39350, 59700);
  check('incompatible pair is rejected', res.representable, false);
  assert('and says why', /cannot both be preset/.test(res.warning));
}

// ---------------------------------------------------------------------------
console.log('\n5) Selecting presets [S2] 3.05');
{
  const r = new RT841();
  r.setPresets(54000, 33000);
  r.setPresetLever(true);

  r.setBand('B');
  const low = r.selectPreset('low');
  assert('low preset selected', low.ok);
  check('band switch already correct', low.bandWrong, false);
  check('dial reads 54.00', r.displayFrequency, '54.00');

  // 3.05(e): with the BAND switch on the wrong band the dial shows a
  // frequency, but it is the wrong one, and the operator must move the switch.
  const high = r.selectPreset('high');
  assert('high preset selected', high.ok);
  check('band switch flagged as wrong', high.bandWrong, true);
  check('dial shows the wrong frequency until BAND moves', r.displayFrequency, '56.00');
  r.setBand('A');
  check('correct after moving BAND to 30-52', r.displayFrequency, '33.00');
}
{
  const r = new RT841();
  r.setPresets(31000, 35000);
  r.setPresetLever(true);
  // The stops limit travel: the control cannot leave the preset span.
  r.tuneMHz(+20);
  check('clockwise travel stops at the high preset', r.displayFrequency, '35.00');
  r.tuneMHz(-20);
  check('counter-clockwise travel stops at the low preset', r.displayFrequency, '31.00');
  r.setPresetLever(false);
  r.tuneMHz(-20);
  check('lever back — control runs free to the band edge', r.displayFrequency, '30.00');
}

// ---------------------------------------------------------------------------
console.log('\n6) FUNCTION switch and power');
{
  const r = new RT841();
  check('starts OFF', r.func, 'OFF');
  assert('unpowered when OFF', !r.powered);
  r.setFunction('ON');
  assert('powered when ON', r.powered);
  assert('not warmed up immediately', !r.warmedUp);
  r.tick(30);
  assert('warmed up after the 30 s [S2] 4.09(a)', r.warmedUp);
  r.setFunction('LITE');
  assert('LITE lights the dial window', r.lite);
  r.setFunction('OFF');
  check('warm-up clock resets on OFF', r.secondsOn, 0);

  let threw = false;
  try { r.setFunction('REM'); } catch { threw = true; }
  assert('rejects a FUNCTION position the set does not have', threw);
}

// ---------------------------------------------------------------------------
console.log('\n7) Battery — reproduces the published life rather than asserting it');
{
  // [S1] "Battery life (BA-398/U): 30 hours (with a 9:1 receive-transmit
  // ratio)" at 60 mA receive / 780 mA transmit. The model stores capacity and
  // derives the hours, so this is a real cross-check of both figures.
  const r = new RT841();
  near('30 h at the published 9:1 duty', r.batteryLifeHours(PUBLISHED_DUTY_RX_TX),
    PUBLISHED_BATTERY_LIFE_H, 0.2);

  // Transmit draws 13x receive, so a heavy transmit duty guts it.
  assert('continuous transmit is far shorter', r.batteryLifeHours(0) < 6);
  assert('listening watch lasts much longer', r.batteryLifeHours(999) > 60);
}
{
  // The formula above and an actual simulated mission must agree. They did
  // not at first: the internal-resistance curve killed transmit at 21 h with
  // 28% of the battery unused, while the formula still claimed 30 h. A
  // headline figure that the simulation cannot reproduce is worse than no
  // figure at all, so this drives a real 9:1 profile minute by minute.
  const r = new RT841();
  r.setFunction('ON');
  let t = 0, txDied = null;
  while (t < 300 * 3600) {
    r.key(false); r.tick(54);   // 54 s receiving
    r.key(true);  r.tick(6);    //  6 s transmitting  -> 9:1
    t += 60;
    if (!r.canTransmit) { txDied = t; break; }
  }
  const hours = txDied / 3600;
  near('simulated 9:1 endurance matches the published 30 h',
    hours, PUBLISHED_BATTERY_LIFE_H, 2.0);
  assert('and matches the closed-form figure it advertises',
    Math.abs(hours - new RT841().batteryLifeHours(9)) < 2.0);
}
{
  // [S2] 4.09: "it is possible to provide enough power for the radio to
  // receive but not transmit". The transmit current sags the terminal voltage
  // under the 12.5 V floor before the receive current does.
  const r = new RT841();
  r.setFunction('ON');
  r.batteryRemainingAh = r.batteryCapacityAh * 0.02;
  assert('still powered up', r.powered);
  assert('but will no longer transmit', !r.canTransmit);
  assert('fault list names the symptom',
    r.faults().some((f) => /receive but not transmit/.test(f)));

  // The switch still throws even though nothing radiates — the antenna
  // changeover relay is mechanical.
  r.key(true);
  assert('PTT switch is held', r.pttHeld);
  assert('but the set is not radiating', !r.ptt);
  r.key(false);
  assert('and releases cleanly', !r.pttHeld && !r.ptt);
}
{
  // A healthy set: held and radiating are the same thing.
  const r = new RT841();
  r.setFunction('ON'); r.tick(30);
  r.key(true);
  assert('healthy set: PTT held', r.pttHeld);
  assert('healthy set: and radiating', r.ptt);
}
{
  const r = new RT841();
  r.setFunction('ON');
  const before = r.batteryRemainingAh;
  r.tick(3600);
  near('one hour receiving drains 60 mAh', (before - r.batteryRemainingAh) * 1000, 60, 0.1);
  r.key(true);
  const mid = r.batteryRemainingAh;
  r.tick(3600);
  near('one hour transmitting drains 780 mAh', (mid - r.batteryRemainingAh) * 1000, 780, 0.1);
}

// ---------------------------------------------------------------------------
console.log('\n8) Operator checklist [S2] 4.08-4.09');
{
  const r = new RT841({ antennaConnected: false });
  r.setFunction('ON');
  assert('flags a missing antenna', r.faults().some((f) => /No antenna/.test(f)));
  assert('cannot transmit without an antenna', !r.canTransmit);
  r.antennaConnected = true;
  r.setVolume(10);
  assert('warns about full volume', r.faults().some((f) => /feedback/.test(f)));
  r.setVolume(4);
  r.tick(30);
  check('clean set has no faults', r.faults().length, 0);
}

// ---------------------------------------------------------------------------
console.log('\n9) Retransmission frequency separation [S2] 5.09');
{
  const a = new RT841({ band: 'A', mhzIndex: 0, khzIndex: 0 });  // 30.00
  const b = new RT841({ band: 'A', mhzIndex: 2, khzIndex: 0 });  // 32.00
  check('2 MHz apart is rejected', a.linkRetrans(b).ok, false);
  b.mhzIndex = 3;                                                // 33.00
  check('exactly 3 MHz apart is accepted', a.linkRetrans(b).ok, true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
