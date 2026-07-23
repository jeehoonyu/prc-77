// net.js — "the air": what each set actually hears.
//
// Couples any number of RT-841s together. For each receiving station it works
// out every signal arriving at its antenna, applies adjacent-channel
// rejection, resolves FM capture, then applies the FUNCTION switch and the
// 150 Hz tone squelch to decide whether the handset opens up.
//
// The squelch truth table is the part worth getting right, because it is the
// thing the handbook spends a page on ([S2] 3.06(g)) and the thing that
// actually bites operators:
//
//   FUNCTION      incoming signal            handset
//   -----------------------------------------------------------------
//   OFF           anything                   dead
//   ON            none                       rushing noise
//   ON            any signal above threshold audio (tone or not)
//   SQUELCH       none                       silent
//   SQUELCH       signal WITHOUT 150 Hz tone silent  <- the classic trap
//   SQUELCH       signal WITH 150 Hz tone    audio
//
// The trap is real: a PRC-77 in SQUELCH cannot hear a PRC-25 or any set whose
// tone is switched off, and it sounds exactly like a dead radio. That is why
// the handbook's netting drill has both stations start in ON.

import { linkBudget, readability } from './propagation.js';
import {
  FM_CAPTURE_RATIO_DB, RETRANS_MIN_SEPARATION_MHZ, ADJACENT_REJECTION_DB, TX_POWER_W,
} from './config.js';

/**
 * Adjacent-channel rejection of the receiver's IF filter, in dB.
 * The set is specified for better than ~55 dB at one channel off; these are
 * the conventional figures for a tactical FM set at 50 kHz spacing.
 */
export function adjacentRejectionDB(offsetKHz) {
  const off = Math.abs(offsetKHz);
  const R = ADJACENT_REJECTION_DB;
  if (off === 0) return R[0];
  if (off <= 50) return R[50];
  if (off <= 100) return R[100];
  if (off <= 200) return R[200];
  // Keep climbing rather than flattening: without this a very strong local
  // set stays "readable" many channels away, which no real IF filter allows.
  return Math.min(R.maxDB, R[200] + R.beyondSlopeDB * Math.log10(off / 200));
}

const distanceM = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);

// Path clutter is taken as the worse of the two endpoints' terrain. A crude
// but defensible reading of "site the set well" — a station in a valley is in
// a valley regardless of who it is talking to.
const CLUTTER_ORDER = ['open', 'rolling', 'lightWoods', 'denseWoods', 'urban', 'valley'];
function worstClutter(a, b) {
  const ia = CLUTTER_ORDER.indexOf(a), ib = CLUTTER_ORDER.indexOf(b);
  return CLUTTER_ORDER[Math.max(ia < 0 ? 0 : ia, ib < 0 ? 0 : ib)];
}

export class Net {
  constructor(stations = []) {
    this.stations = [...stations];
  }

  add(station) { this.stations.push(station); return this; }
  remove(station) {
    this.stations = this.stations.filter((s) => s !== station);
    return this;
  }

  /**
   * Every signal physically present at `rx`'s antenna, strongest first.
   * Includes signals on other channels — rejection is applied, not a filter,
   * because a very strong adjacent-channel signal can still get through.
   */
  signalsAt(rx, { includeRetrans = true } = {}) {
    const out = [];
    for (const tx of this.transmitters({ includeRetrans })) {
      if (tx.station === rx) continue;
      if (!tx.station.antennaConnected) continue;

      const d = distanceM(tx.station, rx);
      const budget = linkBudget({
        distanceM: Math.max(d, 1),
        freqHz: tx.freqKHz * 1000,
        txPowerW: tx.powerW,
        txAntenna: tx.station.antenna,
        rxAntenna: rx.antenna,
        txHeightM: tx.station.antennaHeightM,
        rxHeightM: rx.antennaHeightM,
        clutter: worstClutter(tx.station.terrain, rx.terrain),
        noiseEnv: rx.noiseEnv,
      });

      const rejection = adjacentRejectionDB(tx.freqKHz - rx.freqKHz);
      const effectiveDBm = budget.rxDBm - rejection;

      out.push({
        from: tx.station,
        via: tx.via || null,
        freqKHz: tx.freqKHz,
        hasTone: tx.hasTone,
        distanceM: d,
        rejectionDB: rejection,
        rxDBm: effectiveDBm,
        marginDB: effectiveDBm - budget.sensitivityDBm,
        lineOfSight: budget.lineOfSight,
        pathLossDB: budget.pathLossDB,
      });
    }
    return out.sort((a, b) => b.rxDBm - a.rxDBm);
  }

  /**
   * Everything currently radiating, including signals being relayed by a
   * station in RETRANS.
   */
  transmitters({ includeRetrans = true } = {}) {
    const live = [];
    for (const s of this.stations) {
      if (!s.ptt || !s.canTransmit) continue;
      live.push({
        station: s,
        freqKHz: s.freqKHz,
        powerW: TX_POWER_W,
        // [S1] "Transmission - Voice and 150-Hz squelch tone." The set always
        // sends the tone when keyed; there is no switch to suppress it.
        hasTone: true,
        via: null,
      });
    }
    if (!includeRetrans) return live;

    // One relay hop. Doctrine sites a single relay ([S2] 5.07-5.10); chained
    // relays are not resolved and would need a loop guard if they ever were.
    const relayed = [];
    for (const s of this.stations) {
      if (!s.retransActive) continue;
      const partner = s.retransPartner;
      const heard = live
        .filter((t) => t.station !== s && t.station !== partner)
        .filter((t) => t.freqKHz === s.freqKHz)
        .map((t) => {
          const d = distanceM(t.station, s);
          const b = linkBudget({
            distanceM: Math.max(d, 1),
            freqHz: t.freqKHz * 1000,
            txPowerW: t.powerW,
            txAntenna: t.station.antenna,
            rxAntenna: s.antenna,
            txHeightM: t.station.antennaHeightM,
            rxHeightM: s.antennaHeightM,
            clutter: worstClutter(t.station.terrain, s.terrain),
            noiseEnv: s.noiseEnv,
          });
          return { t, margin: b.rxDBm - b.sensitivityDBm };
        })
        .filter((x) => x.margin >= 0);

      if (!heard.length) continue;
      if (!partner.canTransmit) continue;

      // The relay re-radiates on the partner set's frequency.
      relayed.push({
        station: partner,
        freqKHz: partner.freqKHz,
        powerW: TX_POWER_W,
        hasTone: true,
        via: s,
      });
    }
    return [...live, ...relayed];
  }

  /**
   * What the operator at `rx` hears right now.
   *
   * @returns {{state:string, audio:boolean, ...}}
   *   state is one of: 'off', 'transmitting', 'rushing', 'silent',
   *   'receiving', 'garbled'
   */
  receptionFor(rx) {
    if (!rx.powered) {
      return { state: 'off', audio: false, noise: 0, signals: [], best: null };
    }

    // Half duplex — the set cannot receive while keyed. The antenna changeover
    // relay is mechanical and throws on the switch, not on whether the
    // transmitter is working, so a keyed set is deaf either way.
    if (rx.pttHeld) {
      if (rx.ptt) {
        // Radiating properly: sidetone plus the 150 Hz sub-tone growl.
        // [S2] 4.09(d)(2)-(3)
        return {
          state: 'transmitting', audio: true, noise: 0,
          sidetone: true, subtone: true, signals: [], best: null,
        };
      }
      // Keyed but not radiating — a flat battery, or no antenna. [S2] 4.09:
      // "It may also give a buzzing sound when the PTT is pressed" and the
      // absent sidetone is the diagnostic: "You should hear yourself in the
      // earpiece when you speak. If not, the battery has insufficient power."
      return {
        state: 'keyed-dead', audio: true, noise: 0,
        sidetone: false, subtone: false, buzzing: true,
        signals: [], best: null,
        reason: !rx.antennaConnected
          ? 'Keyed with no antenna connected'
          : 'Keyed, but the battery cannot support the transmitter',
      };
    }

    const signals = this.signalsAt(rx);
    const audible = signals.filter((s) => s.marginDB >= 0);

    // FM capture. The limiter hands the demodulator whichever signal is
    // strongest; if the runner-up is within the capture ratio, neither wins
    // cleanly and the operator gets a garble.
    let captured = null, contested = false;
    if (audible.length === 1) {
      captured = audible[0];
    } else if (audible.length > 1) {
      captured = audible[0];
      contested = (audible[0].rxDBm - audible[1].rxDBm) < FM_CAPTURE_RATIO_DB;
    }

    const rd = captured ? readability(captured.marginDB) : null;

    // --- FUNCTION switch and squelch ---------------------------------------
    if (rx.func === 'SQUELCH') {
      // The squelch gate is opened by the 150 Hz tone, not by signal strength
      // alone. No tone, no audio — however strong the carrier is.
      const opens = captured && captured.hasTone && captured.marginDB >= 0;
      if (!opens) {
        return {
          state: 'silent', audio: false, noise: 0, squelchClosed: true,
          signals, best: captured,
          // Surfaced so the UI can explain the classic failure honestly.
          suppressedSignal: captured && !captured.hasTone ? captured : null,
        };
      }
      return {
        state: contested ? 'garbled' : 'receiving', audio: true,
        noise: rd.noise, readability: rd, signals, best: captured, contested,
      };
    }

    // ON / RETRANS / LITE all pass audio with no squelch.
    if (!captured) {
      // [S2] 3.06(a) "A rushing noise should be heard in the handset."
      return { state: 'rushing', audio: true, noise: 1, signals, best: null };
    }
    return {
      state: contested ? 'garbled' : 'receiving', audio: true,
      noise: rd.noise, readability: rd, signals, best: captured, contested,
    };
  }

  /**
   * The netting drill from [S2] 3.06(g), as a check rather than a procedure:
   * can these two stations actually work each other, and if not, why not?
   */
  diagnose(a, b) {
    const problems = [];
    if (!a.powered) problems.push(`${a.callsign}: FUNCTION switch at OFF`);
    if (!b.powered) problems.push(`${b.callsign}: FUNCTION switch at OFF`);
    if (a.freqKHz !== b.freqKHz) {
      problems.push(`Frequencies differ: ${a.displayFrequency} vs ${b.displayFrequency}`);
    }
    if (a.band !== b.band && a.freqKHz === b.freqKHz) {
      problems.push('Same dial reading but different BAND switch positions');
    }
    for (const [s, other] of [[a, b], [b, a]]) {
      if (!s.antennaConnected) problems.push(`${s.callsign}: no antenna connected`);
      if (!s.canTransmit && s.powered) {
        problems.push(`${s.callsign}: battery will receive but not transmit`);
      }
    }

    // Range check, both directions.
    const d = distanceM(a, b);
    const budget = linkBudget({
      distanceM: Math.max(d, 1),
      freqHz: a.freqKHz * 1000,
      txAntenna: a.antenna, rxAntenna: b.antenna,
      txHeightM: a.antennaHeightM, rxHeightM: b.antennaHeightM,
      clutter: worstClutter(a.terrain, b.terrain),
      noiseEnv: b.noiseEnv,
    });
    if (budget.marginDB < 0) {
      problems.push(
        `Out of range: ${(d / 1000).toFixed(1)} km, ${budget.marginDB.toFixed(0)} dB short` +
        (budget.lineOfSight ? '' : ' (beyond radio horizon)')
      );
    }
    return {
      workable: problems.length === 0,
      problems,
      distanceM: d,
      marginDB: budget.marginDB,
      readability: readability(budget.marginDB),
    };
  }

  /** Check a retransmission pair against the 3 MHz rule. [S2] 5.09 */
  checkRetrans(a, b) {
    const sep = Math.abs(a.freqMHz - b.freqMHz);
    return {
      ok: sep >= RETRANS_MIN_SEPARATION_MHZ,
      separationMHz: sep,
      reason: sep >= RETRANS_MIN_SEPARATION_MHZ ? null
        : `Retrans frequencies must be at least ${RETRANS_MIN_SEPARATION_MHZ} MHz apart (currently ${sep.toFixed(2)} MHz)`,
    };
  }
}
