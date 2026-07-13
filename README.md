# Jumpy 🪢

A jump rope counter that watches you through your phone's camera and keeps score — no wearables, no tapping. Built for propping an iPhone up 2–3 meters away while you jump.

**Live demo:** https://jumpy-swart.vercel.app — open it on your phone and jump.

All processing happens **on-device in the browser** (MediaPipe Pose over WASM/GPU). No video is uploaded anywhere.

## Features

- **Automatic jump counting** — pose tracking on your torso with adaptive peak detection, so it works for big jumps and low fast skips alike
- **Giant counter** readable from across the room, with a pulse on every jump
- **Audio tick** per jump + spoken milestones every 50 jumps (so you don't have to look)
- **Calories burned** — MET-based (Compendium of Physical Activities), scaled to your weight and live cadence
- **Pace (jumps/min)** and **best streak** (longest run without a 2.5 s break)
- **Rhythm strip** — a live tick trace of your last 10 seconds; even spacing = clean rhythm
- **Session summary + history** with personal-best detection (stored locally)
- **Stats screen** — day streak, last-7-days jump chart, week-over-week comparison, all-time totals
- **Optional session recording** — a per-session toggle (off / 10× / 25× / 50× timelapse) composites the camera + skeleton + live HUD into a video. Normal speed uses MediaRecorder over a canvas; timelapse uses WebCodecs (VideoEncoder + [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)) keeping 1 of every 5 frames with re-timestamped output, falling back to normal speed if unsupported. System notifications can never appear since it's not a true screen capture. After the session: save to Photos via the share sheet, or delete. Silent (no mic audio).
- **Share card** — a Strava-style 1080×1920 stats image (jumps, time, calories, pace, streak) generated on-device and shared via the share sheet.
- 10-second countdown after GO, screen wake lock, front/rear camera flip
- Installable: on iPhone, Share → **Add to Home Screen** for a full-screen app

## How the counting works

Each frame, MediaPipe Pose gives 33 body landmarks. Jumpy tracks the hips as the primary signal (so raising your arms can't trigger a count), measured in units of torso length (so distance from the camera doesn't matter). Detection is peak-to-trough cycle counting: a jump is one full rise-and-fall of the hips whose swing exceeds an adaptive threshold, **and** where the shoulders rose with the hips. Because the swing is measured between the running trough and peak (not against a fixed baseline), continuous fast bouncing doesn't lose amplitude to baseline drift — it tracks up to ~330 jumps/min with a 180 ms refractory period. A drift gate suppresses counting while the body is moving sideways or toward/away from the camera, so walking doesn't count. Sensitivity is adjustable in settings. Approach inspired by [aminnj/jumpcount](https://github.com/aminnj/jumpcount).

## Running it

It's a static site — no build step. But **iOS Safari only allows camera access over HTTPS**, so:

**Easiest (recommended): deploy it**

```sh
cd jumpy
npx vercel        # free, gives you an https URL to open on the iPhone
```

(or drag the folder into Netlify Drop, or push to GitHub Pages — anything HTTPS works)

**Local development on your Mac**

```sh
cd jumpy
npx serve .       # http://localhost:3000 — localhost is allowed camera access
```

**Testing on the iPhone against your Mac** requires HTTPS on the LAN; the simplest option:

```sh
npx vite --host   # then use a tool like `npx local-ssl-proxy` — honestly, just deploy instead
```

## Using it (tell your friend)

1. Open the URL on the iPhone, allow camera access
2. Prop the phone upright (portrait) ~2–3 m away, whole body in frame — the front camera is used by default so you can see your count
3. Wait for the pill to say **Tracking**, tap **GO**, get in position during the 10-second countdown
4. Jump. Tap **Finish** when done for the summary
5. Gear icon → set your weight in kg for accurate calories

## Files

| File | What it is |
|---|---|
| `index.html` | markup for all screens (start / ready / live HUD / summary / settings) |
| `style.css` | dark athletic UI, safe-area aware, landscape support |
| `app.js` | camera, pose loop, jump detector, metrics, audio, storage |
| `manifest.json`, `icon.svg` | home-screen install support |

## Credits / references

- [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) — Google's on-device pose model
- [aminnj/jumpcount](https://github.com/aminnj/jumpcount) — prior art for in-browser jump counting via torso peak detection
- [chenwr727/RopeSkippingCounter](https://github.com/chenwr727/RopeSkippingCounter) — Python/OpenCV take on the same idea
