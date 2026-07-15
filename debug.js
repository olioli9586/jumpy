// Offline test harness: replays a video file through the exact JumpDetector
// the app ships (detector.js), logging every counted / rejected landing.
// Frames come from WebCodecs (mp4box demux + VideoDecoder), NOT <video>
// playback: playback/rVFC/timers all throttle or stall in the occluded
// automation window, and files from the app's own timelapse encoder have a
// broken seek index that silently snaps scrubbing back to the first frame.
// Usage: debug.html?v=test-videos/clip1.mp4&sens=normal
import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import MP4Box from "https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm";
import { JumpDetector, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP } from "./detector.js?v=2";

const q = new URLSearchParams(location.search);
const SRC = q.get("v");
const SENSITIVITY = q.get("sens") || "normal";
// For clips recorded by the app's N× timelapse mode: scales timestamps back
// to real time so the detector's timing gates behave as they would live.
const LAPSE = parseFloat(q.get("lapse")) || 1;

const frame = document.getElementById("frame"), fx = frame.getContext("2d");
const plot = document.getElementById("plot"), px = plot.getContext("2d");
const status = document.getElementById("status");
const out = document.getElementById("out");

const detector = new JumpDetector(() => SENSITIVITY);
const jumps = [];
const decisions = [];
const trace = [];
const snaps = [];
detector.onJump = (t) => jumps.push(t);
detector.onDebug = (d) => decisions.push(d);

function drawPlot() {
  const w = plot.width, h = plot.height;
  px.clearRect(0, 0, w, h);
  const samples = trace.filter((p) => p.s != null);
  if (!samples.length) return;
  const dur = trace.at(-1).t;
  const vals = samples.flatMap((p) => [p.s, p.aS]).filter((v) => v != null && isFinite(v));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const X = (t) => (t / dur) * w;
  const Y = (v) => h - ((v - lo) / (hi - lo || 1)) * (h - 30) - 15;

  // landing decisions: green = counted, red = rejected
  for (const d of decisions) {
    px.strokeStyle = d.counted ? "rgba(80,220,120,0.9)" : "rgba(255,80,80,0.9)";
    px.beginPath(); px.moveTo(X(d.tMs), 0); px.lineTo(X(d.tMs), h); px.stroke();
  }
  // hip height (bright) and ankle height (dim)
  for (const [key, style] of [["aS", "rgba(120,150,255,0.5)"], ["s", "#f2f5f9"]]) {
    px.strokeStyle = style;
    px.beginPath();
    let pen = false;
    for (const p of trace) {
      if (p[key] == null || !isFinite(p[key])) { pen = false; continue; }
      const xx = X(p.t), yy = Y(p[key]);
      pen ? px.lineTo(xx, yy) : px.moveTo(xx, yy);
      pen = true;
    }
    px.stroke();
  }
  // second ticks
  px.fillStyle = "#8b95a6";
  for (let sec = 0; sec * 1000 < dur; sec++) {
    px.fillRect(X(sec * 1000), h - 8, 1, 8);
    if (sec % 2 === 0) px.fillText(String(sec), X(sec * 1000) + 2, h - 10);
  }
}

const fmt = (v) => (v == null ? "-" : +v.toFixed(3));

function demux(buf) {
  const mp4 = MP4Box.createFile();
  let track = null;
  const samples = [];
  mp4.onError = (e) => { throw new Error("mp4 demux: " + e); };
  mp4.onReady = (info) => {
    track = info.videoTracks[0];
    if (!track) throw new Error("no video track in file");
    mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
    mp4.start();
  };
  mp4.onSamples = (_id, _user, s) => samples.push(...s);
  buf.fileStart = 0;
  mp4.appendBuffer(buf);
  mp4.flush();
  if (!track) throw new Error("mp4 parse failed (no moov?)");

  // codec init data (avcC / hvcC …) for VideoDecoder
  let description = null;
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(ds);
      description = new Uint8Array(ds.buffer, 8); // strip box size+type header
      break;
    }
  }
  // display rotation (phone videos store it in the track matrix)
  const m = trak.tkhd.matrix;
  const a = m[0] / 65536, b = m[1] / 65536, d = m[4] / 65536;
  const rotation = a === 0 ? (b > 0 ? 90 : 270) : a < 0 && d < 0 ? 180 : 0;
  return { track, samples, description, rotation };
}

async function run() {
  status.textContent = "loading model…";
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });

  status.textContent = "demuxing…";
  const resp = await fetch(SRC);
  if (!resp.ok) throw new Error("cannot load video: " + SRC);
  const { track, samples, description, rotation } = demux(await resp.arrayBuffer());
  const durationS = samples.length
    ? (samples.at(-1).cts + samples.at(-1).duration) / samples.at(-1).timescale
    : 0;

  // work canvas at display orientation; detection reads from here
  const rot90 = rotation === 90 || rotation === 270;
  const work = document.createElement("canvas");
  const cw = track.video.width, ch = track.video.height;
  work.width = rot90 ? ch : cw;
  work.height = rot90 ? cw : ch;
  const wx = work.getContext("2d");

  // keep a thumbnail of every frame that produced a COUNT, for eyeballing
  detector.onDebug = (d) => {
    decisions.push(d);
    if (d.counted) {
      const th = document.createElement("canvas");
      th.width = 180; th.height = Math.round((180 * work.height) / work.width);
      th.getContext("2d").drawImage(work, 0, 0, th.width, th.height);
      snaps.push({ t: d.tMs, url: th.toDataURL("image/jpeg", 0.7) });
    }
  };

  let visibleFrames = 0, frames = 0, lastT = -1;
  const processFrame = (vf) => {
    const tMs = (vf.timestamp / 1000) * LAPSE;
    if (tMs <= lastT) { vf.close(); return; } // decoder emits presentation order; guard anyway
    lastT = tMs;
    frames++;
    wx.save();
    if (rotation) {
      wx.translate(work.width / 2, work.height / 2);
      wx.rotate((rotation * Math.PI) / 180);
      wx.drawImage(vf, -cw / 2, -ch / 2);
    } else {
      wx.drawImage(vf, 0, 0);
    }
    wx.restore();
    vf.close();

    const result = landmarker.detectForVideo(work, tMs);
    const lm = result.landmarks?.[0];
    // same visibility gate as the live pose loop
    const visible =
      lm &&
      [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].every(
        (i) => (lm[i].visibility ?? 1) > 0.5
      );
    if (visible) {
      visibleFrames++;
      detector.update(lm, tMs);
      trace.push({ t: tMs, ...(detector.dbg ?? {}) });
    } else {
      trace.push({ t: tMs, s: null });
    }
    if (frames % 20 === 0) {
      fx.drawImage(work, 0, 0, frame.width, frame.height);
      fx.fillStyle = "#50dc78";
      fx.font = "48px monospace";
      fx.fillText(String(jumps.length), 16, 56);
      status.textContent = `processing ${(tMs / 1000).toFixed(1)} / ${durationS.toFixed(1)}s — counted ${jumps.length}`;
    }
  };

  const decoder = new VideoDecoder({
    output: processFrame,
    error: (e) => console.error("HARNESS decode error", e),
  });
  decoder.configure({
    codec: track.codec,
    codedWidth: cw,
    codedHeight: ch,
    ...(description && { description }),
  });
  for (const s of samples) {
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: Math.round((s.cts * 1_000_000) / s.timescale),
        duration: Math.round((s.duration * 1_000_000) / s.timescale),
        data: s.data,
      })
    );
  }
  await decoder.flush();
  decoder.close();

  drawPlot();
  for (const sn of snaps) {
    const img = new Image();
    img.src = sn.url;
    img.title = "counted @ " + (sn.t / 1000).toFixed(2) + "s";
    img.style.margin = "4px";
    out.before(img);
  }
  const evt = (d) => ({
    t: +(d.tMs / 1000).toFixed(2),
    failed: Object.keys(d.gates).filter((k) => !d.gates[k]),
    rise: fmt(d.rise), swing: fmt(d.swing), sideRise: fmt(d.sideRise),
    shRise: fmt(d.shRise), kneeRise: fmt(d.kneeRise), ankRise: fmt(d.ankRise),
    kneeSeen: d.kneeSeen, ankSeen: d.ankSeen, riseMs: Math.round(d.riseMs),
  });
  const summary = {
    video: SRC,
    sensitivity: SENSITIVITY,
    lapse: LAPSE,
    durationS: +durationS.toFixed(2),
    rotation,
    frames,
    visibleFrames,
    counted: jumps.length,
    jumpTimesS: jumps.map((t) => +(t / 1000).toFixed(2)),
    countedEvents: decisions.filter((d) => d.counted).map(evt),
    rejected: decisions.filter((d) => !d.counted).map(evt),
  };
  status.textContent = `DONE — counted ${jumps.length} jumps in ${summary.durationS}s (${visibleFrames}/${frames} frames with body visible)`;
  out.textContent = JSON.stringify(summary, null, 2);
  console.log("RESULT " + JSON.stringify(summary));
  window.RESULT = summary;
  document.title = "harness-done";
}

run().catch((err) => {
  status.textContent = "ERROR: " + err.message;
  console.error("HARNESS ERROR", err);
});
