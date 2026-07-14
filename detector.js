// Jump detection: peak detection with hysteresis on the smoothed vertical
// position of the torso (mean of shoulders + hips), same idea as
// https://github.com/aminnj/jumpcount
// Shared by the app (app.js) and the offline test harness (debug.html),
// so what gets tested is exactly what ships.

// Landmark indices (MediaPipe Pose, 33 points)
export const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24;
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
    this.dbg = null;
  }
  // Counts full up-down cycles between a running trough and peak, so a fast
  // continuous bounce never loses amplitude to a drifting baseline. All
  // distances are in torso lengths — camera distance doesn't matter.
  update(lm, tMs) {
    const hipY = (lm[L_HIP].y + lm[R_HIP].y) / 2;
    const shY = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
    const kneeY = (lm[L_KNEE].y + lm[R_KNEE].y) / 2;
    const ankY = (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2;
    const kneeVis =
      (lm[L_KNEE].visibility ?? 1) > 0.5 && (lm[R_KNEE].visibility ?? 1) > 0.5;
    const ankVis =
      (lm[L_ANKLE].visibility ?? 1) > 0.5 && (lm[R_ANKLE].visibility ?? 1) > 0.5;
    const x = (lm[L_HIP].x + lm[R_HIP].x) / 2;
    const torso =
      (Math.hypot(lm[L_SHOULDER].x - lm[L_HIP].x, lm[L_SHOULDER].y - lm[L_HIP].y) +
        Math.hypot(lm[R_SHOULDER].x - lm[R_HIP].x, lm[R_SHOULDER].y - lm[R_HIP].y)) / 2;
    if (!(torso > 0)) return;

    if (!this.ready) {
      this.ready = true;
      this.fHip = hipY; this.fSh = shY; this.fKnee = kneeY; this.fAnk = ankY;
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
    this.fSh += 0.7 * (shY - this.fSh);
    this.fKnee += 0.7 * (kneeY - this.fKnee);
    this.fAnk += 0.7 * (ankY - this.fAnk);
    this.fHipL += 0.7 * (lm[L_HIP].y - this.fHipL);
    this.fHipR += 0.7 * (lm[R_HIP].y - this.fHipR);
    this.fX += 0.3 * (x - this.fX);     this.sX += 0.04 * (x - this.sX);
    this.fT += 0.3 * (torso - this.fT); this.sT += 0.04 * (torso - this.sT);

    // normalize by the SLOW torso estimate: arm/hand motion near the body
    // perturbs the instantaneous torso length, which used to lift hip and
    // shoulder heights together and fake a jump on a stationary person
    const s = -this.fHip / this.sT;   // hip height, up = positive
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
      if (shS > this.shMax) this.shMax = shS;
      if (kS > this.kneeMax) this.kneeMax = kS;
      if (aS > this.ankMax) this.ankMax = aS;
      if (sL > this.hipLMax) this.hipLMax = sL;
      if (sR > this.hipRMax) this.hipRMax = sR;
      this.kneeSeen &&= kneeVis;
      this.ankSeen &&= ankVis;
      // dropped clearly below the peak → he's landing
      if (this.peak - s > swing * 0.45) {
        const rise = this.peak - this.trough;
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
        // (slow landmark drift on a stationary body takes far longer)
        const gates = {
          rise: rise >= swing,
          side: sideRise > rise * 0.4,
          shoulder: shRise > rise * 0.4,
          knee: !this.kneeSeen || kneeRise > rise * 0.35,
          ankle: !this.ankSeen || ankRise > rise * 0.35,
          riseTime: tMs - this.riseAt < 900,
          refractory: tMs - this.lastJumpAt > 180,
        };
        const counted = Object.values(gates).every(Boolean);
        this.onDebug?.({
          tMs, counted, gates, rise, swing, sideRise, shRise, kneeRise, ankRise,
          kneeSeen: this.kneeSeen, ankSeen: this.ankSeen, riseMs: tMs - this.riseAt,
        });
        if (counted) {
          this.lastJumpAt = tMs;
          this.amp = 0.75 * this.amp + 0.25 * rise;
          this.onJump?.(tMs);
        }
        this.phase = "down";
        this.trough = s;
      }
    } else {
      if (s < this.trough) this.trough = s;
      // rose clearly off the trough → a new jump is starting
      if (s - this.trough > swing * 0.45) {
        this.phase = "up";
        this.peak = s;
        this.shBase = this.shMax = shS;
        this.kneeBase = this.kneeMax = kS;
        this.ankBase = this.ankMax = aS;
        this.hipLBase = this.hipLMax = sL;
        this.hipRBase = this.hipRMax = sR;
        this.kneeSeen = kneeVis;
        this.ankSeen = ankVis;
        this.riseAt = tMs;
      }
    }
    this.dbg = { t: tMs, s, shS, kS, aS, sL, sR, swing, phase: this.phase };
  }
}
