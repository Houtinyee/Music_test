// Run with: node test.js
const TC = require('./core.js');
const assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const ODE = `e|0-0-1-3-|3-1-0---|------0-|0-------|
B|--------|------3-|1-1-3---|--3-3---|`;

t('a 2-line fragment is not a valid tab block', () => {
  assert.strictEqual(TC.parseAsciiTab(ODE, { dashesPerBeat: 2 }), null);
});

const FULL = `e|0-0-1-3-|3-1-0---|
B|--------|------3-|
G|--------|--------|
D|--------|--------|
A|--------|--------|
E|--------|--------|`;

t('6-line tab: beats, bars, midi', () => {
  const s = TC.parseAsciiTab(FULL, { dashesPerBeat: 2 });
  assert.strictEqual(s.strings, 6);
  assert.deepStrictEqual(s.events.map((e) => e.beat), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(s.events[0].notes[0].midi, 64);       // open e
  assert.strictEqual(s.events[3].notes[0].midi, 67);       // fret 3 on e = G4
  assert.strictEqual(s.events[7].notes[0].midi, 62);       // B string fret 3 = D4
  assert.deepStrictEqual(s.bars, [0, 4]);
  assert.strictEqual(s.totalBeats, 8);
});

t('chords and two-digit frets', () => {
  const tab = `e|--12--|
B|--13--|
G|--0---|
D|------|
A|------|
E|3-----|`;
  const s = TC.parseAsciiTab(tab, { dashesPerBeat: 2 });
  assert.strictEqual(s.events.length, 2);
  assert.strictEqual(s.events[0].notes[0].s, 5);
  const chord = s.events[1];
  assert.deepStrictEqual(chord.notes.map((x) => x.f), [12, 13, 0]);
  assert.strictEqual(chord.notes[0].midi, 64 + 12);
});

t('tuning from labels (drop D) and technique marks', () => {
  const tab = `e|-----|
B|-----|
G|-----|
D|-----|
A|-5h7-|
D|-0---|`;
  const s = TC.parseAsciiTab(tab, { dashesPerBeat: 2 });
  assert.strictEqual(s.tuning[5], 38);
  assert.strictEqual(s.events[0].notes[0].tech, 'h');
  assert.strictEqual(s.events[0].notes[0].midi, 45 + 5);
});

t('multiple blocks continue in time, no barlines gets auto bars', () => {
  const tab = `e|0---0---|
B|--------|
G|--------|
D|--------|
A|--------|
E|--------|

e|3---3---|
B|--------|
G|--------|
D|--------|
A|--------|
E|--------|`;
  const s = TC.parseAsciiTab(tab, { dashesPerBeat: 2 });
  assert.deepStrictEqual(s.events.map((e) => e.beat), [0, 2, 4, 6]);
  assert.deepStrictEqual(s.bars, [0, 4]);
});

t('non-tab text returns null', () => {
  assert.strictEqual(TC.parseAsciiTab('hello world\nnothing here'), null);
});

function synth(freq, sr, n, kind) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (i * freq) / sr;
    if (kind === 'saw') b[i] = 2 * (ph - Math.floor(ph + 0.5)) * 0.5;
    else if (kind === 'harm') b[i] = 0.3 * Math.sin(2 * Math.PI * ph) + 0.5 * Math.sin(4 * Math.PI * ph) + 0.4 * Math.sin(6 * Math.PI * ph);
    else b[i] = 0.5 * Math.sin(2 * Math.PI * ph);
  }
  return b;
}

t('YIN finds guitar pitches within 5 cents (44.1k and 48k)', () => {
  const cases = [['E2', 82.407], ['A2', 110], ['D3', 146.832], ['G3', 195.998], ['B3', 246.942], ['E4', 329.628], ['E5', 659.255]];
  for (const sr of [44100, 48000]) {
    for (const kind of ['sine', 'saw', 'harm']) {
      for (const [name, f] of cases) {
        const r = TC.yin(synth(f, sr, 2048, kind), sr);
        assert.ok(r, `${name} ${kind} ${sr} no result`);
        const cents = 1200 * Math.log2(r.freq / f);
        assert.ok(Math.abs(cents) < 5, `${name} ${kind} ${sr}: ${cents.toFixed(1)} cents`);
        assert.ok(r.clarity > 0.8);
      }
    }
  }
});

t('YIN rejects silence and noise', () => {
  assert.strictEqual(TC.yin(new Float32Array(2048), 48000), null);
  const noise = new Float32Array(2048);
  let seed = 1;
  for (let i = 0; i < noise.length; i++) { seed = (seed * 16807) % 2147483647; noise[i] = (seed / 2147483647 - 0.5) * 0.4; }
  const r = TC.yin(noise, 48000);
  assert.ok(!r || r.clarity < 0.8);
});

t('freq/midi/name helpers', () => {
  assert.strictEqual(TC.midiName(64), 'E4');
  assert.strictEqual(TC.midiName(40), 'E2');
  assert.ok(Math.abs(TC.freqToMidi(440) - 69) < 1e-9);
});

t('Grader: hit, wrong, miss, extra, octave leniency', () => {
  const s = TC.parseAsciiTab(FULL, { dashesPerBeat: 2 });
  const g = new TC.Grader(s.events);
  const tol = 0.4;
  assert.strictEqual(g.onNote(0.05, 64, tol).type, 'hit');
  assert.strictEqual(g.onNote(1.0, 99, tol).type, 'wrong');   // event 1 expects 64
  assert.strictEqual(g.status[1], 'wrong');
  assert.strictEqual(g.onNote(1.1, 64, tol).type, 'hit');     // corrected in time
  assert.strictEqual(g.status[1], 'hit');
  assert.strictEqual(g.onNote(2.0, 64 - 12, tol).type, 'wrong'); // event 2 expects F4 (65)
  assert.strictEqual(g.onNote(2.05, 65 - 12, tol).type, 'hit');  // octave lower accepted
  assert.strictEqual(g.onNote(50, 64, tol).type, 'extra');
  g.sweep(10, tol);
  const st = g.stats();
  assert.strictEqual(st.total, 8);
  assert.strictEqual(st.hit, 3);
  assert.strictEqual(st.extra, 1);
  assert.ok(st.accuracy > 0.37 && st.accuracy < 0.38);
});

t('Grader: range reset for loops', () => {
  const s = TC.parseAsciiTab(FULL, { dashesPerBeat: 2 });
  const g = new TC.Grader(s.events);
  g.reset(4, 8);
  assert.strictEqual(g.stats().total, 4);
  g.onNote(4, 67 - 0, 0.4); // event at beat 4 is fret 3 on e = 67
  assert.strictEqual(g.stats().hit, 1);
  g.reset(4, 8);
  assert.strictEqual(g.stats().hit, 0);
});

t('alphaTab conversion maps strings by pitch and merges voices', () => {
  const mk = (start, notes, extra) => Object.assign({ isRest: false, absolutePlaybackStart: start, playbackDuration: 960, notes }, extra || {});
  const fake = {
    title: 'Fake', tempo: 100,
    tracks: [{ name: 'Guitar', staves: [{ tuning: [64, 59, 55, 50, 45, 40], capo: 0, bars: [{
      masterBar: { start: 0, calculateDuration: () => 3840 },
      voices: [{ isEmpty: false, beats: [
        mk(0, [{ fret: 5, realValue: 69, string: 1 }]),                    // open 64 -> high e
        mk(960, [{ fret: 2, realValue: 47, string: 2 }, { fret: 0, realValue: 40, string: 6 }]), // open 45 (A) and open 40 (low E)
        mk(1920, [], { isRest: true }),
        mk(2880, [{ fret: 3, realValue: 48, string: 5, isTieDestination: true }]),
      ] }],
    }] }] }, { name: 'Drums', staves: [{ tuning: [], bars: [] }] }],
  };
  assert.deepStrictEqual(TC.listGuitarTracks(fake).map((x) => x.name), ['Guitar']);
  const s = TC.convertAlphaTab(fake, 0);
  assert.strictEqual(s.bpm, 100);
  assert.strictEqual(s.events.length, 2);
  assert.strictEqual(s.events[0].notes[0].s, 0);     // open 64 -> string 0 (high e)
  assert.deepStrictEqual(s.events[1].notes.map((x) => x.s), [4, 5]); // A string and low E, found by pitch not by string number
});

t('generatePhrase respects ranges and is seedable', () => {
  const a = TC.generatePhrase({ seed: 7, strings: [2, 3], fretMin: 5, fretMax: 8, bars: 2, perBeat: 2 });
  const b = TC.generatePhrase({ seed: 7, strings: [2, 3], fretMin: 5, fretMax: 8, bars: 2, perBeat: 2 });
  assert.deepStrictEqual(a.events, b.events);
  assert.strictEqual(a.events.length, 16);
  for (const e of a.events) {
    const nt = e.notes[0];
    assert.ok([2, 3].includes(nt.s) && nt.f >= 5 && nt.f <= 8);
    assert.strictEqual(nt.midi, TC.STANDARD[nt.s] + nt.f);
  }
  assert.strictEqual(a.totalBeats, 8);
});

t('EndlessGen: fills ahead, stays in range, no immediate repeats, bars cover', () => {
  const opts = { strings: [3, 4], fretMin: 2, fretMax: 6, perBeat: 1, rests: true };
  const gen = new TC.EndlessGen(opts, 42);
  const score = { events: [], bars: [] };
  gen.fill(score, 40);
  assert.ok(score.events.length >= 30 && score.events.length <= 40);
  assert.strictEqual(score.events[0].beat, 0);
  let sawRest = false;
  score.events.forEach((e, i) => {
    const nt = e.notes[0];
    assert.ok([3, 4].includes(nt.s) && nt.f >= 2 && nt.f <= 6);
    assert.strictEqual(nt.midi, TC.STANDARD[nt.s] + nt.f);
    if (i) {
      const p = score.events[i - 1];
      assert.ok(e.beat > p.beat);
      assert.ok(!(p.notes[0].s === nt.s && p.notes[0].f === nt.f), 'immediate repeat');
      if (e.beat - p.beat > 1.01) sawRest = true;
    }
  });
  assert.ok(sawRest, 'rests should appear');
  assert.ok(score.bars[0] === 0 && score.bars[score.bars.length - 1] >= 40);
  // calling fill again with the same horizon adds nothing, a farther horizon continues the beat sequence
  const n1 = score.events.length;
  gen.fill(score, 40);
  assert.strictEqual(score.events.length, n1);
  gen.fill(score, 60);
  assert.ok(score.events.length > n1 && score.events[n1].beat >= 40 - 1e-9);
});

t('EndlessGen: live option changes apply to later notes; mixed rhythm lands on half beats', () => {
  const opts = { strings: [0], fretMin: 0, fretMax: 3, perBeat: 0, rests: false };
  const gen = new TC.EndlessGen(opts, 5);
  const score = { events: [], bars: [] };
  gen.fill(score, 20);
  const cut = score.events.length;
  opts.strings = [5]; opts.fretMin = 7; opts.fretMax = 9; opts.perBeat = 2;
  gen.fill(score, 40);
  score.events.slice(0, cut).forEach((e) => { assert.strictEqual(e.notes[0].s, 0); assert.ok(e.beat * 2 === Math.round(e.beat * 2)); });
  score.events.slice(cut).forEach((e) => { assert.strictEqual(e.notes[0].s, 5); assert.ok(e.notes[0].f >= 7 && e.notes[0].f <= 9); });
  const steps = new Set(score.events.slice(0, cut - 1).map((e, i) => +(score.events[i + 1].beat - e.beat).toFixed(2)));
  assert.ok(steps.has(0.5) && steps.has(1), 'mixed rhythm uses both 1 and 0.5 beat steps');
});

t('Grader.extend keeps appended events gradable; sweep pointer skips finished events', () => {
  const gen = new TC.EndlessGen({ strings: [0], fretMin: 0, fretMax: 4, perBeat: 1, rests: false }, 9);
  const score = { events: [], bars: [] };
  gen.fill(score, 8);
  const g = new TC.Grader(score.events);
  g.reset(0, Infinity);
  gen.fill(score, 16);
  g.extend();
  assert.strictEqual(g.status.length, score.events.length);
  const e10 = score.events[10];
  assert.strictEqual(g.onNote(e10.beat, e10.notes[0].midi, 0.3).type, 'hit');
  const changed = g.sweep(12, 0.3);
  assert.ok(changed.length >= 10, 'older events become missed');
  assert.strictEqual(g.lo, 12); // events at beats 0..11 are all final (one hit, eleven missed)
  assert.strictEqual(g.status[10], 'hit');
  g.reset(0, Infinity);
  assert.strictEqual(g.lo, 0);
  assert.strictEqual(g.status[10], 'pending');
});

/* ---------- bass ---------- */

const BASS_TAB = `G|--------|--------|----2---|--------|
D|--------|--------|--------|--------|
A|----2---|----2---|0-0---0-|--------|
E|0-0---0-|0-0---0-|--------|0-------|`;

t('4-line bass tab parses with bass tuning', () => {
  const s = TC.parseAsciiTab(BASS_TAB, { dashesPerBeat: 2 });
  assert.strictEqual(s.strings, 4);
  assert.deepStrictEqual(s.tuning, [43, 38, 33, 28]);
  assert.strictEqual(TC.instrumentOf(s), 'bass');
  assert.strictEqual(s.events[0].notes[0].midi, 28);              // open E1
  assert.strictEqual(s.events[2].notes[0].midi, 35);              // A string fret 2 = B1
  assert.deepStrictEqual(s.bars, [0, 4, 8, 12]);
  assert.strictEqual(TC.instrumentOf(TC.parseAsciiTab(FULL)), 'guitar');
});

t('5-line tab parses as 5-string bass (low B)', () => {
  const tab = `G|------|
D|------|
A|------|
E|---0--|
B|-0----|`;
  const s = TC.parseAsciiTab(tab, { dashesPerBeat: 2 });
  assert.strictEqual(s.strings, 5);
  assert.strictEqual(s.events[0].notes[0].midi, 23);              // B0
  assert.strictEqual(TC.instrumentOf(s), 'bass');
});

t('generators and random targets use the bass tuning', () => {
  const ph = TC.generatePhrase({ seed: 3, tuning: TC.BASS, strings: [0, 1, 2, 3, 4, 5], fretMin: 0, fretMax: 5, bars: 2 });
  assert.strictEqual(ph.strings, 4);
  ph.events.forEach((e) => { const nt = e.notes[0]; assert.ok(nt.s < 4); assert.strictEqual(nt.midi, TC.BASS[nt.s] + nt.f); });

  const opts = { tuning: TC.BASS, strings: [5], fretMin: 0, fretMax: 3, perBeat: 1, rests: false }; // string 5 does not exist on bass
  const gen = new TC.EndlessGen(opts, 11);
  const score = { events: [], bars: [] };
  gen.fill(score, 16);
  score.events.forEach((e) => { const nt = e.notes[0]; assert.ok(nt.s < 4); assert.strictEqual(nt.midi, TC.BASS[nt.s] + nt.f); });

  const rnd = TC.mulberry32(1);
  for (let i = 0; i < 50; i++) {
    const tg = TC.randomTarget([0, 3], 0, 5, null, rnd, TC.BASS);
    assert.ok(tg.s === 0 || tg.s === 3);
    assert.strictEqual(tg.midi, TC.BASS[tg.s] + tg.f);
  }
});

t('YIN finds bass pitches (B0 to G3) within 5 cents using the latest buffer slice', () => {
  const inst = TC.INSTRUMENTS.bass;
  const cases = [['B0', 30.868], ['E1', 41.203], ['A1', 55], ['D2', 73.416], ['G2', 97.999], ['G3', 195.998], ['C4', 261.626]];
  for (const sr of [44100, 48000]) {
    const need = 1024 + Math.floor(sr / inst.minF) + 1;
    for (const kind of ['sine', 'saw', 'harm']) {
      for (const [name, f] of cases) {
        const full = synth(f, sr, inst.fft, kind);
        const r = TC.yin(full.subarray(full.length - need), sr, { minF: inst.minF, maxF: inst.maxF });
        assert.ok(r, `${name} ${kind} ${sr} no result`);
        const cents = 1200 * Math.log2(r.freq / f);
        assert.ok(Math.abs(cents) < 5, `${name} ${kind} ${sr}: ${cents.toFixed(1)} cents`);
      }
    }
  }
});

/* ---------- chords ---------- */

// Plucked-string strum: harmonics with pluck-position shaping, slight stiffness, 30 ms strum, background noise.
function strum(notes, sr, seed) {
  const rnd = TC.mulberry32(seed || 1), N = 8192, start = Math.round(0.2 * sr) - N, x = new Float32Array(N);
  notes.slice().sort((a, b) => b.s - a.s).forEach((nt, i, arr) => {
    const t0 = (i / Math.max(1, arr.length - 1)) * 0.03, f0 = TC.midiToFreq(nt.midi), beta = 0.1 + rnd() * 0.15;
    for (let h = 1; h <= 14; h++) {
      const fh = h * f0 * Math.sqrt(1 + 0.0001 * h * h), a = Math.abs(Math.sin(Math.PI * h * beta)) / Math.pow(h, 1.1), ph = rnd() * 6.283;
      for (let k = 0; k < N; k++) { const t = (start + k) / sr - t0; if (t > 0) x[k] += a * Math.exp(-(1.5 + 0.35 * h) * t) * Math.sin(6.283185 * fh * t + ph); }
    }
  });
  for (let k = 0; k < N; k++) x[k] += (rnd() - 0.5) * 0.01;
  return x;
}
const CH = (name) => TC.CHORDS.find((c) => c.name === name);

t('chord names: whole library, slash chords, no-fifth sevenths, non-chords', () => {
  TC.CHORDS.forEach((c) => assert.strictEqual(TC.chordName(c.notes), c.name, c.shape));
  const fromShape = (shape) => shape.split('').map((ch, i) => (ch === 'x' ? null : TC.STANDARD[5 - i] + Number(ch))).filter((m) => m != null);
  assert.strictEqual(TC.chordName(fromShape('032010')), 'C/E');
  assert.strictEqual(TC.chordName(fromShape('x32310')), 'C7');
  assert.strictEqual(TC.chordName([52, 64]), null);      // octave only
  assert.strictEqual(TC.chordName([60, 61, 62]), null);  // cluster
  assert.ok(TC.isChord({ notes: CH('G').notes }) && !TC.isChord({ notes: [{ midi: 52 }, { midi: 64 }] }));
});

t('chord judge: right chord hit, wrong chord and wrong fret rejected (44.1 and 48 kHz)', () => {
  for (const sr of [44100, 48000]) {
    for (const name of ['C', 'G', 'Am', 'D', 'E7', 'F', 'Bm', 'E5']) {
      const r = TC.judgeChord(TC.chroma(strum(CH(name).notes, sr, 7), sr), CH(name).notes);
      assert.ok(r.hit, `${name} @${sr}: ${JSON.stringify(r)}`);
    }
    const g = TC.chroma(strum(CH('G').notes, sr, 3), sr);
    const r = TC.judgeChord(g, CH('C').notes);
    assert.ok(!r.hit && r.heard === 'G', JSON.stringify(r));
    assert.ok(!TC.judgeChord(TC.chroma(strum(CH('Am').notes, sr, 4), sr), CH('E').notes).hit);
    // C with the D string at fret 3 (F instead of E): flagged as an extra note
    const slip = CH('C').notes.map((nt) => (nt.s === 3 ? Object.assign({}, nt, { f: 3, midi: nt.midi + 1 }) : nt));
    const rs = TC.judgeChord(TC.chroma(strum(slip, sr, 5), sr), CH('C').notes);
    assert.ok(!rs.hit && rs.extra.includes('F'), JSON.stringify(rs));
  }
});

t('Grader.onChord marks the matching strum hit, else nearest wrong with feedback', () => {
  const evs = [{ beat: 0, notes: CH('C').notes }, { beat: 1, notes: CH('G').notes }, { beat: 2, notes: CH('Am').notes }];
  const g = new TC.Grader(evs);
  const judgeAs = (heardName) => (ev) => ({ hit: TC.chordName(ev.notes) === heardName, heard: heardName });
  assert.strictEqual(g.onChord(0.05, 0.4, judgeAs('C')).type, 'hit');
  const w = g.onChord(1.1, 0.4, judgeAs('D'));
  assert.strictEqual(w.type, 'wrong');
  assert.strictEqual(g.info[1].heard, 'D');
  assert.strictEqual(g.onChord(1.15, 0.4, judgeAs('G')).type, 'hit'); // corrected in time
  assert.strictEqual(g.onChord(9, 0.4, judgeAs('G')).type, 'extra');
  g.sweep(10, 0.4);
  const st = g.stats();
  assert.strictEqual(st.hit, 2); assert.strictEqual(st.total, 3);
});

t('EndlessGen chord content: pool, length, strum on every beat, no repeats', () => {
  const pool = TC.CHORDS.filter((c) => c.group === 'minor' || c.group === 'major');
  const gen = new TC.EndlessGen({ content: 'chords', chords: pool, chordBeats: 4, strumEach: true }, 21);
  const score = { events: [], bars: [] };
  gen.fill(score, 32);
  assert.strictEqual(score.events.length, 32);                     // one strum per beat
  score.events.forEach((e, i) => {
    assert.ok(pool.some((c) => c.name === e.chord));
    assert.strictEqual(TC.chordName(e.notes), e.chord);
    assert.strictEqual(e.beat, i);
    if (i % 4) assert.strictEqual(e.chord, score.events[i - 1].chord);      // same chord within its bar
  });
  for (let b = 4; b < 32; b += 4) assert.notStrictEqual(score.events[b].chord, score.events[b - 4].chord);
  const mix = new TC.EndlessGen({ content: 'mix', chords: pool, fretMin: 0, fretMax: 3, perBeat: 1 }, 2);
  const ms = { events: [], bars: [] };
  mix.fill(ms, 60);
  const nCh = ms.events.filter((e) => e.chord).length;
  assert.ok(nCh > 3 && nCh < ms.events.length - 10, 'mix has both chords and single notes');
});

t('Endless mix: a chord on every 4th beat, notes fill the gaps without crossing it', () => {
  const pool = TC.CHORDS.filter((c) => c.group === 'major');
  for (const [per, len] of [[1, 1], [2, 1], [0, 2]]) {
    const gen = new TC.EndlessGen({ content: 'mix', chords: pool, chordEvery: 4, mixChordLen: len, perBeat: per, rests: true, fretMin: 0, fretMax: 5 }, 8);
    const sc = { events: [], bars: [] };
    gen.fill(sc, 64);
    const chordEvs = sc.events.filter((e) => e.chord);
    assert.strictEqual(chordEvs.length, 16, `per=${per} len=${len}`);              // one per bar
    chordEvs.forEach((e, i) => { assert.strictEqual(e.beat, i * 4); assert.strictEqual(e.dur, len); });
    sc.events.filter((e) => !e.chord).forEach((e) => {
      const inBar = e.beat % 4;
      assert.ok(inBar >= len - 1e-9, 'note while the chord rings');
      assert.ok(inBar + e.dur <= 4 + 1e-9, 'note runs over the next chord');
      assert.strictEqual(e.notes.length, 1);
    });
    for (let i = 1; i < sc.events.length; i++) assert.ok(sc.events[i].beat > sc.events[i - 1].beat);
  }
});

t('Endless mix: "notes from the chord" picks tones of the ringing chord', () => {
  const pool = TC.CHORDS.filter((c) => c.group === 'major' || c.group === 'minor');
  const gen = new TC.EndlessGen({ content: 'mix', chords: pool, chordEvery: 4, mixChordLen: 1, perBeat: 2, fill: 'chord' }, 4);
  const sc = { events: [], bars: [] };
  gen.fill(sc, 40);
  let cur = null;
  sc.events.forEach((e) => {
    if (e.chord) { cur = TC.CHORDS.find((c) => c.id === e.cid); return; }
    assert.ok(cur.notes.some((n) => n.s === e.notes[0].s && n.f === e.notes[0].f && n.midi === e.notes[0].midi), `${e.notes[0].s}/${e.notes[0].f} not in ${cur.name}`);
  });
});

t('Endless chords: chord every 1/2/4/8 beats with strum once / every beat / every 2 beats', () => {
  const pool = TC.CHORDS.filter((c) => c.group === 'minor');
  const cases = [[4, 1, 4], [4, 2, 2], [4, 0, 1], [8, 2, 4], [8, 0, 1], [2, 1, 2], [1, 2, 1], [1, 0, 1]];
  for (const [every, strum, perChord] of cases) {
    const gen = new TC.EndlessGen({ content: 'chords', chords: pool, chordEvery: every, strumEvery: strum }, 3);
    const sc = { events: [], bars: [] };
    gen.fill(sc, 32);
    assert.strictEqual(sc.events.length, (32 / every) * perChord, `every=${every} strum=${strum}`);
    for (let c = 0; c < 32 / every; c++) {
      const grp = sc.events.slice(c * perChord, (c + 1) * perChord);
      assert.strictEqual(grp[0].beat, c * every);
      assert.ok(grp.every((e) => e.chord === grp[0].chord));
      if (c) assert.notStrictEqual(grp[0].chord, sc.events[(c - 1) * perChord].chord);
    }
  }
});

t('Endless: switching from notes to chords mid-bar re-aligns chords to the grid', () => {
  const opts = { content: 'notes', perBeat: 2, chords: TC.CHORDS.filter((c) => c.group === 'major'), chordEvery: 4, strumEvery: 0 };
  const gen = new TC.EndlessGen(opts, 6);
  const sc = { events: [], bars: [] };
  gen.fill(sc, 5.5);                 // ends mid-bar
  opts.content = 'chords';
  gen.fill(sc, 24);
  const ch = sc.events.filter((e) => e.chord);
  assert.strictEqual(ch[0].beat, 5.5);
  assert.strictEqual(ch[0].dur, 2.5);   // fills up to beat 8
  ch.slice(1).forEach((e, i) => assert.strictEqual(e.beat, 8 + i * 4));
});

t('chord library: barre shapes across the neck, two-digit frets, unique ids, every name right', () => {
  assert.ok(TC.CHORDS.length >= 120, String(TC.CHORDS.length));
  assert.strictEqual(new Set(TC.CHORDS.map((c) => c.id)).size, TC.CHORDS.length);
  TC.CHORDS.forEach((c) => assert.strictEqual(TC.chordName(c.notes), c.name, c.id));
  const find = (group, name) => TC.CHORDS.find((c) => c.group === group && c.name === name);
  assert.strictEqual(find('barreE', 'G').shape, '355433');
  assert.strictEqual(find('barreE', 'Ab').shape, '466544');
  assert.strictEqual(find('barreA', 'C#m').shape, 'x46654');
  assert.strictEqual(find('barreA', 'F#m').shape, 'x 9 11 11 10 9');          // frets past 9 are spaced out
  assert.deepStrictEqual(find('barreA', 'F#m').notes.map((n) => n.f), [9, 10, 11, 11, 9]);
  assert.strictEqual(find('barre7', 'Cmaj7').shape, 'x35453');
  // every root is covered by the two barre families, major and minor
  for (const q of ['', 'm']) {
    const roots = new Set(TC.CHORDS.filter((c) => (c.group === 'barreE' || c.group === 'barreA') && c.name.slice(1).replace('#', '').replace(/^b/, '') === q).map((c) => c.name.replace(/m$/, '')));
    assert.strictEqual(roots.size, 12, q + ': ' + [...roots].join(' '));
  }
  TC.CHORD_GROUPS.forEach((g) => assert.ok(g.count > 0 && g.name, g.id));
});

t('chord judge recognises barre, colour, slash and dim/aug shapes', () => {
  const pick = (group, name) => TC.CHORDS.find((c) => c.group === group && c.name === name);
  const cases = [['barreE', 'Bb'], ['barreE', 'Gm'], ['barreA', 'C#m'], ['barreA', 'F#m'], ['barre7', 'B7'], ['barre7', 'Ebm7'],
    ['colour', 'Cadd9'], ['colour', 'E9'], ['slash', 'D/F#'], ['dim', 'Caug'], ['dim', 'Bm7b5']];
  for (const sr of [44100, 48000]) {
    for (const [g, name] of cases) {
      const ch = pick(g, name);
      assert.ok(TC.judgeChord(TC.chroma(strum(ch.notes, sr, 11), sr), ch.notes).hit, `${name} (${g}) @${sr}`);
    }
    // a barre G strummed when a barre Ab is asked for is caught
    assert.ok(!TC.judgeChord(TC.chroma(strum(pick('barreE', 'G').notes, sr, 2), sr), pick('barreE', 'Ab').notes).hit);
  }
});

/* ---------- harmony ---------- */

const groupsOf = (...ids) => TC.CHORDS.filter((c) => ids.includes(c.group));
const scaleOf = (key) => TC.MODES[key.mode].steps.map((x) => (x + key.tonic) % 12);
function harmonyRun(opts, seed, beats) {
  const gen = new TC.EndlessGen(Object.assign({ content: 'chords', chordEvery: 4, strumEvery: 0 }, opts), seed);
  const sc = { events: [], bars: [] };
  gen.fill(sc, beats || 128);
  return sc.events;
}

t('harmony: every chord belongs to the key (all orders, several chord sets and seeds)', () => {
  const pools = [groupsOf('major', 'minor'), groupsOf('major', 'minor', 'seventh'), groupsOf('barreE', 'barreA'), groupsOf('barreE', 'barreA', 'barre7', 'colour', 'sus', 'dim')];
  let n = 0;
  for (const harmony of ['key', 'progressions', 'circle']) {
    pools.forEach((pool, pi) => {
      for (let seed = 1; seed <= 6; seed++) {
        const evs = harmonyRun({ harmony, key: 'auto', chords: pool }, seed * 13 + pi);
        evs.forEach((e) => {
          assert.ok(e.key && e.roman, 'chord without key/roman');
          if (/^(I|IV)7$/.test(e.roman)) return;                 // 12-bar blues uses I7 and IV7 on purpose
          const key = TC.KEYS.find((k) => k.label === e.key), sc = scaleOf(key), lead = (key.tonic + 11) % 12;
          e.notes.forEach((nt) => {
            const p = nt.midi % 12;
            assert.ok(sc.includes(p) || (key.mode === 'minor' && p === lead), `${e.chord} (${e.roman}) not in ${e.key}`);
          });
          assert.ok(pool.some((c) => c.id === e.cid), 'chord from outside the chosen sets');
          assert.strictEqual(e.chord, TC.spellIn(TC.CHORDS.find((c) => c.id === e.cid).name, TC.KEYS.find((k) => k.label === e.key)));
          n++;
        });
      }
    });
  }
  assert.ok(n > 1000);
});

t('harmony: progressions mode plays known progressions, each twice', () => {
  const evs = harmonyRun({ harmony: 'progressions', key: 'C', chords: groupsOf('major', 'minor', 'seventh', 'barreE', 'barreA') }, 3, 4 * 64);
  const romans = evs.map((e) => e.roman.replace(/(maj7|7|6|add9|9)$/, ''));
  const bases = TC.PROGRESSIONS.major.map((p) => p.degs.map((d) => TC.MODES.major.degs[d][0]));
  let i = 0, found = 0;
  while (i < romans.length - 12) {
    const hit = bases.find((b) => b.every((r, k) => romans[i + k] === r) && b.every((r, k) => romans[i + b.length + k] === r));
    assert.ok(hit, 'no known progression at ' + i + ': ' + romans.slice(i, i + 8).join(' '));
    i += hit.length * 2; found++;
  }
  assert.ok(found >= 4, String(found));
});

t('harmony: circle of fifths moves the root down a fifth', () => {
  const evs = harmonyRun({ harmony: 'circle', key: 'auto', chords: groupsOf('barreE', 'barreA', 'barre7') }, 9, 4 * 40);
  let fifths = 0;
  for (let i = 1; i < evs.length; i++) {
    const a = TC.CHORDS.find((c) => c.id === evs[i - 1].cid).root, b = TC.CHORDS.find((c) => c.id === evs[i].cid).root;
    if ((a - b + 12) % 12 === 7) fifths++;
  }
  assert.ok(fifths / (evs.length - 1) >= 0.8, (fifths / (evs.length - 1)).toFixed(2)); // only the diminished step skips
});

t('harmony: functional moves (V goes home, ii goes to V) and smooth shape choice', () => {
  const evs = harmonyRun({ harmony: 'key', key: 'G', chords: groupsOf('major', 'minor', 'seventh', 'barreE', 'barreA', 'barre7') }, 4, 4 * 400);
  const base = (r) => r.replace(/(maj7|7|6|add9|9)$/, '');
  let fromV = 0, vHome = 0, fromII = 0, iiToV = 0, jumps = 0;
  for (let i = 1; i < evs.length; i++) {
    const a = base(evs[i - 1].roman), b = base(evs[i].roman);
    if (a === 'V') { fromV++; if (b === 'I' || b === 'vi') vHome++; }
    if (a === 'ii') { fromII++; if (b === 'V') iiToV++; }
    jumps += Math.abs(TC.CHORDS.find((c) => c.id === evs[i].cid).pos - TC.CHORDS.find((c) => c.id === evs[i - 1].cid).pos);
  }
  assert.ok(vHome / fromV >= 0.75, 'V resolves: ' + (vHome / fromV).toFixed(2));
  assert.ok(iiToV / fromII >= 0.5, 'ii -> V: ' + (iiToV / fromII).toFixed(2));
  const rnd = harmonyRun({ harmony: 'random', chords: groupsOf('major', 'minor', 'seventh', 'barreE', 'barreA', 'barre7') }, 4, 4 * 400);
  let rj = 0;
  for (let i = 1; i < rnd.length; i++) rj += Math.abs(TC.CHORDS.find((c) => c.id === rnd[i].cid).pos - TC.CHORDS.find((c) => c.id === rnd[i - 1].cid).pos);
  assert.ok(jumps / evs.length < 0.6 * (rj / rnd.length), `hand moves ${(jumps / evs.length).toFixed(2)} vs random ${(rj / rnd.length).toFixed(2)} frets per change`);
  assert.ok(!rnd[0].roman && !rnd[0].key, 'random order has no key');
});

t('harmony: auto key fits the chosen sets; a key the sets cannot play borrows barre shapes', () => {
  const open = groupsOf('major', 'minor');
  assert.deepStrictEqual(TC.keysFor(open, 4).map((x) => x.key.id).sort(), ['Am', 'C', 'D', 'Em', 'G']);
  for (let seed = 1; seed < 15; seed++) assert.ok(['C major', 'G major', 'A minor', 'E minor', 'D major'].includes(harmonyRun({ harmony: 'key', key: 'auto', chords: open }, seed, 8)[0].key));
  const bb = harmonyRun({ harmony: 'progressions', key: 'Bb', chords: open }, 2, 64);
  assert.ok(bb.every((e) => e.key === 'Bb major'));
  assert.ok(bb.some((e) => ['barre', 'barreE', 'barreA'].includes(TC.CHORDS.find((c) => c.id === e.cid).group)));
});

t('harmony: changing key every 8 bars moves to a neighbouring key', () => {
  const evs = harmonyRun({ harmony: 'key', key: 'auto', modulate: 8, chords: groupsOf('barreE', 'barreA', 'barre7') }, 12, 4 * 200);
  const keys = [];
  evs.forEach((e) => { if (keys[keys.length - 1] !== e.key) keys.push(e.key); });
  assert.ok(keys.length >= 5, keys.join(' > '));
  for (let i = 1; i < keys.length; i++) {
    const a = TC.KEYS.find((k) => k.label === keys[i - 1]), b = TC.KEYS.find((k) => k.label === keys[i]);
    const rel = a.mode !== b.mode && ((a.mode === 'major' ? a.tonic + 9 : a.tonic + 3) % 12) === b.tonic;
    const fifth = a.mode === b.mode && [5, 7].includes((b.tonic - a.tonic + 12) % 12);
    assert.ok(rel || fifth, keys[i - 1] + ' > ' + keys[i]);
  }
});

t('mix: notes from the key scale stay in key and move mostly by step', () => {
  const gen = new TC.EndlessGen({ content: 'mix', harmony: 'progressions', key: 'G', chords: groupsOf('major', 'minor'), chordEvery: 4, mixChordLen: 1, perBeat: 2, fill: 'scale', fretMin: 0, fretMax: 5 }, 7);
  const sc = { events: [], bars: [] };
  gen.fill(sc, 4 * 50);
  const g = scaleOf(TC.KEYS.find((k) => k.id === 'G'));
  const notes = sc.events.filter((e) => !e.chord);
  notes.forEach((e) => assert.ok(g.includes(e.notes[0].midi % 12)));
  let steps = 0;
  for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i].notes[0].midi - notes[i - 1].notes[0].midi) <= 4) steps++;
  assert.ok(steps / (notes.length - 1) > 0.6, (steps / (notes.length - 1)).toFixed(2));
});

t('chord names are spelled the way the key is written', () => {
  const K = (id) => TC.KEYS.find((k) => k.id === id);
  assert.strictEqual(TC.KEYS.length, 24);
  assert.strictEqual(new Set(TC.KEYS.map((k) => k.id)).size, 24);
  assert.strictEqual(TC.spellIn('C#', K('Ab')), 'Db');
  assert.strictEqual(TC.spellIn('F#m7', K('Ebm')), 'Gbm7');
  assert.strictEqual(TC.spellIn('Abm', K('E')), 'G#m');
  assert.strictEqual(TC.spellIn('Eb', K('B')), 'D#');
  assert.strictEqual(TC.spellIn('D/F#', K('G')), 'D/F#');
  assert.strictEqual(TC.spellIn('Bb', K('C')), 'Bb');                    // C major / A minor: left as written
  assert.ok(K('Db') && K('G#m') && !TC.KEYS.find((k) => k.label === 'C# major'));
  // a whole run in Ab major never shows a sharp
  const evs = harmonyRun({ harmony: 'key', key: 'Ab', chords: groupsOf('barreE', 'barreA', 'barre7') }, 5, 200);
  assert.ok(evs.every((e) => !e.chord.includes('#')), evs.map((e) => e.chord).join(' '));
});

/* ---------- techniques ---------- */

const six = (rows) => rows.join('\n');
t('tab techniques: hammer-on, pull-off, slide, bend (+release), vibrato, muted, harmonic', () => {
  const sc = TC.parseAsciiTab(six([
    'e|----5b7-----5---|7b9r7-----------|',
    'B|5h7-----------8-|----------------|',
    'G|----------------|----7/9~~~------|',
    'D|----------------|----------7p5-x-|',
    'A|----------------|--------------<12>',
    'E|----------------|----------------|']), { dashesPerBeat: 4 });
  const at = (beat, s) => sc.events.find((e) => e.beat === beat).notes.find((x) => x.s === s);
  assert.deepStrictEqual([at(0, 1).f, at(0, 1).tech, at(0.5, 1).f, at(0.5, 1).legato], [5, 'h', 7, 'h']);
  assert.deepStrictEqual([at(1, 0).f, at(1, 0).bend, TC.soundOf(at(1, 0))], [5, 2, 71]);      // 5b7 is ONE note, bent a tone
  assert.ok(!sc.events.some((e) => e.beat === 1.5 && e.notes.some((x) => x.s === 0)), 'bend target is not a separate note');
  assert.deepStrictEqual([at(4, 0).bend, at(4, 0).release], [2, true]);                        // 7b9r7
  assert.deepStrictEqual([at(5, 2).slideTo, at(5.5, 2).legato, at(5.5, 2).vib], [true, 'slide', true]);
  assert.deepStrictEqual([at(6.5, 3).tech, at(7, 3).legato, at(7, 3).f], ['p', 'p', 5]);
  assert.ok(at(7.5, 3).dead && at(7.5, 3).midi === null && TC.soundOf(at(7.5, 3)) === null);
  assert.ok(at(7.5, 4).harm && at(7.5, 4).sound === 45 + 12);
  assert.strictEqual(TC.bendLabel(2), 'full'); assert.strictEqual(TC.bendLabel(1), '½');
});

t('tab techniques: half bends, b(9) form, PM line above the tab, muted strum is not a chord', () => {
  const pmTab = [
    '                   PM-------------|',
    'e|----------------|----------------|',
    'B|----------------|----------------|',
    'G|----------------|----------------|',
    'D|7b8-------------|----------------|',
    'A|5b(7)-----------|----------------|',
    'E|----------------|0-0-0-0-3-3-x-x-|'].join('\n');
  const sc = TC.parseAsciiTab(pmTab, { dashesPerBeat: 4 });
  const first = sc.events[0];
  assert.deepStrictEqual(first.notes.map((x) => [x.s, x.bend]), [[3, 1], [4, 2]]);
  const pm = sc.events.filter((e) => e.beat >= 4).map((e) => !!e.notes[0].pm);
  assert.ok(pm.every(Boolean), 'notes under PM---- are palm muted: ' + pm.join());
  assert.ok(!first.notes.some((x) => x.pm), 'notes outside the PM span are not');
  const strum = TC.parseAsciiTab(six(['e|x-|', 'B|x-|', 'G|x-|', 'D|x-|', 'A|x-|', 'E|x-|']).replace(/-\|/g, '---|'), { dashesPerBeat: 2 });
  assert.ok(strum.events[0].notes.every((x) => x.dead) && !TC.isChord(strum.events[0]));
  // the old example still reads the same
  const old = TC.parseAsciiTab(six(['e|-----|', 'B|-----|', 'G|-----|', 'D|-----|', 'A|-5h7-|', 'D|-0---|']), { dashesPerBeat: 2 });
  assert.strictEqual(old.events[0].notes[0].tech, 'h');
});

t('grading: bends count at their peak, muted notes accept any hit, no-pitch hits never count as wrong', () => {
  const sc = TC.parseAsciiTab(six(['e|7b9-----|', 'B|--------|', 'G|--------|', 'D|----x---|', 'A|--------|', 'E|--------|']), { dashesPerBeat: 2 });
  const g = new TC.Grader(sc.events);
  assert.ok(TC.Grader.matches(sc.events[0], 64 + 9) && !TC.Grader.matches(sc.events[0], 64 + 7), 'bent note must reach the bent pitch');
  assert.strictEqual(g.onNote(2.02, null, 0.4).type, 'hit');            // muted hit on the x
  assert.strictEqual(g.onNote(0.05, null, 0.4).type, 'none');            // pitchless hit near a pitched note: ignored
  assert.strictEqual(g.status[0], 'pending');
  assert.strictEqual(g.onNote(0.05, 64 + 9, 0.4).type, 'hit');
  assert.strictEqual(TC.Grader.matches(sc.events[1], 50), true);         // a pitched hit on a muted note is fine too
});

t('Guitar Pro import keeps techniques (bend, release, hammer, slide, palm mute, vibrato, muted, harmonic)', () => {
  const N = (o) => Object.assign({ fret: 5, string: 1, realValue: 64 + 5 }, o);
  const origin = N({ fret: 5, isHammerPullOrigin: true });
  const beats = [
    { s: 0, notes: [N({ bendPoints: [{ value: 0 }, { value: 4 }, { value: 0 }] })] },
    { s: 960, notes: [origin] },
    { s: 1920, notes: [N({ fret: 7, realValue: 71, hammerPullOrigin: origin })] },
    { s: 2880, notes: [N({ fret: 7, realValue: 71, slideOutType: 1, isPalmMute: true })] },
    { s: 3840, notes: [N({ fret: 9, realValue: 73, slideOrigin: {}, vibrato: 1 })] },
    { s: 4800, notes: [N({ fret: 12, realValue: 76, harmonicType: 1 }), N({ string: 1, fret: 0, realValue: null, isDead: true })] },
  ].map((b) => ({ isRest: false, absolutePlaybackStart: b.s, playbackDuration: 960, notes: b.notes }));
  const at = { title: 'T', tempo: 90, tracks: [{ name: 'Gtr', staves: [{ tuning: [64, 59, 55, 50, 45, 40], capo: 0, bars: [{ masterBar: { start: 0, calculateDuration: () => 7680 }, voices: [{ isEmpty: false, beats }] }] }] }] };
  const sc = TC.convertAlphaTab(at, 0);
  const n = (i) => sc.events[i].notes[0];
  assert.deepStrictEqual([n(0).bend, n(0).release], [2, true]);
  assert.deepStrictEqual([n(1).tech, n(2).legato], ['h', 'h']);
  assert.deepStrictEqual([n(3).slideTo, n(3).pm, n(4).legato, n(4).vib], [true, true, 'slide', true]);
  assert.ok(sc.events[5].notes.some((x) => x.harm && x.sound === 64 + 12) && sc.events[5].notes.some((x) => x.dead && x.s === 5));
});

t('generated techniques only go where they can be played', () => {
  const all = ['slide', 'legato', 'bend', 'dead', 'pm', 'vib', 'harm'];
  let seen = new Set();
  for (const [tuning, perBeat] of [[TC.STANDARD, 2], [TC.STANDARD, 0], [TC.BASS, 1]]) {
    for (let seed = 1; seed <= 8; seed++) {
      const gen = new TC.EndlessGen({ content: 'notes', tuning, perBeat, rests: true, fretMin: 2, fretMax: 7, techs: all, techRate: 0.5 }, seed);
      const sc = { events: [], bars: [] };
      gen.fill(sc, 64);
      sc.events.forEach((e, i) => {
        const n = e.notes[0], p = sc.events[i - 1];
        if (n.legato) {
          seen.add(n.legato);
          assert.ok(p && Math.abs(p.beat + p.dur - e.beat) < 1e-6, 'legato after a gap');
          const q = p.notes[0];
          assert.strictEqual(q.s, n.s, 'legato across strings');
          assert.ok(!q.dead && !q.bend && !q.harm);
          if (n.legato === 'slide') assert.ok(q.slideTo && q.tech === '/' && Math.abs(q.f - n.f) >= 2);
          else { assert.strictEqual(q.tech, n.legato); assert.ok(n.legato === 'h' ? n.f > q.f : n.f < q.f); assert.ok(Math.abs(q.f - n.f) <= 3); }
        }
        if (n.bend) { seen.add('bend'); assert.ok(n.s <= (tuning.length === 6 ? 3 : 1) && n.f >= 2 && [1, 2, 3].includes(n.bend)); }
        if (n.pm) { seen.add('pm'); assert.ok(tuning.length < 6 || n.s >= 3, 'palm mute on a high string'); }
        if (n.vib) { seen.add('vib'); assert.ok(e.dur >= 1, 'vibrato on a short note'); }
        if (n.harm) { seen.add('harm'); assert.ok([12, 7, 5].includes(n.f) && n.sound === TC.harmonicSound(tuning[n.s], n.f)); }
        if (n.dead) { seen.add('dead'); assert.ok(n.midi === null); }
        if (!n.dead && !n.harm && !n.legato) assert.ok(n.f >= 2 && n.f <= 7, 'fret ' + n.f);
        if (!n.dead) assert.strictEqual(n.midi, tuning[n.s] + n.f);
      });
    }
  }
  assert.deepStrictEqual([...seen].sort(), ['bend', 'dead', 'h', 'harm', 'p', 'pm', 'slide', 'vib']);
});

t('"notes from the chord" keeps chord tones even with techniques on', () => {
  const pool = TC.CHORDS.filter((c) => c.group === 'major' || c.group === 'minor');
  const gen = new TC.EndlessGen({ content: 'mix', chords: pool, chordEvery: 4, mixChordLen: 1, perBeat: 1, fill: 'chord', techs: ['slide', 'legato', 'bend', 'harm', 'dead', 'pm', 'vib'], techRate: 0.8 }, 3);
  const sc = { events: [], bars: [] };
  gen.fill(sc, 160);
  let cur = null, changed = 0;
  sc.events.forEach((e) => {
    if (e.chord) { cur = TC.CHORDS.find((c) => c.id === e.cid); return; }
    const n = e.notes[0];
    if (n.dead) { changed++; return; }
    assert.ok(!n.legato && !n.bend && !n.harm, JSON.stringify(n));
    assert.ok(cur.notes.some((q) => q.s === n.s && q.f === n.f), 'not a chord tone');
    if (n.pm || n.vib) changed++;
  });
  assert.ok(changed > 0, 'muting / palm mute / vibrato still apply');
});

t('techniques in a key stay in the key; no techniques chosen means plain notes as before', () => {
  const gen = new TC.EndlessGen({ content: 'mix', harmony: 'progressions', key: 'G', chords: TC.CHORDS.filter((c) => c.group === 'major' || c.group === 'minor'), chordEvery: 4, mixChordLen: 1, perBeat: 2, fill: 'scale', fretMin: 0, fretMax: 7, techs: ['slide', 'legato', 'bend', 'harm'], techRate: 0.6 }, 5);
  const sc = { events: [], bars: [] };
  gen.fill(sc, 160);
  const g = [7, 9, 11, 0, 2, 4, 6];
  const notes = sc.events.filter((e) => !e.chord);
  assert.ok(notes.some((e) => e.notes[0].bend || e.notes[0].legato));
  notes.forEach((e) => { const t = TC.soundOf(e.notes[0]); assert.ok(g.includes(t % 12), 'out of key: ' + JSON.stringify(e.notes[0])); });
  const a = TC.generatePhrase({ seed: 7, bars: 2, perBeat: 2, fretMin: 0, fretMax: 5 });
  const b = TC.generatePhrase({ seed: 7, bars: 2, perBeat: 2, fretMin: 0, fretMax: 5, techs: [] });
  assert.deepStrictEqual(a.events, b.events);
  assert.ok(a.events.every((e) => !e.notes[0].legato && !e.notes[0].bend));
  const c = TC.generatePhrase({ seed: 7, bars: 4, perBeat: 2, fretMin: 0, fretMax: 5, techs: ['legato', 'slide'], techRate: 0.6 });
  assert.ok(c.events.some((e) => e.notes[0].legato));
});

/* ---------- bass techniques ---------- */

const SLAP = `G|----------------|--2-------------|\nD|--2-------5-----|----------------|\nA|--------------2-|0---x-0-2/5-----|\nE|0---x-0-3---(3)-|------------0-x-|\n  T P   T T P   T  T P   T T   T`;
t('bass tab: T/P line under the tab marks thumb and pop; (3) is a ghost note', () => {
  const sc = TC.parseAsciiTab(SLAP, { dashesPerBeat: 4 });
  const at = (b) => sc.events.find((e) => e.beat === b).notes[0];
  assert.strictEqual(sc.strings, 4);
  assert.deepStrictEqual([at(0).slap, at(0.5).slap, at(0.5).s, at(0.5).f], ['T', 'P', 1, 2]);          // octave pop
  assert.strictEqual(TC.soundOf(at(0.5)) - TC.soundOf(at(0)), 12);
  assert.ok(at(3).ghost && at(3).f === 3 && !at(3).slap);
  assert.ok(at(1).dead && !at(1).slap, 'no letter on a muted note');
  assert.strictEqual(at(6.5).legato, 'slide');
  assert.strictEqual(sc.events.filter((e) => e.notes[0].slap).length, 11);
});

t('T/P line above the tab works too, and a T/P line between two blocks belongs to the one above', () => {
  const up = TC.parseAsciiTab(['  T     P', 'G|------3-|', 'D|--------|', 'A|--------|', 'E|0-------|'].join('\n'), { dashesPerBeat: 2 });
  assert.deepStrictEqual(up.events.map((e) => e.notes[0].slap), ['T', 'P']);
  const two = TC.parseAsciiTab(['G|--------|', 'D|--------|', 'A|--------|', 'E|0---0---|', '  T   T', 'G|--------|', 'D|--------|', 'A|--------|', 'E|0---0---|'].join('\n'), { dashesPerBeat: 2 });
  assert.deepStrictEqual(two.events.map((e) => e.notes[0].slap || '-'), ['T', 'T', '-', '-']);
  // a PM line is not mistaken for slap letters
  const pm = TC.parseAsciiTab(['  PM-----', 'G|--------|', 'D|--------|', 'A|--------|', 'E|0-0-0---|'].join('\n'), { dashesPerBeat: 2 });
  assert.ok(pm.events.every((e) => e.notes[0].pm && !e.notes[0].slap));
  assert.ok(!TC.isSlapLine('PM----') && TC.isSlapLine('  T  P  S') && !TC.isSlapLine('Verse 1'));
});

t('ghost notes accept any hit, like muted notes', () => {
  const sc = TC.parseAsciiTab(SLAP, { dashesPerBeat: 4 });
  const ghost = sc.events.find((e) => e.beat === 3);
  assert.ok(TC.Grader.matches(ghost, null) && TC.Grader.matches(ghost, 40) && TC.Grader.matches(ghost, 31));
  const g = new TC.Grader(sc.events);
  assert.strictEqual(g.onNote(3.02, null, 0.3).type, 'hit');
});

t('generated slap passages: thumb on the low strings, pop on the high ones, octave pops; never on guitar', () => {
  let pops = 0, octave = 0, ghosts = 0, slaps = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const gen = new TC.EndlessGen({ content: 'notes', tuning: TC.BASS, perBeat: 2, rests: true, fretMin: 0, fretMax: 7, techs: ['slap', 'ghost', 'slide', 'legato'], techRate: 0.4 }, seed);
    const sc = { events: [], bars: [] };
    gen.fill(sc, 64);
    sc.events.forEach((e, i) => {
      const n = e.notes[0];
      if (n.ghost) ghosts++;
      if (!n.slap) return;
      slaps++;
      assert.ok(n.slap === 'T' ? n.s >= 2 : n.s <= 1, `${n.slap} on string ${n.s}`);
      if (n.slap === 'P') {
        pops++;
        const p = sc.events[i - 1] && sc.events[i - 1].notes[0];
        if (p && p.slap === 'T' && n.s === p.s - 2 && n.f === p.f + 2) { octave++; assert.strictEqual(n.midi - p.midi, 12); }
      }
      assert.strictEqual(n.midi, TC.BASS[n.s] + n.f);
    });
  }
  assert.ok(slaps > 40 && pops > 5 && octave > 2 && ghosts > 5, `slaps ${slaps}, pops ${pops}, octave pops ${octave}, ghosts ${ghosts}`);
  const gtr = new TC.EndlessGen({ content: 'notes', perBeat: 2, techs: ['slap', 'ghost'], techRate: 0.8 }, 3);
  const gs = { events: [], bars: [] }; gtr.fill(gs, 64);
  assert.ok(gs.events.every((e) => !e.notes[0].slap) && gs.events.some((e) => e.notes[0].ghost));
  assert.ok(TC.TECHS_FOR.bass.all.includes('slap') && !TC.TECHS_FOR.guitar.all.includes('slap'));
  assert.deepStrictEqual(TC.TECHS_FOR.bass.on, ['slide', 'legato', 'slap', 'ghost']);
});

t('periodicityAt: finds a note among other ringing notes, and not a neighbouring pitch', () => {
  const sr = 44100, N = 4096, buf = new Float32Array(N);
  const f = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // A3 (57) plays loudest while E2 (40) and E3 (52) ring underneath
  const tone = (m, a, i) => { let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f(m) * h * i / sr) * a / h; return v; }; // a plucked string has strong harmonics
  for (let i = 0; i < N; i++) buf[i] = tone(57, 0.5, i) + tone(40, 0.3, i) + tone(52, 0.3, i);
  const at = TC.periodicityAt(buf, sr, f(57));
  assert.ok(at > 0.3 && at > 3 * TC.periodicityAt(buf, sr, f(59)) && at > TC.periodicityAt(buf, sr, f(58)), 'in the mix ' + at);
  for (let i = 0; i < N; i++) buf[i] = tone(57, 0.5, i);
  const alone = TC.periodicityAt(buf, sr, f(57));
  assert.ok(alone > 0.95 && alone > TC.periodicityAt(buf, sr, f(56)) && alone > TC.periodicityAt(buf, sr, f(58)), 'alone ' + alone);
});

console.log(`\n${n} test groups passed`);
