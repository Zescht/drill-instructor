// Runs on the audio thread. Detects shots (sharp loud peaks), reports meter levels,
// and forwards raw audio to the main thread while the "ready" recognizer is listening.
// Times are in AudioContext seconds (same clock as ctx.currentTime), so they line up with the beep.

class ShotProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;          // count shots only while armed
    this.threshold = 0.1;        // absolute peak (0..1) a shot must reach
    this.ratio = 4;              // and it must be this many times above the noise floor
    this.lockoutSec = 0.08;      // ignore further peaks for this long after a shot
    this.forward = false;        // forward audio to main thread (for speech recognition)

    this.floor = 0.005;          // slow-moving background level (RMS)
    this.lastShotFrame = -1e12;
    this.meterFrames = 0;
    this.meterPeak = 0;
    this.meterSumSq = 0;
    this.meterCount = 0;
    this.fwd = new Float32Array(4096);
    this.fwdLen = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if ('armed' in m) this.armed = m.armed;
      if ('threshold' in m) this.threshold = m.threshold;
      if ('ratio' in m) this.ratio = m.ratio;
      if ('lockoutSec' in m) this.lockoutSec = m.lockoutSec;
      if ('forward' in m) { this.forward = m.forward; this.fwdLen = 0; }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let peak = 0, peakIdx = 0, sumSq = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      if (a > peak) { peak = a; peakIdx = i; }
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / ch.length);

    // Shot detection
    const frame = currentFrame + peakIdx;
    if (this.armed &&
        peak >= this.threshold &&
        peak >= this.floor * this.ratio &&
        frame - this.lastShotFrame > this.lockoutSec * sampleRate) {
      this.lastShotFrame = frame;
      this.port.postMessage({ type: 'shot', time: frame / sampleRate, peak, floor: this.floor });
    }

    // Noise floor: falls quickly, rises slowly (so a shot barely moves it)
    if (rms < this.floor) this.floor += (rms - this.floor) * 0.05;
    else this.floor += (Math.min(rms, this.floor * 4) - this.floor) * 0.002;
    if (this.floor < 0.0003) this.floor = 0.0003;

    // Meter, about every 25 ms
    this.meterPeak = Math.max(this.meterPeak, peak);
    this.meterSumSq += sumSq;
    this.meterCount += ch.length;
    this.meterFrames += ch.length;
    if (this.meterFrames >= sampleRate * 0.025) {
      this.port.postMessage({
        type: 'meter',
        time: currentFrame / sampleRate,
        peak: this.meterPeak,
        rms: Math.sqrt(this.meterSumSq / this.meterCount),
        floor: this.floor,
      });
      this.meterFrames = 0; this.meterPeak = 0; this.meterSumSq = 0; this.meterCount = 0;
    }

    // Forward audio in chunks of 4096 samples
    if (this.forward) {
      for (let i = 0; i < ch.length; i++) {
        this.fwd[this.fwdLen++] = ch[i];
        if (this.fwdLen === this.fwd.length) {
          this.port.postMessage({ type: 'audio', data: this.fwd }, [this.fwd.buffer]);
          this.fwd = new Float32Array(4096);
          this.fwdLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('shot-processor', ShotProcessor);
