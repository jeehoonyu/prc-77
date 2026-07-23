// app.js — wires the front panel to the engine.
//
// All the behaviour lives in radio.js / propagation.js / net.js. This file
// only moves values between the DOM and those modules, and keeps a clock
// running so the battery drains.

import { RT841, khzToDetents, formatFrequency } from './radio.js';
import { Net } from './net.js';
import { antennaGainDBi, linkBudget, radioHorizonM } from './propagation.js';
import { HandsetAudio } from './audio.js';
import { MHZ_DETENTS_PER_BAND, KHZ_DETENTS, BANDS } from './config.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

const alpha = new RT841({
  callsign: 'ALPHA', antenna: 'AT-271A',
  position: { x: 0, y: 0 }, antennaHeightM: 1.5, terrain: 'open',
});
const bravo = new RT841({
  callsign: 'BRAVO', antenna: 'AT-271A',
  position: { x: 2000, y: 0 }, antennaHeightM: 1.5, terrain: 'open',
});
// BRAVO starts on 35.00 MHz.
bravo.setBand('A'); bravo.mhzIndex = 5; bravo.khzIndex = 0;
bravo.setFunction('ON');

const net = new Net([alpha, bravo]);
const audio = new HandsetAudio();

// BRAVO's tone can be switched off from the UI to reproduce the classic
// squelch trap. The set itself has no such switch, so it is applied here by
// filtering what the net sees rather than by adding a control to the RT841.
let bravoSendsTone = true;
const baseTransmitters = net.transmitters.bind(net);
net.transmitters = (opts) => baseTransmitters(opts).map(
  (t) => (t.station === bravo && !bravoSendsTone ? { ...t, hasTone: false } : t)
);

// ---------------------------------------------------------------------------
// Panel: tuning knobs
// ---------------------------------------------------------------------------

function rotateKnob(el, index, detents) {
  const face = el.querySelector('.knob-face');
  face.style.transform = `rotate(${(index / detents) * 330}deg)`;
}

/** Click left/right of centre, scroll, drag, or arrow keys — all turn it. */
function wireKnob(el, onTurn) {
  el.addEventListener('click', (e) => {
    const r = el.getBoundingClientRect();
    onTurn(e.clientX < r.left + r.width / 2 ? -1 : 1);
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    onTurn(e.deltaY > 0 ? -1 : 1);
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onTurn(-1); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onTurn(1); }
  });

  let dragging = false, lastAngle = null, accum = 0;
  const angleAt = (e) => {
    const r = el.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true; lastAngle = angleAt(e); accum = 0;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const a = angleAt(e);
    let d = a - lastAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    lastAngle = a;
    accum += d;
    const step = Math.PI / 9; // 20 degrees per detent
    while (Math.abs(accum) >= step) {
      onTurn(accum > 0 ? 1 : -1);
      accum -= Math.sign(accum) * step;
    }
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

wireKnob($('knob-mhz'), (d) => { alpha.tuneMHz(d); render(); });
wireKnob($('knob-khz'), (d) => { alpha.tuneKHz(d); render(); });

// ---------------------------------------------------------------------------
// Panel: switches
// ---------------------------------------------------------------------------

$('band-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-band]');
  if (!btn) return;
  alpha.setBand(btn.dataset.band);
  render();
});

$('function-switch').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-func]');
  if (!btn) return;
  alpha.setFunction(btn.dataset.func);
  if (btn.dataset.func !== 'OFF' && !audio.started) await enableAudio();
  render();
});

$('volume').addEventListener('input', (e) => {
  alpha.setVolume(Number(e.target.value));
  audio.setVolume(alpha.volume);
  render();
});

// PRESET levers
$('preset-lever-toggle').addEventListener('click', () => {
  alpha.setPresetLever(!alpha.presetLever);
  render();
});
$('preset-select-low').addEventListener('click', () => selectPreset('low'));
$('preset-select-high').addEventListener('click', () => selectPreset('high'));

function selectPreset(which) {
  const r = alpha.selectPreset(which);
  $('preset-result').textContent = r.ok
    ? (r.bandWrong ? `Stops reached — ${r.reason}` : 'Preset selected.')
    : r.reason;
  render();
}

$('pre-set').addEventListener('click', () => {
  const parse = (v) => {
    const mhz = parseFloat(String(v).trim());
    if (!Number.isFinite(mhz)) return null;
    return Math.round(mhz * 1000);
  };
  const a = parse($('pre1').value), b = parse($('pre2').value);
  if (a === null || b === null) {
    $('preset-result').textContent = 'Enter two frequencies in MHz, e.g. 54.00';
    return;
  }
  if (!khzToDetents(a) || !khzToDetents(b)) {
    $('preset-result').textContent =
      'Both must be tunable: 30.00–52.95 or 53.00–75.95 MHz, on a 50 kHz step.';
    return;
  }
  const res = alpha.setPresets(a, b);
  $('preset-result').textContent = res.representable
    ? `Stops set. Counter-clockwise → ${formatFrequency(res.low.freqKHz)} MHz `
      + `(band ${res.low.band}); clockwise → ${formatFrequency(res.high.freqKHz)} MHz `
      + `(band ${res.high.band}).`
    : res.warning;
  render();
});

// ---------------------------------------------------------------------------
// Push to talk
// ---------------------------------------------------------------------------

async function keyDown() {
  if (alpha.pttHeld) return;
  if (!audio.started) await enableAudio();
  alpha.key(true);
  // The relay is mechanical: it clicks on the switch, not on whether the
  // transmitter can actually produce output.
  if (alpha.pttHeld) audio.relayClick();
  render();
}
function keyUp() {
  if (!alpha.pttHeld) return;
  alpha.key(false);
  audio.relayClick();
  render();
}

const ptt = $('ptt');
ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); keyDown(); });
ptt.addEventListener('pointerup', keyUp);
ptt.addEventListener('pointerleave', keyUp);
ptt.addEventListener('pointercancel', keyUp);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && e.target === document.body) { e.preventDefault(); keyDown(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); keyUp(); }
});

// ---------------------------------------------------------------------------
// Situation and BRAVO
// ---------------------------------------------------------------------------

$('in-distance').addEventListener('input', (e) => {
  bravo.position = { x: Number(e.target.value), y: 0 };
  render();
});
$('in-antenna').addEventListener('change', (e) => { alpha.antenna = e.target.value; render(); });
$('in-height').addEventListener('input', (e) => {
  alpha.antennaHeightM = Number(e.target.value);
  render();
});
$('in-terrain').addEventListener('change', (e) => {
  alpha.terrain = bravo.terrain = e.target.value;
  render();
});
$('in-noise').addEventListener('change', (e) => {
  // Noise belongs to the receiving site, so it is set per station. Both are
  // moved together here because the UI models one situation.
  alpha.noiseEnv = bravo.noiseEnv = e.target.value;
  render();
});

document.querySelector('.bravo-tune').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-b]');
  if (!btn) return;
  const d = Number(btn.dataset.d);
  if (btn.dataset.b === 'mhz') {
    bravo.mhzIndex = Math.min(MHZ_DETENTS_PER_BAND - 1, Math.max(0, bravo.mhzIndex + d));
  } else {
    bravo.khzIndex = Math.min(KHZ_DETENTS - 1, Math.max(0, bravo.khzIndex + d));
  }
  render();
});

$('bravo-func').addEventListener('change', (e) => { bravo.setFunction(e.target.value); render(); });
$('bravo-tone').addEventListener('change', (e) => { bravoSendsTone = e.target.checked; render(); });

const bravoKey = $('bravo-ptt');
const bravoDown = (e) => { e.preventDefault(); bravo.key(true); bravoKey.classList.add('keyed'); render(); };
const bravoUp = () => { bravo.key(false); bravoKey.classList.remove('keyed'); render(); };
bravoKey.addEventListener('pointerdown', bravoDown);
bravoKey.addEventListener('pointerup', bravoUp);
bravoKey.addEventListener('pointerleave', bravoUp);
bravoKey.addEventListener('pointercancel', bravoUp);

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function enableAudio() {
  try {
    await audio.start();
    audio.setVolume(alpha.volume);
    $('audio-toggle').textContent = 'Handset audio on';
    $('audio-toggle').classList.add('on');
  } catch (err) {
    $('audio-toggle').textContent = 'Audio unavailable';
    console.warn('Web Audio unavailable:', err);
  }
}
$('audio-toggle').addEventListener('click', async () => {
  if (audio.started) {
    await audio.stop();
    $('audio-toggle').textContent = 'Enable handset audio';
    $('audio-toggle').classList.remove('on');
  } else {
    await enableAudio();
  }
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let lastState = null;

function render() {
  // --- dial --------------------------------------------------------------
  const mhz = Math.floor(alpha.freqKHz / 1000);
  const khz = alpha.freqKHz % 1000;
  $('dial-mhz').textContent = String(mhz);
  $('dial-khz').textContent = String(khz / 10).padStart(2, '0');
  $('dial-channel').textContent = `CH ${alpha.channel + 1}`;
  $('dial-band-echo').textContent = `BAND ${alpha.band}`;
  $('dial-window').classList.toggle('lit', alpha.func === 'LITE' && alpha.powered);

  rotateKnob($('knob-mhz'), alpha.mhzIndex, MHZ_DETENTS_PER_BAND);
  rotateKnob($('knob-khz'), alpha.khzIndex, KHZ_DETENTS);
  $('knob-mhz').setAttribute('aria-valuenow', alpha.mhzIndex);
  $('knob-khz').setAttribute('aria-valuenow', alpha.khzIndex);

  // --- switches ----------------------------------------------------------
  for (const b of $('band-switch').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.band === alpha.band);
  }
  for (const b of $('function-switch').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.func === alpha.func);
  }
  $('volume-read').textContent = alpha.volume;

  const engaged = alpha.presetLever;
  $('preset-lever-toggle').textContent = engaged ? 'LEVERS FORWARD' : 'LEVERS BACK';
  $('preset-lever-toggle').classList.toggle('on', engaged);
  $('lever-mhz').classList.toggle('engaged', engaged);
  $('lever-khz').classList.toggle('engaged', engaged);
  const havePresets = alpha.presets.low.set && alpha.presets.high.set;
  $('preset-select-low').disabled = !(engaged && havePresets);
  $('preset-select-high').disabled = !(engaged && havePresets);

  // --- BRAVO -------------------------------------------------------------
  $('bravo-dial').textContent = bravo.displayFrequency;

  // --- situation labels --------------------------------------------------
  const distM = bravo.position.x;
  $('lbl-dist').textContent = distM >= 1000
    ? `${(distM / 1000).toFixed(2)} km` : `${distM} m`;
  $('lbl-height').textContent = `${alpha.antennaHeightM.toFixed(1)} m`;

  // --- link --------------------------------------------------------------
  const budget = linkBudget({
    distanceM: Math.max(distM, 1),
    freqHz: bravo.freqKHz * 1000,
    txAntenna: bravo.antenna, rxAntenna: alpha.antenna,
    txHeightM: bravo.antennaHeightM, rxHeightM: alpha.antennaHeightM,
    clutter: alpha.terrain,
    noiseEnv: alpha.noiseEnv,
  });
  const cls = (v, good, warn) => (v >= good ? 'good' : v >= warn ? 'warn' : 'bad');

  $('ro-rx').textContent = `${budget.rxDBm.toFixed(1)} dBm`;
  $('ro-margin').textContent = `${budget.marginDB >= 0 ? '+' : ''}${budget.marginDB.toFixed(1)} dB`;
  $('ro-margin').className = cls(budget.marginDB, 12, 0);
  $('ro-loss').textContent = `${budget.pathLossDB.toFixed(0)} dB`;
  $('ro-dist').textContent = `${(distM / 1000).toFixed(2)} km`;
  const horizonKm = radioHorizonM(alpha.antennaHeightM, bravo.antennaHeightM) / 1000;
  $('ro-los').textContent = budget.lineOfSight ? `LOS (${horizonKm.toFixed(1)} km)` : 'beyond';
  $('ro-los').className = budget.lineOfSight ? 'good' : 'bad';
  $('ro-read').textContent = budget.readability.label;
  $('ro-read').className = cls(budget.readability.level, 3, 1);
  $('ro-noise').textContent = `${budget.externalNoiseDBm.toFixed(1)} dBm`;
  $('ro-sens').textContent = `${budget.sensitivityDBm.toFixed(1)} dBm`;
  // Flag when the environment, not the radio, is setting the limit.
  $('ro-sens').className = budget.noisePenaltyDB > 10 ? 'bad'
    : budget.noisePenaltyDB > 4 ? 'warn' : 'good';

  $('signal-fill').style.width =
    `${Math.max(0, Math.min(100, (budget.marginDB / 40) * 100))}%`;

  const diag = net.diagnose(alpha, bravo);
  $('diagnosis').textContent = diag.workable ? '' : diag.problems.join(' · ');

  // --- set state ---------------------------------------------------------
  $('st-freq').textContent = `${alpha.displayFrequency} MHz`;
  $('st-chan').textContent = `${alpha.channel + 1} of 920`;
  const pct = Math.round(100 * alpha.batteryRemainingAh / alpha.batteryCapacityAh);
  $('st-batt').textContent = `${pct}%`;
  $('st-batt').className = cls(pct, 40, 15);
  $('st-volts').textContent = `${alpha.batteryVoltage.toFixed(2)} V`;
  $('st-gain').textContent =
    `${antennaGainDBi(alpha.antenna, alpha.freqKHz * 1000).toFixed(1)} dBi`;
  $('st-life').textContent = `${alpha.batteryLifeHours(9).toFixed(1)} h`;

  const faults = alpha.faults();
  const list = $('faults');
  list.innerHTML = '';
  if (!faults.length) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = 'Operational check passed';
    list.appendChild(li);
  } else {
    for (const f of faults) {
      const li = document.createElement('li');
      li.textContent = f;
      list.appendChild(li);
    }
  }

  // --- handset -----------------------------------------------------------
  const rx = net.receptionFor(alpha);
  audio.update(rx);

  const lamp = $('lamp-state');
  lamp.className = 'lamp';
  let text;
  switch (rx.state) {
    case 'off':
      text = 'Set is OFF'; break;
    case 'transmitting':
      lamp.classList.add('tx');
      text = `Transmitting on ${alpha.displayFrequency} MHz — sidetone and 150 Hz sub-tone`;
      break;
    case 'keyed-dead':
      lamp.classList.add('tx');
      text = `${rx.reason} — buzzing, no sidetone, and the set is deaf while keyed`;
      break;
    case 'rushing':
      lamp.classList.add('noise');
      text = 'Rushing noise — squelch open, nothing on the air';
      break;
    case 'silent':
      text = rx.suppressedSignal
        ? 'Silent — a signal is present but carries no 150 Hz tone, so SQUELCH holds it out'
        : 'Silent — squelch closed';
      break;
    case 'garbled':
      lamp.classList.add('rx');
      text = 'Two signals contesting the limiter — garbled';
      break;
    case 'receiving':
      lamp.classList.add('rx');
      text = `Receiving ${rx.best.from.callsign}`
        + (rx.best.via ? ` via ${rx.best.via.callsign}` : '')
        + ` — ${rx.readability.label}`;
      break;
    default:
      text = '';
  }
  $('handset-text').textContent = text;
  ptt.setAttribute('aria-pressed', String(alpha.pttHeld));

  // Squelch tail when the gate closes.
  if (lastState === 'receiving' && rx.state === 'silent') audio.squelchTail();
  lastState = rx.state;

  // --- siting note -------------------------------------------------------
  const notes = {
    open: 'Open ground. Best case for a manpack set.',
    rolling: 'Rolling terrain adds a few dB of obstruction loss.',
    lightWoods: 'Light woods. The handbook rates wooded areas as poor sites.',
    denseWoods: 'Dense woods — "densely wooded areas... are poor sites."',
    urban: 'Built-up area. Also avoid power and telephone lines.',
    valley: '"Valleys... and low places are poor sites." Get onto high ground.',
  };
  const noiseNotes = {
    quietRural: '',
    rural: 'Some man-made noise. The receiver is no longer the limit.',
    residential: 'Man-made noise now sets your usable sensitivity, not the set.',
    urban: 'Heavy electrical noise. "Avoid locations near a source of electrical '
         + 'interference, such as power or telephone lines, radar sets."',
  };
  $('siting-note').textContent =
    [notes[alpha.terrain], noiseNotes[alpha.noiseEnv]].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Clock — drains the battery in real time.
// ---------------------------------------------------------------------------

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  alpha.tick(dt);
  bravo.tick(dt);
  render();
}, 500);

render();
