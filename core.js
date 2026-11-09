/* Fretline core: tab parsing, pitch detection, grading, exercise generation.
   Pure logic, no DOM. Works in the browser (window.TabCore) and in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TabCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const STANDARD = [64, 59, 55, 50, 45, 40]; // string 0 = high e ... string 5 = low E
  const BASS = [43, 38, 33, 28];     // G D A E
  const BASS5 = [43, 38, 33, 28, 23]; // G D A E B

  /* Per-instrument settings. minF/maxF bound the pitch search; fft is the analyser buffer size;
     pitchDelay/decide (seconds after an onset) say when to start reading pitch and when to commit.
     Bass notes need a longer window: one period of low E (41 Hz) is about 24 ms. */
  const INSTRUMENTS = {
    // rmsWin: samples used to measure loudness for onsets; it must cover a full cycle of the lowest note (E1 is 24 ms)
    guitar: { id: 'guitar', name: 'Guitar', tuning: STANDARD, minF: 70, maxF: 1200, fft: 2048, pitchDelay: 0.035, decide: 0.1, rmsWin: 512 },
    bass: { id: 'bass', name: 'Bass', tuning: BASS, minF: 29, maxF: 600, fft: 4096, pitchDelay: 0.06, decide: 0.16, rmsWin: 2048 },
  };
  const instrumentOf = (score) => (score && score.strings <= 5 ? 'bass' : 'guitar');
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  const pcName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12];
  const midiName = (m) => pcName(m) + (Math.floor(Math.round(m) / 12) - 1);
  const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function labelPc(label) {
    let pc = LETTER_PC[label[0].toUpperCase()];
    if (pc === undefined) return null;
    if (label[1] === '#') pc++;
    else if (label[1] === 'b') pc--;
    return (pc + 12) % 12;
  }

  function openFromLabel(label, std) {
    const pc = labelPc(label);
    if (pc == null) return std;
    let best = std, bd = 99;
    for (let d = -6; d <= 6; d++) {
      if ((((std + d) % 12) + 12) % 12 === pc && Math.abs(d) < bd) { best = std + d; bd = Math.abs(d); }
    }
    return best;
  }

  /* ---------- ASCII tab parsing ---------- */

  const LINE_RE = /^\s*([A-Ga-g][#b]?)?\s*[|:]?([-\dhpbrt\/\\~xX()^.*<>=|\s:]*)$/;

  function splitTabLine(line) {
    const m = LINE_RE.exec(line);
    if (!m) return null;
    const body = m[2];
    if ((body.match(/-/g) || []).length < 2 || body.trim().length < 4) return null;
    return { label: m[1] || '', body, start: line.length - body.length };
  }

  /* ---------- Techniques on single notes ----------
     A note can carry: legato 'h' | 'p' | 'slide' (reached from the note before on the same string, without picking),
     slideTo (slides into the next note), bend (semitones up, release: comes back down), dead (muted "x", no pitch),
     pm (palm mute), vib (vibrato), harm (natural harmonic, sounds at `sound`),
     ghost (a quiet, half-muted note, written "(5)"), slap 'T' (thumb) | 'P' (pop) for slap bass. */
  const HARMONIC_UP = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31 };
  const harmonicSound = (open, f) => open + (HARMONIC_UP[f] != null ? HARMONIC_UP[f] : 12);
  /* The pitch the player should end up sounding (bent peak, harmonic), or null for a muted note. */
  const soundOf = (n) => (n.dead ? null : n.sound != null ? n.sound : n.bend ? n.midi + n.bend : n.midi);
  const bendLabel = (b) => ({ 1: '½', 2: 'full', 3: '1½', 4: '2' }[b] || b / 2 + '');

  /* A slap-bass line under (or over) the tab: only T / S (thumb) and P (pop) letters, lined up with the notes. */
  const isSlapLine = (line) => !!line && /^[\sTSPtsp.\-|]*$/.test(line) && /[TSPtsp]/.test(line);
  function slapMarks(line, start) {
    if (!isSlapLine(line)) return [];
    const out = [];
    for (let i = 0; i < line.length; i++) if (/[TSPtsp]/.test(line[i])) out.push([i - start, line[i].toUpperCase() === 'P' ? 'P' : 'T']);
    return out;
  }

  /* Reads one string of an ASCII tab block into notes with their column. */
  function tokenizeString(body, s, open, isBar) {
    const out = [];
    let prev = null, pending = null, gap = 0, i = 0;
    const num = (j) => { let k = j; while (k < body.length && k - j < 2 && body[k] >= '0' && body[k] <= '9') k++; return k > j ? [parseInt(body.slice(j, k), 10), k] : null; };
    while (i < body.length) {
      const ch = body[i];
      if (isBar[i]) { i++; continue; }
      let n0 = num(i), ghost = false;
      if (!n0 && ch === '(') { const gn = num(i + 1); if (gn && body[gn[1]] === ')') { n0 = [gn[0], gn[1] + 1]; ghost = true; } } // (5) = ghost note
      if (n0) {
        const [f, end] = n0, col = i;
        const note = { s, f, midi: open + f, tech: '' };
        if (ghost) note.ghost = true;
        i = end;
        if (pending && prev && gap <= 2) {
          note.legato = pending;
          prev.tech = pending === 'slide' ? '/' : pending;
          if (pending === 'slide') prev.slideTo = true;
        } else if (pending === 'slide') note.slideIn = true;
        pending = null; gap = 0;
        // bend: 7b9, 7b(9), 7b9r7; a bare "b" means a full bend
        if (body[i] === 'b' || body[i] === 'B') {
          let j = i + 1; if (body[j] === '(') j++;
          const t = num(j);
          if (t) { note.bend = Math.max(1, t[0] - f); i = t[1]; if (body[i] === ')') i++; } else { note.bend = 2; i = j; }
          if (body[i] === 'r' || body[i] === 'R') { const r = num(i + 1); note.release = true; i = r ? r[1] : i + 1; }
        }
        while (body[i] === '~') { note.vib = true; i++; }
        out.push({ col, note });
        prev = note;
        continue;
      }
      if (ch === 'x' || ch === 'X') { out.push({ col: i, note: { s, f: null, midi: null, dead: true, tech: '' } }); prev = null; pending = null; i++; continue; }
      if (ch === '<') {
        const h = num(i + 1);
        if (h && body[h[1]] === '>') {
          out.push({ col: i, note: { s, f: h[0], midi: open + h[0], harm: true, sound: harmonicSound(open, h[0]), tech: '' } });
          prev = null; pending = null; i = h[1] + 1; continue;
        }
      }
      if (ch === 'h' || ch === 'H') pending = 'h';
      else if (ch === 'p' || ch === 'P') pending = 'p';
      else if (ch === '/' || ch === '\\' || ch === 's') pending = 'slide';
      else if (ch === '-' && pending && ++gap > 2) pending = null;
      i++;
    }
    return out;
  }

  function parseAsciiTab(text, opts) {
    opts = opts || {};
    const dpb = opts.dashesPerBeat || 2;
    const bpb = opts.beatsPerBar || 4;
    const blocks = [];
    let cur = [], above = '', lastText = '', lastWasBelow = false;
    for (const ln of String(text).split(/\r?\n/)) {
      const t = splitTabLine(ln);
      // a T/P line right under a block belongs to that block, not to the one after it
      if (t) { if (!cur.length) above = lastWasBelow && isSlapLine(lastText) ? '' : lastText; cur.push(t); }
      else {
        if (cur.length) { cur.above = above; cur.below = ln; blocks.push(cur); lastWasBelow = true; } else lastWasBelow = false;
        cur = []; lastText = ln;
      }
    }
    if (cur.length) { cur.above = above; cur.below = ''; blocks.push(cur); }

    const groups = [];
    for (const b of blocks) {
      if (b.length >= 6) { for (let i = 0; i + 6 <= b.length; i += 6) { const g = b.slice(i, i + 6); if (i === 0) g.above = b.above; if (i + 12 > b.length) g.below = b.below; groups.push(g); } }
      else if (b.length === 4 || b.length === 5) { const g = b.slice(); g.above = b.above; g.below = b.below; groups.push(g); }
    }
    if (!groups.length) return null;
    const nStr = groups[0].length;
    const use = groups.filter((g) => g.length === nStr);

    const firstLabels = use[0].map((l) => l.label);
    const reversed = nStr === 6 && firstLabels[0] === 'E' && firstLabels[5] === 'e';
    const std = nStr === 4 ? BASS : nStr === 5 ? BASS5 : STANDARD;
    const labels = reversed ? firstLabels.slice().reverse() : firstLabels;
    const tuning = std.map((s, i) => (labels[i] ? openFromLabel(labels[i], s) : s));

    const evMap = new Map();
    const barSet = new Set([0]);
    let offset = 0;

    for (const g of use) {
      // palm-mute spans from a "PM-----" / "P.M. - - -" line just above the block, lined up by column
      const pmSpans = [];
      if (g.above && /P\.?\s?M/i.test(g.above)) {
        const re = /P\.?\s?M\.?[-.|\s]*/gi; let m;
        while ((m = re.exec(g.above))) { const body = m[0].replace(/\s+$/, ''); pmSpans.push([m.index - g[0].start, m.index - g[0].start + Math.max(body.length, 2)]); }
      }
      const rows = reversed ? g.slice().reverse() : g;
      const len = Math.max.apply(null, rows.map((r) => r.body.length));
      const bodies = rows.map((r) => r.body.padEnd(len, '-'));
      const isBar = [];
      const xAt = [];
      let x = 0;
      for (let c = 0; c < len; c++) {
        let bars = 0, other = 0;
        for (const b of bodies) {
          const ch = b[c];
          if (ch === '|' || ch === ':') bars++;
          else if (ch !== '-' && ch !== ' ') other++;
        }
        isBar[c] = bars >= Math.ceil(nStr / 2) && other === 0;
        xAt[c] = x;
        if (!isBar[c]) x++;
      }
      for (let c = 0; c < len; c++) if (isBar[c]) barSet.add(Math.round((offset + xAt[c] / dpb) * 1000) / 1000);

      const placed = [];
      bodies.forEach((body, s) => {
        for (const { col, note } of tokenizeString(body, s, tuning[s], isBar)) {
          if (pmSpans.some(([a, b]) => col >= a && col < b)) note.pm = true;
          placed.push({ col, note });
          const beat = offset + xAt[col] / dpb;
          const key = Math.round(beat * 1000);
          if (!evMap.has(key)) evMap.set(key, { beat, dur: 1, notes: [] });
          const ev = evMap.get(key);
          if (!ev.notes.some((n) => n.s === s)) ev.notes.push(note);
        }
      });
      // slap-bass letters (T / S thumb, P pop) on a line under or over the block: mark the nearest note (±1 column)
      for (const [c, kind] of slapMarks(g.below, g[0].start).concat(slapMarks(g.above, g[0].start))) {
        let best = 2;
        placed.forEach((p) => { if (!p.note.dead) best = Math.min(best, Math.abs(p.col - c)); });
        if (best <= 1) placed.forEach((p) => { if (!p.note.dead && Math.abs(p.col - c) === best) p.note.slap = kind; });
      }
      offset += x / dpb;
    }

    const events = Array.from(evMap.values()).sort((a, b) => a.beat - b.beat);
    if (!events.length) return null;
    events.forEach((e, i) => {
      const next = events[i + 1];
      // the last note lasts until the tab ends (not past it, which would add an empty bar)
      e.dur = next ? Math.min(4, Math.max(0.25, next.beat - e.beat)) : offset > e.beat ? Math.min(1, Math.max(0.25, offset - e.beat)) : 1;
      e.notes.sort((a, b) => a.s - b.s);
    });
    const last = events[events.length - 1];
    const totalBeats = Math.max(offset, last.beat + last.dur);
    let bars = Array.from(barSet).filter((b) => b < totalBeats - 0.01).sort((a, b) => a - b);
    if (bars.length < 2) { bars = []; for (let b = 0; b < totalBeats; b += bpb) bars.push(b); }
    return { title: '', strings: nStr, tuning, events, bars, totalBeats, bpm: opts.bpm || 80, beatsPerBar: bpb, source: 'ascii' };
  }

  /* ---------- Guitar Pro (via alphaTab object model) ---------- */

  function tuningOf(staff) {
    const t = staff.tuning || (staff.stringTuning && staff.stringTuning.tunings) || [];
    return Array.from(t);
  }

  function listGuitarTracks(at) {
    const out = [];
    (at.tracks || []).forEach((t, i) => {
      const staff = (t.staves || []).find((s) => tuningOf(s).length >= 4);
      if (staff) out.push({ index: i, name: t.name || 'Track ' + (i + 1), strings: tuningOf(staff).length });
    });
    return out;
  }

  function convertAlphaTab(at, trackIdx) {
    const TPQ = 960;
    const track = at.tracks[trackIdx];
    const staff = track.staves.find((s) => tuningOf(s).length >= 4) || track.staves[0];
    const tuning = tuningOf(staff).slice().sort((a, b) => b - a);
    const capo = staff.capo || 0;
    const evMap = new Map();
    const bars = [];
    let endTick = 0;
    staff.bars.forEach((bar) => {
      const mb = bar.masterBar;
      bars.push(mb.start / TPQ);
      endTick = Math.max(endTick, mb.start + (mb.calculateDuration ? mb.calculateDuration() : TPQ * 4));
      bar.voices.forEach((voice) => {
        if (voice.isEmpty) return;
        voice.beats.forEach((beat) => {
          if (beat.isRest || !beat.notes || !beat.notes.length) return;
          const startTick = beat.absolutePlaybackStart != null ? beat.absolutePlaybackStart : mb.start + beat.playbackStart;
          const start = startTick / TPQ;
          const dur = (beat.playbackDuration || TPQ) / TPQ;
          const key = Math.round(start * 1000);
          beat.notes.forEach((n) => {
            if (n.isTieDestination) return;
            let s;
            if (n.isDead || n.realValue == null) s = Math.min(tuning.length - 1, Math.max(0, tuning.length - n.string));
            else if (n.realValue != null) {
              const open = n.realValue - n.fret - capo;
              s = 0;
              let bd = 999;
              tuning.forEach((t, j) => { const d = Math.abs(t - open); if (d < bd) { bd = d; s = j; } });
            } else {
              s = Math.min(tuning.length - 1, Math.max(0, tuning.length - n.string));
            }
            const midi = n.realValue != null ? n.realValue : tuning[s] + n.fret;
            const note = n.isDead ? { s, f: null, midi: null, dead: true, tech: '' } : { s, f: n.fret, midi, tech: '' };
            if (!n.isDead) {
              // techniques, as alphaTab reports them (bend values are in quarter tones)
              if (n.isPalmMute) note.pm = true;
              if (n.vibrato) note.vib = true;
              const pts = n.bendPoints || [];
              const peak = pts.reduce((a, p) => Math.max(a, p.value || 0), 0);
              if (peak > 0) { note.bend = Math.max(1, Math.round(peak / 2)); if ((pts[pts.length - 1].value || 0) < peak) note.release = true; }
              if (n.isHammerPullOrigin) note.tech = 'h';
              const hpFrom = n.hammerPullOrigin;
              if (hpFrom) note.legato = hpFrom.fret < n.fret ? 'h' : 'p';
              if (n.slideOutType === 1 || n.slideOutType === 2) { note.slideTo = true; note.tech = '/'; }
              if (n.slideOrigin) note.legato = 'slide';
              if (n.harmonicType === 1) { note.harm = true; note.sound = harmonicSound(midi - n.fret, n.fret); }
            }
            if (!evMap.has(key)) evMap.set(key, { beat: start, dur, notes: [] });
            const ev = evMap.get(key);
            ev.dur = Math.max(ev.dur, dur);
            if (!ev.notes.some((x) => x.s === s)) ev.notes.push(note);
          });
        });
      });
    });
    const events = Array.from(evMap.values()).sort((a, b) => a.beat - b.beat);
    events.forEach((e) => e.notes.sort((a, b) => a.s - b.s));
    const last = events[events.length - 1];
    const totalBeats = Math.max(endTick / TPQ, last ? last.beat + last.dur : 0);
    return {
      title: at.title || track.name || 'Imported tab',
      strings: tuning.length, tuning, events, bars, totalBeats,
      bpm: Math.round(at.tempo || 90), beatsPerBar: 4, source: 'gp',
    };
  }

  /* ---------- Pitch detection (YIN) ---------- */

  /* How strongly the signal repeats at the period of one expected pitch (0..1). Unlike yin() this does not need the
     expected note to be the only thing sounding, so it still answers while other strings ring. */
  function periodicityAt(buf, sr, freq) {
    const t0 = sr / freq, lo = Math.max(2, Math.floor(t0 * 0.983)), hi = Math.ceil(t0 * 1.017);
    const W = Math.min(1024, buf.length - hi - 1);
    if (W < 256) return 0;
    let best = 0;
    for (let tau = lo; tau <= hi; tau++) {
      let d = 0, e = 0;
      for (let j = 0; j < W; j++) { const x = buf[j], y = buf[j + tau]; d += (x - y) * (x - y); e += x * x + y * y; }
      if (e > 0) best = Math.max(best, 1 - d / e);
    }
    return best;
  }
  function yin(buf, sr, opts) {
    opts = opts || {};
    const minF = opts.minF || 70, maxF = opts.maxF || 1200, thr = opts.threshold || 0.15;
    let tauMax = Math.floor(sr / minF);
    const tauMin = Math.max(2, Math.floor(sr / maxF));
    let W = Math.min(opts.window || 1024, buf.length - tauMax);
    if (W < 256) {
      tauMax = buf.length - 256;
      W = 256;
      if (tauMax <= tauMin + 2) return null;
    }
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const x = buf[j] - buf[j + tau]; sum += x * x; }
      d[tau] = sum;
    }
    const cm = new Float32Array(tauMax + 1);
    cm[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    let tauE = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cm[tau] < thr) {
        while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++;
        tauE = tau;
        break;
      }
    }
    if (tauE < 0) {
      let mn = 1, mi = -1;
      for (let tau = tauMin; tau < tauMax; tau++) if (cm[tau] < mn) { mn = cm[tau]; mi = tau; }
      if (mi < 0 || mn > 0.3) return null;
      tauE = mi;
    }
    let t = tauE;
    if (tauE > 1 && tauE < tauMax) {
      const a = cm[tauE - 1], b = cm[tauE], c = cm[tauE + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) t = tauE + (a - c) / (2 * den);
    }
    return { freq: sr / t, clarity: 1 - cm[tauE] };
  }

  /* ---------- Grading ---------- */

  class Grader {
    constructor(events) {
      this.events = events;
      this.status = events.map(() => 'pending');
      this.delta = events.map(() => null);
      this.played = events.map(() => null);
      this.info = events.map(() => null); // chord feedback per event
      this.extra = 0;
      this.range = [0, Infinity];
      this.lo = 0; // every event before this index is final (hit or missed)
    }
    /* Call after events were appended (endless mode) so status arrays line up. */
    extend() {
      while (this.status.length < this.events.length) { this.status.push('pending'); this.delta.push(null); this.played.push(null); this.info.push(null); }
    }
    reset(from, to) {
      this.lo = 0;
      this.range = [from == null ? 0 : from, to == null ? Infinity : to];
      this.events.forEach((e, i) => {
        if (e.beat >= this.range[0] && e.beat < this.range[1]) { this.status[i] = 'pending'; this.delta[i] = null; this.played[i] = null; this.info[i] = null; }
      });
      this.extra = 0;
    }
    inRange(i) { const b = this.events[i].beat; return b >= this.range[0] && b < this.range[1]; }
    /* Does a heard note fit this event? A muted or ghost note accepts any hit; otherwise the sounding pitch
       (a bend's peak, a harmonic) counts, an octave either way too. midi null = a hit with no clear pitch. */
    static matches(ev, midi) {
      if (midi == null) return ev.notes.some((n) => n.dead || n.ghost);
      return ev.notes.some((n) => { if (n.dead || n.ghost) return true; const t = soundOf(n); return midi === t || midi === t + 12 || midi === t - 12; });
    }
    onNote(beat, midi, tolBeats) {
      if (midi == null) { // a muted hit: only counts for muted notes, and is never "wrong"
        let best = -1, bd = Infinity;
        for (let i = this.lo; i < this.events.length; i++) {
          if (!this.inRange(i) || this.status[i] === 'hit' || this.status[i] === 'missed') continue;
          const d = Math.abs(this.events[i].beat - beat);
          if (d <= tolBeats && d < bd && Grader.matches(this.events[i], null)) { best = i; bd = d; }
        }
        if (best < 0) return { type: 'none' };
        this.status[best] = 'hit'; this.delta[best] = beat - this.events[best].beat;
        return { type: 'hit', idx: best, delta: this.delta[best] };
      }
      let best = -1, bd = Infinity, any = -1, ad = Infinity;
      for (let i = this.lo; i < this.events.length; i++) {
        if (!this.inRange(i)) continue;
        const st = this.status[i];
        if (st === 'hit' || st === 'missed') continue;
        const d = Math.abs(this.events[i].beat - beat);
        if (d > tolBeats) continue;
        if (Grader.matches(this.events[i], midi) && d < bd) { best = i; bd = d; }
        if (d < ad) { any = i; ad = d; }
      }
      if (best >= 0) {
        this.status[best] = 'hit';
        this.delta[best] = beat - this.events[best].beat;
        return { type: 'hit', idx: best, delta: this.delta[best] };
      }
      if (any >= 0) {
        this.status[any] = 'wrong';
        this.played[any] = midi;
        return { type: 'wrong', idx: any };
      }
      this.extra++;
      return { type: 'extra' };
    }
    /* A strum was heard at `beat`. judge(event) -> {hit, ...} compares the sound with that event's notes.
       The nearest open event within the window that the strum matches is marked hit; if none match,
       the nearest is marked wrong and keeps the judge's feedback in info[]. */
    onChord(beat, tolBeats, judge) {
      const cands = [];
      for (let i = this.lo; i < this.events.length; i++) {
        if (!this.inRange(i)) continue;
        const b = this.events[i].beat;
        if (b > beat + tolBeats) break;
        const st = this.status[i];
        if (st === 'hit' || st === 'missed' || Math.abs(b - beat) > tolBeats) continue;
        cands.push([Math.abs(b - beat), i]);
      }
      if (!cands.length) { this.extra++; return { type: 'extra' }; }
      cands.sort((a, b) => a[0] - b[0]);
      let first = null;
      for (const [, i] of cands) {
        const r = judge(this.events[i]);
        if (!first) first = { i, r };
        if (r && r.hit) {
          this.status[i] = 'hit'; this.delta[i] = beat - this.events[i].beat; this.info[i] = r;
          return { type: 'hit', idx: i, delta: this.delta[i], result: r };
        }
      }
      this.status[first.i] = 'wrong'; this.played[first.i] = -1; this.info[first.i] = first.r;
      return { type: 'wrong', idx: first.i, result: first.r };
    }
    sweep(beat, tolBeats) {
      const changed = [];
      for (let i = this.lo; i < this.events.length; i++) {
        const st = this.status[i];
        if ((st === 'pending' || st === 'wrong') && this.events[i].beat + tolBeats < beat && this.inRange(i)) {
          this.status[i] = 'missed';
          changed.push(i);
        }
      }
      while (this.lo < this.events.length && (this.status[this.lo] === 'hit' || this.status[this.lo] === 'missed')) this.lo++;
      return changed;
    }
    stats() {
      let total = 0, hit = 0, wrong = 0, sum = 0;
      for (let i = 0; i < this.events.length; i++) {
        if (!this.inRange(i)) continue;
        total++;
        if (this.status[i] === 'hit') { hit++; sum += this.delta[i]; }
        else if (this.played[i] != null) wrong++;
      }
      return { total, hit, wrong, extra: this.extra, accuracy: total ? hit / total : 0, avgDeltaBeats: hit ? sum / hit : 0 };
    }
  }

  /* ---------- Exercises ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Turns a plain single note into a technique now and then. Used by random phrases and Endless.
     o.techs: any of 'slide' 'legato' 'bend' 'dead' 'pm' 'vib' 'harm';  o.techRate: share of notes that get one.
     prev: the note just before, if it ends exactly where this one starts (needed for slides and hammer-ons).
     May change prev (the start of a slide / hammer-on) and returns the note to use. */
  const TECHS = ['slide', 'legato', 'bend', 'slap', 'ghost', 'dead', 'pm', 'vib', 'harm'];
  /* Which techniques make sense on each instrument, and which are on to start with. */
  const TECHS_FOR = {
    guitar: { all: ['slide', 'legato', 'bend', 'ghost', 'dead', 'pm', 'vib', 'harm'], on: ['slide', 'legato', 'bend'] },
    bass: { all: ['slide', 'legato', 'slap', 'ghost', 'dead', 'pm', 'vib', 'harm', 'bend'], on: ['slide', 'legato', 'slap', 'ghost'] },
  };
  function applyTechnique(nt, prev, step, o, rnd, state, scale, keepPitch) {
    // keepPitch: the note must stay as it is (e.g. picked from the chord), so only muting, palm mute and vibrato apply
    const techs = (o.techs || []).filter((x) => TECHS.includes(x) && (!keepPitch || ['dead', 'pm', 'vib', 'ghost', 'slap'].includes(x)));
    const tuning = o.tuning || STANDARD, nStr = tuning.length, bass = nStr <= 5;
    const lowString = (s) => (bass ? true : s >= 3);
    const thumbString = (s) => s >= 2; // bass: thumb on A / E (/ B), pop on D / G
    if (state.pmLeft > 0) { state.pmLeft--; if (lowString(nt.s)) { nt.pm = true; return nt; } }
    if (state.slapLeft > 0 && bass && !nt.dead) { // a slap passage keeps going for a few notes
      state.slapLeft--;
      const fmx = Math.max(o.fretMax != null ? o.fretMax : 5, 0) + 2;
      // the classic octave pop: thumb a note on E / A, pop the same note an octave up two strings higher
      if (!keepPitch && prev && prev.slap === 'T' && prev.f != null && prev.s >= 2 && prev.f + 2 <= fmx && rnd() < 0.45 &&
          (!scale || scale.includes(((tuning[prev.s - 2] + prev.f + 2) % 12 + 12) % 12))) {
        return { s: prev.s - 2, f: prev.f + 2, midi: tuning[prev.s - 2] + prev.f + 2, tech: '', slap: 'P' };
      }
      nt.slap = thumbString(nt.s) ? 'T' : 'P';
      return nt;
    }
    if (!techs.length || rnd() >= (o.techRate || 0.25)) return nt;
    const fmin = o.fretMin != null ? o.fretMin : 0, fmax = Math.max(fmin, o.fretMax != null ? o.fretMax : 5);
    const inScale = (m) => !scale || scale.includes(((m % 12) + 12) % 12);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const order = techs.slice().sort(() => rnd() - 0.5);
    for (const tq of order) {
      if (tq === 'legato' || tq === 'slide') {
        if (!prev || prev.dead || prev.harm || prev.bend || prev.f == null) continue;
        const ds = tq === 'legato' ? [1, 2, 3] : [2, 3, 4, 5];
        const frets = [];
        ds.forEach((d) => [prev.f + d, prev.f - d].forEach((f) => {
          if (f >= Math.max(0, tq === 'slide' ? 1 : 0) && f >= fmin - (tq === 'legato' ? fmin : 0) && f <= Math.max(fmax, prev.f) && inScale(tuning[prev.s] + f)) frets.push(f);
        }));
        if (!frets.length) continue;
        const f = pick(frets);
        const kind = tq === 'slide' ? 'slide' : f > prev.f ? 'h' : 'p';
        prev.tech = kind === 'slide' ? '/' : kind;
        if (kind === 'slide') prev.slideTo = true;
        return { s: prev.s, f, midi: tuning[prev.s] + f, tech: '', legato: kind };
      }
      if (tq === 'bend') {
        const ok = bass ? nt.s <= 1 : nt.s <= 3;
        if (!ok || nt.f == null || nt.f < 2) continue;
        const amt = [2, 2, 1, 3].filter((b) => inScale(nt.midi + b));
        if (!amt.length) continue;
        nt.bend = pick(amt);
        if (rnd() < 0.25 && step >= 1) nt.release = true;
        return nt;
      }
      if (tq === 'dead') return { s: nt.s, f: null, midi: null, dead: true, tech: '' };
      if (tq === 'ghost') { if (nt.dead) continue; nt.ghost = true; return nt; }
      if (tq === 'slap') {
        if (!bass || nt.dead) continue;
        nt.slap = thumbString(nt.s) ? 'T' : 'P';
        state.slapLeft = 3 + Math.floor(rnd() * 4);
        return nt;
      }
      if (tq === 'pm') {
        if (!lowString(nt.s)) continue;
        nt.pm = true; state.pmLeft = 1 + Math.floor(rnd() * 3);
        return nt;
      }
      if (tq === 'vib') { if (step < 1) continue; nt.vib = true; return nt; }
      if (tq === 'harm') {
        const strs = o.strings && o.strings.length ? o.strings.filter((x) => x < nStr) : tuning.map((_, i) => i);
        const opts = [];
        strs.forEach((s) => [12, 7, 5].forEach((f) => { if (inScale(harmonicSound(tuning[s], f))) opts.push([s, f]); }));
        if (!opts.length) continue;
        const [s2, f2] = pick(opts);
        return { s: s2, f: f2, midi: tuning[s2] + f2, harm: true, sound: harmonicSound(tuning[s2], f2), tech: '' };
      }
    }
    return nt;
  }

  function generatePhrase(o) {
    o = o || {};
    const rnd = mulberry32(o.seed != null ? o.seed : (Date.now() & 0x7fffffff));
    const tuning = (o.tuning || STANDARD).slice();
    const all = tuning.map((_, i) => i);
    const strings = o.strings && o.strings.length ? o.strings.filter((x) => x < tuning.length).sort((a, b) => a - b) : all;
    if (!strings.length) strings.push(...all);
    const fmin = o.fretMin != null ? o.fretMin : 0;
    const fmax = Math.max(fmin, o.fretMax != null ? o.fretMax : 4);
    const bars = o.bars || 2, per = o.perBeat || 1, bpb = 4;
    const count = bars * bpb * per;
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    let si = Math.floor(rnd() * strings.length);
    let f = fmin + Math.floor(rnd() * (fmax - fmin + 1));
    const events = [];
    const techState = { pmLeft: 0 };
    let prev = null;
    for (let i = 0; i < count; i++) {
      let guard = 0;
      do {
        if (prev) {
          if (rnd() < 0.35 && strings.length > 1) si = Math.min(strings.length - 1, Math.max(0, si + pick([-1, 1])));
          f = Math.min(fmax, Math.max(fmin, f + pick([-3, -2, -1, 0, 1, 2, 3])));
        }
        guard++;
      } while (prev && prev.s === strings[si] && prev.f === f && guard < 20);
      const s = strings[si];
      prev = { s, f };
      let nt = { s, f, midi: tuning[s] + f, tech: '' };
      if (o.techs && o.techs.length) {
        const last = events.length ? events[events.length - 1].notes[0] : null;
        nt = applyTechnique(nt, last, 1 / per, Object.assign({}, o, { tuning, strings, fretMin: fmin, fretMax: fmax }), rnd, techState, null);
        if (nt.f != null) { f = nt.f; si = Math.max(0, strings.indexOf(nt.s)); prev = { s: nt.s, f: nt.f }; }
      }
      events.push({ beat: i / per, dur: 1 / per, notes: [nt] });
    }
    const totalBeats = bars * bpb;
    const barList = [];
    for (let b = 0; b < totalBeats; b += bpb) barList.push(b);
    return { title: 'Random phrase', strings: tuning.length, tuning, events, bars: barList, totalBeats, bpm: o.bpm || 60, beatsPerBar: bpb, source: 'generated' };
  }

  /* ---------- Chords ---------- */

  const ROOT_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const CHORD_TYPES = [
    ['', [0, 4, 7]], ['m', [0, 3, 7]], ['5', [0, 7]], ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]],
    ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['7sus4', [0, 5, 7, 10]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]],
    ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['add9', [0, 2, 4, 7]], ['madd9', [0, 2, 3, 7]], ['dim7', [0, 3, 6, 9]],
    ['m7b5', [0, 3, 6, 10]], ['9', [0, 2, 4, 7, 10]],
  ];
  const pc = (m) => ((Math.round(m) % 12) + 12) % 12;
  const pcsOf = (midis) => Array.from(new Set(midis.map(pc))).sort((a, b) => a - b);
  const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const midisOf = (notes) => notes.filter((n) => typeof n === 'number' || !n.dead).map((n) => (typeof n === 'number' ? n : soundOf(n)));
  const isChord = (ev) => !!ev && ev.notes.length > 1 && pcsOf(midisOf(ev.notes)).length > 1;

  /* Chord symbol from the notes that sound (e.g. "Am", "C7", "C/E"), or null if it is not a common chord. */
  function chordName(notes) {
    const midis = midisOf(notes);
    if (midis.length < 2) return null;
    const pcs = pcsOf(midis);
    if (pcs.length < 2) return null;
    const bass = pc(Math.min.apply(null, midis));
    const roots = [bass].concat(pcs.filter((p) => p !== bass));
    for (const no5 of [false, true]) {
      for (const r of roots) {
        const iv = pcs.map((p) => (p - r + 12) % 12).sort((a, b) => a - b);
        for (const [suffix, t] of CHORD_TYPES) {
          let tt = t;
          if (no5) { if (t.length < 4 || !t.includes(7)) continue; tt = t.filter((x) => x !== 7); }
          if (sameSet(iv, tt)) return ROOT_NAMES[r] + suffix + (r !== bass ? '/' + ROOT_NAMES[bass] : '');
        }
      }
    }
    return null;
  }

  /* Guitar chord shapes, written low E to high e like a chord chart ("x" = don't play).
     Single-digit shapes are written "x32010"; shapes with frets of 10 or more use spaces: "x 10 12 12 11 10". */
  const CHORD_GROUPS = [
    { id: 'major', name: 'Open major', shapes: { C: 'x32010', A: 'x02220', G: '320003', E: '022100', D: 'xx0232' } },
    { id: 'minor', name: 'Open minor', shapes: { Am: 'x02210', Em: '022000', Dm: 'xx0231' } },
    { id: 'seventh', name: 'Open sevenths', shapes: { A7: 'x02020', D7: 'xx0212', E7: '020100', G7: '320001', C7: 'x32310', B7: 'x21202', Am7: 'x02010', Em7: '020000', Dm7: 'xx0211', Cmaj7: 'x32000', Fmaj7: 'xx3210' } },
    { id: 'sus', name: 'Sus', shapes: { Dsus2: 'xx0230', Dsus4: 'xx0233', Asus2: 'x02200', Asus4: 'x02230', Esus4: '022200' } },
    { id: 'power', name: 'Power chords', shapes: { E5: '022xxx', F5: '133xxx', G5: '355xxx', A5: 'x022xx', C5: 'x355xx', D5: 'x577xx' } },
    { id: 'barre', name: 'Common barre (F, Bm…)', shapes: { F: '133211', Bm: 'x24432', Bb: 'x13331', 'F#m': '244222', B: 'x24442', Cm: 'x35543' } },
    // movable barre shapes, generated across the neck below
    { id: 'barreE', name: 'Barre, root on 6th string', movable: [['', [0, 2, 2, 1, 0, 0]], ['m', [0, 2, 2, 0, 0, 0]]], root: 4, frets: [1, 9] },
    { id: 'barreA', name: 'Barre, root on 5th string', movable: [['', [null, 0, 2, 2, 2, 0]], ['m', [null, 0, 2, 2, 1, 0]]], root: 9, frets: [1, 9] },
    { id: 'barre7', name: 'Barre sevenths', movable: [['7', [0, 2, 0, 1, 0, 0], 4], ['m7', [0, 2, 0, 0, 0, 0], 4], ['7', [null, 0, 2, 0, 2, 0], 9], ['m7', [null, 0, 2, 0, 1, 0], 9], ['maj7', [null, 0, 2, 1, 2, 0], 9]], frets: [1, 7] },
    { id: 'colour', name: 'Maj7, add9, 6, 9', shapes: { Cadd9: 'x32033', Gmaj7: '320002', Dmaj7: 'xx0222', Amaj7: 'x02120', A6: 'x02222', D6: 'xx0202', E9: '020102' } },
    { id: 'slash', name: 'Slash chords', shapes: { 'C/E': '032010', 'C/G': '332010', 'G/B': 'x20003', 'D/F#': '200232' } },
    { id: 'dim', name: 'Dim and aug', shapes: { Bdim: 'x2343x', Cdim7: 'x3424x', Caug: 'x32110', Bm7b5: 'x2323x' } },
  ];
  const shapeText = (frets) => (frets.some((f) => f != null && f > 9) ? frets.map((f) => (f == null ? 'x' : f)).join(' ') : frets.map((f) => (f == null ? 'x' : f)).join(''));
  const CHORDS = [];
  function addChord(group, name, frets) {
    const notes = [];
    frets.forEach((f, i) => { if (f != null) { const s = 5 - i; notes.push({ s, f, midi: STANDARD[s] + f, tech: '' }); } });
    notes.sort((a, b) => a.s - b.s);
    CHORDS.push({ id: group + ':' + name + ':' + shapeText(frets), name, group, shape: shapeText(frets), notes });
  }
  CHORD_GROUPS.forEach((g) => {
    if (g.shapes) {
      Object.keys(g.shapes).forEach((name) => {
        const sh = g.shapes[name];
        const parts = sh.includes(' ') ? sh.split(' ') : sh.split('');
        addChord(g.id, name, parts.map((c) => (c === 'x' ? null : parseInt(c, 10))));
      });
    } else {
      g.movable.forEach(([suffix, offs, rootOpen]) => {
        for (let b = g.frets[0]; b <= g.frets[1]; b++) {
          const root = ((rootOpen != null ? rootOpen : g.root) + b) % 12;
          addChord(g.id, ROOT_NAMES[root] + suffix, offs.map((o) => (o == null ? null : o + b)));
        }
      });
    }
  });
  CHORD_GROUPS.forEach((g) => { g.count = CHORDS.filter((c) => c.group === g.id).length; });

  /* Root, suffix and family of every shape, for picking chords that belong to a key. */
  const FAMILY = { '': 'maj', maj7: 'maj', add9: 'maj', 6: 'maj', 7: 'dom', 9: 'dom', '7sus4': 'sus', sus2: 'sus', sus4: 'sus',
    m: 'min', m7: 'min', m6: 'min', madd9: 'min', dim: 'dim', m7b5: 'dim', dim7: 'dim', aug: 'aug', 5: 'five' };
  CHORDS.forEach((c) => {
    const m = /^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/.exec(c.name);
    c.root = ROOT_NAMES.indexOf(m[1]);
    c.suffix = m[2];
    c.slash = !!m[3];
    c.family = FAMILY[c.suffix] || 'other';
    c.pos = c.notes.reduce((a, n) => a + n.f, 0) / c.notes.length; // rough hand position, for smooth changes
  });

  function randomChord(pool, avoidName, rnd) {
    rnd = rnd || Math.random;
    const list = pool && pool.length ? pool : CHORDS;
    let c, guard = 0;
    do { c = list[Math.floor(rnd() * list.length)]; guard++; } while (list.length > 1 && c.name === avoidName && guard < 30);
    return c;
  }

  /* Radix-2 FFT magnitude of a Blackman-windowed frame (length must be a power of two). */
  const fftCache = {};
  function fftMag(x) {
    const N = x.length;
    let tw = fftCache[N];
    if (!tw) {
      tw = { cos: new Float64Array(N / 2), sin: new Float64Array(N / 2), win: new Float64Array(N) };
      for (let i = 0; i < N / 2; i++) { tw.cos[i] = Math.cos((2 * Math.PI * i) / N); tw.sin[i] = -Math.sin((2 * Math.PI * i) / N); }
      for (let i = 0; i < N; i++) tw.win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (N - 1));
      fftCache[N] = tw;
    }
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i] * tw.win[i];
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1, step = N / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = tw.cos[k * step], wi = tw.sin[k * step];
          const a = i + k, b = a + half;
          const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        }
      }
    }
    const mag = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    return mag;
  }

  /* Pitch-class profile of a frame: every spectral peak between 70 Hz and 2.6 kHz that sits near
     a semitone adds its (compressed) level to that note name. */
  function chroma(x, sr) {
    const N = x.length, mag = fftMag(x), binHz = sr / N;
    const k0 = Math.max(2, Math.floor(70 / binHz)), k1 = Math.min(mag.length - 2, Math.ceil(2600 / binHz));
    let max = 0;
    for (let k = k0; k <= k1; k++) if (mag[k] > max) max = mag[k];
    const c = new Float64Array(12);
    if (max <= 0) return { chroma: c, level: 0 };
    const floor = max * 0.015;
    for (let k = k0; k <= k1; k++) {
      const m = mag[k];
      if (m <= floor || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m), g = Math.log(mag[k + 1] + 1e-12);
      const den = a - 2 * b + g;
      const p = Math.abs(den) > 1e-12 ? (0.5 * (a - g)) / den : 0;
      const f = (k + p) * binHz;
      const mf = 69 + 12 * Math.log2(f / 440), r = Math.round(mf);
      if (Math.abs(mf - r) > 0.35) continue;
      c[((r % 12) + 12) % 12] += Math.pow(m / max, 0.6);
    }
    let cm = 0;
    for (let i = 0; i < 12; i++) cm = Math.max(cm, c[i]);
    if (cm > 0) for (let i = 0; i < 12; i++) c[i] /= cm;
    return { chroma: c, level: max / N };
  }

  // What a note looks like in the chroma: its own name, plus its 3rd harmonic (a fifth up) and 5th harmonic (a third up).
  const HARM = [[0, 2.25], [7, 0.75], [4, 0.3]];
  function templateOf(pcs) {
    const t = new Float64Array(12);
    for (const p of pcs) for (const [o, w] of HARM) t[(p + o) % 12] += w;
    return t;
  }
  function cosine(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < 12; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
  }
  const CANDIDATES = [];
  for (let r = 0; r < 12; r++) {
    for (const [suffix, t] of CHORD_TYPES.slice(0, 11)) {
      const pcs = t.map((x) => (x + r) % 12).sort((a, b) => a - b);
      CANDIDATES.push({ name: ROOT_NAMES[r] + suffix, pcs, t: templateOf(pcs) });
    }
  }
  const CHORD_TUNE = { margin: 0.03, extra: 0.4, extra7: 0.5, missing: 0.06 };

  /* Compare a heard chroma with the chord the tab asks for.
     hit = the expected chord explains the sound about as well as any common chord does,
           no strong note outside the chord (a wrong fret), and no chord tone completely absent. */
  function judgeChord(heard, notes) {
    const c = heard.chroma, exp = pcsOf(midisOf(notes));
    const expName = chordName(notes) || exp.map((p) => ROOT_NAMES[p]).join(' ');
    if (exp.length < 2) {
      let arg = 0;
      for (let i = 1; i < 12; i++) if (c[i] > c[arg]) arg = i;
      return { hit: arg === exp[0], expected: expName, heard: ROOT_NAMES[arg], extra: [], missing: arg === exp[0] ? [] : [ROOT_NAMES[exp[0]]] };
    }
    const es = cosine(c, templateOf(exp));
    let best = { name: expName, pcs: exp }, bs = es;
    for (const cand of CANDIDATES) { const sc = cosine(c, cand.t); if (sc > bs + 1e-9) { bs = sc; best = cand; } }
    const explained = new Set();
    exp.forEach((p) => [0, 7, 4].forEach((o) => explained.add((p + o) % 12)));
    const extra = [], missing = [];
    // a chord tone's 7th harmonic lands near the note a minor seventh up; only flag that one when it is very strong
    const seventh = new Set(exp.map((p) => (p + 10) % 12));
    const strong = [];
    for (let p = 0; p < 12; p++) if (!explained.has(p) && c[p] >= (seventh.has(p) ? CHORD_TUNE.extra7 : CHORD_TUNE.extra)) strong.push(p);
    strong.sort((a, b) => c[b] - c[a]).forEach((p) => extra.push(ROOT_NAMES[p])); // strongest first
    exp.forEach((p) => { if (c[p] < CHORD_TUNE.missing) missing.push(ROOT_NAMES[p]); });
    const close = es >= bs - CHORD_TUNE.margin;
    return {
      hit: close && !extra.length && !missing.length,
      expected: expName, heard: sameSet(best.pcs, exp) ? expName : best.name,
      score: es, bestScore: bs, extra, missing,
    };
  }

  /* ---------- Harmony: keys, progressions, circle of fifths ---------- */

  const MODES = {
    major: { steps: [0, 2, 4, 5, 7, 9, 11], degs: [['I', 'maj'], ['ii', 'min'], ['iii', 'min'], ['IV', 'maj'], ['V', 'dom'], ['vi', 'min'], ['vii°', 'dim']] },
    // minor uses the major V (E in A minor) for a proper pull home, and the minor v if no major V shape is chosen
    minor: { steps: [0, 2, 3, 5, 7, 8, 10], degs: [['i', 'min'], ['ii°', 'dim'], ['III', 'maj'], ['iv', 'min'], ['V', 'dom', 'v', 'min', 7], ['VI', 'maj'], ['VII', 'maj']] },
  };
  // the 24 keys in circle-of-fifths order, spelled the usual way; 'acc' says whether chords in the key are written with sharps or flats
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const KEYS = [];
  [['C', 0, ''], ['G', 7, '#'], ['D', 2, '#'], ['A', 9, '#'], ['E', 4, '#'], ['B', 11, '#'], ['F#', 6, '#'], ['Db', 1, 'b'], ['Ab', 8, 'b'], ['Eb', 3, 'b'], ['Bb', 10, 'b'], ['F', 5, 'b']]
    .forEach(([n, t, acc]) => KEYS.push({ id: n, tonic: t, mode: 'major', acc, label: n + ' major' }));
  [['A', 9, ''], ['E', 4, '#'], ['B', 11, '#'], ['F#', 6, '#'], ['C#', 1, '#'], ['G#', 8, '#'], ['Eb', 3, 'b'], ['Bb', 10, 'b'], ['F', 5, 'b'], ['C', 0, 'b'], ['G', 7, 'b'], ['D', 2, 'b']]
    .forEach(([n, t, acc]) => KEYS.push({ id: n + 'm', tonic: t, mode: 'minor', acc, label: n + ' minor' }));
  /* A chord name written the way the key spells it: Db (not C#) in Ab major, G#m (not Abm) in E major. */
  function spellIn(name, key) {
    if (!key || !key.acc) return name;
    const names = key.acc === '#' ? SHARP_NAMES : FLAT_NAMES;
    const m = /^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/.exec(name);
    if (!m) return name;
    const sp = (r) => names[ROOT_NAMES.indexOf(r)];
    return sp(m[1]) + m[2] + (m[3] ? '/' + sp(m[3]) : '');
  }
  const keyById = (id) => KEYS.find((k) => k.id === id) || null;

  // how well a shape stands in for a chord of quality q
  function fitWeight(c, q) {
    const f = c.family, x = c.suffix;
    let w = 0;
    if (q === 'maj') w = x === '' ? 3 : f === 'maj' ? 1.2 : (x === 'sus2' || x === 'sus4') ? 0.4 : f === 'five' ? 0.6 : 0;
    else if (q === 'dom') w = x === '' ? 3 : f === 'dom' ? 2.2 : (x === 'add9' || x === '6') ? 0.8 : (x === 'sus4' || x === '7sus4') ? 0.7 : f === 'five' ? 0.6 : 0;
    else if (q === 'dom7') w = f === 'dom' ? 3 : x === '' ? 0.8 : f === 'five' ? 0.4 : 0;
    else if (q === 'min') w = x === 'm' ? 3 : f === 'min' ? 1.2 : f === 'five' ? 0.6 : 0;
    else if (q === 'dim') w = x === 'dim' ? 3 : x === 'm7b5' ? 2 : x === 'dim7' ? 1 : 0;
    return c.slash ? w * 0.6 : w;
  }
  /* For a key: which shapes can play each of its 7 degrees. With strict (the default) a shape only counts
     if every note in it belongs to the key (in minor, the raised 7th for V is allowed too). */
  function degreeOptions(pool, key, strict) {
    const M = MODES[key.mode];
    const allowed = new Set(M.steps.map((x) => (x + key.tonic) % 12));
    if (key.mode === 'minor') allowed.add((key.tonic + 11) % 12);
    const inKey = (c) => strict === false || c.notes.every((n) => allowed.has(((n.midi % 12) + 12) % 12));
    return M.degs.map((d, i) => {
      const root = (key.tonic + M.steps[i]) % 12;
      let opts = pool.filter((c) => c.root === root && inKey(c)).map((c) => ({ c, w: fitWeight(c, d[1]), roman: d[0] })).filter((o) => o.w > 0);
      if (!opts.length && d[2]) { // minor key without a major V: use the minor v
        const r2 = (key.tonic + d[4]) % 12;
        opts = pool.filter((c) => c.root === r2 && inKey(c)).map((c) => ({ c, w: fitWeight(c, d[3]), roman: d[2] })).filter((o) => o.w > 0);
      }
      return opts;
    });
  }
  const coverage = (opts) => opts.filter((o) => o.length).length;
  /* Keys the chosen shapes can play: tonic plus at least `min` of the 7 degrees, best first. */
  function keysFor(pool, min) {
    return KEYS.map((k) => ({ key: k, cov: coverage(degreeOptions(pool, k)), tonic: degreeOptions(pool, k)[0].length > 0 }))
      .filter((x) => x.tonic && x.cov >= (min || 4)).sort((a, b) => b.cov - a.cov);
  }

  // typical next chords (functional harmony), by degree index 0..6
  const MOVES = {
    major: [{ 3: 25, 4: 25, 5: 20, 1: 15, 2: 5 }, { 4: 60, 3: 15, 5: 10, 6: 5 }, { 5: 50, 3: 30, 1: 20 }, { 4: 40, 0: 30, 1: 15, 5: 15 }, { 0: 60, 5: 25, 3: 15 }, { 3: 35, 1: 30, 4: 20, 2: 15 }, { 0: 70, 2: 30 }],
    minor: [{ 3: 25, 5: 25, 6: 20, 4: 15, 2: 15 }, { 4: 80, 0: 20 }, { 5: 35, 3: 30, 6: 20, 0: 15 }, { 4: 35, 0: 25, 6: 25, 1: 15 }, { 0: 80, 5: 20 }, { 6: 30, 3: 25, 2: 20, 4: 15, 1: 10 }, { 2: 40, 0: 35, 5: 25 }],
  };
  const PROGRESSIONS = {
    major: [
      { name: 'I–V–vi–IV', degs: [0, 4, 5, 3] }, { name: 'I–vi–IV–V', degs: [0, 5, 3, 4] }, { name: 'I–IV–V–IV', degs: [0, 3, 4, 3] },
      { name: 'vi–IV–I–V', degs: [5, 3, 0, 4] }, { name: 'ii–V–I', degs: [1, 4, 0, 0] }, { name: 'I–IV–vi–V', degs: [0, 3, 5, 4] },
      { name: 'vi–ii–V–I', degs: [5, 1, 4, 0] }, { name: 'I–iii–IV–V', degs: [0, 2, 3, 4] }, { name: 'I–V–IV–I', degs: [0, 4, 3, 0] },
      { name: '12-bar blues', degs: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4], q: 'dom7' },
    ],
    minor: [
      { name: 'i–VI–III–VII', degs: [0, 5, 2, 6] }, { name: 'i–iv–V–i', degs: [0, 3, 4, 0] }, { name: 'i–VII–VI–V', degs: [0, 6, 5, 4] },
      { name: 'i–iv–VII–III', degs: [0, 3, 6, 2] }, { name: 'i–VI–iv–V', degs: [0, 5, 3, 4] }, { name: 'i–VII–VI–VII', degs: [0, 6, 5, 6] },
    ],
  };
  const CIRCLE = [0, 3, 6, 2, 5, 1, 4]; // each step: root down a fifth (I IV vii iii vi ii V, then home)

  /* Chooses chords that belong together. opts: { chords, harmony: 'key'|'progressions'|'circle', key: 'auto'|key id, modulate: bars } */
  class Harmony {
    constructor(opts, rnd) { this.opts = opts; this.rnd = rnd; this.sig = null; this.extended = false; }
    pick(weights) { // weights: [[item, w]]
      const tot = weights.reduce((a, x) => a + x[1], 0);
      let r = this.rnd() * tot;
      for (const x of weights) { r -= x[1]; if (r <= 0) return x[0]; }
      return weights[weights.length - 1][0];
    }
    optionsFor(key) {
      const o = this.opts, pool = o.chords && o.chords.length ? o.chords : CHORDS;
      let opts = degreeOptions(pool, key), all = pool;
      this.extended = false;
      if (!opts[0].length || coverage(opts) < 3) { // a chosen key the sets can't play: add barre shapes for it
        all = pool.concat(CHORDS.filter((c) => (c.group === 'barre' || c.group === 'barreE' || c.group === 'barreA') && !pool.includes(c)));
        opts = degreeOptions(all, key);
        this.extended = true;
      }
      this.blues = degreeOptions(all, key, false); // the 12-bar blues uses I7 and IV7, which step outside the key on purpose
      return opts;
    }
    setKey(key, beat) {
      this.key = key; this.keyStart = beat; this.opts_ = this.optionsFor(key);
      this.deg = null; this.prog = null; this.progLeft = 0; this.circ = 0;
    }
    chooseKey(beat) {
      const o = this.opts;
      if (o.key && o.key !== 'auto' && keyById(o.key)) return this.setKey(keyById(o.key), beat);
      const cands = keysFor(o.chords && o.chords.length ? o.chords : CHORDS, 3);
      if (!cands.length) { this.key = null; return; }
      const best = cands.filter((x) => x.cov >= cands[0].cov - 1);
      this.setKey(this.pick(best.map((x) => [x.key, x.cov * x.cov * (x.key.mode === 'major' ? 1.3 : 1)])), beat);
    }
    /* Neighbouring keys: one step round the circle of fifths, or the relative major/minor. */
    modulate(beat) {
      const k = this.key, rel = k.mode === 'major' ? (k.tonic + 9) % 12 : (k.tonic + 3) % 12;
      const near = [{ t: (k.tonic + 7) % 12, m: k.mode }, { t: (k.tonic + 5) % 12, m: k.mode }, { t: rel, m: k.mode === 'major' ? 'minor' : 'major' }];
      const pool = this.opts.chords && this.opts.chords.length ? this.opts.chords : CHORDS;
      const ok = near.map((n) => KEYS.find((x) => x.tonic === n.t && x.mode === n.m)).filter((x) => { const d = degreeOptions(pool, x); return d[0].length && coverage(d) >= 3; });
      if (ok.length) this.setKey(ok[Math.floor(this.rnd() * ok.length)], beat);
      else this.keyStart = beat;
    }
    nextDegree() {
      const o = this.opts, mode = this.key.mode, avail = (i) => this.opts_[i].length > 0;
      if (o.harmony === 'progressions') {
        if (!this.prog || this.progPos >= this.prog.degs.length) {
          if (this.prog && this.progLeft > 1) { this.progLeft--; this.progPos = 0; }
          else {
            const ps = PROGRESSIONS[mode].filter((p) => p.degs.every((d) => (p.q ? this.blues[d].some((x) => fitWeight(x.c, p.q) >= 2) : avail(d))) && p !== this.prog);
            if (!ps.length) { this.prog = null; return this.markov(); }
            this.prog = ps[Math.floor(this.rnd() * ps.length)]; this.progPos = 0; this.progLeft = 2;
          }
        }
        return { deg: this.prog.degs[this.progPos++], q: this.prog.q };
      }
      if (o.harmony === 'circle') {
        if (this.deg == null) { this.circ = 0; return { deg: 0 }; }
        for (let k = 1; k <= 7; k++) { const i = (this.circ + k) % 7; if (avail(CIRCLE[i])) { this.circ = i; return { deg: CIRCLE[i] }; } }
        return { deg: 0 };
      }
      return this.markov();
    }
    markov() {
      if (this.deg == null) return { deg: 0 };
      const m = MOVES[this.key.mode][this.deg];
      const ws = Object.keys(m).map(Number).filter((d) => this.opts_[d].length).map((d) => [d, m[d]]);
      return { deg: ws.length ? this.pick(ws) : 0 };
    }
    /* The next chord. Returns { chord, roman, key } or null when no key fits the chosen shapes. */
    next(beat, prevChord) {
      const o = this.opts, sig = [o.harmony, o.key, (o.chords || []).length, o.chords && o.chords[0] && o.chords[0].id].join('|');
      if (sig !== this.sig) { this.sig = sig; this.chooseKey(beat); }
      if (!this.key) return null;
      const bars = o.modulate || 0;
      const atHome = this.deg === 0 && (!this.prog || this.progPos >= this.prog.degs.length);
      if (bars && (o.key === 'auto' || !o.key) && beat - this.keyStart >= bars * 4 && (atHome || beat - this.keyStart >= bars * 8)) this.modulate(beat);
      const { deg, q } = this.nextDegree();
      let opts = this.opts_[deg];
      if (q) { const strong = this.blues[deg].filter((x) => fitWeight(x.c, q) >= 2); if (strong.length) opts = strong.map((x) => ({ c: x.c, w: fitWeight(x.c, q), roman: x.roman })); }
      if (!opts.length) opts = this.opts_[0];
      let pickd;
      if (deg === this.deg && prevChord && opts.some((x) => x.c === prevChord)) pickd = opts.find((x) => x.c === prevChord); // same chord again: same shape
      else {
        const near = (c) => (prevChord ? Math.exp(-Math.abs(c.pos - prevChord.pos) / 2.5) : 1); // keep the hand close
        pickd = this.pick(opts.map((x) => [x, x.w * near(x.c) * (prevChord && x.c === prevChord ? 0.3 : 1)]));
      }
      this.deg = deg;
      return { chord: pickd.c, roman: romanOf(pickd.roman, pickd.c), key: this.key, extended: this.extended };
    }
    scale() { return this.key ? MODES[this.key.mode].steps.map((x) => (x + this.key.tonic) % 12) : null; }
  }
  function romanOf(base, c) {
    const x = c.suffix;
    if (x === '' || x === 'm' || x === 'dim') return base;
    if (x === 'm7' || x === 'm6' || x === 'madd9') return base + x.slice(1);
    if (x === 'm7b5') return base.replace('°', '') + 'ø7';
    if (x === 'dim7') return base.replace('°', '') + '°7';
    return base + x;
  }

  /* Endless mode: keeps appending random notes and/or chords to a score as the playhead advances.
     `opts` is read live, so a changed setting applies to everything not generated yet.
     opts: {
       tuning:[midi], strings:[idx], fretMin, fretMax,      where single notes come from
       perBeat: 1 | 2 | 0 (mixed), rests: bool,             single-note rhythm
       content: 'notes' | 'chords' | 'mix',
       chords:[chord], chordEvery: 1 | 2 | 4 | 8 beats,     which chords, and how often a new one starts
       strumEvery: 0 (once) | 1 | 2 beats,                  'chords': how often each chord is strummed
       mixChordLen: 1 | 2 beats,                            'mix': how long the chord rings before notes resume
       fill: 'random' | 'chord' | 'scale'                   'mix': notes between chords: random, from the chord, or from the key's scale
       harmony: 'random' | 'key' | 'progressions' | 'circle', key: 'auto' | key id, modulate: 0 | 8 | 16 bars
     } */
  class EndlessGen {
    constructor(opts, seed) {
      this.opts = opts || {};
      this.rnd = mulberry32(seed != null ? seed : (Date.now() & 0x7fffffff));
      this.beat = 0;
      this.nextBar = 0;
      this.si = 0;
      this.f = 0;
      this.prev = null;
      this.lastRest = true; // first slot always plays a note
      this.lastChord = null;
      this.curChord = null;
      this.harm = new Harmony(this.opts, this.rnd);
      this.techState = { pmLeft: 0 };
      this.lastNote = null; this.lastEnd = -1;
    }
    /* Next chord: from the harmony engine when a chord order is set, otherwise any chord from the sets. */
    nextChord() {
      const o = this.opts;
      if (o.harmony && o.harmony !== 'random') {
        const r = this.harm.next(this.beat, this.curChord);
        if (r) { this.lastChord = r.chord.name; this.curChord = r.chord; return { ch: r.chord, roman: r.roman, key: r.key.label, name: spellIn(r.chord.name, r.key) }; }
      }
      const ch = randomChord(o.chords, this.lastChord, this.rnd);
      this.lastChord = ch.name; this.curChord = ch;
      return { ch };
    }
    /* A single note from the key's scale, moving mostly by small steps (melodic). */
    pickScaleNote(scale) {
      const o = this.opts, rnd = this.rnd, tuning = o.tuning || STANDARD;
      const nStr = tuning.length;
      let strings = o.strings && o.strings.length ? o.strings.filter((x) => x < nStr) : [];
      if (!strings.length) strings = Array.from({ length: nStr }, (_, i) => i);
      const fmin = o.fretMin != null ? o.fretMin : 0, fmax = Math.max(fmin, o.fretMax != null ? o.fretMax : 5);
      const cands = [];
      for (const s of strings) for (let f = fmin; f <= fmax; f++) if (scale.includes(((tuning[s] + f) % 12 + 12) % 12)) cands.push({ s, f, midi: tuning[s] + f });
      if (!cands.length) return null;
      const pm = this.prev ? tuning[this.prev.s] + this.prev.f : null;
      const ws = cands.filter((c) => !this.prev || c.s !== this.prev.s || c.f !== this.prev.f).map((c) => {
        if (pm == null) return [c, 1];
        const d = Math.abs(c.midi - pm);
        return [c, d === 0 ? 0.2 : d <= 2 ? 4 : d <= 4 ? 2 : d <= 7 ? 0.8 : 0.2];
      });
      const n = this.harm.pick(ws.length ? ws : cands.map((c) => [c, 1]));
      this.prev = { s: n.s, f: n.f };
      return n;
    }
    pickNote() {
      const o = this.opts, rnd = this.rnd;
      const nStr = (o.tuning || STANDARD).length;
      let strings = o.strings && o.strings.length ? o.strings.filter((x) => x < nStr).sort((a, b) => a - b) : [];
      if (!strings.length) strings = Array.from({ length: nStr }, (_, i) => i);
      const fmin = o.fretMin != null ? o.fretMin : 0;
      const fmax = Math.max(fmin, o.fretMax != null ? o.fretMax : 5);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      this.si = Math.min(this.si, strings.length - 1);
      let s, f, guard = 0;
      do {
        if (!this.prev || rnd() < 0.15) {
          this.si = Math.floor(rnd() * strings.length);
          f = fmin + Math.floor(rnd() * (fmax - fmin + 1));
        } else {
          if (rnd() < 0.4 && strings.length > 1) this.si = Math.min(strings.length - 1, Math.max(0, this.si + pick([-1, 1])));
          f = Math.min(fmax, Math.max(fmin, this.f + pick([-4, -3, -2, -1, 0, 1, 2, 3, 4])));
        }
        s = strings[this.si];
        guard++;
      } while (this.prev && this.prev.s === s && this.prev.f === f && guard < 30);
      this.f = f;
      this.prev = { s, f };
      return { s, f };
    }
    /* A single note taken from the chord that is ringing (like picking through the shape). */
    pickChordTone(ch) {
      const rnd = this.rnd, ns = ch.notes;
      let n, guard = 0;
      do { n = ns[Math.floor(rnd() * ns.length)]; guard++; } while (ns.length > 1 && this.prev && this.prev.s === n.s && this.prev.f === n.f && guard < 30);
      this.prev = { s: n.s, f: n.f };
      return n;
    }
    pushChord(score, pc, beat, len, strumEvery) {
      const ch = pc.ch, strums = strumEvery ? Math.max(1, Math.round(len / strumEvery)) : 1, step = len / strums;
      for (let k = 0; k < strums; k++) {
        const ev = { beat: beat + k * step, dur: step, chord: pc.name || ch.name, cid: ch.id, notes: ch.notes.map((n) => Object.assign({}, n)) };
        if (pc.roman) { ev.roman = pc.roman; ev.key = pc.key; }
        score.events.push(ev);
      }
    }
    /* Append notes, chords and bar lines to `score` until `upto` beats are covered. */
    fill(score, upto) {
      const o = this.opts, rnd = this.rnd, EPS = 1e-6;
      while (this.nextBar < upto + 4) { score.bars.push(this.nextBar); this.nextBar += 4; }
      while (this.beat < upto) {
        const content = o.content || 'notes';
        const every = o.chordEvery || o.chordBeats || 4;                       // chordBeats: older name
        const strumEvery = o.strumEvery != null ? o.strumEvery : o.strumEach ? 1 : 0; // strumEach: older name
        const slot = Math.abs(this.beat / every - Math.round(this.beat / every)) < EPS;

        if (content === 'chords') {
          // align to the chord grid (only matters right after switching from notes)
          const len = slot ? every : Math.ceil(this.beat / every - EPS) * every - this.beat;
          this.pushChord(score, this.nextChord(), this.beat, len, slot ? strumEvery : 0);
          this.beat += len; this.lastRest = false; this.prev = null;
          continue;
        }

        let next = Infinity; // where the next chord starts ('mix' only)
        if (content === 'mix') {
          if (slot) {
            const len = Math.min(every, Math.max(1, o.mixChordLen || 1));
            this.pushChord(score, this.nextChord(), this.beat, len, 0);
            this.beat += len; this.lastRest = false; this.prev = null;
            continue;
          }
          next = (Math.floor(this.beat / every + EPS) + 1) * every;
        }

        const per = o.perBeat;
        let step = per ? 1 / per : [1, 1, 0.5, 0.5, 0.5][Math.floor(rnd() * 5)];
        step = Math.min(step, next - this.beat);                                // never run over the next chord
        if (o.rests && !this.lastRest && rnd() < 0.12) { this.lastRest = true; this.beat += step; continue; }
        this.lastRest = false;
        const tuning = o.tuning || STANDARD;
        let nt;
        const scale = content === 'mix' && o.fill === 'scale' && o.harmony && o.harmony !== 'random' ? this.harm.scale() : null;
        const sn = scale ? this.pickScaleNote(scale) : null;
        if (sn) nt = { s: sn.s, f: sn.f, midi: sn.midi, tech: '' };
        else if (content === 'mix' && o.fill === 'chord' && this.curChord) {
          const c = this.pickChordTone(this.curChord);
          nt = { s: c.s, f: c.f, midi: c.midi, tech: '' };
        } else {
          const n = this.pickNote();
          nt = { s: n.s, f: n.f, midi: tuning[n.s] + n.f, tech: '' };
        }
        if (o.techs && o.techs.length) {
          const adj = this.lastNote && Math.abs(this.lastEnd - this.beat) < 1e-6 ? this.lastNote : null;
          nt = applyTechnique(nt, adj, step, o, rnd, this.techState, scale, content === 'mix' && o.fill === 'chord');
          if (nt.f != null && !nt.dead) { this.prev = { s: nt.s, f: nt.f }; this.f = nt.f; }
        }
        score.events.push({ beat: this.beat, dur: step, notes: [nt] });
        this.lastNote = nt.dead ? null : nt; this.lastEnd = this.beat + step;
        this.beat += step;
      }
    }
  }

  function randomTarget(strings, fmin, fmax, avoid, rnd, tuning) {
    rnd = rnd || Math.random;
    tuning = tuning || STANDARD;
    let ss = strings && strings.length ? strings.filter((x) => x < tuning.length) : [];
    if (!ss.length) ss = tuning.map((_, i) => i);
    let t, guard = 0;
    do {
      const s = ss[Math.floor(rnd() * ss.length)];
      const f = fmin + Math.floor(rnd() * (fmax - fmin + 1));
      t = { s, f, midi: tuning[s] + f };
      guard++;
    } while (avoid && avoid.s === t.s && avoid.f === t.f && guard < 30);
    return t;
  }

  return {
    NOTE_NAMES, STANDARD, BASS, BASS5, INSTRUMENTS, instrumentOf, pcName, midiName, freqToMidi, midiToFreq,
    parseAsciiTab, tokenizeString, applyTechnique, TECHS, TECHS_FOR, isSlapLine, soundOf, bendLabel, harmonicSound, convertAlphaTab, listGuitarTracks, yin, periodicityAt, Grader, generatePhrase, EndlessGen, randomTarget, mulberry32,
    ROOT_NAMES, CHORD_GROUPS, CHORDS, CHORD_TUNE, KEYS, MODES, PROGRESSIONS, Harmony, keysFor, degreeOptions, spellIn, chordName, isChord, pcsOf, randomChord, fftMag, chroma, judgeChord,
  };
});
