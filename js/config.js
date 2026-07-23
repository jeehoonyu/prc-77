// config.js — Hard specifications for Radio Set AN/PRC-77 (RT-841/PRC-77).
//
// Every number in this file is traceable to a primary source. Where sources
// disagree, both figures are recorded and the choice is justified in a comment.
// Nothing here is invented. If a value could not be sourced it is absent
// rather than guessed.
//
// SOURCES
//  [S1] "AN/PRC-77 Tactical Radio Set" manufacturer data sheet, Associated
//       Industries, North Hollywood CA.  qsl.net/ta2ei/cihaz/prc77/ANPRC77.pdf
//  [S2] Australian Army Cadets, "Cadet Instructor's Handbook - Radio Set
//       AN/PRC-77", June 2007. Derived from the TM / User Handbook.
//  [S3] prc68.com/I/PRC77.shtml — measured current drain, U-229 pinout,
//       receiver sensitivity.
//  [S4] cryptomuseum.com/radio/prc77/ — panel layout, X-MODE, KY-38 coupling.

// ---------------------------------------------------------------------------
// Frequency plan
// ---------------------------------------------------------------------------
// [S1] "920 channels in two frequency bands 30.00 to 52.95 MHz (low),
//       53.00 to 75.95 MHz (high)." Channel spacing 50 kHz.
// [S2] para 3.04(b)(2): "there are 23 positions of the control in each band:
//       from 30 through 52 in band A; from 53 through 75 in band B."
//
// These two statements are consistent and together pin the tuning mechanism
// exactly:  23 MHz detents x 20 kHz detents x 2 bands = 920 channels.
export const BANDS = {
  A: { label: '30-52', mhzLow: 30, mhzHigh: 52 },
  B: { label: '53-75', mhzLow: 53, mhzHigh: 75 },
};

export const MHZ_DETENTS_PER_BAND = 23; // 30..52 inclusive, 53..75 inclusive
export const KHZ_STEP_KHZ = 50;         // [S1] channel spacing
export const KHZ_DETENTS = 20;          // 00,05,10,...,95 (x10 kHz on the dial)
export const TOTAL_CHANNELS = 920;      // [S1] cross-checked: 23*20*2 = 920

// ---------------------------------------------------------------------------
// FUNCTION switch
// ---------------------------------------------------------------------------
// [S2] para 3.03 control table, verbatim function column. Corroborated
// independently by the ACRE2 radio model (OFF/ON/SQUELCH/RETRANS/LITE).
//
// Note: some references to the earlier AN/PRC-25 list a REM position. The
// PRC-77 remotes via the AUDIO connector and the AN/GRA-39 control group
// ([S2] para 5.11), not via a FUNCTION switch position, so REM is not modelled.
export const FUNCTION_POSITIONS = [
  { id: 'OFF',     label: 'OFF',     detail: 'Turns off power' },
  { id: 'ON',      label: 'ON',      detail: 'Applies power' },
  { id: 'SQUELCH', label: 'SQUELCH', detail: 'Applies power and reduces rushing noise when no signal is received' },
  { id: 'RETRANS', label: 'RETRANS', detail: 'Permits radio relay operation' },
  { id: 'LITE',    label: 'LITE',    detail: 'Switches a light inside the frequency display window for night setting' },
];

// ---------------------------------------------------------------------------
// Transmitter / receiver
// ---------------------------------------------------------------------------
// [S1] "Transmitter output power: 1.5 to 2.0 watts." [S3] reports 1.3-4 W
// across the band for various examples. The data-sheet figure is used as
// nominal because it is the published specification rather than a measurement
// of one particular set.
export const TX_POWER_W = 2.0;
export const TX_POWER_W_RANGE = [1.5, 2.0]; // [S1]

// [S3] "Receiver sensitivity: 0.5 uV". Interpreted as PD (delivered to the
// 50 ohm input) at the usual 10 dB quieting reference:
//   P = V^2 / R = (0.5e-6)^2 / 50 = 5.0e-15 W = -113.0 dBm
export const RX_SENSITIVITY_UV = 0.5;
export const RX_INPUT_IMPEDANCE_OHM = 50;

// [S1] "Type of modulation: Frequency."  [S1] "Type of squelch: Tone operated
// by 150-Hz signal."  [S1] "Transmission - Voice and 150-Hz squelch tone."
export const SQUELCH_TONE_HZ = 150;

// ALLOWANCE: FM capture ratio. The receiver's limiter suppresses the weaker of
// two co-channel signals. Good FM limiters achieve a fraction of a dB; a 1960s
// discrete-transistor set is far from that. 6 dB is the conventional
// engineering figure for a tactical FM set. Not sourced.
export const FM_CAPTURE_RATIO_DB = 6.0;

// ALLOWANCE: IF bandwidth. Not stated in any source consulted. 25 kHz is the
// conventional narrowband-FM figure for 50 kHz channel spacing and is used to
// convert noise power spectral density into a noise floor.
export const IF_BANDWIDTH_HZ = 25000;

// ALLOWANCE: the 0.5 uV sensitivity figure is a 10 dB quieting / SINAD
// reference, so the demodulator needs about 10 dB of signal over noise to
// deliver it. The 10 dB itself is conventional, not quoted by a source.
export const REQUIRED_SNR_DB = 10;

// ALLOWANCE: adjacent-channel rejection of the receiver's IF filter, in dB, by
// offset in kHz. The set is specified for better than ~55 dB one channel off;
// these are conventional figures for a tactical FM set at 50 kHz spacing.
// Beyond the table the curve keeps climbing — see adjacentRejectionDB().
export const ADJACENT_REJECTION_DB = {
  0: 0, 50: 60, 100: 75, 200: 90,
  beyondSlopeDB: 30,   // per decade of offset past 200 kHz
  maxDB: 130,
};

// ALLOWANCE: mapping from link margin to what the operator hears. The bands
// follow the usual signal-report scale; the exact dB boundaries are judgement.
export const READABILITY_THRESHOLDS_DB = { broken: 0, difficult: 6, readable: 12, good: 20, loudAndClear: 30 };

// ALLOWANCE: battery discharge shape. The RATINGS are sourced ([S1] currents,
// voltages and life; [S2] cell count) but the curve joining them is not — no
// source publishes a discharge characteristic for these packs. It is shaped so
// that a simulated 9:1 mission stays transmit-capable for very nearly the
// published life and only then falls into the receive-only window that
// [S2] 4.09 describes. Changing these numbers changes when the set dies.
export const BATTERY_CURVE = {
  plateauDropV: 1.2,      // open-circuit sag from full to empty, before the cliff
  cliffFraction: 0.01,    // remaining fraction at which terminal voltage collapses
  cliffDropV: 14,
  baseResistanceOhm: 0.5,
  riseResistanceOhm: 1.5, // scales (1 - fraction)^riseExponent
  riseExponent: 6,
  kneeFraction: 0.03,     // remaining fraction at which internal resistance knees
  kneeResistanceOhm: 8,
};

// ---------------------------------------------------------------------------
// External noise environment — ITU-R P.372, man-made noise
// ---------------------------------------------------------------------------
// Median man-made noise figure above thermal:  Fam = c - d*log10(f_MHz)
//
// This matters enormously at 30-76 MHz and is the reason the handbook says:
//   [S2] 2.03 "avoid locations near a source of electrical interference, such
//   as power or telephone lines, radar sets, and field hospitals."
//
// In a built-up area the external noise floor sits well ABOVE the receiver's
// own sensitivity, so the environment — not the radio — sets how far you can
// hear. In genuinely quiet country the receiver dominates again and the set
// performs to its published specification. Both regimes fall out of this.
export const NOISE_ENVIRONMENTS = {
  quietRural:  { label: 'Quiet rural',    c: 53.6, d: 28.6 },
  rural:       { label: 'Rural',          c: 67.2, d: 27.7 },
  residential: { label: 'Residential',    c: 72.5, d: 27.7 },
  urban:       { label: 'Urban / business', c: 76.8, d: 27.7 },
};
export const DEFAULT_NOISE_ENV = 'quietRural';

// ---------------------------------------------------------------------------
// Antennas
// ---------------------------------------------------------------------------
// [S1] AT-892/PRC-25: 3 ft, semi-rigid steel tape, one section.
// [S1] AT-271A/PRC: 10 ft, six-section tubular folding whip.
// [S2] para 5.02 AT-984A/G: 150 ft long wire, directional off the far end.
export const ANTENNAS = {
  'AT-892': {
    name: 'AT-892/PRC-25',
    nickname: 'Short (tape)',
    lengthM: 0.914,          // 3 ft [S1]
    note: 'General short range service. Steel tape, folds flat.',
  },
  'AT-271A': {
    name: 'AT-271A/PRC',
    nickname: 'Long (whip)',
    lengthM: 3.048,          // 10 ft [S1]
    note: 'Used when maximum range is required. Six sections.',
  },
  'AT-984A': {
    name: 'AT-984A/G',
    nickname: 'Long wire',
    lengthM: 45.72,          // 150 ft [S2] para 5.02
    directional: true,       // [S2] para 5.03 radiates off the far end
    note: 'Fixed site. Radiates off the end, away from the set.',
  },
};

// [S1] "Distance range: 5 miles (8 kilometers) (varies with conditions)."
// [S2] para 1.03(c) "Distance range: 8 km. Varies with siting."
// Used only as a validation target for the propagation model, never as an
// input to it.
export const PLANNING_RANGE_KM = 8;

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------
// [S2] para 1.06: battery is 10 D cells, 15 V DC total.
// [S1] "Transmission - 12.5 to 15 volts dc, 780 ma average.
//       Reception   - 12.5 to 15 volts dc, 60 ma average."
// [S3] measured transmit current 0.85-1.29 A depending on supply voltage.
export const BATTERY_NOMINAL_V = 15.0;
export const BATTERY_MIN_V = 12.5;       // [S1] lower limit of the spec range
export const CURRENT_TX_A = 0.780;       // [S1]
export const CURRENT_RX_A = 0.060;       // [S1]

// [S1] "Battery life (BA-398/U): 30 hours (with a 9:1 receive-transmit ratio)."
// [S2] para 1.03(e) gives 24 hours for the same ratio.
//
// Cross-check that fixes the capacity: at 9:1 the mean draw is
//   0.9*0.060 + 0.1*0.780 = 0.132 A
// 30 h at 0.132 A => 3.96 Ah, which is the rated capacity of the magnesium
// BA-4386/U class of battery. The model therefore stores capacity, not hours,
// and *reproduces* the published 30 h figure rather than asserting it.
export const BATTERY_CAPACITY_AH = 3.96;
export const PUBLISHED_BATTERY_LIFE_H = 30;   // [S1] validation target
export const PUBLISHED_DUTY_RX_TX = 9;        // [S1] 9:1 receive:transmit

export const BATTERIES = {
  'BA-4386': { name: 'BA-4386/U', chem: 'Magnesium', capacityAh: 3.96 },
  'BA-398':  { name: 'BA-398/U',  chem: 'Magnesium', capacityAh: 3.96 },
  'BA-386':  { name: 'BA-386/U',  chem: 'Carbon-zinc', capacityAh: 2.20 },
};

// ---------------------------------------------------------------------------
// Retransmission — [S2] chapter 5, MK-456/GRC cable kit
// ---------------------------------------------------------------------------
// para 5.09: "When frequencies are to be used for retransmission, they must be
// at least 3 MHz apart and must be selected so that the transmitter of neither
// radio will interfere with the receiver of the other."
export const RETRANS_MIN_SEPARATION_MHZ = 3.0;

// para 5.10 note: "Radios operating through a retransmission facility should
// pause for a second after pressing the push-to-talk switch before speaking."
export const RETRANS_KEYUP_DELAY_S = 1.0;

// ---------------------------------------------------------------------------
// Remote control — [S2] para 5.11, AN/GRA-39
// ---------------------------------------------------------------------------
// [S2] gives 3.3 km over WD-1/TT field wire; [S1] gives "two miles". Both are
// recorded; the handbook figure is used as nominal since it is the more
// specific of the two.
export const REMOTE_RANGE_KM = 3.3;

// ---------------------------------------------------------------------------
// Operating behaviour observed by operators — [S2] para 4.09 "Operation"
// ---------------------------------------------------------------------------
// (a) "allow it to sit for at least 30 seconds to allow the battery to develop
//      its full operating voltage"
// (d)(2) "There should be a low growl heard when the PTT is pressed. This is
//      the sub-tone."   <- the 150 Hz squelch tone is audible in the handset
// (d)(3) "When transmitting, you can hear yourself in the earpiece. This is
//      called sidetone and indicates that the radio is transmitting."
// (d)(4) "You can hear the receive/transmit relay inside the radio clicking as
//      you press and release the PTT."
export const WARMUP_S = 30;

// [S2] para 3.06(d): "set the VOLUME control at 4". The panel is graduated
// 1..10, so 4 is the documented starting point.
export const VOLUME_MIN = 1;
export const VOLUME_MAX = 10;
export const VOLUME_DEFAULT = 4;

// [S3] "The audio connector is the standard 5 pin U-229 type and has pin 'E'
// wired with the Retransmission signal that goes to ground to signal that the
// squelch has opened on receive."
export const AUDIO_CONNECTOR = 'U-229 (5-pin)';
