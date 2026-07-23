# Radio Set AN/PRC-77

[![tests](https://github.com/jeehoonyu/prc-77/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/jeehoonyu/prc-77/actions/workflows/tests.yml)

A working simulation of the AN/PRC-77 tactical VHF FM radio set — the
Vietnam-era manpack radio built around Receiver-Transmitter RT-841/PRC-77.

![The RT-841/PRC-77 front panel: MHz and kHz tuning controls with their PRESET
levers, the dial window reading 35.00, BAND and FUNCTION switches with SQUELCH
lit, PUSH TO TALK, and a live link readout to station BRAVO showing −94.5 dBm,
132 dB of path loss and +14.1 dB of margin.](docs/screenshot.png)

## Run it

Zero dependencies and no build step — but the panel loads `js/app.js` as an ES
module, and browsers refuse to resolve module imports from a `file://` origin.
**Opening `index.html` from disk does not work**: the stylesheet still loads, so
you get a perfect olive-drab panel that does nothing. Serve it over HTTP.

```bash
npm run serve   # node tools/serve.js  ->  http://localhost:8000
npm test        # 175 tests, three suites, no server needed
```

Node 22+. In the browser you need ES modules and Web Audio: Chrome/Edge 89+,
Firefox 89+, Safari 15+. Hold <kbd>Space</kbd> for push-to-talk. Handset audio
needs the *Enable handset audio* button — browsers do not allow sound before a
click.

## The short version

Every part of this radio but one can be checked against something real: a
manual, a closed-form textbook result, or a published planning figure.

The three parts have to be judged separately, because "accurate" means
something different for each:

| Part | Status | Why |
|---|---|---|
| Controls, tuning, squelch, battery\*, retrans\* | **Exact** | Specified in published manuals. Reproduced to the detent. |
| Range and signal quality | **Physically modelled** | No manual publishes "the" range, so it is computed from antenna theory, path loss and ITU-R P.372 noise, then checked against closed-form results and the published planning figure. |
| NESTOR / KY-38 voice encryption | **Deliberately omitted** | The algorithm has never been published. There is nothing to be correct against. |

\* Two qualifications, both expanded below. The battery's *ratings* are sourced;
its *discharge curve* is shaped, not sourced. The 3 MHz retransmission
separation rule is checked and reported, not enforced.

A full walkthrough of the design is in **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)**.

## What is exact

Traceable to a source, and enforced by a test. Constants live in
[`js/config.js`](js/config.js) with the citation inline.

**Tuning.** A BAND switch, an MHz control with 23 detents, and a kHz control
with 20. 23 × 20 × 2 = **920 channels** at 50 kHz spacing, spanning 30.00–52.95
and 53.00–75.95 MHz. The channel count and the detent count come from different
sources and multiply out exactly.

The MHz control's positions are *rotational*, not absolute — it has 23 stops and
the BAND switch decides which megahertz they land on. Throwing the BAND switch
does not move the controls; it reassigns them. Tune 34.30 in band A, flick to
band B, and you are on 57.30.

**The PRESET levers.** Two channels held on mechanical stops: turn a control
hard counter-clockwise for one, clockwise for the other. Which frequency gets
which stop follows a rule that looks wrong until you see why:

> …always set the lower section to that MHz frequency that is **lower in its
> band** … 54 is [the 2nd position in band B]; thus, 54 MHz would be set on the
> lower section and 33 MHz would be set on the upper section

The *higher* frequency takes the counter-clockwise stop, because the stops are
rotational positions: 54 MHz is the 2nd detent of band B, 33 MHz the 4th of
band A. Select a preset that lives in the other band and the dial shows a
frequency, but the wrong one, until you move the BAND switch by hand.

A case the handbook never mentions falls out of modelling the two stops as the
independent mechanisms they are: **not every pair of frequencies can be
preset.** Selecting means turning *both* controls to the *same* side, so if one
frequency is lower on the MHz control but higher on the kHz control, the pair
cannot be stored — 39.35 and 59.70 would land you on 59.35, which is neither.
The simulator detects that and says so.

**The 150 Hz tone squelch.** The most consequential logic on the set, and the
reason the handbook spends a page on a netting drill:

| FUNCTION | Incoming | Handset |
|---|---|---|
| OFF | anything | dead |
| ON | nothing | rushing noise |
| ON | any signal above threshold | audio — tone or not |
| SQUELCH | nothing | silent |
| SQUELCH | signal **without** 150 Hz tone | **silent** |
| SQUELCH | signal **with** 150 Hz tone | audio |

Row five is the trap. The gate is opened by the *tone*, not by signal strength.
A set in SQUELCH cannot hear a transmitter whose tone is absent — an AN/PRC-25,
or a failed A54 squelch module — and it is indistinguishable from a dead radio.
Clear the tone checkbox in the UI and watch a signal the readout calls *Good*,
+21 dB of margin at the shipped 2 km default, vanish completely; then drop to ON
and it is there all along. That is why the drill starts both stations in ON.

**The battery.** 10 D cells, 15 V, 60 mA receive, 780 mA transmit.

Capacity is what the model stores, and it is fixed *from* the published life: at
9:1 the mean draw is 0.132 A, so [S1]'s 30 h pins the pack at 3.96 Ah.
`batteryLifeHours(9)` therefore returns exactly 30.0 h **by construction** —
that is bookkeeping, not a result, and unlike the range figure below it could
not have come out any other way.

What could have failed is the next one. Terminal voltage comes from a discharge
curve, and transmit draws 13× the receive current, so as internal resistance
rises the transmit load drags the voltage under the 12.5 V floor while the
receive load is still above it. That reproduces the failure the handbook warns
about — a battery that receives but will not transmit — and the *mechanism* is
emergent, not scripted. Driven minute by minute on a 9:1 duty cycle the set
stays transmit-capable for 28.98 h against the closed-form 30.0 h, stranding
3.4% of the pack. (The curve's shape was tuned to achieve that; it is an
internal-consistency check between two parts of the model, not independent
confirmation against the manual.)

Keying a flat battery does not quietly do nothing. The antenna changeover relay
is mechanical and throws on the switch, so the set goes deaf whether or not the
transmitter can produce output — and the *absent sidetone* is the operator's
diagnostic, exactly as the handbook describes. You can hear it: enable handset
audio, run the battery down, key the set. Relay click, silence, a buzz, and no
sidetone.

**Retransmission.** Two sets back to back via the MK-456/GRC cable, with the
≥3 MHz separation rule checked and reported. The test suite puts two outstations
12 km apart that cannot work each other directly, drops a relay between them,
and confirms traffic gets through. The rule is advisory in the model because
there is no co-site desensitisation term for it to act on — see the omissions
below.

## What is physically modelled

Range is the one thing no manual can hand you. What the sources publish is a
planning figure — 8 km, *"varies with siting"* — plus a page of siting advice.

So [`js/propagation.js`](js/propagation.js) does not hard-code 8 km. It
implements the standard physics and lets range fall out:

- **Antenna gain** from the monopole pattern integral,
  `F(θ) = [cos(kh·cosθ) − cos(kh)] / sinθ`, numerically integrated for
  directivity and radiation resistance. Sinusoidal current is assumed — a
  standard thin-wire approximation, least accurate near anti-resonance
- **Efficiency** from radiation resistance against a counterpoise loss
  *resistance* — not a flat decibel figure, which matters enormously (below)
- **Path loss** as the greater of free-space and plane-earth two-ray
- **Radio horizon** over a 4/3 earth, with a diffraction penalty past it
- **Clutter** allowances for the site types the handbook warns about
- **External noise** per ITU-R P.372 [S5], combined with the receiver's own
  noise to give the sensitivity the set actually achieves at a given site

### Does it work?

The model reproduces closed-form results before it is allowed near a field
figure — otherwise agreement with "8 km" would only mean the fudge factors had
been tuned until the answer came out:

| Check | Expected | Model |
|---|---|---|
| Quarter-wave monopole radiation resistance | 36.5 Ω | **36.54 Ω** |
| Quarter-wave monopole directivity | 5.15 dBi | **5.16 dBi** |
| Short monopole directivity | 4.77 dBi | **4.77 dBi** |
| Short monopole base Rr vs 40π²(h/λ)² | 0.03948 Ω | **0.03947 Ω** |
| Free-space loss, 1 km at 50 MHz | 66.43 dB | **66.43 dB** |
| Radio horizon vs the 4.12 rule | 27.61 km | **27.62 km** |
| 0.5 µV into 50 Ω | −113.0 dBm | **−113.01 dBm** |

The plane-earth closed form is also checked against an explicit two-ray phasor
sum (agrees to 0.01 dB past the breakpoint) — but that one is an internal
consistency check, not independent confirmation: the closed form *is* the
small-angle limit of that sum, so it catches coding errors only.

**What "range" means here:** the distance at which link margin reaches 0 dB —
received power equal to the 10 dB SNR the published 0.5 µV sensitivity is
referenced to, on the median path, with no fade margin. With the long whip,
manpack to manpack, open ground and a quiet site that is **7.4 km**, against a
published planning figure of 8 km. That number is never an input to the model.

Two honesty notes. At 0 dB margin the model's own readability scale says
*"broken and unreadable"* — the first genuinely copyable distance is 5.2 km, and
4.2 km if you want 10 dB in hand. And nobody knows what margin is baked into the
manuals' 8 km; the sources say only "varies with siting."

The 3 ft tape antenna comes out at 4.0 km, roughly half, matching its
description as being for *"general short range service"* while the long whip is
*"used when maximum range is required."* Drag your antenna height to 30 m in the
UI and range goes to 28.2 km — nearly quadruple — running up against the 27.6 km
radio horizon, where the diffraction penalty takes over. Dense woods and valleys
cut it sharply, exactly as the siting advice says.

### The environment often beats the radio

The published 0.5 µV sensitivity assumes the receiver's own noise dominates. At
30–76 MHz that is only true in quiet country. Move the same link from quiet
country into town and usable range falls from **7.4 km to 2.3 km** on identical
hardware — same terrain, same antennas, same power, only the electrical noise
changes. That is what gives teeth to the handbook's *"avoid locations near a
source of electrical interference, such as power or telephone lines, radar
sets"*, and it is a control separate from terrain, because a valley can be quiet
and an open field beside a power line can be very noisy.
(Full table: [HOW-IT-WORKS §3.3](docs/HOW-IT-WORKS.md).)

### Two modelling decisions worth recording

The first antenna model made the 3 ft tape and the 10 ft whip come out nearly
*equal*, contradicting the manuals outright. Two causes: an arbitrary mismatch
term letting anti-resonance dominate, and treating the counterpoise as a flat dB
allowance.

The fix was to model counterpoise loss as what it physically is — a series
**resistance**. That makes the model self-correcting: at 30 MHz the tape's
radiation resistance is 1.0 Ω referred to the current maximum, 3.5 Ω at the
feed, against a 25 Ω loss resistance — 12% efficient. The whip is 62 Ω and 70 Ω
— 74% efficient. A flat decibel allowance cannot express that difference. The
manuals were right and the first model was wrong.

Second: the battery curve originally killed transmit at 21.5 h with 28% of the
capacity unused, so `batteryLifeHours(9)` advertised 30 h while a simulated
mission managed 21.5 h. A headline figure the simulation cannot reproduce is
worse than no figure. There is now a test that runs the mission minute by minute
and requires the two to agree.

### A prediction, not a citation

Across the band the 10 ft whip does three different things: half-wave
anti-resonance at 49.2 MHz where the feed impedance runs away, best horizon gain
near 60 MHz, then the pattern lifting off the horizon past 0.625 λ until at
**73.8 MHz it loses to the 3 ft tape** — by 2.08 dB at the top of band B. No
source states this; it falls out of the pattern integral, and it is standard
behaviour for fixed-length whips over a wide band. Flagged as a model output,
not a documented fact.

Every constant that is not derived from first principles or taken from a source
is tagged `ALLOWANCE` and collected in [`js/allowances.js`](js/allowances.js) —
counterpoise and matching losses, clutter, diffraction, IF bandwidth, capture
ratio, adjacent-channel rejection, readability thresholds, the battery curve.
A test scans the sources and fails if a tagged value is missing from the
registry, so it cannot quietly fall behind the code again.

## What was deliberately left out

**NESTOR voice encryption (KY-38 / X-MODE).** The PRC-77's headline improvement
over the PRC-25 was working with secure voice equipment. It is genuinely part of
the radio — and it is the one part that cannot be simulated against anything
checkable.

The NESTOR family's key generator has never been publicly specified. There is no
published algorithm and no test vector. The behaviour is reproducible — a sync
preamble, garble on a key mismatch, the characteristic degraded audio — but that
would be a costume rather than a cryptosystem, sitting in a project where every
other claim is checked against a source or a closed-form result. Something that
only *looked* right would be the one thing here you could not trust, with
nothing marking it out.

So it is out. The AUDIO connector is on the panel and its type is recorded —
U-229, 5-pin, with [S3]'s note that pin E grounds to signal that squelch has
opened, which is how two sets key each other for retransmission. The pinout
itself is not modelled, and neither is what would plug into it.

What the **propagation** model leaves out matters just as much:

- **Fading and location variability.** Every figure is a deterministic median.
  No log-normal shadowing and no reliability percentile, so there is no "90% of
  locations, 90% of the time" figure of the kind a real planning budget carries.
- **Galactic noise.** ITU-R P.372's cosmic background sits above the modelled
  quiet-rural man-made floor across this band, so it — not man-made noise —
  should set the floor at genuinely quiet sites. Treat 7.4 km as an upper bound.
- **Co-site desensitisation.** There is no desense term, which is why the 3 MHz
  retransmission rule is reported rather than enforced.
- **Terrain profile, body shadowing, polarisation mismatch, sporadic-E.** Smooth
  earth only: a ridge between two stations is invisible unless you say so with
  the clutter control.

Two smaller omissions: no circuit-level analogue simulation (the superhet chain
and AFC loop are not modelled), and no actual RF — the second station is
simulated in the same page.

## The handset

Turn on *Enable handset audio*. Nothing you hear is a sample; it is all
generated in [`js/audio.js`](js/audio.js) — the rushing noise of an open
squelch, the 150 Hz "low growl" on transmit, sidetone, the antenna relay
clicking on each PTT edge, the squelch tail as the gate shuts, and the buzz
*without* sidetone of a flat battery. Receiver noise is driven by the link
margin, so a marginal path audibly sounds marginal. The voice itself is not
modelled — it is a filtered tone standing in for speech, and it is the one thing
in the handset you should read nothing into.

## Repository layout

```
index.html          the front panel
css/style.css       panel styling
js/config.js        every published constant, with its citation
js/radio.js         the RT-841 — controls, presets, battery      (DOM-free)
js/propagation.js   antenna theory and path loss                 (DOM-free)
js/net.js           the air — capture, squelch gating, relay      (DOM-free)
js/allowances.js    the audit registry of non-sourced constants
js/audio.js         Web Audio handset
js/app.js           panel wiring
tools/serve.js      static file server, stdlib only
test/               the three suites — radio, propagation, net
docs/               design walkthrough and screenshot
```

Three engine modules (`radio`, `propagation`, `net`) are DOM-free and run
unchanged under Node; `config.js` is data; `audio.js` and `app.js` are the
browser front end.

## Contributing

The most valuable contribution to a project like this is "I have a manual that
says otherwise." If you have a figure that contradicts one here, please open an
issue with the source — sources disagree in several places already and both
readings are recorded in `config.js`.

Disputes about the physics are equally welcome, particularly about anything in
`js/allowances.js`, which exists precisely to be argued with. `npm test` is the
whole check and needs no install.

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
- **[S5]** ITU-R Recommendation P.372, *Radio noise* — man-made noise
  coefficients used for the external noise floor
- **[S6]** Standard antenna theory (Balanis, *Antenna Theory: Analysis and
  Design*; Kraus, *Antennas*) for the monopole pattern integral and the
  closed-form values in the validation table

Where sources disagree — transmitter power, battery life, remote-control range —
both figures are recorded in `config.js` and the choice is justified in a
comment.

## License

MIT — see [LICENSE](LICENSE).
