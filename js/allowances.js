// allowances.js — the audit registry.
//
// Every constant in the model that is NOT derived from first principles and
// NOT taken from a cited source, gathered in one place. If you distrust a
// number in this project, it is either cited in config.js or it is in here.
//
// The rule: anything tagged `// ALLOWANCE:` in the engine sources must appear
// in this registry. test/propagation.test.js scans the sources and enforces
// that, so the registry cannot quietly fall behind the code — which is exactly
// how it fell behind the first time.
//
// Values are re-exported by reference, never copied, so each has exactly one
// definition and changing it here is impossible.

import {
  IF_BANDWIDTH_HZ, REQUIRED_SNR_DB, FM_CAPTURE_RATIO_DB,
  ADJACENT_REJECTION_DB, READABILITY_THRESHOLDS_DB, BATTERY_CURVE,
} from './config.js';

import {
  GROUND_LOSS_OHM, COUNTERPOISE_LOSS_DB, MATCH_LOSS_SLOPE_DB,
  MATCH_LOSS_MAX_DB, CLUTTER, LONG_WIRE_GAIN_DBI, DIFFRACTION,
} from './propagation.js';

export const ALLOWANCES_DB = {
  // --- Antenna -------------------------------------------------------------
  GROUND_LOSS_OHM,
  COUNTERPOISE_LOSS_DB,
  MATCH_LOSS_SLOPE_DB,
  MATCH_LOSS_MAX_DB,
  LONG_WIRE_GAIN_DBI,

  // --- Path ----------------------------------------------------------------
  CLUTTER,
  DIFFRACTION,

  // --- Receiver ------------------------------------------------------------
  IF_BANDWIDTH_HZ,
  REQUIRED_SNR_DB,
  FM_CAPTURE_RATIO_DB,
  ADJACENT_REJECTION_DB,
  READABILITY_THRESHOLDS_DB,

  // --- Set -----------------------------------------------------------------
  BATTERY_CURVE,
};

/** Registry keys, for the guard test and for anyone auditing by hand. */
export const ALLOWANCE_KEYS = Object.keys(ALLOWANCES_DB);
