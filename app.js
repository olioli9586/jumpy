// Jumpy — camera jump rope counter.
// Pose tracking runs entirely on-device via MediaPipe Pose Landmarker (WASM/GPU).
// Jump detection: peak detection with hysteresis on the smoothed vertical
// position of the torso (mean of shoulders + hips), same idea as
// https://github.com/aminnj/jumpcount

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import {
  JumpDetector,
  L_SHOULDER, R_SHOULDER, L_HIP, R_HIP,
} from "./detector.js";

const MEDIAPIPE_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const $ = (id) => document.getElementById(id);
const els = {
  cam: $("cam"), overlay: $("overlay"),
  screenStart: $("screen-start"), screenReady: $("screen-ready"),
  hud: $("hud"), screenSummary: $("screen-summary"),
  countdown: $("countdown"), pill: $("pill"), hudPill: $("hud-pill"),
  hudTime: $("hud-time"), count: $("count"),
  mPace: $("m-pace"), mKcal: $("m-kcal"), mStreak: $("m-streak"),
  rhythm: $("rhythm"),
  sumPb: $("sum-pb"), sumJumps: $("sum-jumps"), sumTime: $("sum-time"),
  sumKcal: $("sum-kcal"), sumPace: $("sum-pace"), sumPeak: $("sum-peak"),
  history: $("history"),
  sheet: $("sheet"), setWeight: $("set-weight"), setSound: $("set-sound"),
  startError: $("start-error"),
  screenStats: $("screen-stats"), statsBody: $("stats-body"),
};

// ---------- settings ----------

const settings = Object.assign(
  { weightKg: 70, sound: true, facing: "user", sensitivity: "normal" },
  JSON.parse(localStorage.getItem("jumpy.settings") || "{}")
);
function saveSettings() {
  localStorage.setItem("jumpy.settings", JSON.stringify(settings));
}

// ---------- session ----------

const session = {
  active: false,
  startedAt: 0,
  jumps: 0,
  jumpTimes: [],       // performance.now() of each jump
  kcal: 0,
  peakPace: 0,
  bestStreak: 0,
  curStreak: 0,
  lastKcalTick: 0,
};

function currentPace(now) {
  // jumps in the last 10s, scaled to per-minute
  const cutoff = now - 10_000;
  let n = 0;
  for (let i = session.jumpTimes.length - 1; i >= 0; i--) {
    if (session.jumpTimes[i] < cutoff) break;
    n++;
  }
  return n * 6;
}

function metForPace(pace) {
  // Compendium of Physical Activities: skipping rope
  if (pace <= 0) return 0;
  if (pace < 100) return 8.8;
  if (pace <= 120) return 11.8;
  return 12.3;
}

// ---------- audio ----------

let audioCtx = null;
function tick() {
  if (!settings.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 1200;
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.07);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.08);
  } catch { /* audio is a nicety, never break counting */ }
}
function announce(text) {
  if (!settings.sound || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel(); // iOS: a jammed queue blocks all later speech
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-TW";
  u.rate = 1.1;
  speechSynthesis.speak(u);
}

// ---------- camera + pose ----------

let landmarker = null;
let stream = null;
let lastVideoTime = -1;
let lastSeenAt = 0;
const detector = new JumpDetector(() => settings.sensitivity);

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: settings.facing,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  els.cam.srcObject = stream;
  await els.cam.play();
  const mirror = settings.facing === "user";
  els.cam.classList.toggle("mirror", mirror);
  els.overlay.classList.toggle("mirror", mirror);
}

async function loadLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

const BONES = [
  [L_SHOULDER, R_SHOULDER], [L_HIP, R_HIP],
  [L_SHOULDER, L_HIP], [R_SHOULDER, R_HIP],
  [L_HIP, 25], [25, 27], [R_HIP, 26], [26, 28],       // legs
  [L_SHOULDER, 13], [13, 15], [R_SHOULDER, 14], [14, 16], // arms
];

function strokeBones(ctx, lm, px, lineWidth) {
  ctx.strokeStyle = "rgba(255,90,31,0.85)";
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(...px(lm[a]));
    ctx.lineTo(...px(lm[b]));
    ctx.stroke();
  }
}

function drawSkeleton(lm) {
  const c = els.overlay;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!lm) return;

  // map normalized landmark coords through the same cover-crop as the video
  const vw = els.cam.videoWidth, vh = els.cam.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(c.width / vw, c.height / vh);
  const ox = (c.width - vw * scale) / 2;
  const oy = (c.height - vh * scale) / 2;
  const px = (p) => [p.x * vw * scale + ox, p.y * vh * scale + oy];
  strokeBones(ctx, lm, px, 3);
}

// iOS freezes the camera in several ways: it pauses the <video> when other
// media plays (session replay, share sheet), and it can mute or kill the
// camera track around session transitions or backgrounding — the track still
// says "live" but delivers no frames. Any of these freezes the pill and 開始
// never re-enables. Watch for a stalled feed and revive it; if resuming
// playback isn't enough, reacquire the camera (what the flip-camera
// workaround effectively did).
let lastFrameAt = 0, camFixAt = 0;
function ensureCameraLive(now) {
  if (!stream || now - camFixAt < 1500) return;
  camFixAt = now;
  const track = stream.getVideoTracks()[0];
  if (els.cam.paused && track?.readyState === "live" && !track.muted) {
    els.cam.play().catch(() => {});
  } else {
    startCamera().catch(() => {});
  }
}

function poseLoop() {
  requestAnimationFrame(poseLoop);
  const now = performance.now();
  if (!landmarker || els.cam.readyState < 2 || els.cam.currentTime === lastVideoTime) {
    if (now - lastFrameAt > 1200) ensureCameraLive(now);
    return;
  }
  lastVideoTime = els.cam.currentTime;
  lastFrameAt = now;
  let result;
  try {
    result = landmarker.detectForVideo(els.cam, now);
  } catch (err) {
    console.error("pose detect failed:", err);
    return; // skip this frame, keep the loop alive
  }
  const lm = result.landmarks?.[0];

  const visible =
    lm &&
    [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].every(
      (i) => (lm[i].visibility ?? 1) > 0.5
    );

  drawSkeleton(visible ? lm : null);

  if (visible) {
    lastSeenAt = now;
    if (session.active) detector.update(lm, now);
    setPill(true);
  } else {
    setPill(false);
  }

  if (session.active && recActive()) {
    try {
      captureRecFrame(visible ? lm : null, now);
    } catch (err) {
      console.error("recording frame failed:", err); // never break counting
    }
  }
}

let pillOn = null;
function setPill(bodyVisible) {
  if (bodyVisible === pillOn) return;
  pillOn = bodyVisible;
  const label = bodyVisible ? "追蹤中" : "請退後 — 看不到你";
  for (const el of [els.pill, els.hudPill]) {
    el.textContent = label;
    el.classList.toggle("on", bodyVisible);
  }
  if (bodyVisible && state === "ready") $("btn-go").disabled = false;
}

// ---------- session recording ----------
// iOS Safari has no real screen capture, so the "screen recording" is
// composited by hand: each camera frame + skeleton + a redrawn HUD goes onto
// a canvas, and MediaRecorder encodes that canvas. System notifications are
// outside the browser and can never end up in the file.

const OUT_FPS = 30;
const FRAME_US = Math.round(1_000_000 / OUT_FPS);

let recMode = "off"; // off | real | lapse10 | lapse25 | lapse50
const rec = {
  mode: "off", factor: 5, mr: null, chunks: [], canvas: null, ctx: null,
  encoder: null, muxer: null, frameN: 0, outN: 0,
  blob: null, url: null, saved: false,
};

const recSupported = () =>
  "MediaRecorder" in window && !!HTMLCanvasElement.prototype.captureStream;

const recActive = () =>
  rec.mr?.state === "recording" || rec.encoder?.state === "configured";

async function startRecording(mode) {
  // H.264 needs even dimensions
  const vw = els.cam.videoWidth & ~1, vh = els.cam.videoHeight & ~1;
  if (!vw || !vh) return;
  rec.canvas = document.createElement("canvas");
  rec.canvas.width = vw;
  rec.canvas.height = vh;
  rec.ctx = rec.canvas.getContext("2d");
  rec.mode = mode.startsWith("lapse") ? "lapse" : "real";
  rec.factor = parseInt(mode.slice(5), 10) || 10;
  rec.frameN = 0;
  rec.outN = 0;

  if (rec.mode === "lapse") {
    // real timelapse: WebCodecs re-timestamps kept frames; MediaRecorder
    // can only record wall-clock time
    try {
      if (!("VideoEncoder" in window)) throw new Error("WebCodecs unavailable");
      const { Muxer, ArrayBufferTarget } = await import(
        "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm"
      );
      let codec = null;
      for (const c of ["avc1.640028", "avc1.4d0028", "avc1.42e01f"]) {
        if ((await VideoEncoder.isConfigSupported({ codec: c, width: vw, height: vh })).supported) {
          codec = c;
          break;
        }
      }
      if (!codec) throw new Error("no H.264 encoder");
      rec.muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: vw, height: vh },
        fastStart: "in-memory",
      });
      rec.encoder = new VideoEncoder({
        output: (chunk, meta) => rec.muxer.addVideoChunk(chunk, meta),
        error: (e) => console.error("timelapse encoder:", e),
      });
      rec.encoder.configure({ codec, width: vw, height: vh, bitrate: 8_000_000, framerate: OUT_FPS });
    } catch (err) {
      console.warn("timelapse unavailable, falling back to normal speed:", err);
      rec.mode = "real";
    }
  }

  if (rec.mode === "real") {
    const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );
    rec.chunks = [];
    rec.mr = new MediaRecorder(rec.canvas.captureStream(30), {
      ...(mime && { mimeType: mime }),
      videoBitsPerSecond: 5_000_000,
    });
    rec.mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    rec.mr.start(1000);
  }

  $("hud-rec-label").textContent = rec.mode === "lapse" ? `縮時 ${rec.factor}× 錄影中` : "錄影中";
  $("hud-rec").classList.remove("hidden");
}

// called from the pose loop once per camera frame while live
function captureRecFrame(lm, now) {
  if (rec.mode === "lapse") {
    if (rec.frameN++ % rec.factor !== 0) return;
    drawRecFrame(lm, now);
    const frame = new VideoFrame(rec.canvas, {
      timestamp: rec.outN * FRAME_US,
      duration: FRAME_US,
    });
    rec.encoder.encode(frame, { keyFrame: rec.outN % (OUT_FPS * 5) === 0 });
    frame.close();
    rec.outN++;
  } else {
    drawRecFrame(lm, now);
  }
}

// endSession awaits this, so a wedged encoder/recorder must never hang it
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("recording stop timed out")), ms)),
  ]);

async function stopRecording() {
  $("hud-rec").classList.add("hidden");
  if (rec.encoder) {
    try {
      await withTimeout(rec.encoder.flush(), 8000);
      rec.muxer.finalize();
      const blob = new Blob([rec.muxer.target.buffer], { type: "video/mp4" });
      return blob;
    } catch (err) {
      console.error("timelapse finalize failed:", err);
      return null;
    } finally {
      try { rec.encoder.close(); } catch {}
      rec.encoder = null;
      rec.muxer = null;
    }
  }
  return new Promise((resolve) => {
    if (!rec.mr || rec.mr.state === "inactive") return resolve(null);
    const finish = () => {
      clearTimeout(fallback);
      resolve(rec.chunks.length ? new Blob(rec.chunks, { type: rec.mr.mimeType || "video/mp4" }) : null);
    };
    const fallback = setTimeout(finish, 4000); // iOS sometimes never fires onstop
    rec.mr.onstop = finish;
    try { rec.mr.stop(); } catch { finish(); }
  });
}

function discardRecording() {
  if (rec.url) URL.revokeObjectURL(rec.url);
  if (rec.encoder) {
    try { rec.encoder.close(); } catch {}
  }
  $("rec-video").removeAttribute("src");
  $("rec-review").classList.add("hidden");
  Object.assign(rec, { blob: null, url: null, chunks: [], encoder: null, muxer: null, saved: false });
}

function drawRecFrame(lm, now) {
  const { ctx, canvas } = rec;
  const w = canvas.width, h = canvas.height;
  const mirror = settings.facing === "user";

  ctx.save();
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(els.cam, 0, 0, w, h);
  if (lm) strokeBones(ctx, lm, (p) => [p.x * w, p.y * h], Math.max(3, w / 240));
  ctx.restore();

  // HUD: giant count + a stats line, same info as the live screen
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(242,245,249,0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = h * 0.02;
  ctx.font = `${Math.round(h * 0.2)}px Anton, sans-serif`;
  ctx.fillText(String(session.jumps), w / 2, h * 0.26);
  ctx.font = `600 ${Math.round(h * 0.032)}px "Space Grotesk", "PingFang TC", sans-serif`;
  ctx.fillText(
    `${fmtTime(now - session.startedAt)}  ·  ${currentPace(now)} 跳/分  ·  ${session.kcal.toFixed(1)} 大卡`,
    w / 2,
    h * 0.95
  );
  ctx.shadowBlur = 0;
}

// ---------- stat card (Strava-style share image) ----------

let lastStats = null;

async function shareStatCard() {
  if (!lastStats) return;
  const W = 1080, H = 1920;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  const UI = '"Space Grotesk", "PingFang TC", sans-serif';

  x.fillStyle = "#0b0e13";
  x.fillRect(0, 0, W, H);

  // faint rope arc, echoing the app icon
  x.strokeStyle = "rgba(255,90,31,0.14)";
  x.lineWidth = 70;
  x.lineCap = "round";
  x.beginPath();
  x.arc(W / 2, H * 0.02, W * 0.62, Math.PI * 0.15, Math.PI * 0.85);
  x.stroke();

  // header: wordmark + date
  x.textAlign = "left";
  x.fillStyle = "#f2f5f9";
  x.font = "88px Anton, sans-serif";
  x.fillText("JUMPY", 84, 176);
  x.fillStyle = "#ff5a1f";
  x.fillRect(86, 204, 130, 14);
  x.textAlign = "right";
  x.fillStyle = "#8b95a6";
  x.font = `500 44px ${UI}`;
  x.fillText(
    lastStats.date.toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric" }),
    W - 84, 160
  );

  // hero: jump count
  x.textAlign = "center";
  x.fillStyle = "#8b95a6";
  x.font = `500 52px ${UI}`;
  x.fillText("跳繩次數", W / 2, H * 0.32);
  x.fillStyle = "#f2f5f9";
  const digits = String(lastStats.jumps).length;
  x.font = `${digits <= 3 ? 430 : digits === 4 ? 330 : 260}px Anton, sans-serif`;
  x.fillText(String(lastStats.jumps), W / 2, H * 0.55);
  x.fillStyle = "#ff5a1f";
  x.font = `700 56px ${UI}`;
  x.fillText("下", W / 2, H * 0.6);

  // stat grid, 2×2
  const mins = Math.floor(lastStats.elapsedMs / 60000);
  const secs = Math.round((lastStats.elapsedMs % 60000) / 1000);
  const cells = [
    ["時間", mins > 0 ? `${mins}分 ${secs}秒` : `${secs}秒`],
    ["消耗", `${lastStats.kcal < 10 ? lastStats.kcal.toFixed(1) : Math.round(lastStats.kcal)} 大卡`],
    ["平均速度", `${lastStats.avg} 跳/分`],
    ["最佳連跳", `${lastStats.streak} 下`],
  ];
  const gy = H * 0.66, rowH = 210, colW = (W - 168) / 2;
  cells.forEach(([label, value], i) => {
    const cx = 84 + colW * (i % 2) + colW / 2;
    const cy = gy + Math.floor(i / 2) * rowH;
    x.fillStyle = "#8b95a6";
    x.font = `500 42px ${UI}`;
    x.fillText(label, cx, cy);
    x.fillStyle = "#f2f5f9";
    x.font = `700 84px ${UI}`;
    x.fillText(value, cx, cy + 100);
  });

  // footer
  x.fillStyle = "#8b95a6";
  x.font = `500 38px ${UI}`;
  x.fillText("jumpy-swart.vercel.app", W / 2, H - 84);

  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const file = new File([blob], "jumpy-stats.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
}

async function saveRecording() {
  if (!rec.blob) return;
  const ext = rec.blob.type.includes("mp4") ? "mp4" : "webm";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = new File([rec.blob], `jumpy-${stamp}.${ext}`, { type: rec.blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      rec.saved = true;
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // user closed the share sheet
    }
  }
  // fallback: plain download (desktop browsers)
  const a = document.createElement("a");
  a.href = rec.url;
  a.download = file.name;
  a.click();
  rec.saved = true;
}

// ---------- rhythm strip ----------

function drawRhythm(now) {
  const c = els.rhythm;
  if (c.width !== c.clientWidth * devicePixelRatio) {
    c.width = c.clientWidth * devicePixelRatio;
    c.height = c.clientHeight * devicePixelRatio;
  }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const windowMs = 10_000;
  ctx.fillStyle = "#ff5a1f";
  for (let i = session.jumpTimes.length - 1; i >= 0; i--) {
    const age = now - session.jumpTimes[i];
    if (age > windowMs) break;
    const x = c.width - (age / windowMs) * c.width;
    ctx.fillRect(x - 1.5 * devicePixelRatio, c.height * 0.22, 3 * devicePixelRatio, c.height * 0.56);
  }
}

// ---------- UI state machine ----------

let state = "start"; // start | ready | countdown | live | summary

function show(screen) {
  els.screenStart.classList.toggle("hidden", screen !== "start");
  els.screenReady.classList.toggle("hidden", screen !== "ready");
  els.hud.classList.toggle("hidden", screen !== "live");
  els.screenSummary.classList.toggle("hidden", screen !== "summary");
  els.countdown.classList.toggle("hidden", screen !== "countdown");
  els.screenStats.classList.toggle("hidden", screen !== "stats");
  state = screen;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

detector.onJump = (t) => {
  session.jumps++;
  session.jumpTimes.push(t);
  session.curStreak++;
  session.bestStreak = Math.max(session.bestStreak, session.curStreak);
  els.count.textContent = session.jumps;
  els.count.classList.remove("stamp");
  void els.count.offsetWidth; // restart the pulse animation
  els.count.classList.add("stamp");
  tick();
  if (session.jumps % 50 === 0) announce(String(session.jumps));
};

let hudTimer = null;
function startHudLoop() {
  clearInterval(hudTimer);
  hudTimer = setInterval(() => {
    const now = performance.now();
    els.hudTime.textContent = fmtTime(now - session.startedAt);

    const pace = currentPace(now);
    session.peakPace = Math.max(session.peakPace, pace);
    els.mPace.textContent = pace;
    els.mStreak.textContent = session.bestStreak;

    // a gap of >2.5s breaks the streak
    const lastJump = session.jumpTimes.at(-1) ?? 0;
    if (now - lastJump > 2500) session.curStreak = 0;

    // calories accrue only while actually jumping (a jump in the last 3s)
    const dtH = (now - session.lastKcalTick) / 3_600_000;
    session.lastKcalTick = now;
    if (now - lastJump < 3000 && pace > 0) {
      session.kcal += metForPace(pace) * settings.weightKg * dtH;
    }
    els.mKcal.textContent = session.kcal.toFixed(1);

    drawRhythm(now);
  }, 250);
}

// ---------- session flow ----------

async function enableCamera() {
  els.startError.classList.add("hidden");
  $("btn-enable").disabled = true;
  $("btn-enable").textContent = "啟動中…";
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        location.protocol === "https:" || location.hostname === "localhost"
          ? "此瀏覽器無法存取相機。"
          : "相機需要 HTTPS — 請透過 https:// 網址開啟本頁。"
      );
    }
    await startCamera();
    show("ready");
    if (!landmarker) {
      els.pill.textContent = "載入追蹤器中…";
      await loadLandmarker();
      els.pill.textContent = "尋找你的身影中…";
      resizeOverlay();
      poseLoop();
    }
  } catch (err) {
    els.startError.textContent =
      err.name === "NotAllowedError"
        ? "相機權限遭拒。請到「設定 → Safari」允許相機存取後重新載入。"
        : `無法啟動：${err.message}`;
    els.startError.classList.remove("hidden");
    $("btn-enable").disabled = false;
    $("btn-enable").textContent = "開啟相機";
  }
}

function beginCountdown() {
  show("countdown");
  announce("預備");
  let n = 10;
  els.countdown.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) {
      els.countdown.textContent = n;
      tick();
    } else {
      clearInterval(iv);
      beginSession();
    }
  }, 1000);
}

let wakeLock = null;
async function beginSession() {
  Object.assign(session, {
    active: true, jumps: 0, jumpTimes: [], kcal: 0,
    peakPace: 0, bestStreak: 0, curStreak: 0,
    startedAt: performance.now(), lastKcalTick: performance.now(),
  });
  detector.reset();
  els.count.textContent = "0";
  discardRecording();
  if (recMode !== "off" && recSupported()) {
    try { await startRecording(recMode); } catch { /* recording is optional, keep counting */ }
  }
  show("live");
  announce("開始");
  startHudLoop();
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

async function endSession() {
  if (!session.active) return; // double-tap on 結束
  session.active = false;
  clearInterval(hudTimer);
  hudTimer = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;

  const blob = await stopRecording();
  if (blob && blob.size > 0) {
    rec.blob = blob;
    rec.url = URL.createObjectURL(blob);
    rec.saved = false;
    $("rec-video").src = rec.url;
    $("rec-review").classList.remove("hidden");
  }

  const elapsed = performance.now() - session.startedAt;
  const minutes = elapsed / 60_000;
  const avg = minutes > 0.05 ? Math.round(session.jumps / minutes) : 0;

  lastStats = {
    jumps: session.jumps,
    elapsedMs: elapsed,
    kcal: session.kcal,
    avg,
    peak: session.peakPace,
    streak: session.bestStreak,
    date: new Date(),
  };
  $("btn-card").classList.toggle("hidden", session.jumps === 0);

  const past = loadSessions();
  const isPb = session.jumps > 0 && past.every((s) => s.jumps < session.jumps);

  els.sumJumps.textContent = session.jumps;
  els.sumTime.textContent = fmtTime(elapsed);
  els.sumKcal.textContent = session.kcal < 10 ? session.kcal.toFixed(1) : Math.round(session.kcal);
  els.sumPace.textContent = avg;
  els.sumPeak.textContent = session.peakPace;
  els.sumPb.classList.toggle("hidden", !isPb);

  if (session.jumps > 0) {
    past.unshift({
      date: new Date().toISOString(),
      jumps: session.jumps,
      seconds: Math.round(elapsed / 1000),
      kcal: +session.kcal.toFixed(1),
    });
    saveSessions(past.slice(0, 100));
    announce(`完成，${session.jumps} 下`);
  }
  renderHistory(past.slice(0, 5));
  show("summary");
}

function renderHistory(rows) {
  if (!rows.length) { els.history.innerHTML = ""; return; }
  els.history.innerHTML =
    "<h3>最近訓練</h3>" +
    rows
      .map((s) => {
        const d = new Date(s.date);
        const when = d.toLocaleDateString("zh-TW", { month: "short", day: "numeric" });
        return `<div class="history-row"><span>${when}</span><span>${fmtTime(
          s.seconds * 1000
        )} · ${s.kcal} 大卡</span><span class="h-jumps">${s.jumps}</span></div>`;
      })
      .join("");
}

// ---------- stats ----------

const dayKey = (d) => d.toLocaleDateString("en-CA"); // local YYYY-MM-DD

const loadSessions = () =>
  JSON.parse(localStorage.getItem("jumpy.sessions") || "[]");
const saveSessions = (s) =>
  localStorage.setItem("jumpy.sessions", JSON.stringify(s));

function renderStats() {
  const sessions = loadSessions();
  if (!sessions.length) {
    els.statsBody.innerHTML =
      '<p class="stats-empty">還沒有任何紀錄。<br />完成第一次訓練後就會顯示圖表。</p>';
    return;
  }

  // day streak — consecutive training days; today not counted against you yet
  const trained = new Set(sessions.map((s) => dayKey(new Date(s.date))));
  let streak = 0;
  const cursor = new Date();
  if (!trained.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (trained.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // per-day jump totals, last 7 days
  const byDay = {};
  for (const s of sessions) {
    const k = dayKey(new Date(s.date));
    byDay[k] = (byDay[k] || 0) + s.jumps;
  }
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      label: d.toLocaleDateString("zh-TW", { weekday: "narrow" }),
      total: byDay[dayKey(d)] || 0,
      isToday: i === 0,
    });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.total));

  // rolling week vs the week before
  const now = Date.now();
  const WEEK = 7 * 86_400_000;
  const thisWk = { jumps: 0, sec: 0, kcal: 0 };
  const lastWk = { jumps: 0, sec: 0, kcal: 0 };
  for (const s of sessions) {
    const age = now - new Date(s.date).getTime();
    const bucket = age < WEEK ? thisWk : age < 2 * WEEK ? lastWk : null;
    if (!bucket) continue;
    bucket.jumps += s.jumps;
    bucket.sec += s.seconds;
    bucket.kcal += s.kcal;
  }
  let deltaHtml = "";
  if (lastWk.jumps > 0) {
    const pct = Math.round(((thisWk.jumps - lastWk.jumps) / lastWk.jumps) * 100);
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    const word = pct > 0 ? `比前一週多 ${pct}%` : pct < 0 ? `比前一週少 ${-pct}%` : "與前一週持平";
    deltaHtml = `<p class="wk-delta ${cls}">${word}</p>`;
  }

  const totalJumps = sessions.reduce((a, s) => a + s.jumps, 0);
  const best = Math.max(...sessions.map((s) => s.jumps));
  const wkCard = (title, w) => `
    <div class="wk">
      <h4>${title}</h4>
      <span class="wk-jumps">${w.jumps.toLocaleString()}</span>
      <span class="wk-sub">${Math.round(w.sec / 60)} 分鐘 · ${Math.round(w.kcal)} 大卡</span>
    </div>`;

  els.statsBody.innerHTML = `
    <p class="streak"><span class="st-num">${streak}</span><span class="st-label">天連續 — 今天也跳一下，別斷了</span></p>

    <div class="stats-section">
      <h3>最近 7 天 · 跳繩次數</h3>
      <div class="chart">
        ${days
          .map(
            (d) => `
          <div class="bar-col ${d.isToday ? "is-today" : ""}">
            <span class="bar-num">${d.total || ""}</span>
            <div class="bar ${d.isToday ? "today" : ""}" style="height:${Math.round((d.total / maxDay) * 72)}%"></div>
            <span class="bar-day">${d.label}</span>
          </div>`
          )
          .join("")}
      </div>
    </div>

    <div class="stats-section">
      <h3>週對週比較</h3>
      <div class="wk-compare">
        ${wkCard("最近 7 天", thisWk)}
        ${wkCard("前一週", lastWk)}
      </div>
      ${deltaHtml}
    </div>

    <div class="stats-section">
      <h3>歷史總計</h3>
      <div class="alltime">
        <div><span class="s-value">${totalJumps.toLocaleString()}</span><span class="s-label">總次數</span></div>
        <div><span class="s-value">${sessions.length}</span><span class="s-label">訓練次數</span></div>
        <div><span class="s-value">${best.toLocaleString()}</span><span class="s-label">單次最佳</span></div>
      </div>
    </div>

    <div class="stats-section">
      <h3>訓練紀錄</h3>
      ${sessions
        .slice(0, 30)
        .map((s, i) => {
          const d = new Date(s.date);
          const when = d.toLocaleDateString("zh-TW", { month: "short", day: "numeric" });
          return `
        <div class="hrow">
          <span class="h-jumps">${s.jumps}</span>
          <span class="h-meta">${when} · ${fmtTime(s.seconds * 1000)} · ${s.kcal} 大卡</span>
          <button class="btn-mini" data-edit="${i}" aria-label="編輯跳繩次數">✎</button>
          <button class="btn-mini btn-mini-del" data-del="${i}" aria-label="刪除紀錄">✕</button>
        </div>`;
        })
        .join("")}
      ${sessions.length > 30 ? `<p class="h-more">還有 ${sessions.length - 30} 筆較早的紀錄</p>` : ""}
    </div>`;
}

// edit / delete session records (buttons rendered by renderStats)
els.statsBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-edit], [data-del]");
  if (!btn) return;
  const sessions = loadSessions();
  const i = +(btn.dataset.edit ?? btn.dataset.del);
  const s = sessions[i];
  if (!s) return;

  if (btn.dataset.del !== undefined) {
    const when = new Date(s.date).toLocaleDateString("zh-TW");
    if (!confirm(`確定刪除 ${when} 的紀錄（${s.jumps} 下）嗎？`)) return;
    sessions.splice(i, 1);
  } else {
    const v = prompt("這次訓練的跳繩次數：", s.jumps);
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) {
      alert("請輸入 0 或以上的數字。");
      return;
    }
    s.jumps = n;
  }
  saveSessions(sessions);
  renderStats();
});

let statsReturnTo = "start";
function openStats() {
  statsReturnTo = state;
  renderStats();
  show("stats");
}
$("btn-stats-start").addEventListener("click", openStats);
$("btn-stats-sum").addEventListener("click", openStats);
$("btn-stats-close").addEventListener("click", () => show(statsReturnTo));

// ---------- overlay sizing ----------

function resizeOverlay() {
  els.overlay.width = innerWidth * devicePixelRatio;
  els.overlay.height = innerHeight * devicePixelRatio;
  els.overlay.style.width = innerWidth + "px";
  els.overlay.style.height = innerHeight + "px";
}
addEventListener("resize", resizeOverlay);

// ---------- wire up ----------

$("btn-enable").addEventListener("click", enableCamera);
$("btn-go").addEventListener("click", () => {
  if (state !== "ready") return; // ignore double-taps mid-countdown
  // unlock audio + speech inside the user gesture (iOS requirement)
  tick();
  beginCountdown();
});
$("btn-stop").addEventListener("click", endSession);
$("btn-again").addEventListener("click", () => {
  if (rec.blob && !rec.saved && !confirm("影片尚未儲存，要放棄它嗎？")) return;
  discardRecording();
  if (els.cam.paused) els.cam.play().catch(() => {});
  $("btn-go").disabled = pillOn !== true;
  show("ready");
});

const btnRec = $("btn-rec");
const REC_ORDER = ["off", "real", "lapse10", "lapse25", "lapse50"];
const REC_LABELS = { off: "錄影：關", real: "錄影：一般速度", lapse10: "錄影：縮時 10×", lapse25: "錄影：縮時 25×", lapse50: "錄影：縮時 50×" };
if (!recSupported()) btnRec.classList.add("hidden");
btnRec.addEventListener("click", () => {
  recMode = REC_ORDER[(REC_ORDER.indexOf(recMode) + 1) % REC_ORDER.length];
  btnRec.classList.toggle("on", recMode !== "off");
  btnRec.setAttribute("aria-pressed", String(recMode !== "off"));
  btnRec.querySelector(".rec-label").textContent = REC_LABELS[recMode];
});

$("btn-rec-save").addEventListener("click", saveRecording);
$("btn-card").addEventListener("click", shareStatCard);
$("btn-rec-del").addEventListener("click", () => {
  if (!confirm("確定刪除這段影片嗎？")) return;
  discardRecording();
});

$("btn-settings").addEventListener("click", () => {
  els.setWeight.value = settings.weightKg;
  els.setSound.checked = settings.sound;
  $("set-sens").value = settings.sensitivity;
  els.sheet.classList.remove("hidden");
});
$("btn-sheet-close").addEventListener("click", () => {
  const w = parseFloat(els.setWeight.value);
  if (w >= 20 && w <= 250) settings.weightKg = w;
  settings.sound = els.setSound.checked;
  settings.sensitivity = $("set-sens").value;
  saveSettings();
  els.sheet.classList.add("hidden");
});
$("btn-flip").addEventListener("click", async () => {
  settings.facing = settings.facing === "user" ? "environment" : "user";
  saveSettings();
  try { await startCamera(); } catch {}
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state === "live") {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

resizeOverlay();
show("start");
