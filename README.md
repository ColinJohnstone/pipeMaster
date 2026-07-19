# pipeMaster

A modern, web-based sheet music **editor, viewer, and player** for the Great Highland Bagpipe and practice chanter — a professional-feeling successor to PiobMaster.

Runs entirely in the browser (local-first, no backend). Built with React + TypeScript + Vite.

## Run it

```sh
npm install
npm run dev        # dev server
npm test           # vitest suite (BWW round-trip + real-tune fixtures)
npm run build      # production build → dist/
```

## What it does today

- **Engraved notation** — custom SVG renderer using the Bravura (SMuFL) font, following pipe-music conventions: melody stems always down, embellishments as small stem-up beamed gracenote clusters, 4-bar systems, part numbers, repeats, first/second endings.
- **Semantic embellishments** — a note carries `{ type: 'doubling' }`, never hand-placed gracenotes. One registry defines each movement's gracenote expansion (doublings, half/thumb doublings, strikes, G/thumb strikes, grip, taorluath, birls, throws on D, pele, bubbly, single gracenotes) and drives rendering, playback, and file export alike.
- **Editing** — click the staff to enter notes; arrows change pitch, `1–6` set length, `.` dot, `t` tie; a **visual embellishment grid** (each shows its own gracenote shape) plus single-key shortcuts (`d` doubling, `g`/`e` graces, `s` strike, `b` birl, `r` grip, `l` taorluath, `w` throw); full undo/redo; add/remove bars and parts; repeats and **1st/2nd endings**; tune metadata.
- **Photo import (OMR)** — take or upload a photo of printed pipe music; a client-side computer-vision pipeline detects the staves and notehead **pitches** and drops them into the editor as a rough draft to refine. Rhythm and embellishments are added by hand.
- **Playback** — synthesized chanter (just-intonation scale against the drones) with bass + two tenor drones, Highland pipes (Low A ≈ 480 Hz) or practice chanter pitch, tempo control, moving cursor. Repeats and **first/second endings** are honoured. Optional **metronome** and one-bar **count-in** for practice. Space to play/stop.
- **Files** — autosaves to the browser (IndexedDB). Saves/opens native `.pms` (JSON). **Imports and exports Bagpipe Music Writer `.bww`** — the piping world's de facto format — validated against real published tunes. Exports **MusicXML** (`.musicxml`, opens in MuseScore/Sibelius/Finale), **MIDI** (`.mid`, with a drone layer), and print-optimised **PDF** — all from one Export menu.

## Architecture

```
src/
├─ core/
│  ├─ pitch.ts          # 9-note GHB scale, staff positions, just-intonation ratios
│  ├─ duration.ts       # note lengths, time signatures, beam grouping rules
│  ├─ model/            # Score → Part → Bar → Note types + factories
│  ├─ embellishments/   # semantic embellishment registry + gracenote expansions
│  ├─ bww/              # Bagpipe Music Writer parser/serializer
│  ├─ midi/             # Standard MIDI File export
│  ├─ musicxml/         # MusicXML export
│  └─ omr/              # Optical music recognition (photo → notes)
├─ layout/              # bars → systems geometry (widths, breaks, justification)
├─ render/              # SVG engraving (Bravura glyphs, beams, ties, voltas)
├─ audio/               # Web Audio: chanter + drone synthesis, event scheduling
├─ state/               # Zustand store, command-based undo/redo (immer patches)
└─ persistence/         # IndexedDB autosave, file open/save/export
```

## Roadmap

- `.piob`, MIDI, and MusicXML import
- Better OMR — rhythm/duration recognition, embellishment recognition, skew correction
- Cloud library, sharing, and band features (accounts/backend)
- Piobaireachd (the data model is designed for it; the editor isn't yet)
- Sampled chanter/drone sound packs behind the existing instrument interface
