# How it works

A walk through the AN/PRC-77 simulator, from the knobs on the panel to the
signal arriving at the far end. Read top to bottom the first time; after that
each part stands alone.

---

## 1. The shape of the thing

Four modules, three of them free of any DOM reference so they run identically
in the browser and under Node:

```
config.js        every published constant, each with its citation
   |
   +--> radio.js        one RT-841: knobs, presets, battery, PTT
   |
   +--> propagation.js  antennas and path loss — pure physics, no radio state
   |
   +--> net.js          couples radios: who hears whom, and how well
            |
            +--> audio.js   Web Audio handset
            +--> app.js     panel wiring
```

The dependency arrows only point one way. `propagation.js` knows nothing about
radios — hand it a distance, a frequency and two antenna names and it hands
back decibels. `radio.js` knows nothing about other radios. `net.js` is the
only module that knows more than one station exists.

That separation is what makes the thing testable. Every claim about how the
radio behaves is a function call with no setup.

---

## 2. The radio itself

### 2.1 How a frequency gets set

Three controls between you and a frequency:

- **BAND** switch — `30-52` or `53-75`
- **MHz** control — 23 positions
- **kHz** control — 20 positions

23 × 20 × 2 = **920 channels**, at 50 kHz spacing, covering 30.00–52.95 and
53.00–75.95 MHz. Both the 920 and the 23-per-band come from separate sources
and they multiply out exactly, which is a good sign that both are right.

The important subtlety: **the MHz control's positions are rotational, not
absolute.** The control has 23 detents; the BAND switch decides which 23
megahertz they land on. Internally that is `mhzIndex`, 0–22 — never a
megahertz value:

```js
detentsToKHz(band, mhzIndex, khzIndex)
  => (BANDS[band].mhzLow + mhzIndex) * 1000 + khzIndex * 50
```

Throwing the BAND switch does not move the controls. Tune 34.30 in band A,
flick to band B, and you read 57.30 — same detents, different band.

Everything is held as **integer kilohertz**. The set steps in 50 kHz, so
integers are exact; decimal megahertz would accumulate floating-point dust
(`30.05 + 0.05 !== 30.1`).

### 2.2 The PRESET levers

Two channels held on mechanical stops. Swing the levers forward and the
controls can no longer travel past them — turn hard counter-clockwise for one
preset, hard clockwise for the other.

Which frequency gets which stop is the best detail on the radio:

> …always set the lower section to that MHz frequency that is **lower in its
> band** … 54 is [the 2nd position in band B]; thus, 54 MHz would be set on
> the lower section and 33 MHz would be set on the upper section

The *higher* frequency takes the counter-clockwise stop. That looks wrong until
you remember the stops are rotational positions: 54 MHz is the 2nd detent of
band B, 33 MHz is the 4th of band A, and 2 < 4. `setPresets()` computes this
from the detent indices, so the rule is not encoded anywhere — it falls out.

The consequence, straight from §3.05(e): select a preset that lives in the
other band and the dial shows a frequency, but the **wrong** one, until you
move the BAND switch by hand. The stops cannot move it for you. The simulator
returns `bandWrong: true` and tells you which way to throw it.

**And a case the handbook never covers.** The two controls are separate
mechanisms — the MHz stops know nothing about the kHz stops. Selecting a preset
means turning *both* controls to the *same* side, so the only two frequencies
the mechanism can produce are (MHz-low, kHz-low) and (MHz-high, kHz-high).

If one frequency is lower on the MHz control but higher on the kHz control,
the pair cannot be stored. Try 39.35 and 59.70: turning both counter-clockwise
lands on 59.35, which is neither. The simulator detects this and refuses,
rather than silently storing something the hardware could not hold.

### 2.3 The FUNCTION switch

`OFF · ON · SQUELCH · RETRANS · LITE`

`ON` and `SQUELCH` differ only in whether the 150 Hz tone gate is in circuit —
see §4.2. `LITE` lights the dial window. `RETRANS` enables relay operation.

### 2.4 The battery, and why it dies the way it does

10 D cells, 15 V. Receive draws 60 mA; transmit draws 780 mA — **13 times as
much**. That ratio drives everything.

The model stores **capacity**, not hours, and derives the rest:

```
mean current at 9:1  = 0.9 x 0.060 + 0.1 x 0.780 = 0.132 A
3.96 Ah / 0.132 A    = 30.0 h
```

which is the published figure. It is a cross-check, not an input.

Terminal voltage comes from an open-circuit curve minus `I x R_internal`, and
internal resistance climbs as the cells deplete. That single mechanism produces
the failure the handbook warns about:

> it is possible to provide enough power for the radio to receive but not
> transmit

Nothing scripts that. As `R_internal` rises, the 780 mA transmit load drags the
terminal voltage under the 12.5 V floor while the 60 mA receive load is still
comfortably above it. Simulated on a real 9:1 duty cycle: transmit-capable for
**28.98 h**, then a receive-only window, then dead.

> **This was wrong at first and is worth recording.** The original curve killed
> transmit at 21.5 h with 28% of the battery unused — so `batteryLifeHours(9)`
> claimed 30 h while an actual simulated mission gave 21.5 h. A headline figure
> the simulation cannot reproduce is worse than no figure. There is now a test
> that runs the mission minute by minute and requires the two to agree.

### 2.5 PTT: held versus radiating

Two separate flags, and the distinction matters:

- `pttHeld` — the operator is pressing the switch
- `ptt` — the set is actually radiating

Pressing PTT throws the **antenna changeover relay**, which is mechanical. It
throws whether or not the transmitter can produce output, so a keyed set is
deaf either way. On a flat battery you get the state `keyed-dead`: deaf,
buzzing, and — the diagnostic — **no sidetone**:

> You should hear yourself in the earpiece when you speak. If not, the battery
> has insufficient power left.

An earlier version simply refused to key on a flat battery, leaving the set
happily receiving. That was wrong: it removed the very symptom the operator is
supposed to notice.

---

## 3. The physics

`propagation.js` is the only part not taken from a manual, because no manual
publishes a range. What they publish is a *planning figure* — 8 km, "varies
with siting" — and a page of siting advice.

So the module implements standard physics and lets range fall out. The 8 km
figure is a **validation target**, never an input.

### 3.1 Antenna gain

Exact monopole far-field pattern for a sinusoidal current distribution:

```
F(θ) = [cos(kh·cosθ) − cos(kh)] / sinθ        θ = π/2 is the horizon
```

Numerically integrated (Simpson, 2000 points) over the upper hemisphere to get
both directivity and radiation resistance. It reproduces the textbook constants
to three figures — 36.54 Ω and 5.16 dBi for a quarter-wave monopole, against
36.5 Ω and 5.15 dBi.

Realised gain is then:

```
gain = directivity
     + 10log10(efficiency)      efficiency = R_base / (R_base + R_loss)
     − matching-network loss     bounded, grows with transformation ratio
     − pattern-distortion allowance
```

`R_base = R_r / sin²(kh)` — radiation resistance referred to the **base**
current rather than the current maximum. That transformation is not
bookkeeping: it is what produces the anti-resonance the 10 ft whip hits near
half-wave, and it is tested explicitly.

> **The decision that made this model work.** The first version treated the
> counterpoise as a flat decibel allowance, and the 3 ft tape came out nearly
> equal to the 10 ft whip — flatly contradicting the manuals. Modelling it as a
> series **resistance** instead made the model self-correcting: the tape has a
> radiation resistance of 1 Ω at 30 MHz, so a lossy body counterpoise swamps
> it, while the whip at 62 Ω barely notices. A flat dB figure cannot express
> that difference. The manuals were right; the model was wrong.

### 3.2 Path loss

Two regimes, and the greater of the two is used:

- **Free space** close in: `20log10(4πd/λ)`
- **Plane earth** beyond the breakpoint: `40log10(d) − 20log10(h₁h₂)`

The breakpoint is `4πh₁h₂/λ` — for two manpack sets at 1.5 m, about **4.7 m**.
So essentially every real link is in the fourth-power regime, where loss climbs
**12 dB per doubling of distance** and frequency drops out entirely.

This is why the handbook's siting advice matters so much: the `20log10(h₁h₂)`
term means antenna height buys 6 dB per doubling, at *both* ends.

The closed-form plane-earth formula was checked against an explicit two-ray
phasor sum of the direct and ground-reflected rays. They agree to **0.01 dB**
at every distance tested.

Past the radio horizon (4/3 earth, `4.12(√h₁+√h₂)` km) a diffraction penalty
ramps in, and a clutter allowance covers the site types the handbook warns
about.

### 3.3 Noise — why the environment beats the radio

The published 0.5 µV sensitivity (−113.0 dBm into 50 Ω) assumes the receiver's
own noise dominates. At 30–76 MHz that is only true in quiet country.

Man-made noise per ITU-R P.372:

```
Fam = c − d·log10(f_MHz)          N = −174 + Fam + 10log10(B)
```

The receiver's own noise, implied by its sensitivity at a 10 dB SINAD
reference, is −123.0 dBm. Compare:

| Environment | Noise floor | Usable sensitivity | Penalty | Range |
|---|---|---|---|---|
| Quiet rural | −125.0 dBm | −110.9 dBm | 2.1 dB | 7.4 km |
| Rural | −109.9 dBm | −99.7 dBm | 13.3 dB | 3.9 km |
| Residential | −104.6 dBm | −94.5 dBm | 18.5 dB | 2.9 km |
| Urban | −100.3 dBm | −90.3 dBm | 22.8 dB | 2.3 km |

In quiet country the receiver still dominates and the set performs to
specification. In town the **environment** sets the sensitivity and the radio's
own figure is irrelevant. That is a real, well-documented property of low VHF,
and it is what gives teeth to:

> avoid locations near a source of electrical interference, such as power or
> telephone lines, radar sets, and field hospitals

Noise environment is deliberately a **separate control from terrain**, because
they are separate things: a valley can be electrically quiet, and an open field
beside a power line can be very noisy.

### 3.4 A worked link — 3 km, 50 MHz, long whips, open ground, quiet site

```
  transmitter power           +33.01 dBm     (2.0 W)
  transmit antenna gain        +1.90 dBi     AT-271A at 50 MHz
  receive antenna gain         +1.90 dBi
                              ---------
  free-space loss at 3 km      75.97 dB      not used
  plane-earth loss at 3 km    132.04 dB      <- larger, so this governs
  breakpoint                    4.72 m       (we are far past it)
  radio horizon                10.10 km      (3 km is well inside)
  diffraction penalty           0.00 dB
                              ---------
  total path loss             132.04 dB
  received power              -95.22 dBm

  receiver's own noise       -123.01 dBm
  external noise (quiet)     -125.01 dBm
  combined -> usable sens    -110.89 dBm     (2.12 dB worse than spec)

  margin                      +15.66 dB  ->  "Readable"
```

Every one of those numbers is a live function call. Change the antenna, the
terrain, the noise environment, or a height, and the chain re-derives.

---

## 4. The channel

### 4.1 Who hears whom

For each receiving station, `net.js` walks every transmitter, computes a link
budget, and applies **adjacent-channel rejection** — a rejection, not a filter,
so a very strong local set can still bleed through one channel off. It does,
and it should.

**FM capture** then decides what the demodulator gets. The limiter hands it the
strongest signal; if the runner-up is within the capture ratio (6 dB), neither
wins cleanly and the operator gets a garble. Two equidistant stations garble;
move one to twice the distance and — in the fourth-power regime — it falls
12 dB behind and the near one captures cleanly.

### 4.2 Squelch: the truth table

| FUNCTION | Incoming | Handset |
|---|---|---|
| OFF | anything | dead |
| ON | nothing | rushing noise |
| ON | any signal | audio — tone or not |
| SQUELCH | nothing | silent |
| SQUELCH | signal **without** 150 Hz tone | **silent** |
| SQUELCH | signal **with** 150 Hz tone | audio |

Row five is the whole point. The gate is opened by the **tone**, not by signal
strength. A PRC-77 in SQUELCH cannot hear a transmitter whose tone is absent —
an AN/PRC-25, or a failed A54 squelch module — and it is indistinguishable from
a dead radio.

The simulator reports the suppressed signal in `suppressedSignal` rather than
hiding it, so the UI can tell you a 50 dB signal is sitting right there being
held out.

This is exactly why the netting drill starts both stations in `ON`:

```
ALPHA in ON, air quiet                          -> rushing
distant station transmits, ALPHA in ON          -> receiving
ALPHA in SQUELCH, air quiet                     -> silent
distant transmits WITH tone, ALPHA SQUELCH      -> receiving
distant transmits WITHOUT tone, ALPHA SQUELCH   -> silent      <-- the trap
ALPHA falls back to ON                          -> receiving
```

The drill distinguishes "no tone" from "out of range" — two failures that look
identical from behind the handset.

### 4.3 Retransmission

Two sets wired back to back, on frequencies **at least 3 MHz apart** so neither
transmitter desensitises the other's receiver. A station in `RETRANS` whose
partner is also in `RETRANS` re-radiates on the partner's frequency.

One relay hop is resolved — that is what doctrine sites. Chained relays would
need a loop guard and are not attempted.

---

## 5. Checking it yourself

```bash
npm test        # 170 tests, three suites
```

The suites are ordered deliberately. `propagation.test.js` checks closed-form
textbook results **first** — quarter-wave monopole, free-space loss, radio
horizon, sensitivity — and only then compares against field figures. If the
physics did not reproduce values you can look up in an antenna textbook, then
agreement with "8 km" would prove nothing except that the fudge factors had
been tuned until the answer came out.

Some things worth poking at in the UI:

- Clear **"transmits the 150 Hz squelch tone"** with the set in SQUELCH. Watch
  a strong signal vanish. Switch to ON — it was there all along.
- Set the distance to 6 km with the long whip, then switch to the 3 ft tape.
- Leave the distance alone and change only the **noise environment**. Range
  collapses for reasons that have nothing to do with path loss.
- Raise your antenna height to 30 m. Note the range is now bounded by the
  **radio horizon**, not by power.
- Preset 54.00 and 33.00, engage the levers, and select the counter-clockwise
  stop. It gives you 54.00 — the *higher* frequency — and tells you to move the
  BAND switch.

---

## 6. Where the numbers come from

Everything in `config.js` carries a citation tag, `[S1]`–`[S4]`, listed in the
README. Where sources disagree — transmitter power, battery life,
remote-control range — both figures are recorded and the choice is justified in
a comment.

Everything in `propagation.js` that is *not* derived from first principles is
tagged `ALLOWANCE` and collected in `ALLOWANCES_DB`: counterpoise loss
resistance, matching-network loss bounds, clutter figures, IF bandwidth. They
are gathered in one place specifically so they can be inspected and argued
with rather than buried in the middle of a formula.

If you disagree with one, change it and re-run the tests. The closed-form
checks will hold; the field-figure checks will tell you whether your number is
defensible.
