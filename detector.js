// Jump detection: peak detection with hysteresis on the smoothed vertical
// position of the torso (mean of shoulders + hips), same idea as
// https://github.com/aminnj/jumpcount
// Shared by the app (app.js) and the offline test harness (debug.html),
// so what gets tested is exactly what ships.

// Landmark indices (MediaPipe Pose, 33 points)
export const NOSE = 0;
export const L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16;
export const L_HIP = 23, R_HIP = 24;
export const L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;

// Threshold floor multipliers per sensitivity setting
const SENS = { low: 1.35, normal: 1, high: 0.7 };

export class JumpDetector {
  constructor(getSensitivity = () => "normal") {
    this.getSensitivity = getSensitivity;
    this.onJump = null;
    this.onDebug = null; // fires at every landing decision with all gate values
    this.reset();
  }
  reset() {
    this.ready = false;
    this.phase = "down";   // down = falling / on the ground, up = rising
    this.amp = 0.1;        // running peak-to-trough amplitude, in torso lengths
    this.lastJumpAt = 0;
    this.riseAt = 0;       // when the current rise left its trough
    this.recent = [];      // timestamps of the last few counted jumps
    this.relaxStreak = 0;  // consecutive rhythm-mode counts
    this.pending = [];     // candidates held until enough of them confirm a run
    this.armUpStreak = 0;  // consecutive frames with a wrist near/above shoulder level
    this.riseArmUp = false;
    this.riseWristTravel = 0;
    this.dbg = null;
  }
  // Steady cadence of the last few counted jumps, or 0 if none.
  rhythmPeriod() {
    if (this.recent.length < 4) return 0;
    const iv = [];
    for (let i = 1; i < this.recent.length; i++) iv.push(this.recent[i] - this.recent[i - 1]);
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    return iv.every((v) => Math.abs(v - mean) < mean * 0.3) ? mean : 0;
  }
  // Counts full up-down cycles between a running trough and peak, so a fast
  // continuous bounce never loses amplitude to a drifting baseline. All
  // distances are in torso lengths — camera distance doesn't matter.
  update(lm, tMs) {
    const hipY = (lm[L_HIP].y + lm[R_HIP].y) / 2;
    const noseY = lm[NOSE].y;
    const noseVis = (lm[NOSE].visibility ?? 1) > 0.5;
    const shY = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
    const kneeY = (lm[L_KNEE].y + lm[R_KNEE].y) / 2;
    const ankY = (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2;
    const kneeVis =
      (lm[L_KNEE].visibility ?? 1) > 0.5 && (lm[R_KNEE].visibility ?? 1) > 0.5;
    const ankVis =
      (lm[L_ANKLE].visibility ?? 1) > 0.5 && (lm[R_ANKLE].visibility ?? 1) > 0.5;
    const visMin = Math.min(
      ...[L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE].map(
        (i) => lm[i].visibility ?? 1
      )
    );
    const x = (lm[L_HIP].x + lm[R_HIP].x) / 2;
    const torso =
      (Math.hypot(lm[L_SHOULDER].x - lm[L_HIP].x, lm[L_SHOULDER].y - lm[L_HIP].y) +
        Math.hypot(lm[R_SHOULDER].x - lm[R_HIP].x, lm[R_SHOULDER].y - lm[R_HIP].y)) / 2;
    if (!(torso > 0)) return;

    if (!this.ready) {
      this.ready = true;
      this.fHip = hipY; this.fSh = shY; this.fKnee = kneeY; this.fAnk = ankY;
      this.fNose = noseY;
      this.fLW = lm[L_WRIST].y; this.fRW = lm[R_WRIST].y;
      this.noseBase = this.noseMax = -noseY / torso;
      this.noseSeen = noseVis;
      this.fHipL = lm[L_HIP].y; this.fHipR = lm[R_HIP].y;
      this.fX = this.sX = x;
      this.fT = this.sT = torso;
      this.peak = this.trough = -hipY / torso;
      this.shBase = this.shMax = -shY / torso;
      this.kneeBase = this.kneeMax = -kneeY / torso;
      this.ankBase = this.ankMax = -ankY / torso;
      this.hipLBase = this.hipLMax = -lm[L_HIP].y / torso;
      this.hipRBase = this.hipRMax = -lm[R_HIP].y / torso;
      this.kneeSeen = kneeVis;
      this.ankSeen = ankVis;
      return;
    }
    // light smoothing only — heavy smoothing eats the amplitude of fast low skips
    this.fHip += 0.7 * (hipY - this.fHip);
    this.fNose += 0.7 * (noseY - this.fNose);
    this.fSh += 0.7 * (shY - this.fSh);
    this.fKnee += 0.7 * (kneeY - this.fKnee);
    this.fAnk += 0.7 * (ankY - this.fAnk);
    this.fHipL += 0.7 * (lm[L_HIP].y - this.fHipL);
    this.fHipR += 0.7 * (lm[R_HIP].y - this.fHipR);
    this.fLW += 0.7 * (lm[L_WRIST].y - this.fLW);
    this.fRW += 0.7 * (lm[R_WRIST].y - this.fRW);
    this.fX += 0.3 * (x - this.fX);     this.sX += 0.04 * (x - this.sX);
    this.fT += 0.3 * (torso - this.fT); this.sT += 0.04 * (torso - this.sT);

    // Hands at or above shoulder level mean waving / swinging the rope
    // overhead, never rope jumping — the rope is turned from the hips, a
    // full torso length below the shoulders. Big arm swings drag the whole
    // tracked skeleton up and fake a rise no landmark gate can catch.
    // Two consecutive frames so a single glitched wrist can't veto.
    const lwVis = (lm[L_WRIST].visibility ?? 1) > 0.5;
    const rwVis = (lm[R_WRIST].visibility ?? 1) > 0.5;
    const armUp =
      (lwVis && lm[L_WRIST].y < lm[L_SHOULDER].y + 0.25 * this.sT) ||
      (rwVis && lm[R_WRIST].y < lm[R_SHOULDER].y + 0.25 * this.sT);
    this.armUpStreak = armUp ? this.armUpStreak + 1 : 0;
    // wrist height relative to the hips — real jumping carries the hands
    // along with the body, so this barely moves within one rise
    const lwRel = (this.fLW - this.fHip) / this.sT;
    const rwRel = (this.fRW - this.fHip) / this.sT;

    // normalize by the SLOW torso estimate: arm/hand motion near the body
    // perturbs the instantaneous torso length, which used to lift hip and
    // shoulder heights together and fake a jump on a stationary person
    const s = -this.fHip / this.sT;   // hip height, up = positive
    const nS = -this.fNose / this.sT; // head height
    const shS = -this.fSh / this.sT;  // shoulder height
    const kS = -this.fKnee / this.sT; // knee height
    const aS = -this.fAnk / this.sT;  // ankle height
    const sL = -this.fHipL / this.sT; // left / right hip separately —
    const sR = -this.fHipR / this.sT; // a hand occluding one side fakes only that side

    // walking gate: sideways drift, or apparent body size changing
    // (= moving toward/away from the camera) — jumps happen in place
    const drifting =
      Math.abs(this.fX - this.sX) / this.fT > 0.35 ||
      Math.abs(this.fT - this.sT) / this.sT > 0.1;
    if (drifting) {
      this.phase = "down";
      this.peak = this.trough = s;
      this.noseBase = this.noseMax = nS;
      this.noseSeen = noseVis;
      this.shBase = this.shMax = shS;
      this.kneeBase = this.kneeMax = kS;
      this.ankBase = this.ankMax = aS;
      this.hipLBase = this.hipLMax = sL;
      this.hipRBase = this.hipRMax = sR;
      this.kneeSeen = kneeVis;
      this.ankSeen = ankVis;
      this.dbg = { t: tMs, s, aS, drifting: true, phase: this.phase };
      return;
    }

    this.amp *= 0.999;
    const swing = Math.max(0.07 * (SENS[this.getSensitivity()] ?? 1), this.amp * 0.45);

    if (this.phase === "up") {
      if (s > this.peak) this.peak = s;
      if (nS > this.noseMax) this.noseMax = nS;
      if (shS > this.shMax) this.shMax = shS;
      if (kS > this.kneeMax) this.kneeMax = kS;
      if (aS > this.ankMax) this.ankMax = aS;
      if (sL > this.hipLMax) this.hipLMax = sL;
      if (sR > this.hipRMax) this.hipRMax = sR;
      this.kneeSeen &&= kneeVis;
      this.ankSeen &&= ankVis;
      this.noseSeen &&= noseVis;
      this.riseTorsoDev = Math.max(this.riseTorsoDev, Math.abs(this.fT - this.sT) / this.sT);
      this.riseVisMin = Math.min(this.riseVisMin, visMin);
      if (this.armUpStreak >= 2) this.riseArmUp = true;
      if (lwVis) {
        this.lwMin = Math.min(this.lwMin, lwRel);
        this.lwMax = Math.max(this.lwMax, lwRel);
      }
      if (rwVis) {
        this.rwMin = Math.min(this.rwMin, rwRel);
        this.rwMax = Math.max(this.rwMax, rwRel);
      }
      this.riseWristTravel = Math.max(
        this.lwMax > this.lwMin ? this.lwMax - this.lwMin : 0,
        this.rwMax > this.rwMin ? this.rwMax - this.rwMin : 0
      );
      // dropped clearly below the peak → he's landing
      if (this.peak - s > swing * 0.45) {
        const rise = this.peak - this.trough;
        const noseRise = this.noseMax - this.noseBase;
        const shRise = this.shMax - this.shBase;
        const kneeRise = this.kneeMax - this.kneeBase;
        const ankRise = this.ankMax - this.ankBase;
        // both hips must rise about equally — a hand or crossing arms
        // occluding the torso kicks ONE hip landmark up, never both
        const sideRise = Math.min(
          this.hipLMax - this.hipLBase,
          this.hipRMax - this.hipRBase
        );
        // a real jump lifts the whole body at once, fast: both hips a full
        // swing, shoulders / knees / ankles riding up with them (arms alone
        // can't do that), and the whole rise inside one airborne cycle
        // (slow landmark drift on a stationary body takes far longer).
        // Ratios tuned on real footage: jumping with a rope drops shoulder
        // rise to ~0.2-0.4 of hip rise (arms swing down as the body goes up),
        // while hand-waving false positives sit near 0 on knees/ankles and
        // take >1 s to "rise" — see debug.html harness results.
        const gates = {
          rise: rise >= swing,
          side: sideRise > rise * 0.25,
          shoulder: shRise > rise * 0.2,
          knee: !this.kneeSeen || kneeRise > rise * 0.25,
          ankle: !this.ankSeen || ankRise > rise * 0.2,
          riseTime: tMs - this.riseAt < 700,
          refractory: tMs - this.lastJumpAt > 180,
          arms: !this.riseArmUp,
          armSwing: this.riseWristTravel < 0.5,
        };
        let counted = Object.values(gates).every(Boolean);
        let mode = "full";
        // Fast low skips (3+ jumps/s) smear knee/ankle motion in the pose
        // stream and every measured rise shrinks, so full gating drops real
        // jumps. Once a steady rhythm exists — reachable only through fully
        // gated jumps, which hand-waving never passes — accept ON-BEAT
        // landings on softer evidence: hips still must rise, plus any two
        // body parts riding along at half strength. Off-beat candidates
        // (criss-cross phantom peaks, post-run hand motion) still face the
        // full gates, and at most 3 soft counts may chain in a row.
        if (!counted && gates.riseTime && gates.refractory && gates.arms && gates.armSwing) {
          const period = this.rhythmPeriod();
          const since = tMs - this.lastJumpAt;
          if (
            period > 0 && this.relaxStreak < 3 &&
            since > 0.6 * period && since < 1.6 * period &&
            rise >= swing * 0.75
          ) {
            let soft = 0;
            if (sideRise > rise * 0.125) soft++;
            if (shRise > rise * 0.1) soft++;
            if (this.kneeSeen && kneeRise > rise * 0.125) soft++;
            if (this.ankSeen && ankRise > rise * 0.1) soft++;
            if (soft >= 2) { counted = true; mode = "rhythm"; }
          }
        }
        // Run confirmation: real jumping is continuous (the next jump lands
        // within ~2 s), while MediaPipe's whole-skeleton glitches — hands at
        // the waist or a rope swung overhead shift EVERY landmark up
        // coherently, at high confidence, defeating the per-part gates —
        // fire sporadically (at most two ~1.5 s apart on real footage). So
        // candidates are held until three in a row arrive each within 2 s of
        // the last, then all count retroactively; a stray one or two expire
        // uncounted. Losing a deliberate lone jump is the accepted cost.
        let held = false;
        if (counted) {
          const emit = (t) => {
            this.recent.push(t);
            if (this.recent.length > 5) this.recent.shift();
            this.lastJumpAt = t;
            this.onJump?.(t);
          };
          this.relaxStreak = mode === "rhythm" ? this.relaxStreak + 1 : 0;
          if (this.lastJumpAt > 0 && tMs - this.lastJumpAt <= 2000) {
            emit(tMs); // run already going
          } else {
            if (this.pending.length && tMs - this.pending.at(-1) > 2000) this.pending = [];
            this.pending.push(tMs);
            if (this.pending.length >= 3) {
              for (const t of this.pending) emit(t);
              this.pending = [];
            } else {
              held = true;
              counted = false;
            }
          }
          if (!held) this.amp = 0.75 * this.amp + 0.25 * rise;
        }
        this.onDebug?.({
          tMs, counted, held, mode, gates, rise, swing, sideRise, shRise, kneeRise, ankRise,
          noseRise, noseSeen: this.noseSeen,
          kneeSeen: this.kneeSeen, ankSeen: this.ankSeen, riseMs: tMs - this.riseAt,
          riseTorsoDev: this.riseTorsoDev, riseVisMin: this.riseVisMin,
          wristTravel: this.riseWristTravel,
        });
        this.phase = "down";
        this.trough = s;
      }
    } else {
      if (s < this.trough) this.trough = s;
      // rose clearly off the trough → a new jump is starting
      if (s - this.trough > swing * 0.45) {
        this.phase = "up";
        this.peak = s;
        this.noseBase = this.noseMax = nS;
        this.noseSeen = noseVis;
        this.shBase = this.shMax = shS;
        this.kneeBase = this.kneeMax = kS;
        this.ankBase = this.ankMax = aS;
        this.hipLBase = this.hipLMax = sL;
        this.hipRBase = this.hipRMax = sR;
        this.kneeSeen = kneeVis;
        this.ankSeen = ankVis;
        this.riseAt = tMs;
        this.riseTorsoDev = Math.abs(this.fT - this.sT) / this.sT;
        this.riseVisMin = visMin;
        this.riseArmUp = this.armUpStreak >= 2;
        this.lwMin = lwVis ? lwRel : Infinity;
        this.lwMax = lwVis ? lwRel : -Infinity;
        this.rwMin = rwVis ? rwRel : Infinity;
        this.rwMax = rwVis ? rwRel : -Infinity;
        this.riseWristTravel = 0;
      }
    }
    this.dbg = { t: tMs, s, shS, kS, aS, sL, sR, swing, phase: this.phase,
      tR: this.fT / this.sT, visMin };
  }
}
