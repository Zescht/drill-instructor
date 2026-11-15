'use strict';

// ---------- Config ----------
const DRILLS = [
  { id: '2body1head', name: '2 Body - 1 Head', shots: 3, start: 'Low ready', clip: 'audio/drill-2body1head.mp3' },
];
const CLIP_READY = 'audio/shooter-ready.mp3';
const CLIP_STANDBY = 'audio/stand-by.mp3';
const MODEL_URL = new URL('vendor/model-en.tar.gz', location.href).href; // stable URL = cache key for the model

const PRE_DELAY_MS = 3000;     // silent pause after pressing Start
const ANNOUNCE_GAP_MS = 800;   // pause between drill name and "Shooter ready?"
const LISTEN_DELAY_MS = 150;   // start listening for "ready" this long after the prompt ends
const MIN_DELAY = 1, MAX_DELAY = 4; // random delay after "Stand by" (USPSA 8.3.3)
const BEEP_HZ = 2000, BEEP_SEC = 0.4; // placeholder beep

// ---------- Small helpers ----------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -120);
const fromDb = (db) => Math.pow(10, db / 20);
const fmt = (s) => s.toFixed(2);

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const settings = Object.assign(
  { thrDb: -25, ratio: 4, lockMs: 80, readyMode: 'vosk', readyPartial: false, latencyMs: 0 },
  load('vi-settings', {}),
);

const logEl = $('log');
function log(msg) {
  const t = new Date().toISOString().slice(11, 23);
  logEl.value += `${t}  ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- Audio setup ----------
let ctx = null, stream = null, srcNode = null, node = null, workletLoaded = false;
const buffers = {};
const playing = new Set();

async function ensureAudio() {
  // Called directly from a tap: create/resume the AudioContext before any await (iOS requirement).
  if (!ctx) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* iOS 17+ only */ }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const resumed = ctx.resume();

  const track = stream && stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    if (srcNode) srcNode.disconnect();
    if (node) node.disconnect();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    if (!workletLoaded) {
      await ctx.audioWorklet.addModule('shot-worklet.js');
      workletLoaded = true;
    }
    srcNode = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'shot-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e) => onWorklet(e.data);
    srcNode.connect(node);
    node.connect(ctx.destination); // outputs silence; keeps the processor running
    pushDetectorSettings();
    describeMic();
  }
  await resumed;
  await loadClips();
}

function describeMic() {
  const tr = stream.getAudioTracks()[0];
  const s = tr.getSettings ? tr.getSettings() : {};
  const info = `Mic: ${tr.label || 'unknown'} | sampleRate ${ctx.sampleRate} Hz | ` +
    `echoCancellation ${s.echoCancellation} noiseSuppression ${s.noiseSuppression} autoGainControl ${s.autoGainControl} | ` +
    `baseLatency ${Math.round((ctx.baseLatency || 0) * 1000)} ms outputLatency ${Math.round((ctx.outputLatency || 0) * 1000)} ms`;
  $('mic-info').textContent = info;
  log(info);
}

async function loadClips() {
  const urls = [CLIP_READY, CLIP_STANDBY, ...DRILLS.map((d) => d.clip)];
  await Promise.all(urls.filter((u) => !buffers[u]).map(async (u) => {
    const data = await (await fetch(u)).arrayBuffer();
    buffers[u] = await new Promise((res, rej) => ctx.decodeAudioData(data, res, rej));
  }));
}

function playClip(url) {
  return new Promise((resolve) => {
    const s = ctx.createBufferSource();
    s.buffer = buffers[url];
    s.connect(ctx.destination);
    s.onended = () => { playing.delete(s); resolve(); };
    playing.add(s);
    s.start();
  });
}

function scheduleBeep(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.value = BEEP_HZ;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.004);
  g.gain.setValueAtTime(0.5, t + BEEP_SEC - 0.01);
  g.gain.linearRampToValueAtTime(0, t + BEEP_SEC);
  o.connect(g).connect(ctx.destination);
  o.onended = () => playing.delete(o);
  playing.add(o);
  o.start(t);
  o.stop(t + BEEP_SEC + 0.02);
}

function stopAllAudio() {
  for (const s of playing) { try { s.stop(); } catch { /* already stopped */ } }
  playing.clear();
}

function setDetector(msg) { if (node) node.port.postMessage(msg); }
function pushDetectorSettings() {
  setDetector({ threshold: fromDb(settings.thrDb), ratio: settings.ratio, lockoutSec: settings.lockMs / 1000 });
}

// ---------- Worklet messages ----------
function onWorklet(m) {
  if (m.type === 'meter') onMeter(m);
  else if (m.type === 'shot') onShot(m);
  else if (m.type === 'audio') {
    if (recording) recording.chunks.push(m.data);
    if (recognizer) recognizer.acceptWaveformFloat(m.data, ctx.sampleRate);
  }
}

// Raw audio is forwarded from the worklet while the recognizer listens or a sample is recorded.
function updateForward() { setDetector({ forward: !!(recognizer || recording) }); }

const meterPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function onMeter(m) {
  const peakDb = toDb(m.peak);
  for (const w of document.querySelectorAll('.meter-wrap')) {
    const bar = w.querySelector('.meter-bar');
    bar.style.width = meterPct(peakDb) + '%';
    bar.classList.toggle('hot', peakDb >= settings.thrDb);
    w.querySelector('.meter-floor').style.left = meterPct(toDb(m.floor)) + '%';
    w.querySelector('.meter-thr').style.left = meterPct(settings.thrDb) + '%';
    w.querySelector('.meter-val').textContent = `peak ${peakDb.toFixed(0)} dB · bg ${toDb(m.floor).toFixed(0)} dB`;
  }
  if (recording && m.peak > recording.maxPeak) recording.maxPeak = m.peak;

  // "Any voice" fallback: about 250 ms of sound clearly above the background
  if (run && run.voiceCheck) {
    const active = m.rms >= Math.max(m.floor * 3, fromDb(-45));
    run.voiceMs = Math.max(0, (run.voiceMs || 0) + (active ? 25 : -12));
    if (run.voiceMs >= 250) run.voiceCheck('any voice');
  }
}

function onShot(m) {
  if (recording) {
    recording.detections.push({ t: +(m.time - recording.startTime).toFixed(3), peakDb: +toDb(m.peak).toFixed(1), bgDb: +toDb(m.floor).toFixed(1) });
    return;
  }
  if (shotTest.active) {
    shotTest.times.push(m.time);
    const n = shotTest.times.length;
    const split = n > 1 ? `+${fmt(m.time - shotTest.times[n - 2])} s` : 'first';
    const li = document.createElement('li');
    li.textContent = `${split}   peak ${toDb(m.peak).toFixed(0)} dB, bg ${toDb(m.floor).toFixed(0)} dB`;
    $('shot-test-list').appendChild(li);
    log(`shot test #${n}: ${split} peak ${toDb(m.peak).toFixed(1)} dB bg ${toDb(m.floor).toFixed(1)} dB`);
    return;
  }
  const r = run;
  if (!r || r.phase !== 'live') return;
  const rel = m.time - r.beepHeard;
  const early = m.time < r.beepAt + BEEP_SEC + 0.02;
  log(`detect ${rel >= 0 ? '+' : ''}${rel.toFixed(3)} s peak ${toDb(m.peak).toFixed(1)} dB bg ${toDb(m.floor).toFixed(1)} dB${early ? '  IGNORED (before/during beep)' : ''}`);
  if (early) return;
  r.shots.push(m.time);
  $('shot-count').textContent = `${r.shots.length} / ${r.drill.shots} shots`;
  if (r.shots.length >= r.drill.shots) finishRun(r);
}

// ---------- Voice model ("ready") ----------
let model = null, recognizer = null;

async function loadModel() {
  const pill = $('model-status');
  if (!window.Vosk) { pill.textContent = 'Voice model: library missing'; pill.className = 'pill err'; return; }
  pill.textContent = 'Voice model: loading…';
  const t0 = performance.now();
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    model = await Vosk.createModel(MODEL_URL);
    pill.textContent = 'Voice model: ready';
    pill.className = 'pill ok';
    log(`Voice model ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    pill.textContent = 'Voice model: failed';
    pill.className = 'pill err';
    log('Voice model failed: ' + (e && e.message ? e.message : e));
  }
}

function startRecognizer(onReady) {
  const rec = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify(['ready', '[unk]']));
  rec.on('result', (msg) => {
    const text = (msg.result && msg.result.text) || '';
    if (text) log(`heard (final): "${text}"`);
    if (/\bready\b/.test(text)) onReady('voice "ready"');
  });
  rec.on('partialresult', (msg) => {
    const p = (msg.result && msg.result.partial) || '';
    if (settings.readyPartial && /\bready\b/.test(p)) { log(`heard (partial): "${p}"`); onReady('voice "ready" (partial)'); }
  });
  recognizer = rec;
  updateForward();
}

function stopRecognizer() {
  if (recognizer) { try { recognizer.remove(); } catch { /* ignore */ } recognizer = null; }
  updateForward();
}

// ---------- Drill run ----------
let currentDrill = null;
let run = null;
let runCounter = 0;
const alive = (r) => run === r;

function setStatus(text, live = false) {
  $('status').textContent = text;
  $('status').classList.toggle('live', live);
}

function waitForReady(r) {
  return new Promise((resolve) => {
    const cleanup = () => {
      r.readyDone = null; r.voiceCheck = null;
      $('btn-ready').hidden = true;
      stopRecognizer();
    };
    const done = (how) => { if (r.readyDone) { cleanup(); resolve(how); } };
    r.readyDone = done;
    r.cancelReady = cleanup;
    $('btn-ready').hidden = false;

    if (settings.readyMode === 'vosk') {
      if (model) startRecognizer(done);
      else log('Voice model not ready yet: use the Ready tap button');
    } else if (settings.readyMode === 'voice') {
      r.voiceMs = 0;
      r.voiceCheck = done;
    }
  });
}

async function startRun() {
  if (shotTest.active) stopShotTest();
  const r = { id: ++runCounter, drill: currentDrill, phase: 'starting', shots: [] };
  run = r;
  showRunning();
  setStatus('Get set…');
  try {
    await ensureAudio();
  } catch (e) {
    log('Audio/microphone failed: ' + (e && e.message ? e.message : e));
    setStatus('Microphone error');
    run = null;
    showIdle(false);
    return;
  }
  requestWakeLock();
  log(`--- Run ${r.id}: ${r.drill.name} (ready mode: ${settings.readyMode})`);

  await sleep(PRE_DELAY_MS); if (!alive(r)) return;
  setStatus(r.drill.name);
  await playClip(r.drill.clip); if (!alive(r)) return;
  await sleep(ANNOUNCE_GAP_MS); if (!alive(r)) return;
  setStatus('Shooter ready?');
  await playClip(CLIP_READY); if (!alive(r)) return;
  await sleep(LISTEN_DELAY_MS); if (!alive(r)) return;

  r.phase = 'waitReady';
  const t0 = performance.now();
  const how = await waitForReady(r); if (!alive(r)) return;
  log(`Ready via ${how} after ${((performance.now() - t0) / 1000).toFixed(2)} s`);

  r.phase = 'standby';
  setStatus('Stand by');
  await playClip(CLIP_STANDBY); if (!alive(r)) return;

  const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  r.beepAt = ctx.currentTime + delay;
  r.beepHeard = r.beepAt + (ctx.outputLatency || 0);
  scheduleBeep(r.beepAt);
  r.phase = 'live';
  setDetector({ armed: true });
  log(`Beep after ${delay.toFixed(2)} s (outputLatency ${Math.round((ctx.outputLatency || 0) * 1000)} ms)`);
  r.liveTimer = setTimeout(() => {
    if (alive(r) && r.phase === 'live') {
      setStatus('LIVE', true);
      $('shot-count').textContent = `${r.shots.length} / ${r.drill.shots} shots`;
    }
  }, delay * 1000);
}

function finishRun(r) {
  setDetector({ armed: false });
  r.phase = 'done';
  clearTimeout(r.liveTimer);
  const off = settings.latencyMs / 1000;
  const rel = r.shots.map((t) => t - r.beepHeard - off);
  const total = rel[rel.length - 1];
  const first = rel[0];
  const splits = rel.slice(1).map((t, i) => t - rel[i]);

  $('res-total').textContent = fmt(total);
  $('res-first').textContent = fmt(first) + ' s';
  $('res-splits').textContent = splits.length ? splits.map(fmt).join(' · ') : '–';
  setStatus('Done');
  $('shot-count').textContent = `${r.shots.length} / ${r.drill.shots} shots`;
  showDone();

  const runs = load('vi-runs', []);
  runs.push({ drill: r.drill.id, date: new Date().toISOString(), total, first, splits });
  save('vi-runs', runs);
  log(`Result: total ${fmt(total)} s, first ${fmt(first)} s, splits ${splits.map(fmt).join(', ')}`);
}

function abortRun() {
  const r = run;
  run = null;
  if (r) {
    clearTimeout(r.liveTimer);
    if (r.cancelReady) r.cancelReady();
    if (r.phase !== 'done') log(`Run ${r.id} aborted`);
  }
  stopAllAudio();
  stopRecognizer();
  setDetector({ armed: false });
}

// ---------- Shot test (free counting, outside a drill) ----------
const shotTest = { active: false, times: [] };

async function startShotTest() {
  try { await ensureAudio(); } catch (e) { log('Audio/microphone failed: ' + e); return; }
  shotTest.active = true;
  shotTest.times = [];
  $('shot-test-list').innerHTML = '';
  $('btn-shot-test').textContent = 'Stop shot test';
  setDetector({ armed: true });
  requestWakeLock();
  log('--- Shot test started');
}
function stopShotTest() {
  shotTest.active = false;
  setDetector({ armed: false });
  $('btn-shot-test').textContent = 'Start shot test';
  log(`--- Shot test stopped (${shotTest.times.length} shots)`);
}

// ---------- Sample recording (guided) ----------
const RECORDINGS = [
  {
    id: 'single', title: '1. Single shots', maxSec: 60, askShots: true,
    steps: [
      'Stand at your normal shooting position, rifle ready, AirPods on.',
      'Press Record, then stay still and quiet for 2 seconds.',
      'Fire 10 to 15 single shots at your target, about 2 seconds apart.',
      'Wait 2 seconds after the last shot, then press Stop.',
      'Enter how many shots you fired.',
    ],
  },
  {
    id: 'strings', title: '2. Fast strings', maxSec: 60, askShots: true,
    steps: [
      'Same position as before. Press Record, wait 2 seconds.',
      'Fire 3 to 4 strings like in your drills: doubles and triples, as fast as you normally shoot.',
      'Leave about 3 seconds between strings.',
      'Wait 2 seconds, press Stop, and enter the total number of shots.',
    ],
  },
  {
    id: 'noise', title: '3. Everything that is NOT a shot', maxSec: 90, askShots: false,
    steps: [
      'Do NOT fire in this recording.',
      'Say "ready" a few times, talk normally, cough or clear your throat.',
      'Do a magazine change, pull the charging handle, tap the rifle, put it down and pick it up.',
      'Walk a few steps, rustle your clothing, move the way you move between drills.',
      'Add any other sounds typical for your shooting place.',
    ],
  },
  {
    id: 'quiet', title: '4. Quiet background', maxSec: 20, askShots: false,
    steps: [
      'Stand still and stay quiet for about 15 seconds (it stops by itself after 20).',
      'This captures the normal background sound of the place.',
    ],
  },
];

// Tiny IndexedDB store so recordings survive closing the app.
const sampleDb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('drill-vi-samples', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('samples');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('samples', mode);
      const req = fn(t.objectStore('samples'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
})();

const samples = {};      // id -> saved recording (kept in memory so sharing works directly from a tap)
let recording = null;    // the recording in progress
const recStateEls = {};

async function loadSamples() {
  for (const r of RECORDINGS) {
    try { const s = await sampleDb.get(r.id); if (s) samples[r.id] = s; } catch (e) { log('Could not load sample: ' + e); }
  }
  try { $('rec-note').value = (await sampleDb.get('note')) || ''; } catch { /* ignore */ }
}

function fmtDur(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function recStateText(r) {
  if (recording && recording.id === r.id) {
    return `● REC ${fmtDur(ctx.currentTime - recording.startTime)} / ${fmtDur(r.maxSec)} · ${recording.detections.length} spikes`;
  }
  const s = samples[r.id];
  if (!s) return 'not recorded yet';
  const shots = r.askShots ? (s.shots != null ? ` · ${s.shots} shots fired` : ' · enter shots fired!') : '';
  const sent = sending.has(r.id) ? ' · sending…' : s.sentAt ? ' · sent to Claude ✓' : ' · not sent';
  return `✓ ${fmtDur(s.duration)} · ${s.detections.length} spikes${shots}${sent}`;
}

let playerUrls = [];

function renderRecList() {
  const list = $('rec-list');
  list.innerHTML = '';
  for (const u of playerUrls) URL.revokeObjectURL(u);
  playerUrls = [];
  for (const r of RECORDINGS) {
    const s = samples[r.id];
    const active = recording && recording.id === r.id;
    const card = document.createElement('div');
    card.className = 'rec-card' + (active ? ' active' : s ? ' done' : '');
    card.innerHTML = `
      <div class="rec-head"><b></b><span class="rec-state"></span></div>
      <ol></ol>
      <audio controls preload="metadata" hidden></audio>
      <label class="rec-shots" hidden>Shots fired in this recording
        <input type="number" min="0" inputmode="numeric" placeholder="e.g. 12">
      </label>
      <div class="warn rec-err" hidden></div>
      <div class="buttons small-row rec-actions"></div>`;
    card.querySelector('b').textContent = r.title;
    for (const step of r.steps) {
      const li = document.createElement('li');
      li.textContent = step;
      card.querySelector('ol').appendChild(li);
    }
    const state = card.querySelector('.rec-state');
    state.textContent = recStateText(r);
    recStateEls[r.id] = state;

    // Replay
    const player = card.querySelector('audio');
    if (s && !active) {
      const url = URL.createObjectURL(s.blob);
      playerUrls.push(url);
      player.src = url;
      player.hidden = false;
    }

    const shotsBox = card.querySelector('.rec-shots');
    const shotsInput = shotsBox.querySelector('input');
    shotsBox.hidden = !(r.askShots && s && !active);
    if (s && s.shots != null) shotsInput.value = s.shots;
    shotsInput.onchange = () => {
      s.shots = shotsInput.value === '' ? null : Math.max(0, Math.round(+shotsInput.value));
      s.sentAt = null; // changed after sending: needs sending again
      sampleDb.set(r.id, s).catch((e) => log('Save failed: ' + e));
      renderRecList();
    };

    const err = card.querySelector('.rec-err');
    if (s && s.sendError && !sending.has(r.id)) {
      err.hidden = false;
      err.textContent = 'Not sent: ' + s.sendError;
    }

    // Buttons: recording -> Stop / Abort; recorded -> Redo / Send / Delete; empty -> Record
    const actions = card.querySelector('.rec-actions');
    const addBtn = (label, fn, disabled = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.disabled = disabled;
      b.onclick = fn;
      actions.appendChild(b);
    };
    const busy = (!!recording && !active) || sending.size > 0; // another card is recording, or an upload runs
    if (active) {
      addBtn('Stop & keep', () => stopRecording());
      addBtn('Abort', () => abortRecording());
    } else if (s) {
      addBtn('Redo', () => startRecording(r), busy);
      addBtn(sending.has(r.id) ? 'Sending…' : s.sentAt ? 'Send again' : 'Send this one', () => sendSamples([r]), busy);
      addBtn('Delete', () => deleteSample(r), busy);
    } else {
      addBtn('Record', () => startRecording(r), busy);
    }

    list.appendChild(card);
  }
  const unsent = RECORDINGS.filter((r) => samples[r.id] && !samples[r.id].sentAt);
  const shareBtn = $('btn-rec-share');
  shareBtn.disabled = !!recording || sending.size > 0 || !unsent.length;
  shareBtn.textContent = sending.size ? 'Sending…' : unsent.length ? `Send ${unsent.length === 1 ? 'the unsent recording' : `all ${unsent.length} unsent recordings`}` : 'Everything is sent ✓';
}

// Mic Mode: a website cannot read the iPhone setting, so the user confirms it.
// If the browser ever reports voice isolation on the track, warn automatically.
function checkVoiceIsolation() {
  const tr = stream && stream.getAudioTracks()[0];
  const s = tr && tr.getSettings ? tr.getSettings() : {};
  return s.voiceIsolation === true;
}

const MIC_MODE_NAMES = { wide: 'Wide Spectrum', auto: 'Automatic', voice: 'Voice Isolation', none: 'no Mic Mode shown' };
if (settings.micModeOk && !settings.micMode) settings.micMode = 'wide'; // from the earlier checkbox version

function refreshMicModeBox() {
  const mode = settings.micMode || '';
  const reported = checkVoiceIsolation();
  $('micmode-sel').value = mode;
  const box = document.querySelector('.micmode');
  const bad = mode === 'voice' || reported;
  box.classList.toggle('ok', !!mode && !bad);
  box.classList.toggle('bad', bad);
  const warn = $('micmode-warn');
  warn.hidden = !bad;
  warn.textContent = reported
    ? 'The browser reports that voice isolation is ON. Switch Mic Mode to Wide Spectrum or Automatic.'
    : 'Voice Isolation filters out your shots. Please switch to Wide Spectrum, or Automatic if Wide Spectrum is greyed out.';
}

async function startRecording(r) {
  if (recording) return;
  try { await ensureAudio(); } catch (e) { log('Audio/microphone failed: ' + e); alert('Microphone not available: ' + e); return; }
  refreshMicModeBox();
  if ((checkVoiceIsolation() || settings.micMode === 'voice') && !confirm('Voice Isolation filters out shots. Record anyway?')) return;
  if (!settings.micMode && !confirm('You have not selected which Mic Mode is set (see the box above). Record anyway?')) return;
  if (samples[r.id] && !confirm(`Replace the existing "${r.title}" recording?`)) return;
  recording = { id: r.id, chunks: [], detections: [], maxPeak: 0, startTime: ctx.currentTime };
  updateForward();
  setDetector({ armed: true }); // log what the current detector would count (for comparison)
  requestWakeLock();
  recording.tick = setInterval(() => {
    if (!recording) return;
    recStateEls[r.id].textContent = recStateText(r);
    if (ctx.currentTime - recording.startTime >= r.maxSec) stopRecording();
  }, 250);
  log(`--- Recording "${r.id}" started`);
  renderRecList();
}

function stopRecording() {
  const rec = recording;
  if (!rec) return;
  recording = null;
  clearInterval(rec.tick);
  updateForward();
  setDetector({ armed: false });
  const r = RECORDINGS.find((x) => x.id === rec.id);
  const blob = encodeWav(rec.chunks, ctx.sampleRate);
  const tr = stream && stream.getAudioTracks()[0];
  const s = {
    id: rec.id,
    blob,
    date: new Date().toISOString(),
    duration: rec.chunks.reduce((a, c) => a + c.length, 0) / ctx.sampleRate,
    sampleRate: ctx.sampleRate,
    maxPeakDb: +toDb(rec.maxPeak).toFixed(1),
    detections: rec.detections,
    shots: null, // entered by the user after the recording
    mic: tr ? tr.label : '',
    micSettings: tr && tr.getSettings ? tr.getSettings() : {},
    detector: { thrDb: settings.thrDb, ratio: settings.ratio, lockMs: settings.lockMs },
    micMode: MIC_MODE_NAMES[settings.micMode] || 'not selected',
  };
  samples[rec.id] = s;
  sampleDb.set(rec.id, s).catch((e) => log('Save failed: ' + e));
  log(`--- Recording "${rec.id}" stopped: ${s.duration.toFixed(1)} s, ${s.detections.length} spikes, max ${s.maxPeakDb} dB`);
  renderRecList();
  if (r.askShots) {
    const input = $('rec-list').querySelectorAll('.rec-card')[RECORDINGS.indexOf(r)].querySelector('.rec-shots input');
    input.focus();
  }
}

// Throw away the recording in progress; an earlier recording of the same step is kept.
function abortRecording() {
  const rec = recording;
  if (!rec) return;
  recording = null;
  clearInterval(rec.tick);
  updateForward();
  setDetector({ armed: false });
  log(`--- Recording "${rec.id}" aborted (discarded)`);
  renderRecList();
}

async function deleteSample(r) {
  if (!confirm(`Delete the "${r.title}" recording?`)) return;
  delete samples[r.id];
  await sampleDb.del(r.id).catch((e) => log('Delete failed: ' + e));
  renderRecList();
}

function encodeWav(chunks, sampleRate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const x = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function sampleFileName(s) {
  const d = s.date.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const shots = s.shots != null ? `_${s.shots}shots` : '';
  return `${s.id}${shots}_${d}.wav`;
}

// ---------- Send to Claude: upload into the private GitHub repo ----------
// The upload key (fine-grained token, only for that repo) is stored on this phone only.
const UPLOAD_REPO = 'Zescht/drill-samples';
const TOKEN_KEY = 'vi-upload-token';
const sending = new Set(); // ids being uploaded right now

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

function ghApi(path, opts = {}, token = getToken()) {
  return fetch(`https://api.github.com/repos/${UPLOAD_REPO}${path}`, {
    ...opts,
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

async function ghError(res) {
  if (res.status === 401) return 'upload key is wrong or expired. Set it up again.';
  if (res.status === 403 || res.status === 404) return 'upload key has no write access to drill-samples (check repository and "Contents: Read and write").';
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
  return `GitHub error ${res.status} ${msg}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// Create the file, or overwrite it if it already exists (resend).
async function putFile(path, base64, message) {
  const body = { message, content: base64 };
  let res = await ghApi('/contents/' + path, { method: 'PUT', body: JSON.stringify(body) });
  if (res.status === 422 || res.status === 409) {
    const cur = await ghApi('/contents/' + path);
    if (cur.ok) {
      body.sha = (await cur.json()).sha;
      res = await ghApi('/contents/' + path, { method: 'PUT', body: JSON.stringify(body) });
    }
  }
  if (!res.ok) throw new Error(await ghError(res));
}

function sampleInfo(s) {
  return {
    app: 'drill-instructor',
    sent: new Date().toISOString(),
    note: $('rec-note').value,
    userAgent: navigator.userAgent,
    file: sampleFileName(s), id: s.id, date: s.date, durationSec: +s.duration.toFixed(2), sampleRate: s.sampleRate,
    wavBytes: s.blob ? s.blob.size : 0,
    shotsFired: s.shots, maxPeakDb: s.maxPeakDb, mic: s.mic, micSettings: s.micSettings,
    micMode: s.micMode || 'not selected',
    detectorAtRecording: s.detector, detectedSpikes: s.detections,
  };
}

async function sendSamples(which) {
  if (sending.size) return;
  if (!getToken()) {
    alert('Sending needs a one-time setup first: see the box "Send to Claude" on this page.');
    $('upload-box').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const list = which.filter((r) => samples[r.id]);
  if (!list.length) return;
  const missing = list.filter((r) => r.askShots && samples[r.id].shots == null);
  if (missing.length && !confirm('The number of shots fired is missing for: ' + missing.map((r) => r.title).join(', ') + '. Send anyway?')) return;

  for (const r of list) sending.add(r.id);
  renderRecList();
  for (const r of list) {
    const s = samples[r.id];
    s.sendError = null;
    try {
      const folder = `samples/${s.date.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}_${s.id}`;
      await putFile(`${folder}/${sampleFileName(s)}`, await blobToBase64(s.blob), `${r.title}: recording`);
      await putFile(`${folder}/info.json`, await blobToBase64(new Blob([JSON.stringify(sampleInfo(s), null, 2)])), `${r.title}: info`);
      s.sentAt = new Date().toISOString();
      await sampleDb.set(r.id, s).catch(() => {});
      log(`--- Sent "${s.id}" to ${folder}`);
    } catch (e) {
      s.sendError = e.message === 'Failed to fetch' || e.message === 'Load failed' ? 'no internet connection. Try again.' : e.message;
      log(`Send "${s.id}" failed: ${s.sendError}`);
    }
    sending.delete(r.id);
    renderRecList();
  }
}

function refreshUploadBox() {
  const has = !!getToken();
  $('upload-box').classList.toggle('ok', has);
  $('upload-setup').hidden = has;
  $('upload-connected').hidden = !has;
  $('upload-status').textContent = has
    ? 'Connected ✓ "Send" uploads directly to Claude. Nothing else to do.'
    : 'Not set up yet. Do this once (about 2 minutes), then every "Send" goes straight to Claude.';
}

async function saveToken() {
  const t = $('upload-token').value.trim();
  if (!t) return;
  const btn = $('btn-token-save');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await ghApi('', {}, t);
    if (!res.ok) throw new Error(await ghError(res));
    setToken(t);
    $('upload-token').value = '';
    refreshUploadBox();
  } catch (e) {
    alert('This key does not work: ' + (e.message === 'Failed to fetch' || e.message === 'Load failed' ? 'no internet connection.' : e.message));
  }
  btn.disabled = false;
  btn.textContent = 'Save key';
}

async function openRecordScreen() {
  showScreen('record');
  refreshMicModeBox();
  refreshUploadBox();
  await loadSamples();
  renderRecList();
}

// ---------- Wake lock ----------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { log('Wake lock not available: ' + e.message); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (run || shotTest.active)) requestWakeLock();
});

// ---------- Screens ----------
function showScreen(name) {
  $('screen-menu').hidden = name !== 'menu';
  $('screen-drill').hidden = name !== 'drill';
  $('screen-record').hidden = name !== 'record';
  if (name === 'menu') renderMenu();
  window.scrollTo(0, 0);
}

function renderMenu() {
  const runs = load('vi-runs', []);
  const list = $('drill-list');
  list.innerHTML = '';
  for (const d of DRILLS) {
    const mine = runs.filter((x) => x.drill === d.id);
    const best = mine.length ? Math.min(...mine.map((x) => x.total)) : null;
    const last = mine.length ? mine[mine.length - 1].total : null;
    const btn = document.createElement('button');
    btn.className = 'drill-card';
    btn.innerHTML = `<b></b><span></span>`;
    btn.querySelector('b').textContent = d.name;
    btn.querySelector('span').textContent =
      `${d.shots} shots · ${d.start}` + (best !== null ? ` · best ${fmt(best)} s · last ${fmt(last)} s` : '');
    btn.onclick = () => openDrill(d);
    list.appendChild(btn);
  }
}

function openDrill(d) {
  currentDrill = d;
  $('drill-title').textContent = d.name;
  showScreen('drill');
  showIdle();
}

function showIdle(resetStatus = true) {
  if (resetStatus) setStatus('Press Start');
  $('shot-count').textContent = '';
  $('result').hidden = true;
  $('btn-start').hidden = false;
  $('btn-ready').hidden = true;
  $('btn-again').hidden = true;
  $('btn-menu').hidden = true;
  $('btn-shot-test').disabled = false;
}
function showRunning() {
  $('result').hidden = true;
  $('shot-count').textContent = '';
  $('btn-start').hidden = true;
  $('btn-again').hidden = true;
  $('btn-menu').hidden = true;
  $('btn-shot-test').disabled = true;
}
function showDone() {
  $('result').hidden = false;
  $('btn-again').hidden = false;
  $('btn-menu').hidden = false;
  $('btn-shot-test').disabled = false;
}

// ---------- Settings UI ----------
function bindSettings() {
  const thr = $('thr'), ratio = $('ratio'), lock = $('lock');
  const mode = $('ready-mode'), partial = $('ready-partial'), lat = $('latency');
  thr.value = settings.thrDb; ratio.value = settings.ratio; lock.value = settings.lockMs;
  mode.value = settings.readyMode; partial.checked = settings.readyPartial; lat.value = settings.latencyMs;

  const refresh = () => {
    $('thr-val').textContent = `${settings.thrDb} dB`;
    $('ratio-val').textContent = `×${settings.ratio} (${(20 * Math.log10(settings.ratio)).toFixed(0)} dB)`;
    $('lock-val').textContent = settings.lockMs;
    for (const el of document.querySelectorAll('.meter-thr')) el.style.left = meterPct(settings.thrDb) + '%';
  };
  const changed = () => { save('vi-settings', settings); pushDetectorSettings(); refresh(); };

  thr.oninput = () => { settings.thrDb = +thr.value; changed(); };
  ratio.oninput = () => { settings.ratio = +ratio.value; changed(); };
  lock.oninput = () => { settings.lockMs = +lock.value; changed(); };
  mode.onchange = () => { settings.readyMode = mode.value; changed(); };
  partial.onchange = () => { settings.readyPartial = partial.checked; changed(); };
  lat.onchange = () => { settings.latencyMs = +lat.value || 0; changed(); };
  refresh();
}

// ---------- Wire up ----------
$('btn-start').onclick = () => startRun();
$('btn-ready').onclick = () => { if (run && run.readyDone) run.readyDone('tap'); };
$('btn-again').onclick = () => { abortRun(); showIdle(); };
$('btn-menu').onclick = () => { abortRun(); showScreen('menu'); };
$('btn-reset').onclick = () => { abortRun(); showIdle(); };
$('btn-end').onclick = () => { abortRun(); if (shotTest.active) stopShotTest(); showScreen('menu'); };
$('btn-shot-test').onclick = () => (shotTest.active ? stopShotTest() : startShotTest());
$('btn-clear-log').onclick = () => { logEl.value = ''; };

$('btn-open-record').onclick = () => openRecordScreen();
$('btn-rec-back').onclick = () => {
  if (recording && !confirm('A recording is running. Leave and discard it?')) return;
  abortRecording();
  showScreen('menu');
};
$('btn-rec-share').onclick = () => sendSamples(RECORDINGS.filter((r) => samples[r.id] && !samples[r.id].sentAt));
$('btn-token-save').onclick = () => saveToken();
$('btn-token-remove').onclick = () => {
  if (!confirm('Remove the upload key from this phone? Sending stops working until you set it up again.')) return;
  setToken('');
  refreshUploadBox();
};
$('btn-rec-clear').onclick = async () => {
  if (recording || !confirm('Delete all recordings from this phone?')) return;
  await sampleDb.clear().catch((e) => log('Delete failed: ' + e));
  for (const k of Object.keys(samples)) delete samples[k];
  $('rec-note').value = '';
  renderRecList();
};
$('rec-note').onchange = () => sampleDb.set('note', $('rec-note').value).catch(() => {});
$('btn-mic-on').onclick = async () => {
  try {
    await ensureAudio();
    $('btn-mic-on').textContent = 'Microphone is on ✓';
    refreshMicModeBox();
  } catch (e) { alert('Microphone not available: ' + e); }
};
$('micmode-sel').onchange = () => {
  settings.micMode = $('micmode-sel').value;
  save('vi-settings', settings);
  refreshMicModeBox();
};
$('btn-copy-log').onclick = async () => {
  try { await navigator.clipboard.writeText(logEl.value); log('(log copied)'); }
  catch { logEl.select(); document.execCommand('copy'); }
};

bindSettings();
showScreen('menu');
loadModel();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => log('Service worker failed: ' + e));
}
