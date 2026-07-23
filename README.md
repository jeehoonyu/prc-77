# Radio Set AN/PRC-77

A working simulation of the AN/PRC-77 tactical VHF FM radio set — the
Vietnam-era manpack radio built around Receiver-Transmitter RT-841/PRC-77.

Zero dependencies, no build step. Open `index.html` or run `npm run serve`.

```bash
npm test
```

170 tests across three suites, all passing.

A full walkthrough of the design lives in
**[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)**.

---

## The short version

**Yes, this can be done with correct real-world logic — for almost all of it.**

The radio splits cleanly into three parts, and they need to be judged
separately, because "accurate" means something different for each:

| Part | Status | Why |
|---|---|---|
| Controls, tuning, squelch, battery, retrans | **Exact** | Fully specified in published manuals. Reproduced to the detent. |
| Range and signal quality | **Physically modelled** | No manual publishes "the" range, so this is computed from antenna theory, path loss and ITU-R P.372 noise, then validated against the published planning figure. |
| NESTOR / KY-38 voice encryption | **Deliberately omitted** | The algorithm is still classified. See below. |

---

## What is exact

Everything in this section is traceable to a source and enforced by a test.
Constants live in [`js/config.js`](js/config.js) with the citation inline.

**Tuning.** The set has a BAND switch, an MHz control with 23 detents, and a
kHz control with 20 detents. 23 × 20 × 2 = **920 channels** at 50 kHz spacing,
spanning 30.00–52.95 and 53.00–75.95 MHz. Both the channel count and the
detent count are independently sourced, and they multiply out exactly.

The MHz control's positions are *rotational*, not absolute — the control has 23
stops and the BAND switch decides which megahertz they land on. Throwing the
BAND switch does not move the controls; it reassigns them. Tune to 34.30 in
band A, flick to band B, and you are on 57.30.

**The PRESET levers.** Two channels held on mechanical stops. Turning a control
hard counter-clockwise finds one, clockwise the other. The ordering rule is the
best detail on the whole radio:

> …always set the lower section to that MHz frequency that is **lower in its
> band** … 54 is [the 2nd position in band B]; thus, 54 MHz would be set on the
> lower section and 33 MHz would be set on the upper section

The *higher* frequency takes the counter-clockwise stop, because the stops are
rotational positions and 54 MHz is only the 2nd detent of band B while 33 MHz
is the 4th of band A. The simulator enforces this, and reproduces the
consequence in §3.05(e): after selecting a preset in the other band the dial
shows a frequency, but it is the *wrong* one until you move the BAND switch.

There is also a case the handbook never mentions, which fell out of modelling
the stops as the two independent mechanisms they physically are: **not every
pair of frequencies can be preset.** If one frequency is lower on the MHz
control but higher on the kHz control, turning both controls counter-clockwise
lands on a third frequency that is neither of them. 39.35 and 59.70 cannot both
be stored. The simulator detects this and says so rather than silently storing
something the hardware could not hold.

**The 150 Hz tone squelch.** The most consequential logic on the set, and the
reason the handbook spends a page on a netting drill:

| FUNCTION | Incoming | Handset |
|---|---|---|
| OFF | anything | dead |
| ON | nothing | rushing noise |
| ON | any signal | audio — tone or not |
| SQUELCH | nothing | silent |
| SQUELCH | signal **without** 150 Hz tone | **silent** |
| SQUELCH | signal **with** 150 Hz tone | audio |

Row five is the trap. A set in SQUELCH cannot hear a transmitter whose tone is
absent — an AN/PRC-25, or a failed A54 squelch module — and it is
indistinguishable from a dead radio. Clear the tone checkbox in the UI and
watch a signal with 50 dB of margin vanish, then come straight back when you
drop to ON. That is precisely why the drill has both stations start in ON.

**The battery.** 10 D cells, 15 V, 60 mA receive, 780 mA transmit. The model
stores *capacity* and derives the hours, so the published "30 hours at a 9:1
receive-transmit ratio" is a **cross-check, not an input** — and it comes out
at 30.0 h.

It also reproduces the failure the handbook warns about: a tired battery that
receives but will not transmit. That is not scripted. Internal resistance rises
as the cells deplete, transmit draws 13× the receive current, so the transmit
load drags the terminal voltage under the 12.5 V floor while the receive load
is still comfortably above it. Simulated on a real 9:1 duty cycle the set stays
transmit-capable for 28.98 h, against the published 30 h.

Keying that flat battery does **not** quietly do nothing. The antenna
changeover relay is mechanical and throws on the switch, so the set goes deaf
whether or not the transmitter can produce output — and the *absent sidetone*
is the operator's diagnostic, exactly as the handbook describes.

**Retransmission.** Two sets back to back via the MK-456/GRC cable, with the
≥3 MHz separation rule enforced. The test suite sets up two outstations 12 km
apart that cannot work each other directly, drops a relay between them, and
confirms traffic gets through.

---

## What is physically modelled

Range is the one thing no manual can hand you. What the sources publish is a
planning figure — 8 km, *"varies with siting"* — plus a page of siting advice.

So [`js/propagation.js`](js/propagation.js) does not hard-code 8 km. It
implements the standard physics and lets range fall out:

- **Antenna gain** from the exact monopole pattern integral,
  `F(θ) = [cos(kh·cosθ) − cos(kh)] / sinθ`, numerically integrated for
  directivity and radiation resistance
- **Efficiency** from radiation resistance against a counterpoise loss
  *resistance* — modelled as a resistance, not a flat decibel figure, which
  matters enormously (see below)
- **Path loss** as the greater of free-space and plane-earth two-ray
- **Radio horizon** over a 4/3 earth, with a diffraction penalty past it
- **Clutter** allowances for the site types the handbook warns about
- **External noise** per ITU-R P.372, combined with the receiver's own noise to
  give the sensitivity the set actually achieves at a given site

### Does it work?

The model reproduces closed-form textbook results before it is allowed
anywhere near a field figure — otherwise agreement with "8 km" would only mean
the fudge factors had been tuned until the answer came out:

| Check | Expected | Model |
|---|---|---|
| Quarter-wave monopole radiation resistance | 36.5 Ω | **36.54 Ω** |
| Quarter-wave monopole directivity | 5.15 dBi | **5.16 dBi** |
| Short monopole directivity | 4.77 dBi | **4.77 dBi** |
| Short monopole base Rr vs 40π²(h/λ)² | 0.0395 Ω | **0.0394 Ω** |
| Free-space loss, 1 km at 50 MHz | 66.43 dB | **66.43 dB** |
| Radio horizon vs the 4.12 rule | 27.61 km | **27.62 km** |
| 0.5 µV into 50 Ω | −113.0 dBm | **−113.01 dBm** |
| Plane-earth loss vs explicit two-ray phasor sum | identical | **agrees to 0.01 dB** |

Only then, the field figures. With the long whip, manpack to manpack, open
ground, quiet site: **7.4 km**. The published planning figure is 8 km. That
number is never an input to the model.

The short tape antenna comes out at 4.0 km — about half — matching its
description as being for *"general short range service"* while the long whip is
*"used when maximum range is required."* Siting behaves as the handbook says it
does: dense woods and valleys cut the range sharply, and a 30 m hilltop more
than triples it, bounded by the radio horizon exactly as it should be.

### The environment often beats the radio

The published 0.5 µV sensitivity assumes the receiver's own noise dominates. At
30–76 MHz that is only true in quiet country:

| Environment | Usable sensitivity | Penalty | Range, long whip |
|---|---|---|---|
| Quiet rural | −110.9 dBm | 2.1 dB | 7.4 km |
| Rural | −99.7 dBm | 13.3 dB | 3.9 km |
| Residential | −94.5 dBm | 18.5 dB | 2.9 km |
| Urban | −90.3 dBm | 22.8 dB | 2.3 km |

Same terrain, same antennas, same power — only the electrical noise changes.
This is what gives teeth to the handbook's *"avoid locations near a source of
electrical interference, such as power or telephone lines, radar sets"*, and it
is modelled as a control separate from terrain, because a valley can be quiet
and an open field beside a power line can be very noisy.

### Two modelling decisions worth recording

The first version of the antenna model made the 3 ft tape and the 10 ft whip
come out nearly *equal*, which contradicts the manuals outright. Two causes:
an arbitrary mismatch term letting half-wave anti-resonance dominate, and
treating the counterpoise as a flat dB allowance.

The fix was to model counterpoise loss as what it physically is — a series
**resistance**. That makes the model self-correcting: the 3 ft tape has a
radiation resistance of 1 Ω at 30 MHz, so a lossy body counterpoise swamps it;
the 10 ft whip at 62 Ω barely notices. A flat decibel allowance cannot express
that difference. The manuals were right and the first model was wrong.

Second: the battery curve originally killed transmit at 21.5 h with 28% of the
capacity unused, so `batteryLifeHours(9)` advertised 30 h while an actual
simulated mission managed 21.5 h. A headline figure the simulation cannot
reproduce is worse than no figure at all. There is now a test that runs the
mission minute by minute and requires the two to agree.

### A prediction, not a citation

At 75.95 MHz the 10 ft whip is 0.77 wavelengths, its pattern lifts off the
horizon, and it *loses* to the 3 ft tape. No source states this; it falls out
of the pattern integral. It is standard behaviour for fixed-length whips over
a wide band and it is why the long whip works best low in the band — but it is
flagged here as a model output rather than a documented fact.

Every engineering allowance that is not derived from first principles is
tagged `ALLOWANCE` in the source and collected in `ALLOWANCES_DB`, so it can be
inspected and argued with rather than buried.

---

## What was deliberately left out

**NESTOR voice encryption (KY-38 / X-MODE).** The PRC-77's headline improvement
over the PRC-25 was its ability to work with secure voice equipment. It is
genuinely part of the radio — and it is the one part that **cannot** be
simulated with correct real-world logic.

The NESTOR family's key generator has never been publicly specified. There is
no published algorithm, no test vector, nothing to be correct *against*. I
could reproduce the *behaviour* — a sync preamble, garble on a key mismatch,
the characteristic degraded audio — but that would be a costume, not a
cryptosystem, and putting it beside an Enigma engine that is exactly correct
would be actively misleading about which one you can trust.

So it is out. The AUDIO connector and its U-229 pinout are modelled, including
pin E carrying the retransmission/squelch-open signal; what would plug into it
is not.

Two smaller omissions, for completeness:

- **Circuit-level analogue simulation.** The superhet chain and AFC loop are
  not simulated. Not needed for behaviour and not attempted.
- **Actual RF.** Two browser tabs cannot transmit to each other. The included
  second station is simulated in the same page.

---

## Layout

```
js/config.js       every published constant, with its citation
js/radio.js        the RT-841 itself — controls, presets, battery (DOM-free)
js/propagation.js  antenna theory and path loss (DOM-free)
js/net.js          the air — capture effect, squelch gating, relay (DOM-free)
js/audio.js        Web Audio handset
js/app.js          panel wiring
test/              150 tests
```

The three engine modules are DOM-free so they run unchanged in the browser and
under Node.

## Sources

- **[S1]** *AN/PRC-77 Tactical Radio Set*, manufacturer data sheet, Associated
  Industries — [qsl.net](https://www.qsl.net/ta2ei/cihaz/prc77/ANPRC77.pdf)
- **[S2]** Australian Army Cadets, *Cadet Instructor's Handbook — Radio Set
  AN/PRC-77*, June 2007, derived from the TM / User Handbook —
  [auscadet](https://auscadet.wordpress.com/wp-content/uploads/2013/11/cadet-instructors-handbook-radio-set-an-prc-77-2007.pdf)
- **[S3]** [prc68.com](http://www.prc68.com/I/PRC77.shtml) — measured current
  drain, U-229 pinout, receiver sensitivity
- **[S4]** [Crypto Museum](https://www.cryptomuseum.com/radio/prc77/) — panel
  layout, X-MODE, KY-38 coupling

Where sources disagree — transmitter power, battery life, remote-control range
— both figures are recorded in `config.js` and the choice is justified in a
comment.

## Licence

MIT.
