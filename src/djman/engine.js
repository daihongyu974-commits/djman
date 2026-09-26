// @ts-nocheck
/*
 * DJMAN engine: audio (Web Audio API), transition scheduling, device panel (SVG),
 * two-lane screen (canvas) and playlist UI. Ported from the single-file demo.
 *
 * initDjman() expects the markup rendered by DjmanApp.tsx to be in the DOM,
 * and returns a cleanup function.
 */
function startDjman() {
'use strict';
let alive = true;
const docListeners = [];
const onDoc = (type, fn, opts) => { document.addEventListener(type, fn, opts); docListeners.push([type, fn]); };
// ================= definitions =================
const BLENDS = { fade:'Fade', bassswap:'Bass Swap', filter:'Filter', cut:'Cut' };
const BUILDS = { none:'None', roll:'Loop Roll', riser:'Riser', swoosh:'Swoosh' };
const EXITS  = { none:'None', echo:'Echo', reverb:'Reverb', downsweep:'Downsweep', vinyl:'Vinyl Break' };
const BUILD_BARS = { none:0, roll:2, riser:4, swoosh:1 };
const FX_ORDER = ['none','echo','reverb','flanger','gater','roll']; // clockwise from top, 60° apart
const FX_NAMES = { none:'None', echo:'Echo', reverb:'Reverb', flanger:'Flanger', gater:'Gater', roll:'Roll' };
const SAMPLES = {
  drum:   ['Clap','Kick','Snare','Hat','Shaker','Rim','Tom','Perc'],
  bass:   ['Horn','Bell','Whistle','Hit','Coin','Camera','Door','Laugh'],
  melody: ['Piano Stab','Synth Stab','Bass Hit','Chord','Riff','Pluck'],
  vocal:  ['Hey','Yeah','Woo','Oh','Come On',"Let's Go",'Crowd Chant']
};
const PADS = [['drum','DRUM'],['bass','BASS'],['melody','MELODY'],['vocal','VOCAL']];
const NSETS = 8;
const LINE = { blend:'#FF5CC8', build:'#C6F432', exit:'#37E0E8' };

let globalSet = { blend:'bassswap', bars:16, build:'none', exit:'none', outEarly:0, inSkip:0 };
const overrides = new Map();
const tracks = [];
let uid = 1;

let ctx = null, M = null, noiseBuf = null, irBuf = null;
let cur = null, committed = null, forced = null, playing = false, ended = false, curSlot = 0;
const bufCache = new Map();
const transients = new Set();
let timers = [];
const fx = { active:null, amt:0.6, vol:0.8, filter:0 };
let sampleSet = 0;
let scr = null;
let toast = null;
let ghost = null;   // finished track still scrolling off the screen

function getCtx(){
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint:'playback' });
  buildMaster();
  return ctx;
}
const G = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
const BQ = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; };

function buildMaster(){
  const sr = ctx.sampleRate;
  noiseBuf = ctx.createBuffer(1, sr * 2, sr);
  const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const len = Math.floor(sr * 3.2); irBuf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++){ const d = irBuf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 3.4); }
  const bus = G(1), gate = G(1), post = G(1), dry = G(1), fOut = G(1);
  bus.connect(gate); gate.connect(post); post.connect(dry); dry.connect(fOut);
  const echoSend = G(0), echo = ctx.createDelay(4), echoFb = G(0.45), echoHp = BQ('highpass', 280);
  post.connect(echoSend); echoSend.connect(echo); echo.connect(echoHp); echoHp.connect(echoFb); echoFb.connect(echo); echoHp.connect(fOut);
  const revSend = G(0), conv = ctx.createConvolver(); conv.buffer = irBuf;
  post.connect(revSend); revSend.connect(conv); conv.connect(fOut);
  const flSend = G(0), fl = ctx.createDelay(0.05), flFb = G(0); fl.delayTime.value = 0.004;
  post.connect(flSend); flSend.connect(fl); fl.connect(flFb); flFb.connect(fl); fl.connect(fOut);
  const flLfo = ctx.createOscillator(); flLfo.frequency.value = 0.25; const flDepth = G(0.0028);
  flLfo.connect(flDepth); flDepth.connect(fl.delayTime); flLfo.start();
  const hp = BQ('highpass', 20, 0.8), lp = BQ('lowpass', 20000, 0.8);
  const vol = G(fx.vol * fx.vol * 1.2);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -4; lim.knee.value = 3; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.15;
  fOut.connect(hp); hp.connect(lp); lp.connect(vol); vol.connect(lim); lim.connect(ctx.destination);
  const sampleBus = G(0.8); sampleBus.connect(bus);
  M = { bus, gate, echoSend, echo, echoFb, revSend, flSend, flFb, flLfo, hp, lp, vol, sampleBus, gateOsc:null, gateOscG:null };
  applyFilter();
}

// ================= deck =================
class Deck {
  constructor(track, buf, gridBpm){
    this.track = track; this.buf = buf; this.src = null; this.rollStart = null;
    this.gridBpm = gridBpm || track.bpm; this.synced = false;
    this.eqL = BQ('lowshelf', 180); this.eqL.gain.value = 0;
    this.eqM = BQ('peaking', 1000, 0.8); this.eqM.gain.value = 0;
    this.eqH = BQ('highshelf', 3500); this.eqH.gain.value = 0;
    this.hp = BQ('highpass', 20, 1); this.lp = BQ('lowpass', 20000, 1);
    this.dry = G(1);
    this.echoSend = G(0); this.echoDelay = ctx.createDelay(4); this.echoFb = G(0.55); this.echoHp = BQ('highpass', 300);
    this.revSend = G(0); this.conv = ctx.createConvolver(); this.conv.buffer = irBuf;
    this.eqL.connect(this.eqM); this.eqM.connect(this.eqH); this.eqH.connect(this.hp); this.hp.connect(this.lp);
    this.lp.connect(this.dry); this.dry.connect(M.bus);
    this.lp.connect(this.echoSend); this.echoSend.connect(this.echoDelay); this.echoDelay.connect(this.echoHp);
    this.echoHp.connect(this.echoFb); this.echoFb.connect(this.echoDelay); this.echoHp.connect(M.bus);
    this.lp.connect(this.revSend); this.revSend.connect(this.conv); this.conv.connect(M.bus);
    this.anchorT = 0; this.anchorPos = 0; this.segs = [{ t0:0, t1:Infinity, r0:1, r1:1 }];
  }
  rateAt(t){
    for (const s of this.segs){
      if (s.t1 === Infinity || t < s.t1){
        if (t <= s.t0 || s.t1 === Infinity) return s.r0;
        return s.r0 + (s.r1 - s.r0) * ((t - s.t0) / (s.t1 - s.t0));
      }
    }
    return 1;
  }
  finalRate(){ return this.segs[this.segs.length - 1].r1; }
  posAt(t){
    if (t < this.anchorT) return this.anchorPos - (this.anchorT - t) * this.segs[0].r0;
    let pos = this.anchorPos;
    for (const s of this.segs){
      if (t <= s.t0) break;
      const te = Math.min(t, s.t1), d = te - s.t0;
      const rEnd = s.t1 === Infinity ? s.r0 : s.r0 + (s.r1 - s.r0) * (d / (s.t1 - s.t0));
      pos += d * (s.r0 + rEnd) / 2;
    }
    return pos;
  }
  timeAtPos(P){
    let lo = this.anchorT, hi = this.anchorT + Math.max(1, P - this.anchorPos) * 2 + 2;
    for (let i = 0; i < 60; i++){ const m = (lo + hi) / 2; if (this.posAt(m) < P) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  _makeSource(when, offset){
    const s = ctx.createBufferSource(); s.buffer = this.buf; s.connect(this.eqL);
    const pr = s.playbackRate;
    pr.setValueAtTime(this.rateAt(when), when);
    for (const g of this.segs){
      if (g.t1 === Infinity || g.t1 <= when || g.r0 === g.r1) continue;
      if (g.t0 > when) pr.setValueAtTime(g.r0, g.t0);
      pr.linearRampToValueAtTime(g.r1, g.t1);
    }
    s.start(when, Math.max(0, Math.min(offset, this.buf.duration - 0.01)));
    if (this.stopT != null && this.stopT > when) s.stop(this.stopT);
    return s;
  }
  startAt(when, pos, rate){
    this.anchorT = when; this.anchorPos = pos;
    this.segs = [{ t0:when, t1:Infinity, r0:rate, r1:rate }];
    this.src = this._makeSource(when, pos);
  }
  setRamp(tA, tB, rT, tR){
    const r0 = this.segs[0].r0;
    this.segs = [{ t0:this.anchorT, t1:tA, r0, r1:r0 }, { t0:tA, t1:tB, r0, r1:rT }, { t0:tB, t1:Infinity, r0:rT, r1:rT }];
    const pr = this.src.playbackRate;
    if (tR != null) hold(pr, tR);
    pr.setValueAtTime(r0, tA); pr.linearRampToValueAtTime(rT, tB);
  }
  reposition(when, pos){
    const segs = [];
    for (const s of this.segs){
      if (s.t1 <= when) continue;
      if (s.t0 < when) segs.push({ t0:when, t1:s.t1, r0:this.rateAt(when), r1: s.t1 === Infinity ? this.rateAt(when) : s.r1 });
      else segs.push(s);
    }
    try { this.src && this.src.stop(when); } catch(e){}
    this.anchorT = when; this.anchorPos = pos; this.segs = segs; this.rollStart = null;
    this.src = this._makeSource(when, pos);
  }
  roll(sizeBeats, tRef){
    if (!this.src) return;
    const beat = 60 / this.track.bpm;
    if (this.rollStart == null){
      const p = this.posAt(tRef) + 0.004;
      const g = ((this.track.downbeat % beat) + beat) % beat;
      this.rollStart = g + Math.floor((p - g) / beat) * beat;
    }
    this.src.loopStart = this.rollStart;
    this.src.loopEnd = this.rollStart + sizeBeats * beat;
    this.src.loop = true;
  }
  unroll(when){
    if (this.rollStart == null || !this.src) return;
    const pos = this.posAt(when), old = this.src;
    try { old.stop(when); } catch(e){}
    this.src = this._makeSource(when, pos);
    this.rollStart = null;
  }
  stopAt(t){ this.stopT = t; try { this.src && this.src.stop(t); } catch(e){} }
  dispose(){
    try { this.src && this.src.stop(); } catch(e){}
    [this.eqL,this.eqM,this.eqH,this.hp,this.lp,this.dry,this.echoSend,this.echoDelay,this.echoHp,this.echoFb,this.revSend,this.conv]
      .forEach(n => { try { n.disconnect(); } catch(e){} });
  }
}

// ================= analysis =================
function analyze(buf){
  const sr = buf.sampleRate, hop = 512, n = Math.floor(buf.length / hop);
  const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const full = new Float32Array(n), low = new Float32Array(n), rms = new Float32Array(n);
  const lo = new Float32Array(n), hi = new Float32Array(n);
  const a = Math.exp(-2 * Math.PI * 160 / sr), a2 = Math.exp(-2 * Math.PI * 2000 / sr);
  let lpv = 0, lp2 = 0;
  for (let i = 0; i < n; i++){
    let sf = 0, sl = 0, sh = 0; const e = (i + 1) * hop;
    for (let j = i * hop; j < e; j++){
      const x = (c0[j] + c1[j]) * 0.5; lpv = a * lpv + (1 - a) * x; lp2 = a2 * lp2 + (1 - a2) * x;
      const h = x - lp2; sf += x * x; sl += lpv * lpv; sh += h * h;
    }
    full[i] = Math.log(1e-8 + sf); low[i] = Math.log(1e-8 + sl);
    rms[i] = Math.sqrt(sf / hop); lo[i] = Math.sqrt(sl / hop); hi[i] = Math.sqrt(sh / hop);
  }
  const on = new Float32Array(n), onL = new Float32Array(n);
  for (let i = 1; i < n; i++){ const dl = Math.max(0, low[i] - low[i-1]); on[i] = Math.max(0, full[i] - full[i-1]) + dl; onL[i] = dl; }
  const fps = sr / hop;
  const W = Math.min(n, Math.floor(fps * 90)), s0 = Math.max(0, Math.floor((n - W) / 2));
  const seg = on.subarray(s0, s0 + W);
  const ip = x => { const i = Math.floor(x), f = x - i; return i + 1 < W ? seg[i] * (1 - f) + seg[i + 1] * f : 0; };
  const score = bpm => {
    const p = fps * 60 / bpm; let bestPh = 0;
    for (let ph = 0; ph < p; ph += 1){ let sum = 0, cnt = 0; for (let x = ph; x < W - 1; x += p){ sum += ip(x); cnt++; } const m = sum / cnt; if (m > bestPh) bestPh = m; }
    return bestPh / (1 + Math.pow((bpm - 120) / 60, 2) * 0.12);
  };
  let best = 120, bs = -1;
  for (let b = 70; b <= 180; b += 0.1){ const s = score(b); if (s > bs){ bs = s; best = b; } }
  for (let b = best - 0.12; b <= best + 0.12; b += 0.02){ const s = score(b); if (s > bs){ bs = s; best = b; } }
  if (Math.abs(best - Math.round(best)) < 0.09) best = Math.round(best);
  best = Math.round(best * 100) / 100;
  const p = fps * 60 / best;
  let bPh = 0, bPs = -1;
  for (let ph = 0; ph < p; ph += 0.25){ let s = 0; for (let x = ph; x < n; x += p) s += on[Math.round(x)] || 0; if (s > bPs){ bPs = s; bPh = ph; } }
  let bM = 0, bMs = -1;
  for (let m = 0; m < 4; m++){ let s = 0; for (let x = bPh + m * p; x < n; x += 4 * p) s += onL[Math.round(x)] || 0; if (s > bMs){ bMs = s; bM = m; } }
  const beat = 60 / best, bar = 4 * beat;
  let downbeat = (bPh * hop) / sr + bM * beat; downbeat = ((downbeat % bar) + bar) % bar;
  let peak = 0; for (let i = 0; i < n; i++) if (rms[i] > peak) peak = rms[i];
  const thr = peak * 0.04;
  let first = 0; while (first < n && rms[first] < thr) first++;
  let last = n - 1; while (last > 0 && rms[last] < thr) last--;
  const firstSound = first * hop / sr, lastSound = Math.min(buf.duration, (last + 1) * hop / sr);
  let inPoint = downbeat + Math.ceil((firstSound - 0.05 - downbeat) / bar) * bar;
  if (inPoint < 0) inPoint += bar;
  if (firstSound < 0.3) inPoint = 0;
  // band data for the screen, normalised
  const amp = new Uint8Array(n), shL = new Uint8Array(n), shH = new Uint8Array(n);
  for (let i = 0; i < n; i++){
    amp[i] = Math.min(255, Math.round(Math.pow(rms[i] / (peak || 1), 0.8) * 255));
    const tot = rms[i] * rms[i] + 1e-12;
    shL[i] = Math.min(255, Math.round(Math.min(1, lo[i] * lo[i] / tot) * 255));
    shH[i] = Math.min(255, Math.round(Math.min(1, hi[i] * hi[i] / tot * 3) * 255));
  }
  return { bpm:best, downbeat, firstSound, lastSound, inPoint, duration:buf.duration, fps, amp, shL, shH, key: detectKey(buf) };
}
function decodeBytes(ab){
  return new Promise((res, rej) => { const pr = getCtx().decodeAudioData(ab, res, rej); if (pr && pr.then) pr.then(res, rej); });
}
// local files are re-read from disk; Audius tracks are downloaded once and kept compressed in memory
async function decodeTrack(t){
  if (t.src && t.src.type === 'audius'){
    if (!t.bytes) t.bytes = await fetchAudiusBytes(t.src.id);
    return await decodeBytes(t.bytes.slice(0));   // decodeAudioData detaches its input, so decode a copy
  }
  return await decodeBytes(await t.file.arrayBuffer());
}
let analyzing = Promise.resolve();
function queueAnalysis(t){
  analyzing = analyzing.then(async () => {
    try {
      const buf = await decodeTrack(t);
      await new Promise(r => setTimeout(r, 0));
      Object.assign(t, analyze(buf), { status:'ready' });
      const i = tracks.indexOf(t), ci = curIndex();
      if (i >= 0 && (i === ci + 1 || (ci < 0 && i === 0))) bufCache.set(t.id, { promise:Promise.resolve(buf), buffer:buf });
    } catch(e){ t.status = 'error'; t.errMsg = t.src && t.src.type === 'audius' ? (e && e.message && !/decode/i.test(e.message) ? e.message : "Couldn't load this Audius track") : null; }
    renderList(); renderAudius();
  });
}
function ensureBuffer(t){
  if (!t || t.status !== 'ready') return null;
  let e = bufCache.get(t.id);
  if (!e){
    e = { promise:null, buffer:null };
    e.promise = decodeTrack(t).then(b => { e.buffer = b; return b; }).catch(() => { bufCache.delete(t.id); return null; });
    bufCache.set(t.id, e);
  }
  return e;
}
function pruneCache(){
  const keep = new Set();
  if (cur) keep.add(cur.track.id);
  if (committed) keep.add(committed.inc.track.id);
  const n = tracks[curIndex() + 1]; if (n) keep.add(n.id);
  for (const id of [...bufCache.keys()]) if (!keep.has(id)) bufCache.delete(id);
}

// ---------- musical key (chroma + Krumhansl profiles) ----------
const KEY_NAMES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const PROF_MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const PROF_MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
function fftInPlace(re, im){
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++){
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j){ let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1){
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len){
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++){
        const a = i + k, b = a + h;
        const br = re[b] * cr - im[b] * ci, bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br; im[b] = im[a] - bi; re[a] += br; im[a] += bi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
function keyCorr(ch, prof, tonic){
  let mx = 0, my = 0; for (let p = 0; p < 12; p++){ mx += ch[p]; my += prof[(p - tonic + 12) % 12]; } mx /= 12; my /= 12;
  let sxy = 0, sxx = 0, syy = 0;
  for (let p = 0; p < 12; p++){ const dx = ch[p] - mx, dy = prof[(p - tonic + 12) % 12] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy || 1);
}
function detectKey(buf){
  const sr = buf.sampleRate, c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const D = 4, fs = sr / D, N = 4096, n = Math.floor(buf.length / D);
  if (n < N * 3) return null;
  const a = Math.exp(-2 * Math.PI * 2000 / sr); let y1 = 0, y2 = 0;
  const x = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i++){ const v = (c0[i] + c1[i]) * 0.5; y1 = a * y1 + (1 - a) * v; y2 = a * y2 + (1 - a) * y1; if (i % D === D - 1) x[j++] = y2; }
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const pcOf = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++){ const f = k * fs / N; if (f < 60 || f > 2000) continue; pcOf[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12; }
  const chroma = new Float64Array(12), re = new Float64Array(N), im = new Float64Array(N), cf = new Float64Array(12);
  const frames = Math.min(300, Math.floor((n - N) / N)), step = Math.floor((n - N) / frames);
  for (let fi = 0; fi < frames; fi++){
    const off = fi * step;
    for (let i = 0; i < N; i++){ re[i] = x[off + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im); cf.fill(0); let tot = 0;
    for (let k = 1; k < N / 2; k++){ const pc = pcOf[k]; if (pc < 0) continue; const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]); cf[pc] += m; tot += m; }
    if (tot < 1e-4) continue;
    for (let p = 0; p < 12; p++) chroma[p] += cf[p] / tot;
  }
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) for (const [prof, minor] of [[PROF_MAJ, false], [PROF_MIN, true]]){
    const r = keyCorr(chroma, prof, tonic); if (!best || r > best.r) best = { r, tonic, minor };
  }
  const majPc = best.minor ? (best.tonic + 3) % 12 : best.tonic, num = ((7 * majPc) % 12 + 7) % 12 + 1, letter = best.minor ? 'A' : 'B';
  return { name: KEY_NAMES[best.tonic] + (best.minor ? 'm' : ''), camelot: num + letter, num, letter };
}
function keyDist(a, b){
  if (!a || !b) return 3;
  let d = Math.abs(a.num - b.num); d = Math.min(d, 12 - d);
  return d + (a.letter === b.letter ? 0 : 1);
}
// ---------- harmonic ordering (Camelot distance + tempo, favouring rising BPM) ----------
function transCost(a, b){
  const m = tempoMatch(a.bpm, b.bpm), pct = (1 / m.ratio - 1) * 100;   // + = next song faster
  return keyDist(a.key, b.key) + Math.abs(pct) / 2.5 + (pct < 0 ? -pct / 2.5 : 0) + (m.ok ? 0 : 4);
}
function harmonicOrder(list, start){
  const rest = [...list], out = [];
  let prev = start;
  if (!prev){ rest.sort((x, y) => x.bpm - y.bpm); prev = rest.shift(); out.push(prev); }
  while (rest.length){
    let best = rest[0], bc = Infinity;
    for (const t of rest){ const c = transCost(prev, t); if (c < bc){ bc = c; best = t; } }
    out.push(best); rest.splice(rest.indexOf(best), 1); prev = best;
  }
  return out;
}
let manualOrder = false;
function autoSort(batch){
  let fixed = 0;
  if (cur){ fixed = curIndex() + 1; if (committed) fixed = Math.max(fixed, tracks.indexOf(committed.inc.track) + 1); }
  let head, pool;
  if (batch && manualOrder){
    // the user arranged the list by hand: keep it, only sort the new songs and add them at the end
    const nb = new Set(batch);
    head = tracks.filter((t, i) => !nb.has(t) || i < fixed);
    pool = tracks.filter((t, i) => nb.has(t) && i >= fixed);
  } else {
    head = tracks.slice(0, fixed); pool = tracks.slice(fixed);
  }
  const sortable = pool.filter(t => t.status === 'ready'), others = pool.filter(t => t.status !== 'ready');
  const start = [...head].reverse().find(t => t.status === 'ready') || null;
  if (!sortable.length || (!start && sortable.length < 2)){ if (!batch) showToast('Needs at least two analyzed songs'); return; }
  const ordered = harmonicOrder(sortable, start);
  tracks.splice(0, tracks.length, ...head, ...ordered, ...others);
  if (!batch) manualOrder = false;
  forced = null;
  if (ctx){ pruneCache(); const nx = tracks[curIndex() + 1]; if (nx && cur) ensureBuffer(nx); }
  renderList();
  showToast(cur ? 'Upcoming songs sorted by KEY / BPM' : 'Sorted by KEY / BPM');
}

// ================= settings =================
const keyOf = i => (tracks[i] && tracks[i + 1]) ? tracks[i].id + '>' + tracks[i + 1].id : null;
const getSet = () => globalSet;
function tempoMatch(outBpm, inBpm){
  let bc = inBpm, br = outBpm / inBpm;
  for (const c of [inBpm, inBpm * 2, inBpm / 2]){ const r = outBpm / c; if (Math.abs(Math.log(r)) < Math.abs(Math.log(br))){ br = r; bc = c; } }
  return { ok: Math.abs(br - 1) <= 0.08, cand: bc, ratio: br };
}
function resolveSet(s){ const r = { ...s }; if (r.exit === 'vinyl') r.blend = 'cut'; return r; }
const resolve = i => resolveSet(getSet(i));
function applyEdit(s, k, v){ const n = { ...s }; n[k] = (k === 'bars' || k === 'outEarly' || k === 'inSkip') ? +v : v; return n; }
// the transition the hardware faders point at
function sliderTarget(){ return { live: !!committed, s: resolveSet(globalSet), raw: globalSet }; }
function setFromSlider(k, v){
  const t = sliderTarget();
  if (k === 'bars' && t.s.blend === 'cut'){ showToast('Cut has no length'); return; }
  if (k === 'blend' && t.s.exit === 'vinyl' && v !== 'cut'){ showToast('Vinyl Break forces Cut'); renderDevice(); return; }
  const names = { blend:'BLEND ' + BLENDS[v], build:'BUILD ' + BUILDS[v], exit:'EXIT ' + EXITS[v], bars:'BLEND ' + v + ' bars' };
  globalSet = applyEdit(globalSet, k, v);
  if (t.live){ const msg = liveEdit(globalSet); showToast(msg || names[k]); renderList(); return; }
  showToast(names[k]);
  renderList();
}

// ================= scheduling =================
function curIndex(){ return cur ? tracks.indexOf(cur.track) : -1; }
function later(t, fn, tag){ timers.push({ t, fn, tag }); }
function nextBarAfter(t, pos){ const bar = 4 * 60 / t.bpm; return t.downbeat + Math.ceil((pos - t.downbeat) / bar) * bar; }
function planNext(){
  if (!cur) return null;
  const ci = curIndex(); const nt = tracks[ci + 1];
  if (!nt || nt.status !== 'ready') return null;
  const t = cur.track, s = resolve(ci), now = ctx.currentTime;
  const rF = cur.finalRate(), bpmEff = t.bpm * rF;
  const beatWall = 60 / bpmEff, barWall = 4 * beatWall, barBuf = 4 * 60 / t.bpm;
  const buildBars = BUILD_BARS[s.build];
  let blendBars = s.blend === 'cut' ? 0 : s.bars;
  let P0;
  if (forced) P0 = forced.P0;
  else {
    const Pmax = t.lastSound - blendBars * barBuf - (s.blend === 'cut' ? barBuf * 0.25 : 0) - s.outEarly * barBuf;
    P0 = t.downbeat + Math.floor((Pmax - t.downbeat) / barBuf) * barBuf;
  }
  const minP = nextBarAfter(t, cur.posAt(now) + buildBars * barBuf + 0.25 * rF);
  if (P0 < minP) P0 = minP;
  while (blendBars > 0 && P0 + blendBars * barBuf > t.duration + 0.01) blendBars = blendBars >= 2 ? blendBars / 2 : 0;
  const s2 = { ...s }; if (blendBars === 0) s2.blend = 'cut';
  const T0 = cur.timeAtPos(P0), Tb = T0 - buildBars * barWall, T1 = T0 + blendBars * barWall;
  const sync = tempoMatch(bpmEff, nt.bpm);
  let inPos = (nt.inPoint || 0) + s.inSkip * (4 * 60 / nt.bpm);
  if (inPos > nt.duration - 20) inPos = nt.inPoint || 0;
  return { s:s2, nt, P0, T0, Tb, T1, beatWall, barWall, barBuf, buildBars, blendBars, sync, bpmEff, inPos };
}
function tick(){
  if (!ctx) return;
  const now = ctx.currentTime;
  if (timers.length){
    const due = timers.filter(x => x.t <= now); timers = timers.filter(x => x.t > now);
    due.forEach(x => { try { x.fn(); } catch(e){ console.warn(e); } });
  }
  if (ctx.state === 'running') scheduleLoops(now);
  if (!playing || scr) return;
  if (cur && !committed){
    const plan = planNext();
    if (plan){
      const e = ensureBuffer(plan.nt);
      if (now >= plan.Tb - 0.6 && e && e.buffer) commit(plan, e.buffer);
    } else if (!tracks[curIndex() + 1] && cur.posAt(now) >= cur.track.duration){
      endPlayback();
    }
  }
  if (committed && now >= committed.handover) finalize();
}
const tickId = setInterval(tick, 25);

// ---------- automation helpers ----------
function hold(param, t){
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { const v = param.value; param.cancelScheduledValues(t); param.setValueAtTime(v, t); }
}
function valueAt(pts, rest, t){
  if (!pts || !pts.length) return rest;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++){
    const [ta, va] = pts[i], [tb, vb, k] = pts[i + 1];
    if (t >= ta && t < tb){
      if (k === 'set') return va;
      const u = (t - ta) / (tb - ta);
      if (k === 'exp' && va > 0 && vb > 0) return va * Math.pow(vb / va, u);
      return va + (vb - va) * u;
    }
  }
  return pts[pts.length - 1][1];
}
// hold the param at tR, glide to the new curve, then follow it
function schedule(param, pts, rest, tR, glide, exp){
  hold(param, tR);
  const tG = tR + glide, vG = valueAt(pts, rest, tG);
  if (exp) param.exponentialRampToValueAtTime(Math.max(1e-3, vG), tG); else param.linearRampToValueAtTime(vG, tG);
  for (const [t, v, k] of (pts || [])){
    if (t <= tG) continue;
    if (k === 'set') param.setValueAtTime(v, t);
    else if (k === 'exp') param.exponentialRampToValueAtTime(Math.max(1e-3, v), t);
    else param.linearRampToValueAtTime(v, t);
  }
}
const REST = { outDry:1, inDry:0, outEqL:0, outEqH:0, inEqL:0, outHp:20, inLp:20000, outEcho:0, outRev:0 };
// every automation curve of a transition, from its plan
function curvesFor(p){
  const { s, T0, T1, Tb } = p, Tc = p.Tc != null ? p.Tc : T0, bw = p.beatWall, D = T1 - T0, Mid = T0 + D / 2, h = p.hold;
  const C = {};
  if (s.blend === 'fade'){
    C.outDry = []; C.inDry = [];
    for (let i = 0; i <= 16; i++){ const u = i / 16; C.outDry.push([T0 + u * D, Math.cos(u * Math.PI / 2)]); C.inDry.push([T0 + u * D, Math.sin(u * Math.PI / 2)]); }
  } else if (s.blend === 'bassswap'){
    C.inEqL = [[Mid - 0.015, -40, 'set'], [Mid + 0.015, 0]];
    C.inDry = [[T0, 0, 'set'], [Mid, 1]];
    C.outEqL = [[Mid - 0.015, 0, 'set'], [Mid + 0.015, -40]];
    C.outEqH = [[Mid, 0, 'set'], [T1, -15]];
    C.outDry = [[Mid, 1, 'set'], [T1, 0]];
  } else if (s.blend === 'filter'){
    C.outHpB = [[T0, 20, 'set'], [T1, 1800, 'exp']];
    C.outDry = [[T0 + 0.6 * D, 1, 'set'], [T1, 0]];
    C.inLp = [[T0, 300, 'set'], [T1, 20000, 'exp']];
    C.inDry = [[T0, 0, 'set'], [T0 + 0.35 * D, 1]];
  } else {
    const vin = s.exit === 'vinyl', pre = vin ? 0.3 * bw : 0.006;
    const H = h || { outDry:1, inDry:0, inEqL:0, outEqL:0, outEqH:0, outHp:20, inLp:20000 };
    C.outDry = [[Tc - pre, H.outDry, 'set'], [Tc + (vin ? 0 : 0.004), 0]];
    C.inDry = [[Tc - 0.004, H.inDry, 'set'], [Tc, 1]];
    if (h){
      C.inEqL = [[Tc - 0.004, H.inEqL, 'set'], [Tc, 0]];
      C.outEqL = [[Tc, H.outEqL, 'set']]; C.outEqH = [[Tc, H.outEqH, 'set']];
      C.outHpB = [[Tc, H.outHp, 'set']];
      C.inLp = [[Tc - 0.004, H.inLp, 'set'], [Tc, 20000, 'set']];
    }
  }
  const bh = s.build === 'roll' ? 420 : s.build === 'riser' ? 260 : 0;
  C.outHp = bh ? [[Tb, 20, 'set'], [T0 - 0.01, bh, 'exp'], [T0, 20, 'set']] : [];
  if (C.outHpB) C.outHp = C.outHp.filter(q => q[0] < T0).concat(C.outHpB);
  const Te = s.blend === 'cut' ? Tc : T1;
  if (s.exit === 'echo') C.outEcho = [[Te - bw, 0, 'set'], [Te, 1], [Te + 0.005, 0, 'set']];
  if (s.exit === 'reverb') C.outRev = [[Te - 2 * bw, 0, 'set'], [Te, 0.9], [Te + 0.005, 0, 'set']];
  return C;
}
function applyCurves(p, out, inc, tR, glide){
  const C = curvesFor(p);
  schedule(out.dry.gain, C.outDry, REST.outDry, tR, glide);
  schedule(inc.dry.gain, C.inDry, REST.inDry, tR, glide);
  schedule(out.eqL.gain, C.outEqL, REST.outEqL, tR, glide);
  schedule(out.eqH.gain, C.outEqH, REST.outEqH, tR, glide);
  schedule(inc.eqL.gain, C.inEqL, REST.inEqL, tR, glide);
  schedule(out.hp.frequency, C.outHp, REST.outHp, tR, glide, true);
  schedule(inc.lp.frequency, C.inLp, REST.inLp, tR, glide, true);
  schedule(out.echoSend.gain, C.outEcho, REST.outEcho, tR, 0.005);
  schedule(out.revSend.gain, C.outRev, REST.outRev, tR, 0.005);
}
function stopNodes(list, tR){
  (list || []).forEach(n => {
    n.gains.forEach(g => { hold(g.gain, tR); g.gain.setTargetAtTime(0, tR, 0.012); });
    n.srcs.forEach(s => { try { s.stop(tR + 0.08); } catch(e){} });
  });
}
function clearTimers(tag){ timers = timers.filter(x => x.tag !== tag); }
function startBuild(p, out, tR){
  const { s, T0, Tb } = p, bw = p.beatWall, Bw = p.barWall, nodes = [];
  if (tR >= T0) return nodes;
  if (s.build === 'roll'){
    let curSz = null;
    [[Tb,1],[Tb + Bw,0.5],[T0 - 2 * bw,0.25],[T0 - bw,0.125]].forEach(([t, sz]) => { if (t <= tR) curSz = sz; else later(t - 0.05, () => out.roll(sz, t), 'build'); });
    if (curSz) out.roll(curSz, tR);
    later(T0 - 0.2, () => { if (committed && committed.out === out && committed.plan.s.blend !== 'cut') out.unroll(T0); }, 'build');
  } else if (s.build === 'riser'){
    const tS = Math.max(Tb, tR), n = noiseSrc(tS, T0 + 0.05), f = BQ('bandpass', 400, 1.3), g = G(0);
    schedule(f.frequency, [[Tb, 400], [T0, 9000, 'exp']], 400, tS, 0.005, true);
    schedule(g.gain, [[Tb, 0], [T0 - 0.02, 0.2], [T0 + 0.03, 0]], 0, tS, 0.005);
    n.connect(f); f.connect(g); g.connect(M.bus);
    const o = ctx.createOscillator(), og = G(0), ol = BQ('lowpass', 2400);
    o.type = 'sawtooth';
    schedule(o.frequency, [[Tb, 110], [T0, 880, 'exp']], 110, tS, 0.005, true);
    schedule(og.gain, [[Tb, 0], [T0 - 0.02, 0.03], [T0 + 0.03, 0]], 0, tS, 0.005);
    o.connect(ol); ol.connect(og); og.connect(M.bus); o.start(tS); o.stop(T0 + 0.05);
    transients.add(o); o.onended = () => transients.delete(o);
    nodes.push({ gains:[g, og], srcs:[n, o] });
  } else if (s.build === 'swoosh'){
    const t0 = T0 - Bw, t1 = T0 + 1.5 * bw, tS = Math.max(t0, tR);
    const n = noiseSrc(tS, t1), f = BQ('bandpass', 300, 3), g = G(0);
    schedule(f.frequency, [[t0, 300], [T0, 7000, 'exp'], [t1, 1500, 'exp']], 300, tS, 0.005, true);
    schedule(g.gain, [[t0, 0], [T0, 0.3], [t1, 0]], 0, tS, 0.005);
    n.connect(f); f.connect(g);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan){ schedule(pan.pan, [[t0, -0.8], [t1, 0.8]], -0.8, tS, 0.005); g.connect(pan); pan.connect(M.bus); } else g.connect(M.bus);
    nodes.push({ gains:[g], srcs:[n] });
  }
  return nodes;
}
function startExit(p, out, tR, prevVinyl){
  const { s } = p, bw = p.beatWall, Bw = p.barWall, Tc = p.Tc != null ? p.Tc : p.T0, Te = s.blend === 'cut' ? Tc : p.T1, nodes = [];
  const pr = out.src && out.src.playbackRate;
  if (s.exit === 'vinyl' && pr){
    const tb = Tc - 2 * bw; hold(pr, tR);
    if (tb > tR) pr.setValueAtTime(out.rateAt(tb), tb);
    pr.exponentialRampToValueAtTime(0.03, Tc);
  } else if (prevVinyl && pr){ hold(pr, tR); pr.linearRampToValueAtTime(out.rateAt(tR), tR + 0.12); }
  if (s.exit === 'echo'){ out.echoDelay.delayTime.value = Math.min(3.9, 0.75 * bw); out.echoFb.gain.value = 0.55; }
  if (s.exit === 'downsweep'){
    const t0 = Te - bw, t1 = Te + 2 * Bw;
    if (tR < t1){
      const tS = Math.max(t0, tR), n = noiseSrc(tS, t1), f = BQ('bandpass', 9000, 2.5), g = G(0);
      schedule(f.frequency, [[t0, 9000], [t1, 120, 'exp']], 9000, tS, 0.005, true);
      schedule(g.gain, [[t0, 0], [Te, 0.26], [t1, 0]], 0, tS, 0.005);
      n.connect(f); f.connect(g); g.connect(M.bus);
      nodes.push({ gains:[g], srcs:[n] });
    }
  }
  return nodes;
}
function retimeTempo(c, tR){
  if (Math.abs(c.ratio - 1) <= 0.0005) return;
  const tA = c.Te + 0.01;
  if ((c.rampA != null && c.rampA <= tR) || tA <= tR) return;
  c.rampA = tA;
  c.inc.setRamp(tA, tA + Math.max(8 * c.plan.barWall, 6), 1, tR);
}
function commit(plan, buf){
  const { nt, T0, sync, inPos } = plan;
  if (fx.active === 'roll'){ fxOff('roll'); fx.active = null; }
  plan.Tc = T0;
  const ratio = sync.ok ? sync.ratio : 1;
  const out = cur, inc = new Deck(nt, buf, sync.ok ? sync.cand : nt.bpm);
  inc.synced = sync.ok;
  inc.dry.gain.value = 0;
  inc.startAt(T0, inPos, ratio);
  const Te = plan.s.blend === 'cut' ? plan.Tc : plan.T1, tR = ctx.currentTime + 0.005;
  committed = { plan, out, inc, ratio, key: out.track.id + '>' + nt.id, Te, handover: Te + 0.06, slot: 1 - curSlot, buildNodes:[], exitNodes:[] };
  applyCurves(plan, out, inc, tR, 0.005);
  committed.buildNodes = startBuild(plan, out, tR);
  committed.exitNodes = startExit(plan, out, tR, false);
  retimeTempo(committed, tR);
  out.stopAt(Te + 0.04);
  renderList();
}
// change BLEND / BUILD / EXIT while the transition is running
function reschedule(want){
  const c = committed, p = c.plan, old = p.s, now = ctx.currentTime, tR = now + 0.03, bw = p.beatWall, Bw = p.barWall;
  if (now >= c.Te - 0.02) return { s: old, msg: 'Transition ending, applies next time' };
  const s = { ...old, ...want }; let msg = '';
  const blendDone = old.blend === 'cut' ? now >= p.Tc - 0.02 : now >= p.T1 - 0.02;
  if (s.build !== old.build && now >= p.T0 - 0.05){ s.build = old.build; msg = 'BUILD is over, applies next time'; }
  if ((s.blend !== old.blend || (s.bars !== old.bars && s.blend !== 'cut')) && blendDone){ s.blend = old.blend; s.bars = old.bars; msg = 'BLEND is over, applies next time'; }
  if (s.exit === 'vinyl' && s.blend !== 'cut'){ s.exit = old.exit; msg = msg || "Can't switch to Vinyl Break now"; }
  const np = { ...p, s, hold:null };
  np.buildBars = BUILD_BARS[s.build]; np.Tb = p.T0 - np.buildBars * Bw;
  if (s.blend === 'cut'){
    np.blendBars = 0; np.T1 = p.T0;
    const pre = s.exit === 'vinyl' ? 2 * bw : 0.1;
    np.Tc = (tR + pre <= p.T0) ? p.T0 : p.T0 + Math.ceil((tR + pre - p.T0) / bw) * bw;
    if (np.Tc > p.T0 + 1e-3){
      const oc = curvesFor(p);
      np.hold = { outDry: valueAt(oc.outDry, 1, tR), inDry: valueAt(oc.inDry, 0, tR), inEqL: valueAt(oc.inEqL, 0, tR), outEqL: valueAt(oc.outEqL, 0, tR),
        outEqH: valueAt(oc.outEqH, 0, tR), outHp: valueAt(oc.outHp, 20, tR), inLp: valueAt(oc.inLp, 20000, tR) };
    }
  } else {
    np.Tc = p.T0;
    let T1 = p.T0 + s.bars * Bw;
    if (T1 < tR + 0.5 * Bw) T1 = p.T0 + Math.ceil((tR + 0.5 * Bw - p.T0) / Bw) * Bw;
    np.T1 = T1; np.blendBars = Math.round((T1 - p.T0) / Bw);
  }
  const Te = s.blend === 'cut' ? np.Tc : np.T1;
  applyCurves(np, c.out, c.inc, tR, 0.06);
  if (s.build !== old.build){
    stopNodes(c.buildNodes, tR); clearTimers('build');
    if (c.out.rollStart != null) c.out.unroll(tR);
    c.buildNodes = startBuild(np, c.out, tR);
  }
  if (s.exit !== old.exit || Math.abs(Te - c.Te) > 1e-3){
    stopNodes(c.exitNodes, tR);
    c.exitNodes = startExit(np, c.out, tR, old.exit === 'vinyl');
  }
  c.out.stopAt(Te + 0.04); c.handover = Te + 0.06; c.Te = Te; c.plan = np;
  retimeTempo(c, tR);
  return { s, msg };
}
function liveEdit(raw){
  const res = reschedule(resolveSet(raw));
  return res.msg || '';
}
function finalize(){
  const { out, inc, slot } = committed;
  ghost = { deck: out, slot: curSlot, endPos: out.posAt(committed.Te), lines: autoLines(committed.plan).out, bw: committed.plan.beatWall };
  cur = inc; curSlot = slot; committed = null; forced = null; clearTimers('build');
  setTimeout(() => out.dispose(), 9000);
  pruneCache();
  const n = tracks[curIndex() + 1]; if (n) ensureBuffer(n);
  if (fx.active) fxOn(fx.active, true);
  renderList(); renderDevice();
}
function endPlayback(){
  playing = false; ended = true;
  if (cur){ const d = cur; setTimeout(() => d.dispose(), 6000); ghost = { deck: d, slot: curSlot, endPos: d.track.duration, lines: [], bw: 60 / d.track.bpm }; }
  if (fx.active){ fxOff(fx.active); fx.active = null; }
  cur = null; renderList(); renderDevice();
}
function noiseSrc(t0, t1){
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.start(t0); n.stop(t1);
  transients.add(n); n.onended = () => transients.delete(n); return n;
}

// ================= transport =================
function hardStop(){
  if (scr){ if (scr.sp) try { scr.sp.disconnect(); } catch(e){} scr = null; }
  [cur, committed && committed.out, committed && committed.inc].forEach(d => d && d.dispose());
  transients.forEach(n => { try { n.stop(); } catch(e){} }); transients.clear();
  timers = []; committed = null; cur = null; forced = null; ghost = null;
  if (fx.active === 'roll') fx.active = null;
}
async function startFrom(i){
  const t = tracks[i]; if (!t || t.status !== 'ready') return;
  getCtx(); hardStop(); ended = false;
  const e = ensureBuffer(t); const buf = await e.promise; if (!buf) return;
  await ctx.resume();
  cur = new Deck(t, buf); cur.startAt(ctx.currentTime + 0.08, 0, 1); curSlot = 0;
  playing = true; pruneCache(); const n = tracks[i + 1]; if (n) ensureBuffer(n);
  if (fx.active) fxOn(fx.active, true);
  renderList();
}
async function togglePlay(){
  if (!cur){ const i = tracks.findIndex(t => t.status === 'ready'); if (i >= 0) await startFrom(i); else showToast('Add local music first'); return; }
  if (scr) return;
  if (ctx.state === 'running'){ await ctx.suspend(); playing = false; }
  else { await ctx.resume(); playing = true; }
  renderDevice();
}
function seekTo(pos){
  if (!cur || committed) return;
  cur.reposition(ctx.currentTime + 0.03, Math.max(0, Math.min(pos, cur.track.duration - 0.5)));
  forced = null;
}
function mixNow(){
  if (!cur || committed || !playing){ showToast(committed ? 'Transition in progress' : 'Start playback first'); return; }
  const ci = curIndex(); if (!tracks[ci + 1]){ showToast('This is the last song'); return; }
  const s = resolve(ci), t = cur.track, barBuf = 4 * 60 / t.bpm;
  forced = { P0: nextBarAfter(t, cur.posAt(ctx.currentTime) + BUILD_BARS[s.build] * barBuf + 0.7) };
  showToast('Mixing at the next bar');
}
function jumpToTransition(){
  if (!cur || committed) return;
  const p = planNext(); if (!p) return;
  seekTo(p.P0 - p.buildBars * p.barBuf - 10);
}

// ================= jog: move forward / back =================
const SCRATCH_SEC_PER_REV = 1.8;                          // like a 33⅓ rpm record
const coarseSecPerRev = t => 32 * 4 * 60 / t.bpm;         // Shift + jog: ~32 bars per turn
function startNav(){
  if (!cur || !ctx || committed || scr) return false;
  if (fx.active === 'roll'){ fxOff('roll'); fx.active = null; renderDevice(); }
  const now = ctx.currentTime, d = cur, live = playing && ctx.state === 'running';
  const st = { deck:d, pos: d.posAt(now), vel: live ? d.rateAt(now) : 0, rate: d.rateAt(now), live, sp:null,
    coarse:false, usedCoarse:false, release:false, handT:null, started:false, lastEnd: now, lastEndPos: 0, lpL:0, lpR:0 };
  st.target = st.pos;
  scr = st;
  if (live){
    // The platter position follows the hand; the audio position chases it with a short
    // spring, so the pitch/speed changes smoothly and backspins sound natural.
    const buf = d.buf, sp = ctx.createScriptProcessor(512, 1, 2);
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const sr = buf.sampleRate, osr = ctx.sampleRate, dur = buf.duration;
    const aVel = 1 - Math.exp(-1 / (0.006 * osr)), aRel = 1 - Math.exp(-1 / (0.035 * osr));
    sp.onaudioprocess = e => {
      const oL = e.outputBuffer.getChannelData(0), oR = e.outputBuffer.getChannelData(1), n = oL.length;
      const T0 = e.playbackTime || ctx.currentTime;
      if (!st.started){
        // seamless touch: take over exactly where the deck is when this block plays
        st.started = true;
        const p0 = d.posAt(T0), shift = p0 - st.pos; st.pos += shift; st.target += shift;
        try { d.src.stop(T0); } catch(err){}
      }
      for (let i = 0; i < n; i++){
        const t = T0 + i / osr;
        if (st.handT != null && t >= st.handT + 0.006){ oL[i] = oR[i] = 0; continue; }
        if (st.coarse){ st.pos = st.target; st.vel = 0; oL[i] = oR[i] = 0; continue; }
        if (st.release) st.vel += (st.rate - st.vel) * aRel;
        else {
          let vd = (st.target - st.pos) / 0.02;
          if (vd > 14) vd = 14; else if (vd < -14) vd = -14;
          st.vel += (vd - st.vel) * aVel;
        }
        st.pos += st.vel / osr;
        if (st.pos < 0){ st.pos = 0; st.vel = 0; } else if (st.pos > dur - 0.01){ st.pos = dur - 0.01; st.vel = 0; }
        const x = st.pos * sr, j = Math.floor(x), f = x - j;
        const l = L[j] * (1 - f) + L[j + 1] * f, r = R[j] * (1 - f) + R[j + 1] * f;
        const spd = Math.abs(st.vel), a = Math.exp(-2 * Math.PI * (spd > 1 ? 16000 / spd : 16000) / osr);
        st.lpL = a * st.lpL + (1 - a) * l; st.lpR = a * st.lpR + (1 - a) * r;
        const g = st.handT != null && t > st.handT ? Math.max(0, 1 - (t - st.handT) / 0.006) : 1;
        oL[i] = st.lpL * g; oR[i] = st.lpR * g;
      }
      st.lastEnd = T0 + n / osr; st.lastEndPos = st.pos;
    };
    sp.connect(d.eqL); st.sp = sp;
  }
  return true;
}
function navMove(delta, coarse){
  const st = scr; if (!st) return;
  const dur = st.deck.track.duration;
  if (coarse){
    st.coarse = true; st.usedCoarse = true;
    st.target = Math.max(0, Math.min(dur - 0.5, st.target + delta)); st.pos = st.target; st.vel = 0;
    showToast('Seek ' + mmss(st.pos) + ' / ' + mmss(dur));
    return;
  }
  if (st.coarse){ st.coarse = false; st.target = st.pos; st.vel = 0; }
  st.target = Math.max(0, Math.min(dur - 0.02, st.target + delta));
  if (!st.live) st.pos = Math.min(dur - 0.5, st.target);
}
function endNav(){
  const st = scr; if (!st || st.ending) return;
  st.ending = true;
  const deck = st.deck;
  const finish = (when, pos) => {
    if (scr === st) scr = null;
    if (deck === cur) deck.reposition(when, Math.max(0, Math.min(pos, deck.track.duration - 0.5)));
    forced = null;
    if (st.sp) setTimeout(() => { try { st.sp.disconnect(); } catch(e){} }, Math.max(120, (when - ctx.currentTime) * 1000 + 120));
  };
  if (!st.live || st.coarse){
    let pos = st.target;
    if (st.coarse){ const t = deck.track, bar = 4 * 60 / t.bpm; pos = t.downbeat + Math.round((pos - t.downbeat) / bar) * bar; }
    st.handT = ctx.currentTime;
    finish(ctx.currentTime + 0.03, pos);
    return;
  }
  // like a DJ controller: let go and the motor brings the record back up to speed,
  // then the deck takes over from the exact position the platter reached
  st.release = true; st.rate = deck.rateAt(ctx.currentTime);
  setTimeout(() => {
    const now = ctx.currentTime, handT = Math.max(now + 0.03, st.lastEnd) + 0.01;
    const pos = st.lastEndPos + (handT - st.lastEnd) * st.vel;
    st.handT = handT;
    finish(handT, pos);
  }, 110);
}

// ================= master fx =================
const curBpm = () => (cur && ctx) ? cur.track.bpm * cur.rateAt(ctx.currentTime) : 120;
const rollSize = I => I < 0.25 ? 1 : I < 0.5 ? 0.5 : I < 0.75 ? 0.25 : 0.125;
function nextGridTime(frac){
  if (!cur) return ctx.currentTime;
  const t = cur.track, bb = 60 / t.bpm * frac, pos = cur.posAt(ctx.currentTime + 0.02);
  return cur.timeAtPos(t.downbeat + Math.ceil((pos - t.downbeat) / bb) * bb);
}
function fxOn(n, retempo){
  const t = ctx.currentTime, b = curBpm(), beat = 60 / b, I = fx.amt;
  if (n === 'echo'){
    M.echo.delayTime.setTargetAtTime(Math.min(3.9, 0.75 * beat), t, 0.01);
    M.echoFb.gain.setTargetAtTime(0.3 + 0.45 * I, t, 0.02); M.echoSend.gain.setTargetAtTime(0.2 + 0.7 * I, t, 0.02);
  } else if (n === 'reverb'){
    M.revSend.gain.setTargetAtTime(0.1 + 1.0 * I, t, 0.03);
  } else if (n === 'flanger'){
    M.flLfo.frequency.setTargetAtTime(b / 60 / 8, t, 0.05);
    M.flFb.gain.setTargetAtTime(0.15 + 0.65 * I, t, 0.02); M.flSend.gain.setTargetAtTime(0.85, t, 0.02);
  } else if (n === 'gater'){
    const depth = 0.35 + 0.65 * I;
    if (M.gateOsc && !retempo){ M.gateOscG.gain.setTargetAtTime(depth / 2, t, 0.01); M.gate.gain.setTargetAtTime(1 - depth / 2, t, 0.01); return; }
    if (M.gateOsc){ try { M.gateOsc.stop(); M.gateOsc.disconnect(); } catch(e){} }
    const o = ctx.createOscillator(), og = G(depth / 2); o.type = 'square'; o.frequency.value = b / 60 * 4;
    o.connect(og); og.connect(M.gate.gain);
    M.gate.gain.cancelScheduledValues(t); M.gate.gain.setValueAtTime(1 - depth / 2, t);
    o.start(nextGridTime(0.25)); M.gateOsc = o; M.gateOscG = og;
  } else if (n === 'roll'){
    if (cur && !committed && !scr) cur.roll(rollSize(I), ctx.currentTime);
  }
}
function fxOff(n){
  const t = ctx.currentTime;
  if (n === 'echo') M.echoSend.gain.setTargetAtTime(0, t, 0.02);
  else if (n === 'reverb') M.revSend.gain.setTargetAtTime(0, t, 0.05);
  else if (n === 'flanger'){ M.flSend.gain.setTargetAtTime(0, t, 0.02); M.flFb.gain.setTargetAtTime(0, t, 0.02); }
  else if (n === 'gater'){
    if (M.gateOsc){ try { M.gateOsc.stop(t + 0.01); } catch(e){} const o = M.gateOsc; setTimeout(() => { try { o.disconnect(); } catch(e){} }, 200); }
    M.gateOsc = null; M.gateOscG = null; M.gate.gain.cancelScheduledValues(t); M.gate.gain.setTargetAtTime(1, t, 0.01);
  }
  else if (n === 'roll'){ if (cur) cur.unroll(t + 0.02); }
}
function setFx(n){
  getCtx();
  const next = n === 'none' ? null : n;
  if (next !== fx.active){
    if (fx.active) fxOff(fx.active);
    fx.active = next;
    if (next === 'roll' && (committed || !cur)) showToast(committed ? 'Roll unavailable during a transition' : 'Roll needs playback');
    else showToast('FX ' + FX_NAMES[n]);
    if (fx.active) fxOn(fx.active, true);
  }
  renderDevice();
}
function filterFreqs(v){
  let hp = 20, lp = 20000, q = 0.7;
  if (v < -0.03){ lp = 20000 * Math.pow(180 / 20000, Math.min(1, (-v - 0.03) / 0.97)); q = 1.3; }
  else if (v > 0.03){ hp = 20 * Math.pow(6000 / 20, Math.min(1, (v - 0.03) / 0.97)); q = 1.3; }
  return { hp, lp, q };
}
function applyFilter(){
  if (!M) return;
  const f = filterFreqs(fx.filter), t = ctx.currentTime;
  M.hp.frequency.setTargetAtTime(f.hp, t, 0.02); M.lp.frequency.setTargetAtTime(f.lp, t, 0.02);
  M.hp.Q.setTargetAtTime(f.q, t, 0.05); M.lp.Q.setTargetAtTime(f.q, t, 0.05);
}
function filterText(){
  const v = fx.filter, f = filterFreqs(v), fmt = x => x >= 1000 ? (x / 1000).toFixed(1) + 'k' : Math.round(x) + '';
  return v < -0.03 ? 'LPF ' + fmt(f.lp) : v > 0.03 ? 'HPF ' + fmt(f.hp) : 'OFF';
}
// keyboard [ / ] for the amount lever: a tap nudges it, holding sweeps it smoothly
const amtKeys = { dec:false, inc:false, since:0, t:0 };
const AMT_TAP = 0.01, AMT_RATE = 0.4;   // per tap / per second while held
function amtKeyDir(e){
  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '【') return 'dec';
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '】') return 'inc';
  return null;
}
function stepAmtKeys(){
  if (amtKeys.dec === amtKeys.inc) return;
  const now = performance.now(), dt = Math.min(0.05, (now - amtKeys.t) / 1000); amtKeys.t = now;
  if (now - amtKeys.since < 180) return;
  setAmt(fx.amt + (amtKeys.inc ? 1 : -1) * AMT_RATE * dt);
}
function setAmt(v){ fx.amt = Math.max(0, Math.min(1, v)); if (ctx && fx.active) fxOn(fx.active, false); showToast('FX amount ' + Math.round(fx.amt * 100) + '%'); renderDevice(); }
function showToast(text){ toast = { text, until: performance.now() + 1300 }; }

// ================= samples (synthesised placeholders) =================
function envG(t, a, d, peak){ const g = G(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); return g; }
function tone(type, f0, f1, t, dur, out, glide){
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + (glide || dur));
  o.connect(out); o.start(t); o.stop(t + dur + 0.05); return o;
}
function nz(t, dur, out){ const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.connect(out); n.start(t, Math.random() * 1.5); n.stop(t + dur); return n; }
const to = (...ns) => { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[0]; };
const VOW = { a:[800,1150,2900], e:[480,1900,2600], i:[300,2300,3000], o:[480,850,2800], u:[330,760,2500], m:[250,1100,2400] };
function consonant(c, t, out, amp){
  if (c === 'h') nz(t, 0.08, to(BQ('bandpass', 1600, 0.7), envG(t, 0.01, 0.05, 0.3 * amp), out));
  else if (c === 's') nz(t, 0.1, to(BQ('highpass', 4500), envG(t, 0.015, 0.06, 0.3 * amp), out));
  else if (c === 'k') nz(t, 0.05, to(BQ('bandpass', 1800, 1.5), envG(t, 0.001, 0.025, 0.6 * amp), out));
}
function voice(t, segs, out, k = 1, amp = 1){
  const src = ctx.createOscillator(); src.type = 'sawtooth';
  const vib = ctx.createOscillator(); vib.frequency.value = 5.5; const vd = G(3 * k); vib.connect(vd); vd.connect(src.frequency);
  const vg = G(0);
  const bands = [0, 1, 2].map(i => { const b = BQ('bandpass', VOW.a[i], [5, 7, 9][i]); const g = G([1.8, 1.0, 0.55][i]); src.connect(b); b.connect(g); g.connect(vg); return b; });
  vg.connect(out);
  let tt = t;
  for (const s of segs){
    if (s.c){ consonant(s.c, tt, out, amp); tt += s.c === 's' ? 0.07 : s.c === 'h' ? 0.04 : 0.02; }
    if (s.v){
      const F = VOW[s.v];
      bands.forEach((b, i) => b.frequency.setTargetAtTime(F[i], tt, 0.02));
      src.frequency.setValueAtTime(s.f[0] * k, tt); src.frequency.linearRampToValueAtTime(s.f[1] * k, tt + s.d);
      vg.gain.setTargetAtTime((s.v === 'm' ? 0.4 : 1) * amp, tt, 0.012);
      tt += s.d;
      if (s.gap){ vg.gain.setTargetAtTime(0, tt, 0.012); tt += s.gap; }
    } else { vg.gain.setTargetAtTime(0, tt, 0.01); tt += s.d || 0; }
  }
  vg.gain.setTargetAtTime(0, tt, 0.03);
  src.start(t); vib.start(t); src.stop(tt + 0.3); vib.stop(tt + 0.3);
}
const HEY = [{ c:'h', v:'e', d:0.2, f:[270,250] }, { v:'i', d:0.12, f:[250,215] }];
const SYN = {
  Kick: (t, o) => tone('sine', 160, 42, t, 0.45, to(envG(t, 0.003, 0.4, 1), o), 0.12),
  Clap: (t, o) => {
    const g = G(0), f = BQ('bandpass', 1300, 1.2);
    [0, 0.011, 0.022].forEach(k => { g.gain.setValueAtTime(0.8, t + k); g.gain.exponentialRampToValueAtTime(0.05, t + k + 0.009); });
    g.gain.setValueAtTime(0.6, t + 0.033); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    nz(t, 0.3, to(f, g, o));
  },
  Snare: (t, o) => { nz(t, 0.25, to(BQ('highpass', 1500), envG(t, 0.002, 0.2, 0.6), o)); tone('triangle', 200, 150, t, 0.15, to(envG(t, 0.002, 0.12, 0.5), o)); },
  Hat: (t, o) => nz(t, 0.08, to(BQ('highpass', 7500), envG(t, 0.001, 0.06, 0.45), o)),
  Shaker: (t, o) => { const g = G(0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.35, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17); nz(t, 0.2, to(BQ('bandpass', 6500, 1.5), g, o)); },
  Rim: (t, o) => { tone('triangle', 1750, 1750, t, 0.05, to(envG(t, 0.001, 0.04, 0.45), o)); nz(t, 0.03, to(BQ('bandpass', 3200, 3), envG(t, 0.001, 0.02, 0.3), o)); },
  Tom: (t, o) => tone('sine', 210, 105, t, 0.5, to(envG(t, 0.002, 0.45, 0.9), o), 0.3),
  Perc: (t, o) => { tone('sine', 440, 330, t, 0.22, to(envG(t, 0.002, 0.2, 0.6), o), 0.08); nz(t, 0.02, to(BQ('bandpass', 2000), envG(t, 0.001, 0.01, 0.2), o)); },
  Horn: (t, o) => {
    const lp = BQ('lowpass', 2600), g = G(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.03); g.gain.setValueAtTime(0.2, t + 0.75); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    const vib = ctx.createOscillator(); vib.frequency.value = 6; const vd = G(5); vib.connect(vd); vib.start(t); vib.stop(t + 1);
    lp.connect(g); g.connect(o);
    [466, 587, 698].forEach((f, i) => { const x = tone('sawtooth', f + (i - 1) * 1.5, 0, t, 0.95, lp); vd.connect(x.frequency); });
  },
  Bell: (t, o) => {
    const g = envG(t, 0.002, 1.6, 0.3); g.connect(o);
    const car = tone('sine', 880, 0, t, 1.7, g), mod = ctx.createOscillator(), mg = G(0);
    mod.frequency.value = 880 * 3.5; mg.gain.setValueAtTime(1500, t); mg.gain.exponentialRampToValueAtTime(1, t + 1.5);
    mod.connect(mg); mg.connect(car.frequency); mod.start(t); mod.stop(t + 1.7);
  },
  Whistle: (t, o) => {
    const x = tone('sine', 1900, 2500, t, 0.7, to(envG(t, 0.03, 0.6, 0.22), o), 0.12);
    const v = ctx.createOscillator(); v.frequency.value = 7; const vd = G(40); v.connect(vd); vd.connect(x.frequency); v.start(t + 0.12); v.stop(t + 0.75);
  },
  Hit: (t, o) => { nz(t, 0.3, to(BQ('lowpass', 4000), envG(t, 0.001, 0.25, 1), o)); tone('sine', 110, 40, t, 0.4, to(envG(t, 0.001, 0.35, 0.9), o), 0.25); nz(t, 1.1, to(BQ('lowpass', 1200), envG(t, 0.02, 1.0, 0.12), o)); },
  Coin: (t, o) => { const g = G(0.15); g.gain.setValueAtTime(0.15, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5); g.connect(o); const x = tone('square', 988, 0, t, 0.5, g); x.frequency.setValueAtTime(1319, t + 0.08); },
  Camera: (t, o) => { [0, 0.1].forEach(k => nz(t + k, 0.04, to(BQ('bandpass', 2800, 2), envG(t + k, 0.001, 0.025, 0.4), o))); tone('sine', 140, 140, t, 0.06, to(envG(t, 0.001, 0.05, 0.3), o)); },
  Door: (t, o) => { [0, 0.2].forEach(k => { tone('sine', 120, 70, t + k, 0.16, to(envG(t + k, 0.002, 0.15, 0.8), o), 0.12); nz(t + k, 0.06, to(BQ('lowpass', 900), envG(t + k, 0.001, 0.05, 0.4), o)); }); },
  Laugh: (t, o) => voice(t, [0, 1, 2, 3].map(i => ({ c:'h', v:'a', d:0.09, f:[330 - i * 25, 310 - i * 25], gap:0.05 })), o, 1, 0.9),
  'Piano Stab': (t, o) => [220, 261.63, 329.63, 440].forEach(f => { tone('triangle', f, 0, t, 0.8, to(envG(t, 0.003, 0.7, 0.12), o)); tone('sine', f * 2, 0, t, 0.4, to(envG(t, 0.003, 0.3, 0.04), o)); }),
  'Synth Stab': (t, o) => {
    const lp = BQ('lowpass', 5000, 4); lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    to(lp, envG(t, 0.003, 0.35, 0.22), o);
    [220, 261.63, 329.63, 392].forEach((f, i) => tone('sawtooth', f + (i % 2 ? 1 : -1), 0, t, 0.4, lp));
  },
  'Bass Hit': (t, o) => { const g = envG(t, 0.004, 0.7, 0.7), lp = BQ('lowpass', 500); to(lp, g, o); tone('sawtooth', 55, 0, t, 0.75, lp); tone('sine', 110, 55, t, 0.75, g, 0.08); },
  Chord: (t, o) => [220, 261.63, 329.63, 392].forEach(f => { const g = G(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.11, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4); g.connect(o); tone('triangle', f, 0, t, 1.45, g); }),
  Riff: (t, o) => { const st = 60 / curBpm() / 4, lp = BQ('lowpass', 1800); lp.connect(o); [440, 523.25, 659.25, 587.33].forEach((f, i) => tone('sawtooth', f, 0, t + i * st, st, to(envG(t + i * st, 0.004, st * 0.9, 0.18), lp))); },
  Pluck: (t, o) => {
    const d = ctx.createDelay(0.05), fb = G(0.965), lp = BQ('lowpass', 3000), bg = G(0.7), og = G(0.5);
    d.delayTime.value = 1 / 220; nz(t, 0.012, bg); bg.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(og); og.connect(o);
    setTimeout(() => { [d, fb, lp, bg, og].forEach(n => { try { n.disconnect(); } catch(e){} }); }, 3000);
  },
  Hey: (t, o) => voice(t, HEY, o),
  Yeah: (t, o) => voice(t, [{ v:'i', d:0.07, f:[240,250] }, { v:'e', d:0.1, f:[250,260] }, { v:'a', d:0.28, f:[260,205] }], o),
  Woo: (t, o) => voice(t, [{ v:'u', d:0.55, f:[300,470] }], o),
  Oh: (t, o) => voice(t, [{ v:'o', d:0.45, f:[250,195] }], o),
  'Come On': (t, o) => voice(t, [{ c:'k', v:'a', d:0.14, f:[230,235] }, { v:'m', d:0.07, f:[235,240] }, { v:'o', d:0.24, f:[270,205] }, { v:'m', d:0.08, f:[205,195] }], o),
  "Let's Go": (t, o) => voice(t, [{ v:'e', d:0.13, f:[240,250] }, { c:'s', d:0.02 }, { c:'k', v:'o', d:0.2, f:[285,270] }, { v:'u', d:0.16, f:[270,225] }], o),
  'Crowd Chant': (t, o) => {
    const beat = 60 / curBpm();
    const segs = [{ c:'h', v:'e', d:0.18, f:[270,255] }, { v:'i', d:0.1, f:[255,225], gap: Math.max(0.05, beat - 0.32) }, { c:'h', v:'e', d:0.18, f:[270,255] }, { v:'i', d:0.12, f:[255,215] }];
    for (let i = 0; i < 8; i++){
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : G(1);
      if (p.pan) p.pan.value = Math.random() * 1.6 - 0.8; p.connect(o);
      voice(t + Math.random() * 0.04, segs, p, 0.75 + Math.random() * 0.6, 0.32);
    }
    nz(t, 1.3, to(BQ('bandpass', 900, 0.6), envG(t, 0.1, 1.1, 0.07), o));
  }
};
const sampleName = cat => SAMPLES[cat][sampleSet % SAMPLES[cat].length];
function playSample(cat){
  getCtx();
  lastPad = cat;
  if (loops[cat]){ stopLoop(cat); return; }
  if (ctx.state !== 'running'){
    if (cur){ showToast('Resume playback to play samples'); return; }
    ctx.resume();
  }
  const name = sampleName(cat);
  try { SYN[name](ctx.currentTime + 0.01, M.sampleBus); } catch(e){ console.warn(e); }
  flashPad(cat);
}
function nextSampleSet(){ sampleSet = (sampleSet + 1) % NSETS; renderDevice(); showToast('Sample set ' + (sampleSet + 1) + ' / ' + NSETS); }
// ---------- sample loops (Shift after a pad) ----------
const LOOP_BEATS = { Clap:2, Kick:1, Snare:2, Hat:0.5, Shaker:0.5, Rim:1, Tom:2, Perc:1,
  Horn:4, Bell:2, Whistle:4, Hit:4, Coin:2, Camera:2, Door:2, Laugh:4,
  'Piano Stab':2, 'Synth Stab':1, 'Bass Hit':2, Chord:4, Riff:1, Pluck:1,
  Hey:2, Yeah:2, Woo:4, Oh:4, 'Come On':4, "Let's Go":4, 'Crowd Chant':4 };
const loops = {};            // pad -> loop state
let lastPad = null, freeBpm = 120;
const shiftState = { held:false, used:false };
const fmtBeats = b => b >= 4 ? (b === 4 ? '1 bar' : (b / 4) + ' bars') : b >= 1 ? (b === 1 ? '1 beat' : b + ' beats') : '1/' + Math.round(1 / b) + ' beat';
function nextGridPos(deck, tMin, quantum){
  const t = deck.track, qb = 60 / t.bpm * quantum, p = deck.posAt(tMin);
  return t.downbeat + Math.ceil((p - t.downbeat) / qb - 1e-6) * qb;
}
function startLoop(cat){
  getCtx();
  if (cur && ctx.state !== 'running'){ showToast('Resume playback to loop'); return; }
  if (ctx.state !== 'running') ctx.resume();
  const name = sampleName(cat), beats = LOOP_BEATS[name] || 1;
  const L = { cat, beats, q: Math.min(1, beats), deck:null, nextP:0, nextT:null };
  if (cur){ L.deck = cur; L.nextP = nextGridPos(cur, ctx.currentTime + 0.03, L.q); }
  else L.nextT = ctx.currentTime + 0.03;
  loops[cat] = L;
  renderDevice(); showToast('LOOP ' + name.toUpperCase() + ', every ' + fmtBeats(beats));
}
function stopLoop(cat){ delete loops[cat]; renderDevice(); showToast('LOOP off'); }
function toggleLoopLast(){
  if (!lastPad){ showToast('Press a pad, then SHIFT'); return; }
  loops[lastPad] ? stopLoop(lastPad) : startLoop(lastPad);
}
function scheduleLoops(now){
  if (cur) freeBpm = curBpm();
  for (const cat in loops){
    const L = loops[cat];
    for (let guard = 0; guard < 16; guard++){
      let t;
      if (cur){
        if (L.deck !== cur){
          // the track changed (or playback started): carry the loop over to the new beat grid
          const tPrev = L.deck ? L.deck.timeAtPos(L.nextP) : L.nextT;
          L.deck = cur; L.nextP = nextGridPos(cur, Math.max(tPrev, now + 0.01), L.q);
        }
        t = cur.timeAtPos(L.nextP);
        const beat = 60 / curBpm();
        if (t < now - 0.05 || t > now + L.beats * beat + 0.3){ L.nextP = nextGridPos(cur, now + 0.02, L.q); t = cur.timeAtPos(L.nextP); }
      } else {
        if (L.deck){ L.nextT = Math.max(now + 0.01, L.deck.timeAtPos(L.nextP)); L.deck = null; }
        if (L.nextT < now - 0.05) L.nextT = now + 0.01;
        t = L.nextT;
      }
      if (t > now + 0.25) break;
      try { SYN[sampleName(cat)](Math.max(t, now + 0.005), M.sampleBus); } catch(e){}
      setTimeout(() => flashPad(cat), Math.max(0, (t - ctx.currentTime) * 1000));
      if (cur) L.nextP += L.beats * 60 / cur.track.bpm;
      else L.nextT = t + L.beats * 60 / freeBpm;
    }
  }
}
function padColors(cat){ return loops[cat] ? { bg:'#CFCEC7', flash:'#ECEAE2', name:INK, cat:'#4A4A4A' } : { bg:'#7C7C7C', flash:'#9A9A9A', name:CREAM, cat:'#D8CFBD' }; }
function flashPad(cat){
  const pad = dev.querySelector(`.pad[data-pad="${cat}"] .pad-bg`); if (!pad) return;
  pad.setAttribute('fill', padColors(cat).flash); setTimeout(() => pad.setAttribute('fill', padColors(cat).bg), 110);
}
function shiftDown(){ if (shiftState.held) return; shiftState.held = true; shiftState.used = false; renderShift(); }
function shiftUp(){ if (!shiftState.held) return; shiftState.held = false; if (!shiftState.used) toggleLoopLast(); renderShift(); }
function renderShift(){ const f = dev.querySelector('#shiftFace'); if (f) f.setAttribute('fill', shiftState.held ? '#B9A986' : BODY); }

// ================= device SVG =================
const INK = '#1b1b1b', BODY = '#E8D9B8', GREY = '#6E6E6E', RED = '#C0403A', ROD = '#C9B78F', JOG = '#E9E0CC', CREAM = '#F3EBDA';
const Y0 = 133, Y1 = 568;
const spread = n => Array.from({ length: n }, (_, i) => Y0 + (Y1 - Y0) * i / (n - 1));
const FADERS = [
  { k:'blend', x:401, title:'BLEND', color:LINE.blend, opts:[['fade','FADE'],['bassswap','BASS|SWAP'],['filter','FILTER'],['cut','CUT']] },
  { k:'build', x:519, title:'BUILD', color:LINE.build, opts:[['none','NONE'],['roll','LOOP|ROLL'],['riser','RISER'],['swoosh','SWOOSH']] },
  { k:'exit',  x:637, title:'EXIT',  color:LINE.exit,  opts:[['none','NONE'],['echo','ECHO'],['reverb','REVERB'],['downsweep','DOWN|SWEEP'],['vinyl','VINYL|BREAK']] }
];
FADERS.forEach(f => { const ys = spread(f.opts.length); f.opts = f.opts.map((o, i) => [o[0], o[1], ys[i]]); });
const RC = { x:880, y:290 }, JC = { x:880, y:705 }, LC = { x:1030, y:96, r:74 };
const FONT = 'Inter,system-ui,sans-serif';

function buildDeviceSVG(){
  const faders = FADERS.map(f => {
    const labels = f.opts.map(([v, lab, y]) => {
      const parts = lab.split('|');
      const tsp = parts.length === 1 ? `<tspan x="${f.x - 30}" y="${y + 5}">${parts[0]}</tspan>`
        : `<tspan x="${f.x - 30}" y="${y - 3}">${parts[0]}</tspan><tspan x="${f.x - 30}" y="${y + 13}">${parts[1]}</tspan>`;
      return `<g class="hit sl-opt" data-v="${v}"><rect x="${f.x - 100}" y="${y - 22}" width="72" height="44" fill="transparent"/><text class="sl-lab" text-anchor="end" font-family="${FONT}" font-weight="800" font-size="14" fill="${INK}">${tsp}</text></g>`;
    }).join('');
    return `<g id="sl-${f.k}" class="fader" data-k="${f.k}" tabindex="0" role="slider" aria-label="${f.title}" aria-valuemin="0" aria-valuemax="${f.opts.length - 1}">
      <text x="${f.x - 30}" y="84" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="29" fill="${INK}">${f.title}</text>
      <rect x="${f.x - 50}" y="95" width="40" height="6" rx="3" fill="${f.color}" stroke="${INK}" stroke-width="1.5"/>
      <rect class="drag" x="${f.x - 7}" y="${Y0}" width="14" height="${Y1 - Y0}" rx="7" fill="${ROD}" stroke="${INK}" stroke-width="2.5"/>
      ${labels}
      <g class="sl-knob drag"><circle cx="${f.x}" cy="0" r="22" fill="${GREY}" stroke="${INK}" stroke-width="3" filter="url(#knobShadow)"/><circle cx="${f.x - 12}" cy="0" r="4.5" fill="#fff" stroke="${INK}" stroke-width="1.5"/><circle class="focus-ring" cx="${f.x}" cy="0" r="28"/></g>
    </g>`;
  }).join('');
  const bars = [4, 8, 16].map((n, i) => `<g class="hit bar-key" data-bars="${n}" tabindex="0" role="button" aria-label="Blend length ${n} bars">
      <rect class="bk-bg" x="${318 + i * 40}" y="604" width="34" height="30" rx="7" fill="${BODY}" stroke="${INK}" stroke-width="2"/>
      <text class="bk-tx" x="${335 + i * 40}" y="624" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="14" fill="${INK}">${n}</text>
      <rect class="focus-ring" x="${314 + i * 40}" y="600" width="42" height="38" rx="9"/></g>`).join('');
  const ring = FX_ORDER.map((k, i) => {
    const a = (i * 60 - 90) * Math.PI / 180, x = RC.x + 146 * Math.cos(a), y = RC.y + 146 * Math.sin(a);
    return `<g class="fx-item hit" data-fx="${k}" data-x="${x}" data-y="${y}"><circle cx="${x}" cy="${y}" r="36" fill="transparent"/>
      <text class="fx-lab" x="${x}" y="${y + 6}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="17" fill="#1e1e1e">${FX_NAMES[k].toUpperCase()}</text></g>`;
  }).join('');
  const pads = PADS.map(([k, label], i) => {
    const x = 538 + i * 107;
    return `<g class="hit pad" data-pad="${k}" tabindex="0" role="button">
      <rect class="pad-bg" x="${x}" y="951" width="95" height="95" rx="11" fill="#7C7C7C" stroke="${INK}" stroke-width="2.5"/>
      <text class="pad-cat" x="${x + 47.5}" y="982" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="12" fill="#D8CFBD" letter-spacing=".06em">${label}</text>
      <text class="pad-name" x="${x + 47.5}" y="1016" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="16" fill="${CREAM}"></text>
      <text class="pad-loop" x="${x + 47.5}" y="1036" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="10" fill="${RED}" letter-spacing=".12em" opacity="0">LOOP</text>
      <rect class="focus-ring" x="${x - 4}" y="947" width="103" height="103" rx="14"/></g>`;
  }).join('');
  return `
  <defs><filter id="knobShadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-opacity=".25"/></filter></defs>
  <g id="volTab" class="hit" tabindex="0" role="button" aria-label="Volume side key: click the top half for louder, the bottom half for quieter">
    <rect x="2" y="118" width="16" height="172" rx="8" fill="${BODY}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="focus-ring" x="-3" y="113" width="26" height="182" rx="12"/></g>
  <g id="shiftTab" class="hit" tabindex="0" role="button" aria-label="SHIFT side key: tap to loop the last sample; hold while turning the jog wheel to seek quickly">
    <rect id="shiftFace" x="2" y="908" width="16" height="80" rx="8" fill="${BODY}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="focus-ring" x="-3" y="903" width="26" height="90" rx="12"/></g>
  <text x="-10" y="948" transform="rotate(-90 -10 948)" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="12" fill="#8a8a84" letter-spacing=".08em" pointer-events="none">SHIFT</text>
  <g id="setBtn" class="hit" tabindex="0" role="button" aria-label="Next sample set">
    <rect id="setFace" x="1098" y="262" width="16" height="124" rx="8" fill="${RED}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="focus-ring" x="1093" y="257" width="26" height="134" rx="12"/></g>
  <rect x="28" y="22" width="1068" height="1066" rx="58" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
  <g id="lever" class="drag" tabindex="0" role="slider" aria-label="FX amount lever" aria-valuemin="0" aria-valuemax="100">
    <path d="M${LC.x} ${LC.y - LC.r} A${LC.r} ${LC.r} 0 0 1 ${LC.x + LC.r} ${LC.y}" fill="none" stroke="${INK}" stroke-width="30" stroke-linecap="round"/>
    <path d="M${LC.x} ${LC.y - LC.r} A${LC.r} ${LC.r} 0 0 1 ${LC.x + LC.r} ${LC.y}" fill="none" stroke="#B9A986" stroke-width="24" stroke-linecap="round"/>
    <path id="leverFill" fill="none" stroke="${RED}" stroke-width="24" stroke-linecap="round"/>
    <circle id="leverCap" r="15" fill="${RED}" stroke="${INK}" stroke-width="3"/>
    <path class="focus-ring" d="M${LC.x} ${LC.y - LC.r} A${LC.r} ${LC.r} 0 0 1 ${LC.x + LC.r} ${LC.y}" stroke-width="40"/>
  </g>
  <rect x="45" y="43" width="256" height="1022" rx="28" fill="#474747" stroke="${INK}" stroke-width="3"/>
  <rect x="57" y="54" width="232" height="1000" rx="19" fill="#000"/>
  ${faders}
  ${bars}
  <text x="318" y="660" font-family="${FONT}" font-weight="800" font-size="12" fill="${INK}" letter-spacing=".08em">BARS</text>

  <text x="${RC.x}" y="84" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="37" fill="${INK}">I</text>
  <g id="fxRing" tabindex="0" role="slider" aria-label="FX ring" aria-valuemin="0" aria-valuemax="5">
    <circle cx="${RC.x}" cy="${RC.y}" r="191" fill="${GREY}" stroke="${INK}" stroke-width="3" class="drag"/>
    <circle class="focus-ring" cx="${RC.x}" cy="${RC.y}" r="197"/>
    <g id="ringRot">${ring}</g>
  </g>
  <g id="filterKnob" tabindex="0" role="slider" aria-label="FILTER knob: left for low-pass, right for high-pass, double-click to center" aria-valuemin="-100" aria-valuemax="100" class="drag">
    <circle cx="${RC.x}" cy="${RC.y}" r="96" fill="${GREY}" stroke="${INK}" stroke-width="3"/>
    <path id="filterArc" fill="none" stroke="${CREAM}" stroke-width="6" stroke-linecap="round"/>
    <line id="filterPtr" x1="${RC.x}" y1="${RC.y}" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
    <circle cx="${RC.x}" cy="${RC.y}" r="9" fill="${INK}"/>
    <text x="${RC.x - 58}" y="${RC.y + 10}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="12" fill="#2a2a2a">LPF</text>
    <text x="${RC.x + 58}" y="${RC.y + 10}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="12" fill="#2a2a2a">HPF</text>
    <text x="${RC.x}" y="${RC.y + 50}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="13" fill="#2a2a2a">FILTER</text>
    <text id="filterRead" x="${RC.x}" y="${RC.y + 70}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="12" fill="${CREAM}">OFF</text>
    <circle class="focus-ring" cx="${RC.x}" cy="${RC.y}" r="101"/>
  </g>

  <g id="jog" class="drag" aria-label="Jog wheel: drag the outer ring to scratch">
    <circle cx="${JC.x}" cy="${JC.y}" r="186" fill="${JOG}" stroke="${INK}" stroke-width="3"/>
    <g id="jogRot"><line x1="${JC.x}" y1="${JC.y - 172}" x2="${JC.x}" y2="${JC.y - 150}" stroke="#CDBF9F" stroke-width="5" stroke-linecap="round"/></g>
  </g>
  <line x1="976" y1="700" x2="1062" y2="700" stroke="#111" stroke-width="6" stroke-linecap="round" pointer-events="none"/>
  <g id="playBtn" class="hit" tabindex="0" role="button" aria-label="Play / pause">
    <circle id="playFace" cx="${JC.x}" cy="${JC.y}" r="48" fill="${RED}" stroke="${INK}" stroke-width="3"/>
    <circle class="focus-ring" cx="${JC.x}" cy="${JC.y}" r="54"/></g>

  <g id="mixBtn" class="hit" tabindex="0" role="button" aria-label="Transition now">
    <rect id="mixFace" x="345" y="800" width="98" height="56" rx="12" fill="${GREY}" stroke="${INK}" stroke-width="2.5"/>
    <text x="394" y="834" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="17" fill="${CREAM}" pointer-events="none">MIX</text>
    <rect class="focus-ring" x="340" y="795" width="108" height="66" rx="15"/></g>

  <text id="setText" x="527" y="928" font-family="${FONT}" font-weight="800" font-size="14" fill="${INK}" letter-spacing=".06em">SET 1 / ${NSETS}</text>
  <rect x="527" y="940" width="440" height="117" rx="18" fill="${GREY}" stroke="${INK}" stroke-width="2.5"/>
  ${pads}`;
}
const dev = document.getElementById('dev');
dev.innerHTML = buildDeviceSVG();
const Q = s => dev.querySelector(s);
function svgPt(e){ const p = dev.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(dev.getScreenCTM().inverse()); }

let ringShown = 0, ringTarget = 0, ringDragging = false;
function phaseLock(k){
  if (!committed || !ctx) return false;
  const c = committed, p = c.plan, now = ctx.currentTime;
  if (now >= c.Te - 0.02) return true;
  if (k === 'build') return now >= p.T0 - 0.05;
  if (k === 'blend') return p.s.blend === 'cut' ? now >= p.Tc - 0.02 : now >= p.T1 - 0.02;
  return false;
}
function renderDevice(){
  const t = sliderTarget(), s = t.s;
  FADERS.forEach(f => {
    const g = Q('#sl-' + f.k), o = f.opts.find(p => p[0] === s[f.k]) || f.opts[0];
    if (!g.dataset.dragging) g.querySelector('.sl-knob').setAttribute('transform', `translate(0 ${o[2]})`);
    g.setAttribute('aria-valuenow', f.opts.indexOf(o)); g.setAttribute('aria-valuetext', o[1].replace('|', ' '));
    g.querySelectorAll('.sl-opt').forEach(el => {
      const dis = (f.k === 'blend' && s.exit === 'vinyl' && el.dataset.v !== 'cut') ;
      el.querySelector('text').setAttribute('opacity', dis ? 0.35 : 1);
    });
  });
  dev.querySelectorAll('.bar-key').forEach(el => {
    const on = +el.dataset.bars === s.bars && s.blend !== 'cut';
    el.querySelector('.bk-bg').setAttribute('fill', on ? INK : BODY);
    el.querySelector('.bk-tx').setAttribute('fill', on ? CREAM : INK);
    el.setAttribute('opacity', s.blend === 'cut' ? 0.35 : 1);
    el.setAttribute('aria-pressed', on);
  });
  const idx = FX_ORDER.indexOf(fx.active || 'none');
  ringTarget = -idx * 60;
  dev.querySelectorAll('.fx-item').forEach(g => g.querySelector('text').setAttribute('fill', g.dataset.fx === (fx.active || 'none') ? CREAM : '#1e1e1e'));
  Q('#fxRing').setAttribute('aria-valuenow', idx); Q('#fxRing').setAttribute('aria-valuetext', FX_NAMES[FX_ORDER[idx]]);
  // filter knob
  const ang = fx.filter * 135, r = 80, pol = (a, rr) => [RC.x + rr * Math.sin(a * Math.PI / 180), RC.y - rr * Math.cos(a * Math.PI / 180)];
  const [px, py] = pol(ang, 64); Q('#filterPtr').setAttribute('x2', px); Q('#filterPtr').setAttribute('y2', py);
  if (Math.abs(ang) < 1) Q('#filterArc').setAttribute('d', '');
  else { const [x0, y0] = pol(0, r), [x1, y1] = pol(ang, r); Q('#filterArc').setAttribute('d', `M${x0} ${y0} A${r} ${r} 0 0 ${ang > 0 ? 1 : 0} ${x1} ${y1}`); }
  Q('#filterRead').textContent = filterText();
  Q('#filterKnob').setAttribute('aria-valuenow', Math.round(fx.filter * 100)); Q('#filterKnob').setAttribute('aria-valuetext', filterText());
  // lever
  const la = -90 + 90 * fx.amt, lr = la * Math.PI / 180, lx = LC.x + LC.r * Math.cos(lr), ly = LC.y + LC.r * Math.sin(lr);
  Q('#leverFill').setAttribute('d', fx.amt < 0.01 ? '' : `M${LC.x} ${LC.y - LC.r} A${LC.r} ${LC.r} 0 0 1 ${lx} ${ly}`);
  Q('#leverCap').setAttribute('cx', lx); Q('#leverCap').setAttribute('cy', ly);
  Q('#lever').setAttribute('aria-valuenow', Math.round(fx.amt * 100));
  // pads
  dev.querySelectorAll('.pad').forEach(g => {
    const name = sampleName(g.dataset.pad), tx = g.querySelector('.pad-name');
    tx.textContent = name.toUpperCase(); tx.setAttribute('font-size', name.length > 9 ? 12.5 : name.length > 6 ? 14.5 : 16);
    const pc = padColors(g.dataset.pad), on = !!loops[g.dataset.pad];
    g.querySelector('.pad-bg').setAttribute('fill', pc.bg); tx.setAttribute('fill', pc.name);
    g.querySelector('.pad-cat').setAttribute('fill', pc.cat); g.querySelector('.pad-loop').setAttribute('opacity', on ? 1 : 0);
    g.setAttribute('aria-pressed', on);
    g.setAttribute('aria-label', PADS.find(p => p[0] === g.dataset.pad)[1] + ' ' + name);
  });
  Q('#setText').textContent = `SET ${sampleSet + 1} / ${NSETS}`;
  const isPlaying = playing && ctx && ctx.state === 'running';
  Q('#playFace').setAttribute('fill', isPlaying ? '#D24A43' : RED);
  Q('#playBtn').setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

// faders
FADERS.forEach(f => {
  const g = Q('#sl-' + f.k), knob = g.querySelector('.sl-knob');
  let drag = false;
  const nearest = y => f.opts.reduce((b, p) => Math.abs(p[2] - y) < Math.abs(b[2] - y) ? p : b)[0];
  g.addEventListener('pointerdown', e => { if (e.target.closest('.sl-opt')) return; drag = true; g.dataset.dragging = '1'; g.setPointerCapture(e.pointerId); move(e); });
  const move = e => { if (!drag) return; const y = Math.max(Y0, Math.min(Y1, svgPt(e).y)); knob.setAttribute('transform', `translate(0 ${y})`); };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', e => { if (!drag) return; drag = false; delete g.dataset.dragging; setFromSlider(f.k, nearest(svgPt(e).y)); renderDevice(); });
  g.addEventListener('pointercancel', () => { drag = false; delete g.dataset.dragging; renderDevice(); });
  g.addEventListener('click', e => { const o = e.target.closest('.sl-opt'); if (o){ setFromSlider(f.k, o.dataset.v); renderDevice(); } });
  g.addEventListener('keydown', e => {
    const s = sliderTarget().s, i = f.opts.findIndex(p => p[0] === s[f.k]); let n = i;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = Math.min(f.opts.length - 1, i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = Math.max(0, i - 1);
    else return;
    e.preventDefault(); if (n !== i){ setFromSlider(f.k, f.opts[n][0]); renderDevice(); }
  });
});
dev.querySelectorAll('.bar-key').forEach(el => {
  const go = () => { setFromSlider('bars', el.dataset.bars); renderDevice(); };
  el.addEventListener('click', go);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); go(); } });
});
// fx ring
(() => {
  const g = Q('#fxRing'); let drag = null;
  const ang = p => Math.atan2(p.y - RC.y, p.x - RC.x) * 180 / Math.PI;
  g.addEventListener('pointerdown', e => {
    const p = svgPt(e); if (Math.hypot(p.x - RC.x, p.y - RC.y) < 96) return;
    drag = { a: ang(p), base: ringShown, moved:false, item: e.target.closest('.fx-item') };
    g.setPointerCapture(e.pointerId); ringDragging = true;
  });
  g.addEventListener('pointermove', e => {
    if (!drag) return; let d = ang(svgPt(e)) - drag.a; d = ((d + 540) % 360) - 180;
    if (Math.abs(d) > 4) drag.moved = true;
    if (drag.moved) ringShown = drag.base + d;
  });
  const end = () => {
    if (!drag) return; ringDragging = false;
    let chosen;
    if (drag.moved){ const idx = ((Math.round(-ringShown / 60) % 6) + 6) % 6; chosen = FX_ORDER[idx]; }
    else if (drag.item) chosen = drag.item.dataset.fx;
    drag = null;
    if (chosen) setFx(chosen); else renderDevice();
  };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', () => { drag = null; ringDragging = false; renderDevice(); });
  g.addEventListener('keydown', e => {
    const i = FX_ORDER.indexOf(fx.active || 'none');
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown'){ e.preventDefault(); setFx(FX_ORDER[(i + 1) % 6]); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp'){ e.preventDefault(); setFx(FX_ORDER[(i + 5) % 6]); }
    else if (e.key === 'Home' || e.key === '0'){ e.preventDefault(); setFx('none'); }
  });
})();
// filter knob
(() => {
  const g = Q('#filterKnob'); let drag = null;
  const setF = v => { v = Math.max(-1, Math.min(1, v)); if (Math.abs(v) < 0.03) v = 0; fx.filter = v; applyFilter(); renderDevice(); };
  g.addEventListener('pointerdown', e => { e.stopPropagation(); getCtx(); drag = { y: e.clientY, x: e.clientX, v: fx.filter }; g.setPointerCapture(e.pointerId); });
  g.addEventListener('pointermove', e => { if (drag) setF(drag.v + ((drag.y - e.clientY) + (e.clientX - drag.x)) / 180); });
  g.addEventListener('pointerup', () => drag = null); g.addEventListener('pointercancel', () => drag = null);
  g.addEventListener('dblclick', () => { setF(0); showToast('FILTER centered'); });
  g.addEventListener('wheel', e => { e.preventDefault(); getCtx(); setF(fx.filter - Math.sign(e.deltaY) * 0.05); }, { passive:false });
  g.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight'){ e.preventDefault(); getCtx(); setF(fx.filter + 0.05); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft'){ e.preventDefault(); getCtx(); setF(fx.filter - 0.05); }
    else if (e.key === 'Home' || e.key === '0'){ e.preventDefault(); setF(0); }
  });
})();
// amount lever
(() => {
  const g = Q('#lever'); let drag = false;
  const fromPt = p => { const a = Math.atan2(p.y - LC.y, p.x - LC.x) * 180 / Math.PI; return Math.max(0, Math.min(1, (a + 90) / 90)); };
  g.addEventListener('pointerdown', e => { drag = true; g.setPointerCapture(e.pointerId); setAmt(fromPt(svgPt(e))); });
  g.addEventListener('pointermove', e => { if (drag) setAmt(fromPt(svgPt(e))); });
  g.addEventListener('pointerup', () => drag = false); g.addEventListener('pointercancel', () => drag = false);
  g.addEventListener('wheel', e => { e.preventDefault(); setAmt(fx.amt - Math.sign(e.deltaY) * 0.05); }, { passive:false });
  g.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight'){ e.preventDefault(); setAmt(fx.amt + 0.05); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft'){ e.preventDefault(); setAmt(fx.amt - 0.05); }
  });
})();
// jog
(() => {
  const g = Q('#jog'); let drag = null;
  const ang = p => Math.atan2(p.y - JC.y, p.x - JC.x);
  g.addEventListener('pointerdown', e => {
    if (e.shiftKey || shiftState.held) shiftState.used = true;
    if (!startNav()){ if (!scr) showToast(committed ? 'Jog locked during a transition' : 'Start playback first'); return; }
    drag = { a: ang(svgPt(e)), t: performance.now() }; g.setPointerCapture(e.pointerId);
  });
  g.addEventListener('pointermove', e => {
    if (!drag || !scr) return;
    const a = ang(svgPt(e)), now = performance.now();
    let d = a - drag.a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    const coarse = e.shiftKey || shiftState.held; if (coarse) shiftState.used = true;
    navMove(d / (2 * Math.PI) * (coarse ? coarseSecPerRev(scr.deck.track) : SCRATCH_SEC_PER_REV), coarse);
    drag.a = a; drag.t = now;
  });
  const end = () => { if (!drag) return; drag = null; endNav(); };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
})();
const pressFlash = el => { el.setAttribute('transform', 'translate(0 3)'); setTimeout(() => el.removeAttribute('transform'), 140); };
const onActivate = (el, fn) => { el.addEventListener('click', fn); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); e.stopPropagation(); fn(e); } }); };
onActivate(Q('#playBtn'), () => togglePlay());
onActivate(Q('#mixBtn'), () => { pressFlash(Q('#mixFace')); mixNow(); });
onActivate(Q('#setBtn'), () => { Q('#setFace').setAttribute('transform', 'translate(-3 0)'); setTimeout(() => Q('#setFace').removeAttribute('transform'), 140); nextSampleSet(); });
const volStep = d => { fx.vol = Math.max(0, Math.min(1, fx.vol + d)); if (ctx) M.vol.gain.setTargetAtTime(fx.vol * fx.vol * 1.2, ctx.currentTime, 0.02); showToast('Volume ' + Math.round(fx.vol * 100) + '%'); };
Q('#volTab').addEventListener('click', e => volStep(svgPt(e).y < 204 ? 0.1 : -0.1));
Q('#volTab').addEventListener('keydown', e => { if (e.key === 'ArrowUp'){ e.preventDefault(); volStep(0.1); } if (e.key === 'ArrowDown'){ e.preventDefault(); volStep(-0.1); } });
(() => {
  const g = Q('#shiftTab');
  g.addEventListener('pointerdown', e => { e.preventDefault(); try { g.setPointerCapture(e.pointerId); } catch(err){} shiftDown(); });
  g.addEventListener('pointerup', () => shiftUp());
  g.addEventListener('pointercancel', () => { shiftState.used = true; shiftUp(); });
  g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); e.stopPropagation(); toggleLoopLast(); } });
})();
dev.querySelectorAll('.pad').forEach(g => {
  g.addEventListener('pointerdown', e => { e.preventDefault(); playSample(g.dataset.pad); });
  g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); playSample(g.dataset.pad); } });
});

// ================= screen =================
const cv = document.getElementById('screen'), cx = cv.getContext('2d');
const SW = 232, SH = 1000, TOPW = 78, BOTW = 992, PLAYY = 400, PXB = 25;
const WAVE = { blue:'#2F6BFF', amber:'#F5A524', white:'#FFF4DE' };
function blendLevel(type, u, isIn){
  u = Math.max(0, Math.min(1, u));
  if (type === 'fade') return isIn ? Math.sin(u * Math.PI / 2) : Math.cos(u * Math.PI / 2);
  if (type === 'bassswap') return isIn ? Math.min(1, u * 2) : (u < 0.5 ? 1 : 1 - (u - 0.5) * 2);
  if (type === 'filter') return isIn ? Math.min(1, u / 0.35) : (u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4);
  return isIn ? 1 : 0;
}
function autoLines(p){
  const { s, T1, Tb } = p, T0 = p.T0, Tc = p.Tc != null ? p.Tc : p.T0, bw = p.beatWall, Bw = p.barWall, out = [], inc = [];
  const pts = (f, a, b, n = 48) => { const r = []; for (let i = 0; i <= n; i++){ const t = a + (b - a) * i / n; r.push([t, f(t)]); } return r; };
  if (s.blend === 'cut'){
    const h = p.hold || { outDry:1, inDry:0 };
    out.push({ c:'blend', pts:[[Math.min(T0, Tc) - Bw, h.outDry], [Tc, h.outDry], [Tc, 0], [Tc + bw, 0]] });
    inc.push({ c:'blend', pts:[[Tc - Bw, h.inDry], [Tc, h.inDry], [Tc, 1], [Tc + Bw, 1]] });
  } else {
    const D = T1 - T0;
    out.push({ c:'blend', pts:[[T0 - Bw, 1], ...pts(t => blendLevel(s.blend, (t - T0) / D, false), T0, T1), [T1 + bw, 0]] });
    inc.push({ c:'blend', pts:[[T0 - Bw, 0], ...pts(t => blendLevel(s.blend, (t - T0) / D, true), T0, T1), [T1 + Bw, 1]] });
    if (s.blend === 'bassswap'){ const Mid = T0 + D / 2; out.push({ c:'blend', mark:'BASS', pts:[[Mid, 0], [Mid, 1]], dash:true }); inc.push({ c:'blend', mark:'BASS', pts:[[Mid, 0], [Mid, 1]], dash:true }); }
  }
  if (s.build === 'roll') out.push({ c:'build', pts:[[Tb, 0], [Tb, .25], [Tb + Bw, .25], [Tb + Bw, .5], [T0 - 2 * bw, .5], [T0 - 2 * bw, .75], [T0 - bw, .75], [T0 - bw, 1], [T0, 1], [T0, 0]] });
  else if (s.build === 'riser') out.push({ c:'build', pts:[...pts(t => Math.pow((t - Tb) / (T0 - Tb), 1.6), Tb, T0), [T0, 0]] });
  else if (s.build === 'swoosh'){ const t0 = T0 - Bw, t1 = T0 + 1.5 * bw; out.push({ c:'build', pts:[...pts(t => Math.pow((t - t0) / (T0 - t0), 2), t0, T0, 24), ...pts(t => 1 - (t - T0) / (t1 - T0), T0, t1, 12)] }); }
  const Te = s.blend === 'cut' ? Tc : T1;
  if (s.exit === 'echo') out.push({ c:'exit', pts:[[Te - bw, 0], [Te, 1], ...pts(t => Math.pow(0.55, (t - Te) / (0.75 * bw)), Te, Te + 3 * Bw)] });
  else if (s.exit === 'reverb') out.push({ c:'exit', pts:[[Te - 2 * bw, 0], [Te, 0.9], ...pts(t => 0.9 * Math.exp(-(t - Te) * 1.6), Te, Te + 3.2)] });
  else if (s.exit === 'downsweep'){ const a = Te - bw, b = Te + 2 * Bw; out.push({ c:'exit', pts: pts(t => 1 - (t - a) / (b - a), a, b) }); }
  else if (s.exit === 'vinyl'){ const tb = Tc - 2 * bw; out.push({ c:'exit', pts:[[tb - bw, 1], ...pts(t => Math.exp(Math.log(0.03) * (t - tb) / (Tc - tb)), tb, Tc), [Tc, 0]] }); }
  return { out, inc, bw };
}
function laneData(slot){
  const now = ctx ? ctx.currentTime : 0;
  if (!cur) return null;
  const plan = committed ? committed.plan : planNext();
  const L = plan ? autoLines(plan) : null;
  if (slot === curSlot){
    const pos = scr ? scr.pos : cur.posAt(now);
    const endPos = committed ? cur.posAt(committed.Te) : null;
    const cues = plan ? [plan.P0 - plan.buildBars * plan.barBuf, plan.P0].concat(plan.blendBars ? [plan.P0 + plan.blendBars * plan.barBuf] : []) : [];
    return { t: cur.track, pos, gridBpm: cur.gridBpm, bpm: cur.track.bpm * cur.rateAt(now), sync: cur.synced || Math.abs(cur.rateAt(now) - 1) > 0.001,
      sub: scr ? (scr.coarse ? 'Seeking' : scr.live ? 'Scratching' : 'Cueing') : (playing ? 'Playing' : 'Paused'), cues, endPos, lines: L && !scr ? L.out : [], bw: L && L.bw };
  }
  if (committed){
    const d = committed.inc;
    return { t: d.track, pos: d.posAt(now), gridBpm: d.gridBpm, bpm: d.track.bpm * d.rateAt(now), sync: d.synced, sub: now < committed.plan.T0 ? 'Coming in' : 'Mixing in', cues: [committed.plan.inPos], lines: L.inc, bw: L.bw };
  }
  if (!plan){ const nt = tracks[curIndex() + 1]; return nt ? { t: nt, pos: null, sub: nt.status === 'ready' ? 'Up next' : 'Analyzing' } : null; }
  const ratio = plan.sync.ok ? plan.sync.ratio : 1;
  return { t: plan.nt, pos: plan.inPos - (plan.T0 - now) * ratio, gridBpm: plan.sync.ok ? plan.sync.cand : plan.nt.bpm, bpm: plan.nt.bpm * ratio, sync: plan.sync.ok, sub: 'Up next', cues: [plan.inPos], lines: scr ? [] : L.inc, bw: L.bw };
}
function fitText(s, w){ if (cx.measureText(s).width <= w) return s; while (s.length > 1 && cx.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; }
function drawLines(L, x0, w, now){
  if (!L.lines || !L.lines.length) return;
  cx.save(); cx.beginPath(); cx.rect(x0 - 2, TOPW, w + 4, BOTW - TOPW); cx.clip();
  cx.lineWidth = 2.2; cx.lineJoin = 'round'; cx.lineCap = 'round';
  const X = l => x0 + 5 + l * (w - 10), Y = t => PLAYY + (t - now) / L.bw * PXB;
  for (const ln of L.lines){
    cx.strokeStyle = LINE[ln.c]; cx.setLineDash(ln.dash ? [3, 3] : []);
    cx.beginPath(); ln.pts.forEach(([t, l], i) => { const x = X(l), y = Y(t); i ? cx.lineTo(x, y) : cx.moveTo(x, y); }); cx.stroke();
    const first = ln.pts.find(([t]) => { const y = Y(t); return y > TOPW + 8 && y < BOTW; });
    if (first && !ln.dash){ cx.setLineDash([]); cx.fillStyle = LINE[ln.c]; cx.font = '800 7px Inter,sans-serif'; cx.fillText(ln.c.toUpperCase(), Math.min(X(first[1]) + 3, x0 + w - 26), Y(first[0]) - 3); }
    if (ln.mark){ const y = Y(ln.pts[0][0]); if (y > TOPW && y < BOTW){ cx.setLineDash([]); cx.fillStyle = LINE[ln.c]; cx.font = '800 7px Inter,sans-serif'; cx.fillText(ln.mark, x0 + w - 20, y - 3); } }
  }
  cx.restore(); cx.setLineDash([]);
}
// waveform + beat grid of one track, clipped to [minPos, maxPos] of the track
function drawWave(t, pos, beat, x0, maxPos, dim){
  const w = 100, mid = x0 + w / 2, fps = t.fps, end = Math.min(t.duration, maxPos);
  cx.save(); cx.beginPath(); cx.rect(x0, TOPW, w, BOTW - TOPW); cx.clip();
  const bFirst = Math.floor((pos - (PLAYY - TOPW) / PXB * beat - t.downbeat) / beat), bLast = Math.ceil((pos + (BOTW - PLAYY) / PXB * beat - t.downbeat) / beat);
  for (let k = bFirst; k <= bLast; k++){
    const pk = t.downbeat + k * beat; if (pk < 0 || pk > end) continue;
    const y = PLAYY + (pk - pos) / beat * PXB;
    cx.fillStyle = (((k % 4) + 4) % 4 === 0) ? '#2b2f36' : '#15181c'; cx.fillRect(x0, Math.round(y), w, 1);
  }
  const secPerRow = beat / PXB;
  cx.globalAlpha = dim ? 0.55 : 0.8;
  for (let y = TOPW; y < BOTW; y += 1){
    const p = pos + (y - PLAYY) * secPerRow;
    if (p < 0 || p > end) continue;
    const f0 = Math.floor(p * fps), f1 = Math.max(f0 + 1, Math.floor((p + secPerRow) * fps));
    let a = 0, l = 0, h = 0, c = 0;
    for (let f = f0; f < f1 && f < t.amp.length; f++){ if (t.amp[f] > a) a = t.amp[f]; l += t.shL[f]; h += t.shH[f]; c++; }
    if (!c || a < 3) continue;
    const A = a / 255, sL = l / c / 255, sH = h / c / 255, half = 46 * A;
    cx.fillStyle = WAVE.blue; cx.fillRect(mid - half, y, half * 2, 1);
    const am = half * (0.3 + 0.7 * (1 - sL)); cx.fillStyle = WAVE.amber; cx.fillRect(mid - am, y, am * 2, 1);
    const wh = half * Math.min(1, 0.1 + 0.85 * sH); cx.fillStyle = WAVE.white; cx.fillRect(mid - wh, y, wh * 2, 1);
  }
  cx.globalAlpha = 1;
  // end-of-track marker
  if (end < t.duration || maxPos >= t.duration){
    const ye = PLAYY + (end - pos) / beat * PXB;
    if (ye > TOPW && ye < BOTW){ cx.fillStyle = '#3a4150'; cx.fillRect(x0 + 10, Math.round(ye), w - 20, 1); }
  }
  cx.restore();
}
function drawLane(L, x0, now, gh){
  const w = 100;
  // a track that has finished keeps scrolling up until it leaves the lane
  if (gh){
    drawWave(gh.deck.track, gh.deck.posAt(now), 60 / gh.deck.gridBpm, x0, gh.endPos, true);
    drawLines({ lines: gh.lines, bw: gh.bw }, x0, w, now);
  }
  const head = L || (gh ? { t: gh.deck.track, sub: 'Finished', ghostHead: true } : null);
  if (!head){ cx.fillStyle = '#3c4453'; cx.font = '500 11px Inter,"Noto Sans SC",sans-serif'; cx.fillText('—', x0, 32); cx.fillStyle = '#5FD3A6'; cx.fillRect(x0 - 2, PLAYY - 1, w + 4, 2); return; }
  const t = head.t;
  cx.fillStyle = head.ghostHead ? '#7d8796' : '#fff'; cx.font = '700 14px Inter,"Noto Sans SC",sans-serif'; cx.fillText(fitText(t.name, w - 2), x0, 30);
  cx.fillStyle = '#b8c4d3'; cx.font = '400 10px Inter,"Noto Sans SC",sans-serif'; cx.fillText((head.sub || '') + (t.key ? '  ' + t.key.camelot : ''), x0, 45);
  if (!L || t.status !== 'ready' || L.pos == null){ cx.fillStyle = '#5FD3A6'; cx.fillRect(x0 - 2, PLAYY - 1, w + 4, 2); return; }
  cx.fillStyle = '#fff'; cx.font = '700 11px Inter,sans-serif'; const bt = L.bpm.toFixed(1) + ' BPM'; cx.fillText(bt, x0, 63);
  cx.fillStyle = L.sync ? '#5FD3A6' : '#4a5566'; cx.font = '600 8px Inter,sans-serif'; cx.fillText('SYNC', x0 + cx.measureText(bt).width + 30, 63);
  const beat = 60 / L.gridBpm, pos = L.pos;
  drawWave(t, pos, beat, x0, L.endPos != null ? L.endPos : Infinity, false);
  cx.save(); cx.beginPath(); cx.rect(x0, TOPW, w, BOTW - TOPW); cx.clip();
  cx.fillStyle = '#FF4A45';
  (L.cues || []).forEach(c => { const y = PLAYY + (c - pos) / beat * PXB; if (y < TOPW || y > BOTW) return; cx.beginPath(); cx.moveTo(x0, y - 5); cx.lineTo(x0 + 7, y); cx.lineTo(x0, y + 5); cx.fill(); });
  cx.restore();
  drawLines(L, x0, w, now);
  cx.fillStyle = '#5FD3A6'; cx.fillRect(x0 - 2, PLAYY - 1, w + 4, 2);
  const rel = (pos - t.downbeat) / beat, barN = Math.floor(rel / 4) + 1, beatN = Math.floor(((rel % 4) + 4) % 4) + 1;
  const lbl = pos < 0 ? '-' + Math.ceil(-rel / 4) + ' bar' : barN + '.' + beatN + ' bar';
  cx.font = '600 9px Inter,sans-serif'; const lw = cx.measureText(lbl).width + 8;
  cx.fillStyle = '#0d2c24'; cx.fillRect(x0 - 2, PLAYY - 15, lw, 13);
  cx.fillStyle = '#5FD3A6'; cx.fillText(lbl, x0 + 2, PLAYY - 5);
}
function drawScreen(){
  const dpr = window.devicePixelRatio || 1, cw = cv.clientWidth, ch = cv.clientHeight;
  if (!cw) return;
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (cv.width !== W || cv.height !== H){ cv.width = W; cv.height = H; }
  cx.setTransform(W / SW, 0, 0, H / SH, 0, 0);
  cx.clearRect(0, 0, SW, SH);
  cx.save(); cx.beginPath(); cx.roundRect ? cx.roundRect(0, 0, SW, SH, 19) : cx.rect(0, 0, SW, SH); cx.clip();
  cx.fillStyle = '#000'; cx.fillRect(0, 0, SW, SH);
  cx.textBaseline = 'alphabetic';
  if (ghost && ctx){
    const d = ghost.deck, ye = PLAYY + (ghost.endPos - d.posAt(ctx.currentTime)) / (60 / d.gridBpm) * PXB;
    if (ye < TOPW - 4) ghost = null;
  }
  if (!cur && !ghost){
    cx.fillStyle = '#b8c4d3'; cx.font = '500 12px Inter,"Noto Sans SC",sans-serif'; cx.textAlign = 'center';
    const lines = ended ? ['Playlist finished'] : tracks.length ? ['Press the red', 'button to play'] : ['Add local music', 'to get started'];
    lines.forEach((l, i) => cx.fillText(l, SW / 2, 470 + i * 18));
    cx.textAlign = 'left';
  } else {
    const now = ctx.currentTime;
    const gh = s => (ghost && ghost.slot === s) ? ghost : null;
    drawLane(cur ? laneData(0) : null, 12, now, gh(0)); drawLane(cur ? laneData(1) : null, 122, now, gh(1));
  }
  if (toast && performance.now() < toast.until){
    let tfs = 12; cx.font = `600 ${tfs}px Inter,sans-serif`;
    while (cx.measureText(toast.text).width > SW - 36 && tfs > 8){ tfs -= 0.5; cx.font = `600 ${tfs}px Inter,sans-serif`; }
    const tw = cx.measureText(toast.text).width + 20;
    cx.fillStyle = 'rgba(232,217,184,.95)'; const x = (SW - tw) / 2;
    cx.beginPath(); cx.roundRect ? cx.roundRect(x, 900, tw, 26, 6) : cx.rect(x, 900, tw, 26); cx.fill();
    cx.fillStyle = '#1b1b1b'; cx.textAlign = 'center'; cx.fillText(toast.text, SW / 2, 917); cx.textAlign = 'left';
  }
  cx.restore();
}

// ================= companion UI =================
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const mmss = x => { x = Math.max(0, x); const m = Math.floor(x / 60), s = Math.floor(x % 60); return m + ':' + String(s).padStart(2, '0'); };
function gapInfo(i){
  const a = tracks[i], b = tracks[i + 1];
  if (committed && committed.out.track === a && committed.inc.track === b) return '<div class="gapinfo"><b>Transition in progress</b></div>';
  if (!(a && b && a.bpm && b.bpm)) return '<div class="gapinfo">Waiting for analysis</div>';
  const m = tempoMatch(a.bpm, b.bpm), pct = (m.ratio - 1) * 100;
  const kt = (a.key && b.key) ? `; key ${a.key.camelot} → ${b.key.camelot}${keyDist(a.key, b.key) <= 1 ? ' (compatible)' : ' (distant)'}` : '';
  return m.ok ? `<div class="gapinfo">Tempo ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%, will beatmatch${kt}</div>`
    : `<div class="gapinfo warn">Tempos ${Math.abs(pct).toFixed(0)}% apart, can't beatmatch${resolveSet(globalSet).blend !== 'cut' ? '; a long blend will clash, Cut works better here' : ''}${kt}</div>`;
}
function renderCurSet(){
  const r = resolveSet(globalSet);
  const row = (c, l, v) => `<div><i style="background:var(--c-${c})"></i><span>${l}</span><strong>${v}</strong></div>`;
  $('#curSet').innerHTML = row('blend', 'BLEND', BLENDS[r.blend] + (r.blend === 'cut' ? '' : ', ' + r.bars + ' bars'))
    + row('build', 'BUILD', BUILDS[r.build]) + row('exit', 'EXIT', EXITS[r.exit])
    + (globalSet.exit === 'vinyl' && globalSet.blend !== 'cut' ? `<span class="note">While Vinyl Break is on, BLEND is held at Cut. It returns to ${BLENDS[globalSet.blend]} when you turn Vinyl Break off.</span>` : '')
    + '<span class="note">Set by the faders on the panel. All upcoming transitions use these settings.</span>';
}
const ICO = {
  play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  up:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 14l6-6 6 6"/></svg>',
  down:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 10l6 6 6-6"/></svg>',
  del:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};
function renderList(){
  const ul = $('#tracks'), ci = curIndex();
  $('#drop').style.display = tracks.length ? 'none' : '';
  const busy = new Set([cur && cur.track, committed && committed.inc.track].filter(Boolean));
  let h = '';
  tracks.forEach((t, i) => {
    const st = t.status === 'ready'
      ? `<span class="bpm">${t.key ? `<span class="key" title="${t.key.name}">${t.key.camelot}</span>` : ''}${t.bpm.toFixed(t.bpm % 1 ? 1 : 0)} BPM <button class="mini" data-bpm="0.5" data-i="${i}" aria-label="Halve BPM">÷2</button><button class="mini" data-bpm="2" data-i="${i}" aria-label="Double BPM">×2</button></span>`
      : t.status === 'error' ? `<span class="sub">${esc(t.errMsg || "Can't decode this file")}</span>` : '<span class="sub">Analyzing…</span>';
    h += `<li class="row ${i === ci ? 'current' : ''}"><span class="idx">${i + 1}</span>
      <div style="min-width:0"><div class="name">${esc(t.name)}</div><div class="sub">${t.duration ? mmss(t.duration) : ''}${t.src && t.src.type === 'audius' ? '<span class="src-tag">AUDIUS</span>' : ''}</div></div>${st}
      <div class="acts">
        <button class="icon" data-act="play" data-i="${i}" aria-label="Play from here" ${t.status !== 'ready' ? 'disabled' : ''}>${ICO.play}</button>
        <button class="icon" data-act="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ICO.up}</button>
        <button class="icon" data-act="down" data-i="${i}" aria-label="Move down" ${i === tracks.length - 1 ? 'disabled' : ''}>${ICO.down}</button>
        <button class="icon" data-act="del" data-i="${i}" aria-label="Remove" ${busy.has(t) ? 'disabled' : ''}>${ICO.del}</button>
      </div></li>`;
    if (i < tracks.length - 1) h += `<li class="gap">${gapInfo(i)}</li>`;
  });
  ul.innerHTML = h;
  renderCurSet();
  renderDevice();
}
$('#tracks').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.bpm){ const t = tracks[+b.dataset.i]; t.bpm = Math.round(t.bpm * +b.dataset.bpm * 100) / 100; if (cur && cur.track === t) cur.gridBpm = t.bpm; forced = null; renderList(); return; }
  const i = +b.dataset.i, act = b.dataset.act;
  if (act === 'play') startFrom(i);
  else if (act === 'up' && i > 0){ [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; manualOrder = true; afterReorder(); }
  else if (act === 'down' && i < tracks.length - 1){ [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; manualOrder = true; afterReorder(); }
  else if (act === 'del'){ const [t] = tracks.splice(i, 1); bufCache.delete(t.id); afterReorder(); renderAudius(); }
});
function afterReorder(){ forced = null; if (ctx){ pruneCache(); const n = tracks[curIndex() + 1]; if (n && cur) ensureBuffer(n); } renderList(); }
function addFiles(list){
  const files = [...list].filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|aiff?|opus)$/i.test(f.name));
  if (!files.length) return;
  getCtx();
  const batch = files.map(f => { const t = { id: uid++, file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'analyzing' }; tracks.push(t); queueAnalysis(t); return t; });
  analyzing = analyzing.then(() => autoSort(batch));
  renderList();
}
$('#addBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('#jumpBtn').onclick = () => jumpToTransition();
$('#sortBtn').onclick = () => autoSort(null);
['#drop', '#tracks'].forEach(sel => {
  const el = $(sel);
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); addFiles(e.dataTransfer.files); });
});
onDoc('dragover', e => e.preventDefault());
onDoc('drop', e => { e.preventDefault(); if (!e.target.closest('#drop,#tracks')) addFiles(e.dataTransfer.files); });
onDoc('keydown', e => { if (e.key === 'Shift' && !e.repeat) shiftDown(); });
onDoc('keydown', e => {
  const d = amtKeyDir(e); if (!d || e.target.closest('input,textarea')) return;
  e.preventDefault();
  if (!amtKeys[d]){ amtKeys[d] = true; amtKeys.since = amtKeys.t = performance.now(); setAmt(fx.amt + (d === 'inc' ? AMT_TAP : -AMT_TAP)); }
});
onDoc('keyup', e => { const d = amtKeyDir(e); if (d) amtKeys[d] = false; });
onDoc('visibilitychange', () => { amtKeys.dec = amtKeys.inc = false; });
onDoc('keyup', e => { if (e.key === 'Shift') shiftUp(); });
onDoc('visibilitychange', () => { shiftState.held = false; renderShift(); });
onDoc('keydown', e => {
  if (e.target.closest('input,textarea,[role="slider"],[role="button"],button')) return;
  if (e.code === 'Space'){ e.preventDefault(); togglePlay(); }
  else if (e.key === 'm' || e.key === 'M') mixNow();
  else if (e.key === 'j' || e.key === 'J') jumpToTransition();
  else if (['1','2','3','4'].includes(e.key)) playSample(PADS[+e.key - 1][0]);
});

function updateStatus(){
  const el = $('#status');
  $('#jumpBtn').disabled = !(cur && !committed && tracks[curIndex() + 1]);
  if (!cur || !ctx){ el.innerHTML = ended ? 'Playlist finished.' : tracks.length ? 'Press the red button in the middle of the jog wheel to play.' : 'Add music, then press the red button in the middle of the jog wheel to start.'; return; }
  const now = ctx.currentTime, ci = curIndex();
  let st = '', sub = '';
  if (committed){
    const p = committed.plan;
    if (now < p.Tb) st = `Transition starts in ${mmss(p.Tb - now)}`;
    else if (now < p.T0) st = `BUILD: ${BUILDS[p.s.build]}`;
    else if (p.s.blend === 'cut' && now < p.Tc) st = 'BLEND: Cut on the next beat';
    else if (now < p.T1){ const bar = Math.min(p.blendBars, Math.floor((now - p.T0) / p.barWall) + 1); st = `BLEND: ${BLENDS[p.s.blend]}, bar ${bar} / ${p.blendBars}`; }
    else st = `EXIT: ${EXITS[p.s.exit]}`;
    sub = `Mixing in ${committed.inc.track.name}`;
  } else {
    const plan = planNext();
    if (plan){
      const s = plan.s;
      st = `Next transition in ${mmss(plan.Tb - now)}`;
      sub = `BLEND ${BLENDS[s.blend]}${s.blend === 'cut' ? '' : ' ' + plan.blendBars + ' bars'}, BUILD ${BUILDS[s.build]}, EXIT ${EXITS[s.exit]}. ${plan.sync.ok ? 'Will beatmatch.' : 'Tempos too far apart to beatmatch.'}`;
    } else if (tracks[ci + 1]) st = 'The next song is still being analyzed; the transition will be scheduled when it is ready.';
    else st = 'This is the last song in the playlist.';
  }
  if (!playing) st = 'Paused. ' + st;
  el.innerHTML = esc(st) + (sub ? `<span class="sub">${esc(sub)}</span>` : '');
}
let lastStatus = 0, lastRing = null;
function frame(ts){
  if (!alive) return;
  requestAnimationFrame(frame);
  stepAmtKeys();
  if (!ringDragging){ ringShown += (ringTarget - ringShown) * 0.25; if (Math.abs(ringTarget - ringShown) < 0.05) ringShown = ringTarget; }
  if (ringShown !== lastRing){
    lastRing = ringShown;
    Q('#ringRot').setAttribute('transform', `rotate(${ringShown} ${RC.x} ${RC.y})`);
    dev.querySelectorAll('.fx-item').forEach(g => g.querySelector('text').setAttribute('transform', `rotate(${-ringShown} ${g.dataset.x} ${g.dataset.y})`));
  }
  if (cur && ctx){
    const pos = scr ? scr.pos : cur.posAt(ctx.currentTime);
    const secPerRev = SCRATCH_SEC_PER_REV;
    Q('#jogRot').setAttribute('transform', `rotate(${(pos / secPerRev * 360) % 360} ${JC.x} ${JC.y})`);
  }
  drawScreen();
  if (ts - lastStatus > 200){ lastStatus = ts; updateStatus(); if (committed) renderDevice(); }
}
// ================= user manual (line drawing + control list) =================
const MANUAL = [
  { g:'Screen' },
  { n:1, x:173, y:560, name:'Screen', desc:'Two scrolling lanes: the song that is playing and the next one, with waveform, BPM, key, SYNC and bar position. Colored lines show BLEND (pink), BUILD (green) and EXIT (cyan).', keys:[] },
  { g:'Transition' },
  { n:2, x:345, y:350, name:'BLEND fader', desc:'How the two songs hand over: Fade, Bass Swap, Filter or Cut.', keys:[] },
  { n:3, x:470, y:619, name:'Length keys', desc:'Length of the blend: 4, 8 or 16 bars.', keys:[] },
  { n:4, x:463, y:350, name:'BUILD fader', desc:'Build-up before the handover: None, Loop Roll, Riser or Swoosh.', keys:[] },
  { n:5, x:581, y:350, name:'EXIT fader', desc:'How the old song ends: None, Echo, Reverb, Downsweep or Vinyl Break (Vinyl Break always uses Cut).', keys:[] },
  { n:11, x:394, y:760, name:'MIX key', desc:'Starts the transition at the next bar instead of waiting for the end of the song.', keys:['M'] },
  { g:'Effects' },
  { n:6, x:732, y:290, name:'FX ring', desc:'Turn an effect under the “I” mark to switch it on: Echo, Reverb, Flanger, Gater or Roll. NONE switches it off.', keys:[] },
  { n:7, x:880, y:290, name:'FILTER knob', desc:'Left for low-pass, right for high-pass, double-click to reset. Works together with the FX ring.', keys:[] },
  { n:8, x:1135, y:18, name:'FX amount lever', desc:'Strength of the active effect.', keys:['[', ']'] },
  { g:'Playback' },
  { n:10, x:880, y:705, name:'Play / pause', desc:'Starts the playlist, pauses and resumes.', keys:['Space'] },
  { n:9, x:880, y:585, name:'Jog wheel', desc:'Drag the outer ring to scratch, about 1.8 s per turn. Hold SHIFT while turning to move fast, about 32 bars per turn.', keys:['drag', 'Shift+drag'] },
  { n:14, x:-35, y:204, name:'Volume key', desc:'Top half turns the volume up, bottom half turns it down.', keys:[] },
  { g:'Samples' },
  { n:12, x:1010, y:998, name:'Sample pads', desc:'DRUM, BASS, MELODY and VOCAL one-shots. Pressing a looping pad stops its loop.', keys:['1', '2', '3', '4'] },
  { n:13, x:-35, y:948, name:'SHIFT key', desc:'Tap right after a pad to loop that sample in time with the beat. Hold while turning the jog wheel to move fast.', keys:['Shift'] },
  { n:15, x:1150, y:324, name:'Sample set key', desc:'Switches all four pads to the next of 8 sample sets.', keys:[] }
];
{ let k = 0; MANUAL.forEach(m => { if (!m.g) m.n = ++k; }); }   // number the parts in list order
function buildManualArt(){
  const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const R = (x, y, w, h, r) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
  const C = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
  const txt = (x, y, s, size = 26) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="${size}" font-weight="700" fill="currentColor" stroke="none">${s}</text>`;
  let art = '';
  art += R(28, 22, 1068, 1066, 58);
  art += R(2, 118, 16, 172, 8) + R(2, 908, 16, 80, 8) + R(1098, 262, 16, 124, 8);
  art += `<path d="M1030 22 A74 74 0 0 1 1104 96" stroke-width="22" stroke-linecap="round"/><path d="M1030 22 A74 74 0 0 1 1104 96" stroke-width="16" stroke-linecap="round" stroke="var(--panel)"/>`;
  art += R(45, 43, 256, 1022, 28) + R(57, 54, 232, 1000, 19) + L(173, 90, 173, 1030) + L(70, 400, 276, 400);
  for (const x of [401, 519, 637]){ art += R(x - 7, 133, 14, 435, 7) + C(x, 133, 22); }
  art += txt(372, 90, 'BLEND') + txt(490, 90, 'BUILD') + txt(608, 90, 'EXIT');
  art += R(318, 604, 34, 30, 7) + R(358, 604, 34, 30, 7) + R(398, 604, 34, 30, 7);
  art += txt(880, 88, 'I', 34);
  art += C(880, 290, 191) + C(880, 290, 96) + L(880, 290, 880, 226);
  for (let i = 0; i < 6; i++){ const a = (i * 60 - 90) * Math.PI / 180; art += C(880 + 146 * Math.cos(a), 290 + 146 * Math.sin(a), 7); }
  art += C(880, 705, 186) + C(880, 705, 48) + L(976, 700, 1062, 700);
  art += R(345, 800, 98, 56, 12) + txt(394, 838, 'MIX');
  art += R(527, 940, 440, 117, 18);
  for (let i = 0; i < 4; i++) art += R(538 + i * 107, 951, 95, 95, 11);
  const badges = MANUAL.filter(m => m.n).map(m =>
    `<g class="mbadge" data-n="${m.n}"><circle cx="${m.x}" cy="${m.y}" r="31"/><text x="${m.x}" y="${m.y + 11}" text-anchor="middle" font-size="31" font-weight="800">${m.n}</text></g>`).join('');
  return `<svg viewBox="-80 -30 1260 1130" role="img" aria-label="Line drawing of the DJMAN panel with numbered controls">
    <g fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" font-family="Inter,system-ui,sans-serif">${art}</g>${badges}</svg>`;
}
function renderManual(){
  const host = document.getElementById('manual'); if (!host) return;
  const kb = k => k === 'drag' ? '<span class="kdrag">drag</span>' : k === 'Shift+drag' ? '<kbd>Shift</kbd><span class="kdrag">+ drag</span>' : `<kbd>${k}</kbd>`;
  const row = m => m.g ? `<li class="grp">${m.g}</li>` :
    `<li data-n="${m.n}"><span class="n">${m.n}</span><span><b>${m.name}</b>${m.desc}</span><span class="k">${m.keys.length ? m.keys.map(kb).join('') : '<span class="none">—</span>'}</span></li>`;
  // split the groups into two text columns of roughly equal length
  const groups = []; MANUAL.forEach(m => { if (m.g) groups.push([m]); else groups[groups.length - 1].push(m); });
  const len = g => g.reduce((s, m) => s + (m.desc ? m.desc.length + 60 : 30), 0), total = groups.reduce((s, g) => s + len(g), 0);
  let acc = 0, cut = groups.length;
  for (let i = 0; i < groups.length; i++){ if (acc + len(groups[i]) / 2 > total / 2){ cut = i; break; } acc += len(groups[i]); }
  const head = '<li class="head"><span></span><span>Control</span><span>Keyboard</span></li>';
  const col = gs => `<ol class="manual-list">${head}${gs.flat().map(row).join('')}</ol>`;
  host.innerHTML = `<div class="manual-grid">
    <div class="manual-left"><figure class="manual-art">${buildManualArt()}</figure>
      <p class="manual-note">Fader and FX settings apply to every upcoming transition and take effect right away, even during a transition. Panel controls can also be selected with <kbd>Tab</kbd> and adjusted with the arrow keys. <b>Jump to transition</b> in the Status card (<kbd>J</kbd>) skips to just before the next transition.</p></div>
    ${col(groups.slice(0, cut))}${col(groups.slice(cut))}</div>`;
  const setOn = (n, on) => { const b = host.querySelector(`.mbadge[data-n="${n}"]`); if (b) b.classList.toggle('on', on); };
  host.querySelectorAll('.manual-list li[data-n]').forEach(li => {
    li.addEventListener('mouseenter', () => setOn(li.dataset.n, true));
    li.addEventListener('mouseleave', () => setOn(li.dataset.n, false));
  });
}
// ================= Audius (open music catalog) =================
// Docs: https://docs.audius.co/api — streaming returns the MP3 file, so Audius tracks go
// through the same analysis and mixing engine as local files.
const AUDIUS_API = 'https://api.audius.co/v1';
const AUDIUS_APP = 'DJMAN';
const AUDIUS_API_KEY = '';   // optional: a free key from api.audius.co/plans raises the rate limit
const AUDIUS_GENRES = ['All genres', 'Electronic', 'House', 'Deep House', 'Techno', 'Tech House', 'Drum & Bass', 'Dubstep', 'Trance', 'Hip-Hop/Rap', 'Pop', 'Lo-Fi', 'R&B/Soul'];
function audiusQuery(extra){
  const p = new URLSearchParams({ app_name: AUDIUS_APP, ...extra });
  if (AUDIUS_API_KEY) p.set('api_key', AUDIUS_API_KEY);
  return p.toString();
}
async function audiusGet(path, extra){
  const r = await fetch(`${AUDIUS_API}${path}?${audiusQuery(extra || {})}`);
  if (!r.ok) throw new Error('Audius error ' + r.status);
  const j = await r.json();
  return j.data || [];
}
const audiusPlayable = x => x && x.id && x.is_streamable !== false && !x.stream_conditions && !x.is_stream_gated && x.is_available !== false;
async function fetchAudiusBytes(id){
  const r = await fetch(`${AUDIUS_API}/tracks/${encodeURIComponent(id)}/stream?${audiusQuery({})}`);
  if (!r.ok) throw new Error(r.status === 404 ? 'This track has no audio' : 'Audius error ' + r.status);
  return await r.arrayBuffer();
}
let audiusResults = [];
function renderAudius(msg){
  const box = document.getElementById('audiusResults'); if (!box) return;
  if (msg){ box.innerHTML = `<p class="au-msg">${esc(msg)}</p>`; return; }
  if (!audiusResults.length){ box.innerHTML = ''; return; }
  const inList = new Set(tracks.filter(t => t.src && t.src.type === 'audius').map(t => t.src.id));
  box.innerHTML = '<ul class="au-list">' + audiusResults.map((x, i) => {
    const art = x.artwork && (x.artwork['150x150'] || x.artwork['480x480']);
    const link = x.permalink ? `https://audius.co${x.permalink}` : '';
    const added = inList.has(x.id);
    return `<li>
      ${art ? `<img src="${esc(art)}" alt="" loading="lazy">` : '<span class="au-noart"></span>'}
      <div class="au-meta"><a class="au-title" ${link ? `href="${esc(link)}" target="_blank" rel="noopener"` : ''}>${esc(x.title || 'Untitled')}</a>
        <span>${esc((x.user && x.user.name) || 'Unknown artist')}${x.duration ? '  ' + mmss(x.duration) : ''}${x.genre ? '  ' + esc(x.genre) : ''}</span></div>
      <button class="hbtn au-add" data-au="${i}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button></li>`;
  }).join('') + '</ul><p class="au-credit">Music from <a href="https://audius.co" target="_blank" rel="noopener">Audius</a>. Titles link to the artist\'s page.</p>';
}
async function audiusLoad(kind){
  const q = ($('#audiusQ').value || '').trim(), genre = $('#audiusGenre').value;
  if (kind === 'search' && !q){ renderAudius('Type an artist or song name to search.'); return; }
  renderAudius(kind === 'search' ? 'Searching Audius…' : 'Loading trending tracks…');
  try {
    const params = kind === 'search' ? { query: q } : { time: 'week', ...(genre && genre !== 'All genres' ? { genre } : {}) };
    const data = await audiusGet(kind === 'search' ? '/tracks/search' : '/tracks/trending', params);
    audiusResults = data.filter(audiusPlayable).slice(0, 20);
    if (!audiusResults.length) renderAudius('No playable tracks found.');
    else renderAudius();
  } catch(e){
    renderAudius("Couldn't reach Audius. Check the internet connection and try again.");
  }
}
function addAudiusTrack(x){
  if (tracks.some(t => t.src && t.src.type === 'audius' && t.src.id === x.id)){ showToast('Already in the playlist'); return; }
  getCtx();
  const t = { id: uid++, src: { type:'audius', id: x.id }, name: `${(x.user && x.user.name) || 'Unknown'} – ${x.title || 'Untitled'}`, status: 'analyzing' };
  tracks.push(t); queueAnalysis(t);
  analyzing = analyzing.then(() => autoSort([t]));
  renderList(); renderAudius();
}
(() => {
  const g = document.getElementById('audiusGenre');
  if (g) g.innerHTML = AUDIUS_GENRES.map(x => `<option>${x}</option>`).join('');
  const s = document.getElementById('audiusSearch'), tr = document.getElementById('audiusTrending'), q = document.getElementById('audiusQ'), box = document.getElementById('audiusResults');
  if (s) s.onclick = () => audiusLoad('search');
  if (tr) tr.onclick = () => audiusLoad('trending');
  if (q) q.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); audiusLoad('search'); } });
  if (box) box.addEventListener('click', e => { const b = e.target.closest('[data-au]'); if (b && !b.disabled) addAudiusTrack(audiusResults[+b.dataset.au]); });
})();
renderManual();
renderList(); requestAnimationFrame(frame);

return () => {
  alive = false;
  clearInterval(tickId);
  docListeners.forEach(([type, fn]) => document.removeEventListener(type, fn));
  try { hardStop(); } catch (e) {}
  if (ctx) ctx.close();
};
}

// Keeps a single running instance. React StrictMode (used by some templates) mounts,
// unmounts and re-mounts effects in development; the short delay lets the second mount
// reuse the running engine instead of starting it twice.
let instance = null;
let pendingTeardown = null;
export function initDjman() {
  if (pendingTeardown) { clearTimeout(pendingTeardown); pendingTeardown = null; }
  if (!instance) instance = startDjman();
  return () => {
    pendingTeardown = setTimeout(() => {
      pendingTeardown = null;
      if (instance) { instance(); instance = null; }
    }, 0);
  };
}
