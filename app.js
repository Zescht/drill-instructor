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
  else if (m.type === 'audio' && recognizer) recognizer.acceptWaveformFloat(m.data, ctx.sampleRate);
}

function onMeter(m) {
  const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const peakDb = toDb(m.peak);
  const bar = $('meter-bar');
  bar.style.width = pct(peakDb) + '%';
  bar.classList.toggle('hot', peakDb >= settings.thrDb);
  $('meter-floor').style.left = pct(toDb(m.floor)) + '%';
  $('meter-thr').style.left = pct(settings.thrDb) + '%';
  $('meter-val').textContent = `peak ${peakDb.toFixed(0)} dB · bg ${toDb(m.floor).toFixed(0)} dB`;

  // "Any voice" fallback: about 250 ms of sound clearly above the background
  if (run && run.voiceCheck) {
    const active = m.rms >= Math.max(m.floor * 3, fromDb(-45));
    run.voiceMs = Math.max(0, (run.voiceMs || 0) + (active ? 25 : -12));
    if (run.voiceMs >= 250) run.voiceCheck('any voice');
  }
}

function onShot(m) {
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
  setDetector({ forward: true });
}

function stopRecognizer() {
  setDetector({ forward: false });
  if (recognizer) { try { recognizer.remove(); } catch { /* ignore */ } recognizer = null; }
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
  setDetector({ armed: false, forward: false });
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
  if (name === 'menu') renderMenu();
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
    $('meter-thr').style.left = Math.max(0, Math.min(100, ((settings.thrDb + 60) / 60) * 100)) + '%';
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
