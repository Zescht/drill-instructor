# Drill Instructor (MVP)

A virtual range officer and shot timer for airsoft/GBB drill practice, running in the phone browser and offline.

Flow: pick a drill → **Start** → 3 s → "Two body, one head. Low ready." → "Shooter ready?" → you say **"ready"** → "Stand by." → random 1–4 s → **beep** → the app counts your shots through the microphone and stops the timer at the last shot.

## Use it

1. Open the GitHub Pages link on the iPhone (Chrome, Firefox or Safari).
2. Share → **Add to Home Screen**, and always start it from that icon (offline use only works there).
3. Open it once online and wait until the pill says **Voice model: ready** (41 MB, stored on the phone).
4. Allow microphone access when asked.

## Test panel

- **Meter:** live microphone peak (bar), background level (grey line), shot threshold (red line).
- **Shot threshold / above background / ignore after a shot:** tune shot detection. A peak counts as a shot when it is above the threshold *and* far enough above the background.
- **Start shot test:** counts shots freely outside a drill and lists the time between them.
- **"Ready" detection:** offline speech model (word "ready"), any voice, or tap only.
- **Log:** every detection with its level. Use **Copy log** to share test results.

## Files

- `index.html`, `style.css`, `app.js`: the app
- `shot-worklet.js`: shot detection on the audio thread
- `sw.js`, `manifest.webmanifest`: offline support and install
- `audio/`: voice clips (`tools/make_voice.py`, edge-tts voice en-US-ChristopherNeural)
- `vendor/vosk.js`, `vendor/model-en.tar.gz`: offline speech recognition ([vosk-browser](https://github.com/ccoreilly/vosk-browser) and the [Vosk](https://alphacephei.com/vosk/) small English model, both Apache-2.0)
