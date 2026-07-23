// net.test.js — what the operator actually hears.
//
// The centrepiece is the squelch truth table. The 150 Hz tone squelch is the
// single most consequential piece of logic on this radio, and the way it fails
// is silent: a set in SQUELCH that cannot hear a tone-less transmitter sounds
// exactly like a broken radio. [S2] 3.06(g) devotes a page to a drill whose
// only purpose is to detect that condition.

import { RT841 } from '../js/radio.js';
import { Net, adjacentRejectionDB } from '../js/net.js';

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
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`); }
}

/** Two sets, same frequency, close enough for a solid link. */
function pair(distanceM = 500, opts = {}) {
  const a = new RT841({ callsign: 'ALPHA', antenna: 'AT-271A', position: { x: 0, y: 0 }, ...opts });
  const b = new RT841({ callsign: 'BRAVO', antenna: 'AT-271A', position: { x: distanceM, y: 0 }, ...opts });
  for (const r of [a, b]) { r.setBand('A'); r.mhzIndex = 5; r.khzIndex = 0; r.tick(30); } // 35.00
  return { a, b, net: new Net([a, b]) };
}

console.log('\nChannel and squelch test suite');
console.log('==============================\n');

// ---------------------------------------------------------------------------
console.log('1) The squelch truth table [S1] type of squelch, [S2] 3.06(g)');
{
  const { a, b, net } = pair();

  // OFF — dead, whatever is happening on the air.
  a.setFunction('OFF'); b.setFunction('ON'); b.key(true);
  check('OFF: handset is dead', net.receptionFor(a).state, 'off');
  check('OFF: no audio', net.receptionFor(a).audio, false);

  // ON with nothing on the air — the rushing noise of an open squelch.
  b.key(false); a.setFunction('ON');
  check('ON, nothing on the air: rushing noise', net.receptionFor(a).state, 'rushing');
  check('ON, nothing on the air: audio is open', net.receptionFor(a).audio, true);
  check('ON, nothing on the air: full noise', net.receptionFor(a).noise, 1);

  // ON with a signal — audio, tone or no tone.
  b.key(true);
  check('ON, signal present: receiving', net.receptionFor(a).state, 'receiving');
  assert('ON, signal present: noise drops', net.receptionFor(a).noise < 1);

  // SQUELCH with nothing on the air — silence, which is the whole point.
  b.key(false); a.setFunction('SQUELCH');
  check('SQUELCH, nothing on the air: silent', net.receptionFor(a).state, 'silent');
  check('SQUELCH, nothing on the air: no audio', net.receptionFor(a).audio, false);

  // SQUELCH with a tone-bearing signal — opens up.
  b.key(true);
  check('SQUELCH, signal with 150 Hz tone: receiving', net.receptionFor(a).state, 'receiving');
  check('SQUELCH, signal with 150 Hz tone: audio', net.receptionFor(a).audio, true);
}
{
  // SQUELCH against a transmitter with no tone — the trap. The signal is
  // strong, the frequency is right, and the handset stays silent.
  const { a, b, net } = pair();
  a.setFunction('SQUELCH'); b.setFunction('ON'); b.key(true);

  // Simulate a set whose tone is absent (an AN/PRC-25, or a defective A54
  // squelch module) by stripping the tone from what it radiates.
  const original = net.transmitters.bind(net);
  net.transmitters = (o) => original(o).map((t) => (t.station === b ? { ...t, hasTone: false } : t));

  const rx = net.receptionFor(a);
  check('SQUELCH, signal without the tone: silent', rx.state, 'silent');
  check('SQUELCH, signal without the tone: no audio', rx.audio, false);
  assert('and the suppressed signal is reported, not hidden', rx.suppressedSignal !== null);
  assert('the signal really was strong enough to hear', rx.suppressedSignal.marginDB > 0,
    `${rx.suppressedSignal.marginDB.toFixed(0)} dB margin`);

  // The handbook's fix: drop back to ON and it is there all along.
  a.setFunction('ON');
  check('the same signal is perfectly readable in ON', net.receptionFor(a).state, 'receiving');
}

// ---------------------------------------------------------------------------
console.log('\n2) Half duplex [S2] 4.09(d)');
{
  const { a, b, net } = pair();
  a.setFunction('ON'); b.setFunction('ON');
  a.key(true); b.key(true);
  const rx = net.receptionFor(a);
  check('a keyed set cannot receive', rx.state, 'transmitting');
  assert('operator hears sidetone', rx.sidetone === true);
  assert('and the 150 Hz sub-tone growl', rx.subtone === true);
}
{
  // Keyed on a flat battery. The antenna changeover relay is mechanical and
  // throws on the switch, so the set goes deaf whether or not the transmitter
  // can produce output — and the ABSENT sidetone is the operator's diagnostic.
  const { a, b, net } = pair();
  a.setFunction('ON'); b.setFunction('ON');
  b.key(true);
  check('healthy: hears BRAVO', net.receptionFor(a).state, 'receiving');

  a.batteryRemainingAh = a.batteryCapacityAh * 0.02;
  a.key(true);
  const rx = net.receptionFor(a);
  check('keyed on a flat battery: not receiving', rx.state, 'keyed-dead');
  assert('no sidetone — the documented symptom', rx.sidetone === false);
  assert('and no 150 Hz sub-tone either', rx.subtone === false);
  assert('buzzing instead', rx.buzzing === true);
  assert('reason names the battery', /battery/.test(rx.reason));
}
{
  // Same relay behaviour with no antenna fitted.
  const { a, b, net } = pair();
  a.setFunction('ON'); b.setFunction('ON'); b.key(true);
  a.antennaConnected = false;
  a.key(true);
  const rx = net.receptionFor(a);
  check('keyed with no antenna: deaf too', rx.state, 'keyed-dead');
  assert('reason names the antenna', /antenna/.test(rx.reason));
}

// ---------------------------------------------------------------------------
console.log('\n3) Frequency selectivity');
{
  const { a, b, net } = pair();
  a.setFunction('ON'); b.setFunction('ON'); b.key(true);
  check('co-channel: heard', net.receptionFor(a).state, 'receiving');

  // One channel off — 50 kHz — is rejected.
  b.khzIndex = 1;
  check('one channel off: not heard', net.receptionFor(a).state, 'rushing');

  // Same dial reading, wrong BAND switch: 35.00 in band A vs band B is
  // 58.00, which is 23 MHz away. A classic netting failure.
  b.khzIndex = 0; b.setBand('B');
  check('same dial reading, different band: not heard', net.receptionFor(a).state, 'rushing');
  check('because the frequencies really are different', a.freqKHz === b.freqKHz, false);

  check('adjacent rejection at 0 kHz', adjacentRejectionDB(0), 0);
  check('adjacent rejection at 50 kHz', adjacentRejectionDB(50), 60);
  check('adjacent rejection is symmetric', adjacentRejectionDB(-50), 60);
}

// ---------------------------------------------------------------------------
console.log('\n4) FM capture effect');
{
  // Three sets on one frequency. CHARLIE is much closer to ALPHA than BRAVO
  // is, so it should capture the receiver outright.
  const a = new RT841({ callsign: 'ALPHA', antenna: 'AT-271A', position: { x: 0, y: 0 } });
  const b = new RT841({ callsign: 'BRAVO', antenna: 'AT-271A', position: { x: 4000, y: 0 } });
  const c = new RT841({ callsign: 'CHARLIE', antenna: 'AT-271A', position: { x: 200, y: 0 } });
  for (const r of [a, b, c]) { r.setBand('A'); r.mhzIndex = 5; r.khzIndex = 0; r.setFunction('ON'); r.tick(30); }
  const net = new Net([a, b, c]);

  b.key(true); c.key(true);
  const rx = net.receptionFor(a);
  check('the stronger signal captures the receiver', rx.best.from.callsign, 'CHARLIE');
  check('and it is not contested', rx.contested, false);
  check('clean copy', rx.state, 'receiving');

  // Move BRAVO to the same distance as CHARLIE: neither captures, and the
  // operator gets a garble rather than one clean signal.
  b.position = { x: -205, y: 0 };
  const rx2 = net.receptionFor(a);
  assert('two comparable signals contest the limiter', rx2.contested === true);
  check('and the result is garbled', rx2.state, 'garbled');
}

// ---------------------------------------------------------------------------
console.log('\n5) Range and the netting diagnosis [S2] 3.06(g)');
{
  const { a, b, net } = pair(500);
  a.setFunction('ON'); b.setFunction('ON');
  const d = net.diagnose(a, b);
  assert('500 m apart: workable', d.workable, d.problems.join('; '));
  assert('and readable', d.readability.copy);
}
{
  const { a, b, net } = pair(60000);
  a.setFunction('ON'); b.setFunction('ON');
  const d = net.diagnose(a, b);
  check('60 km apart: not workable', d.workable, false);
  assert('reported as out of range', d.problems.some((p) => /Out of range/.test(p)));
  assert('and noted as beyond the horizon', d.problems.some((p) => /radio horizon/.test(p)));
}
{
  const { a, b, net } = pair(500);
  a.setFunction('ON'); b.setFunction('ON');
  b.khzIndex = 4;
  const d = net.diagnose(a, b);
  check('frequency mismatch: not workable', d.workable, false);
  assert('and it says which frequencies', d.problems.some((p) => /Frequencies differ/.test(p)));
}
{
  const { a, b, net } = pair(500);
  a.setFunction('ON'); b.setFunction('OFF');
  assert('a set at OFF is reported', net.diagnose(a, b).problems.some((p) => /OFF/.test(p)));
}

// ---------------------------------------------------------------------------
console.log('\n6) Retransmission [S2] 5.07-5.10');
{
  // Two outstations too far apart to work each other, with a relay between.
  const west = new RT841({ callsign: 'WEST', antenna: 'AT-271A', position: { x: 0, y: 0 } });
  const east = new RT841({ callsign: 'EAST', antenna: 'AT-271A', position: { x: 12000, y: 0 } });
  const r1 = new RT841({ callsign: 'RELAY-1', antenna: 'AT-271A', position: { x: 6000, y: 0 } });
  const r2 = new RT841({ callsign: 'RELAY-2', antenna: 'AT-271A', position: { x: 6000, y: 0 } });

  // WEST and RELAY-1 on 35.00; EAST and RELAY-2 on 40.00 — 5 MHz apart.
  for (const r of [west, r1]) { r.setBand('A'); r.mhzIndex = 5; r.khzIndex = 0; }
  for (const r of [east, r2]) { r.setBand('A'); r.mhzIndex = 10; r.khzIndex = 0; }
  for (const r of [west, east, r1, r2]) { r.setFunction('ON'); r.tick(30); }
  const net = new Net([west, east, r1, r2]);

  const direct = net.diagnose(west, east);
  check('WEST and EAST cannot work each other directly', direct.workable, false);

  const link = r1.linkRetrans(r2);
  assert('5 MHz separation satisfies the 3 MHz rule', link.ok, `${link.separationMHz} MHz`);
  r1.setFunction('RETRANS'); r2.setFunction('RETRANS');
  assert('relay is active', r1.retransActive);

  west.key(true);
  const heard = net.receptionFor(east);
  check('EAST now hears the relayed signal', heard.state, 'receiving');
  check('and it arrives via the relay', heard.best.via.callsign, 'RELAY-1');
  check('on the second relay set', heard.best.from.callsign, 'RELAY-2');

  // Fail the separation rule and the pairing is rejected.
  r2.mhzIndex = 6; // 36.00, only 1 MHz from 35.00
  check('1 MHz separation is rejected', net.checkRetrans(r1, r2).ok, false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
