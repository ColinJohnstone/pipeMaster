# pipeMaster — notes for Claude

Web-based bagpipe sheet music editor/viewer/player (PiobMaster successor). React + TS + Vite, no backend (local-first). The user (Colin) is a piper — musical correctness matters and they can adjudicate notation conventions.

## Commands
- `npm run dev` / `npm test` (vitest) / `npm run build` (tsc + vite)

## Load-bearing design decisions
- **Embellishments are semantic**: notes store `{ type: 'doubling' }`; gracenote sequences come from `src/core/embellishments/registry.ts`. Never add hand-placed gracenotes to the model. Rendering, playback, and BWW export all read the registry.
- **BWW is the interchange format** (`src/core/bww/bww.ts`). Token spellings were verified against the limepipes-plugin-bww symbol mapper and the real tune fixture `tests/fixtures/Balmoral.bww` (parses with zero warnings — keep it that way).
- **Engraving conventions** (renderer `src/render/ScoreView.tsx`): melody stems always down; gracenotes small, stems up, 3 mini-beams, above the staff; parts start new systems; max 4 bars/system; repeat-start sign goes after clef+time sig at a system start.
- **Pitch/audio**: 9-note scale in `src/core/pitch.ts`, just-intonation ratios vs Low A (pipes 480 Hz, practice chanter 440). Playback synthesizes one continuous chanter voice (frequency steps, no per-note envelopes) + drone stack — an intentional model of how pipes actually sound.
- Undo/redo = immer patches per command in `src/state/store.ts`; every edit goes through `apply()`.
- Layout geometry lives in `src/layout/layout.ts`; renderer consumes it and must not measure text.

## Roadmap context (user-approved plan)
Later phases: MIDI/MusicXML/.piob, OMR photo import, backend/accounts/sharing, piobaireachd (keep the model ready for it), sampled sound packs.
