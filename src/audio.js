// Every sound is synthesized live with the Web Audio API — the repo ships no
// audio files. One engine voice, one siren voice, fire-and-forget one-shots.
export class AudioSys {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('oc_mute') === '1';
  }

  init() { // must be called from a user gesture
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(ctx.destination);

    // noise buffer shared by shots/impacts
    const len = ctx.sampleRate * 1;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // --- engine voice ---
    this.engOsc = ctx.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engOsc.frequency.value = 50;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 500;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engOsc.connect(this.engFilter).connect(this.engGain).connect(this.master);
    this.engOsc.start();

    // --- siren voice: two-tone via LFO on frequency ---
    this.sirOsc = ctx.createOscillator();
    this.sirOsc.type = 'square';
    this.sirOsc.frequency.value = 700;
    this.sirLFO = ctx.createOscillator();
    this.sirLFO.type = 'square';
    this.sirLFO.frequency.value = 0.85;
    this.sirLFOGain = ctx.createGain();
    this.sirLFOGain.gain.value = 120;
    this.sirLFO.connect(this.sirLFOGain).connect(this.sirOsc.frequency);
    this.sirGain = ctx.createGain();
    this.sirGain.gain.value = 0;
    const sirFilter = ctx.createBiquadFilter();
    sirFilter.type = 'lowpass'; sirFilter.frequency.value = 1800;
    this.sirOsc.connect(sirFilter).connect(this.sirGain).connect(this.master);
    this.sirOsc.start(); this.sirLFO.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('oc_mute', this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  engine(speedNorm, throttleOn, driving) {
    if (!this.ctx) return;
    const f = 46 + speedNorm * 190 + Math.sin(this.ctx.currentTime * 30) * 2;
    this.engOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
    this.engFilter.frequency.setTargetAtTime(300 + speedNorm * 900, this.ctx.currentTime, 0.1);
    const g = driving ? (throttleOn ? 0.10 : 0.045) : 0;
    this.engGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.08);
  }

  siren(on, vol) {
    if (!this.ctx) return;
    this.sirGain.gain.setTargetAtTime(on ? 0.055 * vol : 0, this.ctx.currentTime, 0.2);
  }

  sirenBlip() { // short whoop when a star is gained
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(500, t);
    o.frequency.exponentialRampToValueAtTime(1100, t + 0.28);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.4);
  }

  _noise(dur, filterFreq, gain, type = 'lowpass') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur);
  }

  shot(kind, vol = 1) {
    if (kind === 'fist') return this._noise(0.09, 300, 0.10 * vol);
    if (kind === 'smg') return this._noise(0.07, 2400, 0.16 * vol, 'bandpass');
    this._noise(0.13, 1600, 0.22 * vol, 'bandpass'); // pistol
  }

  impact(mag) { this._noise(0.18, 260, 0.28 * mag); }

  explosion() {
    this._noise(0.9, 220, 0.5);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.7);
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.85);
  }

  click() { this._noise(0.03, 3000, 0.08, 'highpass'); }

  _notes(seq, type = 'sine', vol = 0.14) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    seq.forEach(([freq, at, dur]) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(vol, t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
      o.connect(g).connect(this.master);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.05);
    });
  }

  ding() { this._notes([[880, 0, 0.3], [1320, 0.09, 0.4]]); }
  cash() { this._notes([[660, 0, 0.15], [880, 0.08, 0.15], [1100, 0.16, 0.3]]); }
  jingle() { this._notes([[523, 0, 0.2], [659, 0.12, 0.2], [784, 0.24, 0.2], [1046, 0.36, 0.5]], 'triangle', 0.16); }
  fail() { this._notes([[440, 0, 0.3], [349, 0.2, 0.3], [262, 0.4, 0.6]], 'triangle', 0.15); }
  death() { this._notes([[196, 0, 0.8], [185, 0.5, 1.2]], 'sawtooth', 0.10); }
}
