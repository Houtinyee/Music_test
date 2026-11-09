# Fretline

Practice reading guitar tab while you play. Runs entirely in the browser, no build step.

## Run it

The microphone only works on `https://` pages or `http://localhost`, so serve the folder:

    cd fretline
    python3 -m http.server 8000
    # open http://localhost:8000

## What it does

- **Guitar or bass**: the switch in the header changes tuning, samples, drills, Endless mode and the pitch detector (bass reads down to low B, 31 Hz). Each instrument remembers its own song, and pasting a 4- or 5-line tab switches to bass automatically.
- **Chords (guitar)**: strums are checked as a whole chord, using the spectrum rather than single-note pitch, and you're told if it sounds like a different chord, has a wrong note, or is missing one. Chord names (C, Am, G7, C/E…) appear above the tab. Drills: *Play the chord* (mic) and *Name the chord*, from 12 chord sets (122 shapes) you pick: open major, open minor, open sevenths, sus, power chords, common barre chords, barre chords with the root on the 6th string (E shape, every major and minor from fret 1 to 9), barre chords with the root on the 5th string (A shape, same range), barre sevenths (7, m7, maj7), maj7/add9/6/9, slash chords (C/E, G/B, D/F#…), and diminished/augmented. Endless mode can send chords or a mix of notes and chords.
- **Techniques on single notes**: slides (`5/7`, `7\5`), hammer-ons and pull-offs (`5h7`, `7p5`), bends (`7b9`, `7b(9)`, bend and release `7b9r7`; ½, full, 1½), vibrato (`~`), muted notes (`x`), natural harmonics (`<12>`) and palm muting (a `PM-----` line above the tab). They're read from pasted tabs and Guitar Pro files, drawn on the tab (slide lines, h/p arcs, bend arrows with the amount, vibrato waves, x, PM, harmonic diamonds), played by *Hear the tab*, and graded by the mic: a bend has to reach its pitch ("Bend short: reached ½ of full"), hammer-ons, pull-offs and slides are heard as pitch changes without a new pick, and muted notes count as percussive hits. Pick which techniques Endless and random phrases use, and how often, in the Drills tab.
- **Bass techniques**: slap and pop (a line of `T` thumb / `P` pop letters under or over the tab; drawn under each note, played with a slap and a snap; Endless and phrases generate slap passages with the thumb on E/A, pops on D/G and octave pops) and ghost notes (`(5)`: drawn in brackets, played quiet, any light hit counts; also on guitar). Slides, hammer-ons, muted notes, palm mute, vibrato and harmonics work on bass too. The Techniques picker shows what fits each instrument and remembers guitar and bass choices separately. The mic grades slapped and popped notes by pitch and timing; it can't tell a slap from a fingered note, so T and P are there for you to follow.
- **Scrolling tab with a playhead**, count-in and click. Notes turn green (hit), red (missed or wrong).
- **Microphone grading** (YIN pitch detection + onset detection): hit/wrong/extra notes and early/late timing in ms. It measures the room noise itself and listens just above it, so quiet input works; it spots a new pick on a ringing string by the burst of highs even when the loudness barely changes; and while other strings ring it checks whether the note you are asked for is in the sound (a neighbouring pitch is still marked wrong). The meter shows the level with a tick where a note has to pass.
- **Wait for my note** mode: the tab holds until you play the highlighted note.
- **Loop a section** and a **speed trainer** that raises the tempo after each good pass.
- **Endless mode** (mode menu, or Drills tab): random material keeps coming until you stop, with hits, streak, best streak and accuracy. Settings:
  - *What comes*: single notes, chords, or chords and notes (guitar).
  - *Chord order* (so the chords sound good together): **common progressions** (I–V–vi–IV, I–vi–IV–V, ii–V–I, vi–ii–V–I, 12-bar blues; minor: i–VI–III–VII, i–VII–VI–V, i–iv–V–i…, each played twice), **stay in a key** (chords move the way songs usually do: V goes home to I, ii leads to V, IV goes to V or I), **circle of fifths** (each root falls a fifth: vi → ii → V → I → IV …), or random.
  - *Key*: auto (picks keys your chord sets can play) or any of the 24 keys; a key your sets can't cover borrows barre shapes. *Change key* every 8 or 16 bars to a neighbouring key (one step round the circle of fifths, or the relative major/minor).
  - Only shapes whose notes are all in the key are used (the blues' I7 and IV7 are the deliberate exception), shapes close to your hand are preferred, chord names are spelled the way the key is written (Db in Ab major, G#m in E major), and the tab shows each chord's Roman numeral (G V, Em vi).
  - In chords-and-notes, the notes between chords can come from the key's scale, moving mostly by step, so the melody fits the chords.
  - *New chord every* 1, 2, 4 or 8 beats; in chord mode, *strum* once, on every beat or every 2 beats.
  - Chords and notes: a chord lands on the downbeat every N beats and *rings* for 1 or 2 beats, then single notes fill the gap, either random (from the strings and frets you picked) or *from the chord*, like picking through the shape.
  - Note rhythm (quarter, eighth, mixed) and rests; speed-up (+N BPM every M hits, up to a maximum); and *end the run* after 3, 5 or 10 misses in a row.
- **Fretboard hint** showing where the next note sits on the neck.
- **Drills**: find the fret on your guitar (mic) or name the note, plus random phrases for sight-reading.
- **Input**: paste ASCII tab (6 lines for guitar, 4 or 5 for bass, highest string first) or import Guitar Pro files (.gp3/.gp4/.gp5/.gpx/.gp).

## On a phone

Open the published page (https, e.g. GitHub Pages) in the phone's browser and allow the microphone.

- The layout stacks to one column, buttons and chips are finger-sized, and inputs don't trigger the iPhone zoom.
- The screen stays on while you play or drill (where the browser supports it).
- Starting a run or loading a tab scrolls the tab back into view.
- **Full screen** shows only the tab and the play controls; tap the tab to play or pause. Turn the phone sideways to see more beats ahead.
- iPhone: sound from *Hear the tab* and the click follows the ring/silent switch, and with the mic on, iOS may play it through the earpiece; headphones avoid both.

## Files

- `index.html` UI and transport
- `core.js` tab parser, pitch detection, grader, exercise generator (pure logic)
- `test.js` `node test.js` runs the logic tests

## Limits

- Chord checking is lenient by design: chords that differ by one note the other strings already imply (A vs A7, Am vs Am7, C vs Cadd9) can pass for each other. Bass double stops count if any of their notes is heard.
- ASCII tabs carry no rhythm, so timing comes from dash spacing (set what a dash means in the Song tab).
- Guitar Pro repeats are not unrolled.
