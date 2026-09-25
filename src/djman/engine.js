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
  return { bpm:best, downbeat, firstSound, lastSound, inPoint, duration:buf.duration, fps, amp, shL, shH };
}
async function decodeFile(file){
  const ab = await file.arrayBuffer();
  return await new Promise((res, rej) => { const pr = getCtx().decodeAudioData(ab, res, rej); if (pr && pr.then) pr.then(res, rej); });
}
let analyzing = Promise.resolve();
function queueAnalysis(t){
  analyzing = analyzing.then(async () => {
    try {
      const buf = await decodeFile(t.file);
      await new Promise(r => setTimeout(r, 0));
      Object.assign(t, analyze(buf), { status:'ready' });
      const i = tracks.indexOf(t), ci = curIndex();
      if (i >= 0 && (i === ci + 1 || (ci < 0 && i === 0))) bufCache.set(t.id, { promise:Promise.resolve(buf), buffer:buf });
    } catch(e){ t.status = 'error'; }
    renderList();
  });
}
function ensureBuffer(t){
  if (!t || t.status !== 'ready') return null;
  let e = bufCache.get(t.id);
  if (!e){
    e = { promise:null, buffer:null };
    e.promise = decodeFile(t.file).then(b => { e.buffer = b; return b; }).catch(() => { bufCache.delete(t.id); return null; });
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
  if (k === 'bars' && t.s.blend === 'cut'){ showToast('Cut 没有长度'); return; }
  if (k === 'blend' && t.s.exit === 'vinyl' && v !== 'cut'){ showToast('Vinyl Break 固定为 Cut'); renderDevice(); return; }
  const names = { blend:'BLEND ' + BLENDS[v], build:'BUILD ' + BUILDS[v], exit:'EXIT ' + EXITS[v], bars:'BLEND ' + v + ' 小节' };
  globalSet = applyEdit(globalSet, k, v);
  if (t.live){ const msg = liveEdit(globalSet); showToast(msg ? names[k] + '：' + msg : names[k]); renderList(); return; }
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
  if (scr && now - scr.lastMove > 0.05) scr.target = 0;
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
  if (now >= c.Te - 0.02) return { s: old, msg: '过渡已进入尾声，改动留到下次' };
  const s = { ...old, ...want }; let msg = '';
  const blendDone = old.blend === 'cut' ? now >= p.Tc - 0.02 : now >= p.T1 - 0.02;
  if (s.build !== old.build && now >= p.T0 - 0.05){ s.build = old.build; msg = 'BUILD 已经结束'; }
  if ((s.blend !== old.blend || (s.bars !== old.bars && s.blend !== 'cut')) && blendDone){ s.blend = old.blend; s.bars = old.bars; msg = 'BLEND 已经结束'; }
  if (s.exit === 'vinyl' && s.blend !== 'cut'){ s.exit = old.exit; msg = msg || '现在不能换成 Vinyl Break'; }
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
  return res.msg ? res.msg + '，下一次过渡生效' : '';
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
  if (!cur){ const i = tracks.findIndex(t => t.status === 'ready'); if (i >= 0) await startFrom(i); else showToast('先添加本地音乐'); return; }
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
  if (!cur || committed || !playing){ showToast(committed ? '过渡进行中' : '先开始播放'); return; }
  const ci = curIndex(); if (!tracks[ci + 1]){ showToast('这是最后一首'); return; }
  const s = resolve(ci), t = cur.track, barBuf = 4 * 60 / t.bpm;
  forced = { P0: nextBarAfter(t, cur.posAt(ctx.currentTime) + BUILD_BARS[s.build] * barBuf + 0.7) };
  showToast('下一个小节开始过渡');
}
function jumpToTransition(){
  if (!cur || committed) return;
  const p = planNext(); if (!p) return;
  seekTo(p.P0 - p.buildBars * p.barBuf - 10);
}

// ================= jog: move forward / back =================
function startNav(){
  if (!cur || !ctx || committed) return false;
  if (fx.active === 'roll'){ fxOff('roll'); fx.active = null; renderDevice(); }
  const now = ctx.currentTime, d = cur, live = playing && ctx.state === 'running';
  scr = { deck:d, pos: d.posAt(now), vel: live ? d.rateAt(now) : 0, target: 0, lastMove: now, live, sp:null };
  if (live){
    const buf = d.buf, sp = ctx.createScriptProcessor(512, 1, 2);
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const sr = buf.sampleRate, alpha = 1 - Math.exp(-1 / (0.015 * ctx.sampleRate)), dur = buf.duration;
    sp.onaudioprocess = e => {
      const oL = e.outputBuffer.getChannelData(0), oR = e.outputBuffer.getChannelData(1);
      const s = scr; if (!s || s.sp !== sp){ oL.fill(0); oR.fill(0); return; }
      for (let i = 0; i < oL.length; i++){
        s.vel += (s.target - s.vel) * alpha;
        s.pos += s.vel / ctx.sampleRate;
        if (s.pos < 0) s.pos = 0; if (s.pos > dur - 0.01) s.pos = dur - 0.01;
        const g = Math.min(1, 2.5 / Math.max(1, Math.abs(s.vel)));
        const x = s.pos * sr, j = Math.floor(x), f = x - j;
        oL[i] = (L[j] * (1 - f) + L[j + 1] * f) * g; oR[i] = (R[j] * (1 - f) + R[j + 1] * f) * g;
      }
    };
    sp.connect(d.eqL); scr.sp = sp;
    try { d.src.stop(now + 0.01); } catch(e){}
  }
  return true;
}
function navMove(deltaSec, dt){
  if (!scr) return;
  if (scr.live){ scr.target = Math.max(-16, Math.min(16, deltaSec / dt)); scr.lastMove = ctx.currentTime; }
  else scr.pos = Math.max(0, Math.min(scr.deck.track.duration - 0.5, scr.pos + deltaSec));
}
function endNav(){
  if (!scr) return;
  const { deck, sp, pos } = scr; scr = null;
  if (deck === cur) deck.reposition(ctx.currentTime + 0.02, Math.max(0, Math.min(pos, deck.track.duration - 0.5)));
  forced = null;
  if (sp) setTimeout(() => { try { sp.disconnect(); } catch(e){} }, 80);
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
    if (next === 'roll' && (committed || !cur)) showToast(committed ? '过渡进行中，Roll 暂不可用' : 'Roll 需要先开始播放');
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
function setAmt(v){ fx.amt = Math.max(0, Math.min(1, v)); if (ctx && fx.active) fxOn(fx.active, false); showToast('FX 强度 ' + Math.round(fx.amt * 100) + '%'); renderDevice(); }
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
  if (ctx.state !== 'running'){
    if (cur){ showToast('播放时才能触发采样'); return; }
    ctx.resume();
  }
  const name = sampleName(cat);
  try { SYN[name](ctx.currentTime + 0.01, M.sampleBus); } catch(e){ console.warn(e); }
  const pad = dev.querySelector(`.pad[data-pad="${cat}"] .pad-bg`);
  if (pad){ pad.setAttribute('fill', '#9A9A9A'); setTimeout(() => pad.setAttribute('fill', '#7C7C7C'), 120); }
}
function nextSampleSet(){ sampleSet = (sampleSet + 1) % NSETS; renderDevice(); showToast('采样组 ' + (sampleSet + 1) + ' / ' + NSETS); }

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
  const bars = [4, 8, 16].map((n, i) => `<g class="hit bar-key" data-bars="${n}" tabindex="0" role="button" aria-label="交接长度 ${n} 小节">
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
      <text x="${x + 47.5}" y="982" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="12" fill="#D8CFBD" letter-spacing=".06em">${label}</text>
      <text class="pad-name" x="${x + 47.5}" y="1016" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="16" fill="${CREAM}"></text>
      <rect class="focus-ring" x="${x - 4}" y="947" width="103" height="103" rx="14"/></g>`;
  }).join('');
  return `
  <defs><filter id="knobShadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-opacity=".25"/></filter></defs>
  <g id="volTab" class="hit" tabindex="0" role="button" aria-label="音量侧键，点上半部分加，下半部分减">
    <rect x="2" y="118" width="16" height="172" rx="8" fill="${BODY}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="focus-ring" x="-3" y="113" width="26" height="182" rx="12"/></g>
  <rect x="2" y="908" width="16" height="80" rx="8" fill="${BODY}" stroke="${INK}" stroke-width="2.5"/>
  <g id="setBtn" class="hit" tabindex="0" role="button" aria-label="切换到下一组采样">
    <rect id="setFace" x="1098" y="262" width="16" height="124" rx="8" fill="${RED}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="focus-ring" x="1093" y="257" width="26" height="134" rx="12"/></g>
  <rect x="28" y="22" width="1068" height="1066" rx="58" fill="${BODY}" stroke="${INK}" stroke-width="3"/>
  <g id="lever" class="drag" tabindex="0" role="slider" aria-label="FX 强度拨杆" aria-valuemin="0" aria-valuemax="100">
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
  <g id="fxRing" tabindex="0" role="slider" aria-label="效果转环" aria-valuemin="0" aria-valuemax="5">
    <circle cx="${RC.x}" cy="${RC.y}" r="191" fill="${GREY}" stroke="${INK}" stroke-width="3" class="drag"/>
    <circle class="focus-ring" cx="${RC.x}" cy="${RC.y}" r="197"/>
    <g id="ringRot">${ring}</g>
  </g>
  <g id="filterKnob" tabindex="0" role="slider" aria-label="FILTER 旋钮，向左低通，向右高通，双击回中" aria-valuemin="-100" aria-valuemax="100" class="drag">
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

  <g id="jog" class="drag" aria-label="转盘，拖动外圈前进或后退">
    <circle cx="${JC.x}" cy="${JC.y}" r="186" fill="${JOG}" stroke="${INK}" stroke-width="3"/>
    <g id="jogRot"><line x1="${JC.x}" y1="${JC.y - 172}" x2="${JC.x}" y2="${JC.y - 150}" stroke="#CDBF9F" stroke-width="5" stroke-linecap="round"/></g>
  </g>
  <line x1="976" y1="700" x2="1062" y2="700" stroke="#111" stroke-width="6" stroke-linecap="round" pointer-events="none"/>
  <g id="playBtn" class="hit" tabindex="0" role="button" aria-label="播放 / 暂停">
    <circle id="playFace" cx="${JC.x}" cy="${JC.y}" r="48" fill="${RED}" stroke="${INK}" stroke-width="3"/>
    <circle class="focus-ring" cx="${JC.x}" cy="${JC.y}" r="54"/></g>

  <g id="mixBtn" class="hit" tabindex="0" role="button" aria-label="立即过渡">
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
    g.setAttribute('aria-label', PADS.find(p => p[0] === g.dataset.pad)[1] + ' ' + name);
  });
  Q('#setText').textContent = `SET ${sampleSet + 1} / ${NSETS}`;
  const isPlaying = playing && ctx && ctx.state === 'running';
  Q('#playFace').setAttribute('fill', isPlaying ? '#D24A43' : RED);
  Q('#playBtn').setAttribute('aria-label', isPlaying ? '暂停' : '播放');
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
  g.addEventListener('dblclick', () => { setF(0); showToast('FILTER 回中'); });
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
    if (!startNav()){ showToast(committed ? '过渡进行中，转盘暂不可用' : '先开始播放'); return; }
    drag = { a: ang(svgPt(e)), t: performance.now() }; g.setPointerCapture(e.pointerId);
  });
  g.addEventListener('pointermove', e => {
    if (!drag || !scr) return;
    const a = ang(svgPt(e)), now = performance.now();
    let d = a - drag.a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    const secPerRev = 16 * 60 / scr.deck.track.bpm;
    navMove(d / (2 * Math.PI) * secPerRev, Math.max(0.004, (now - drag.t) / 1000));
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
const volStep = d => { fx.vol = Math.max(0, Math.min(1, fx.vol + d)); if (ctx) M.vol.gain.setTargetAtTime(fx.vol * fx.vol * 1.2, ctx.currentTime, 0.02); showToast('音量 ' + Math.round(fx.vol * 100) + '%'); };
Q('#volTab').addEventListener('click', e => volStep(svgPt(e).y < 204 ? 0.1 : -0.1));
Q('#volTab').addEventListener('keydown', e => { if (e.key === 'ArrowUp'){ e.preventDefault(); volStep(0.1); } if (e.key === 'ArrowDown'){ e.preventDefault(); volStep(-0.1); } });
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
      sub: scr ? (scr.live ? '转盘移动中' : '定位中') : (playing ? '正在播放' : '已暂停'), cues, endPos, lines: L && !scr ? L.out : [], bw: L && L.bw };
  }
  if (committed){
    const d = committed.inc;
    return { t: d.track, pos: d.posAt(now), gridBpm: d.gridBpm, bpm: d.track.bpm * d.rateAt(now), sync: d.synced, sub: now < committed.plan.T0 ? '等待切入' : '切入中', cues: [committed.plan.inPos], lines: L.inc, bw: L.bw };
  }
  if (!plan){ const nt = tracks[curIndex() + 1]; return nt ? { t: nt, pos: null, sub: nt.status === 'ready' ? '下一首' : '分析中' } : null; }
  const ratio = plan.sync.ok ? plan.sync.ratio : 1;
  return { t: plan.nt, pos: plan.inPos - (plan.T0 - now) * ratio, gridBpm: plan.sync.ok ? plan.sync.cand : plan.nt.bpm, bpm: plan.nt.bpm * ratio, sync: plan.sync.ok, sub: '下一首', cues: [plan.inPos], lines: scr ? [] : L.inc, bw: L.bw };
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
  const head = L || (gh ? { t: gh.deck.track, sub: '已结束', ghostHead: true } : null);
  if (!head){ cx.fillStyle = '#3c4453'; cx.font = '500 11px Inter,"Noto Sans SC",sans-serif'; cx.fillText('—', x0, 32); cx.fillStyle = '#5FD3A6'; cx.fillRect(x0 - 2, PLAYY - 1, w + 4, 2); return; }
  const t = head.t;
  cx.fillStyle = head.ghostHead ? '#7d8796' : '#fff'; cx.font = '700 14px Inter,"Noto Sans SC",sans-serif'; cx.fillText(fitText(t.name, w - 2), x0, 30);
  cx.fillStyle = '#b8c4d3'; cx.font = '400 10px Inter,"Noto Sans SC",sans-serif'; cx.fillText(head.sub || '', x0, 45);
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
    const lines = ended ? ['歌单播放完了'] : tracks.length ? ['按红色按钮', '开始播放'] : ['添加本地音乐', '开始试听'];
    lines.forEach((l, i) => cx.fillText(l, SW / 2, 470 + i * 18));
    cx.textAlign = 'left';
  } else {
    const now = ctx.currentTime;
    const gh = s => (ghost && ghost.slot === s) ? ghost : null;
    drawLane(cur ? laneData(0) : null, 12, now, gh(0)); drawLane(cur ? laneData(1) : null, 122, now, gh(1));
  }
  if (toast && performance.now() < toast.until){
    cx.font = '600 12px Inter,"Noto Sans SC",sans-serif'; const tw = cx.measureText(toast.text).width + 20;
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
  if (committed && committed.out.track === a && committed.inc.track === b) return '<div class="gapinfo"><b>过渡进行中</b></div>';
  if (!(a && b && a.bpm && b.bpm)) return '<div class="gapinfo">等待分析</div>';
  const m = tempoMatch(a.bpm, b.bpm), pct = (m.ratio - 1) * 100;
  return m.ok ? `<div class="gapinfo">速度差 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%，会变速对拍</div>`
    : `<div class="gapinfo warn">速度相差 ${Math.abs(pct).toFixed(0)}%，无法对拍${resolveSet(globalSet).blend !== 'cut' ? '，长交接会乱拍，这里更适合 Cut' : ''}</div>`;
}
function renderCurSet(){
  const r = resolveSet(globalSet);
  const row = (c, l, v) => `<div><i style="background:var(--c-${c})"></i><span>${l}</span><strong>${v}</strong></div>`;
  $('#curSet').innerHTML = row('blend', 'BLEND', BLENDS[r.blend] + (r.blend === 'cut' ? '' : '，' + r.bars + ' 小节'))
    + row('build', 'BUILD', BUILDS[r.build]) + row('exit', 'EXIT', EXITS[r.exit])
    + (globalSet.exit === 'vinyl' && globalSet.blend !== 'cut' ? `<span class="note">Vinyl Break 时 BLEND 暂时固定为 Cut，换掉 Vinyl Break 后恢复 ${BLENDS[globalSet.blend]}。</span>` : '')
    + '<span class="note">由面板推子控制，之后的过渡都按这组设定进行。</span>';
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
      ? `<span class="bpm">${t.bpm.toFixed(t.bpm % 1 ? 1 : 0)} BPM <button class="mini" data-bpm="0.5" data-i="${i}" aria-label="BPM 减半">÷2</button><button class="mini" data-bpm="2" data-i="${i}" aria-label="BPM 加倍">×2</button></span>`
      : t.status === 'error' ? '<span class="sub">无法解码这个文件</span>' : '<span class="sub">分析中…</span>';
    h += `<li class="row ${i === ci ? 'current' : ''}"><span class="idx">${i + 1}</span>
      <div style="min-width:0"><div class="name">${esc(t.name)}</div><div class="sub">${t.duration ? mmss(t.duration) : ''}</div></div>${st}
      <div class="acts">
        <button class="icon" data-act="play" data-i="${i}" aria-label="从这首开始播放" ${t.status !== 'ready' ? 'disabled' : ''}>${ICO.play}</button>
        <button class="icon" data-act="up" data-i="${i}" aria-label="上移" ${i === 0 ? 'disabled' : ''}>${ICO.up}</button>
        <button class="icon" data-act="down" data-i="${i}" aria-label="下移" ${i === tracks.length - 1 ? 'disabled' : ''}>${ICO.down}</button>
        <button class="icon" data-act="del" data-i="${i}" aria-label="移除" ${busy.has(t) ? 'disabled' : ''}>${ICO.del}</button>
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
  else if (act === 'up' && i > 0){ [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; afterReorder(); }
  else if (act === 'down' && i < tracks.length - 1){ [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; afterReorder(); }
  else if (act === 'del'){ const [t] = tracks.splice(i, 1); bufCache.delete(t.id); afterReorder(); }
});
function afterReorder(){ forced = null; if (ctx){ pruneCache(); const n = tracks[curIndex() + 1]; if (n && cur) ensureBuffer(n); } renderList(); }
function addFiles(list){
  const files = [...list].filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|aiff?|opus)$/i.test(f.name));
  if (!files.length) return;
  getCtx();
  files.forEach(f => { const t = { id: uid++, file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'analyzing' }; tracks.push(t); queueAnalysis(t); });
  renderList();
}
$('#addBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('#jumpBtn').onclick = () => jumpToTransition();
['#drop', '#tracks'].forEach(sel => {
  const el = $(sel);
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); addFiles(e.dataTransfer.files); });
});
onDoc('dragover', e => e.preventDefault());
onDoc('drop', e => { e.preventDefault(); if (!e.target.closest('#drop,#tracks')) addFiles(e.dataTransfer.files); });
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
  if (!cur || !ctx){ el.innerHTML = ended ? '歌单播放完了。' : tracks.length ? '按转盘中间的红色按钮开始播放。' : '添加音乐后按转盘中间的红色按钮开始。'; return; }
  const now = ctx.currentTime, ci = curIndex();
  let st = '', sub = '';
  if (committed){
    const p = committed.plan;
    if (now < p.Tb) st = `过渡即将开始，${mmss(p.Tb - now)} 后`;
    else if (now < p.T0) st = `BUILD：${BUILDS[p.s.build]}`;
    else if (p.s.blend === 'cut' && now < p.Tc) st = 'BLEND：Cut，下一拍切换';
    else if (now < p.T1){ const bar = Math.min(p.blendBars, Math.floor((now - p.T0) / p.barWall) + 1); st = `BLEND：${BLENDS[p.s.blend]}，第 ${bar} / ${p.blendBars} 小节`; }
    else st = `EXIT：${EXITS[p.s.exit]}`;
    sub = `正在切入 ${committed.inc.track.name}`;
  } else {
    const plan = planNext();
    if (plan){
      const s = plan.s;
      st = `下一次过渡 ${mmss(plan.Tb - now)} 后开始`;
      sub = `BLEND ${BLENDS[s.blend]}${s.blend === 'cut' ? '' : ' ' + plan.blendBars + ' 小节'}，BUILD ${BUILDS[s.build]}，EXIT ${EXITS[s.exit]}。${plan.sync.ok ? '会变速对拍。' : '速度差距大，不对拍。'}`;
    } else if (tracks[ci + 1]) st = '下一首还在分析，完成后会自动安排过渡。';
    else st = '这是歌单最后一首。';
  }
  if (!playing) st = '已暂停。' + st;
  el.innerHTML = esc(st) + (sub ? `<span class="sub">${esc(sub)}</span>` : '');
}
let lastStatus = 0, lastRing = null;
function frame(ts){
  if (!alive) return;
  requestAnimationFrame(frame);
  if (!ringDragging){ ringShown += (ringTarget - ringShown) * 0.25; if (Math.abs(ringTarget - ringShown) < 0.05) ringShown = ringTarget; }
  if (ringShown !== lastRing){
    lastRing = ringShown;
    Q('#ringRot').setAttribute('transform', `rotate(${ringShown} ${RC.x} ${RC.y})`);
    dev.querySelectorAll('.fx-item').forEach(g => g.querySelector('text').setAttribute('transform', `rotate(${-ringShown} ${g.dataset.x} ${g.dataset.y})`));
  }
  if (cur && ctx){
    const pos = scr ? scr.pos : cur.posAt(ctx.currentTime);
    const secPerRev = 16 * 60 / cur.track.bpm;
    Q('#jogRot').setAttribute('transform', `rotate(${(pos / secPerRev * 360) % 360} ${JC.x} ${JC.y})`);
  }
  drawScreen();
  if (ts - lastStatus > 200){ lastStatus = ts; updateStatus(); if (committed) renderDevice(); }
}
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
