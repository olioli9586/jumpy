// Synthetic MediaPipe-style pose streams for driving JumpDetector in tests.
// Coordinates are normalized image space (y grows downward), like the real
// landmarker output; torso length is 0.2.

const BASE = {
  0: [0.5, 0.25],                    // nose
  11: [0.45, 0.35], 12: [0.55, 0.35], // shoulders
  13: [0.42, 0.45], 14: [0.58, 0.45], // elbows
  15: [0.40, 0.55], 16: [0.60, 0.55], // wrists, down at the hips
  23: [0.46, 0.55], 24: [0.54, 0.55], // hips
  25: [0.46, 0.70], 26: [0.54, 0.70], // knees
  27: [0.46, 0.85], 28: [0.54, 0.85], // ankles
};

// One frame. `lift` raises the whole body (positive = up, in image units);
// `dx` shifts it sideways; `wristY` overrides both wrists' y.
export function pose({ lift = 0, dx = 0, wristY = null } = {}) {
  const lm = [];
  for (let i = 0; i < 33; i++) {
    const [x, y] = BASE[i] ?? [0.5, 0.5];
    lm.push({ x: x + dx, y: y - lift, z: 0, visibility: 0.99 });
  }
  if (wristY != null) {
    lm[15].y = wristY - lift;
    lm[16].y = wristY - lift;
  }
  return lm;
}

// Body height over time for rope jumping: `n` hops of `height` starting at
// `start` ms, one every `period` ms, airborne for `air` of each period.
export function hops({ n, period = 500, height = 0.05, air = 0.5, start = 1000 }) {
  return (t) => {
    const k = Math.floor((t - start) / period);
    if (t < start || k >= n) return 0;
    const ph = (t - start - k * period) / (period * air);
    return ph < 1 ? height * Math.sin(Math.PI * ph) : 0;
  };
}

// Feeds `frame(t)` to the detector at `fps` from 0 to `durMs`; returns the
// counted jump timestamps.
export function run(detector, frame, durMs, fps = 30) {
  const counted = [];
  detector.onJump = (t) => counted.push(t);
  const dt = 1000 / fps;
  for (let t = 0; t <= durMs; t += dt) detector.update(frame(t), t);
  return counted;
}
