# DJMAN prototype: local playlist mixer

A browser prototype for testing the DJMAN hardware interactions. Load local music into a playlist and it mixes automatically according to the BLEND / BUILD / EXIT faders on the panel; the screen shows the playing track and the next one side by side. All audio is processed in the browser with the Web Audio API and nothing is uploaded.

## Run

```bash
npm install
npm run dev     # http://localhost:8080
```

## Structure

| File | Contents |
|---|---|
| `src/djman/DjmanApp.tsx` | Page markup: device and side column (status, playlist, current settings), then the user manual below. The manual's line drawing and control list are generated from the `MANUAL` table in `engine.js`. The engine finds elements by `id`, so keep the ids when changing the layout. |
| `src/djman/engine.js` | All logic: audio engine, BPM / beat / key analysis, transition scheduling (including live changes during a transition), device panel SVG, two-track screen, sample synthesis and loops, playlist UI. |
| `src/djman/djman.css` | Styles and light / dark theme variables. |

`engine.js` is split into commented sections: `definitions`, `deck`, `analysis`, `key` (key detection and harmonic sorting), `settings`, `scheduling` (`curvesFor` / `reschedule` hold the transition curves and live edits), `transport`, `jog`, `master fx`, `samples`, `sample loops`, `device SVG`, `screen`, `companion UI`.

## Panel

- **BLEND / BUILD / EXIT faders**: the fader positions apply to every upcoming transition; moving them during a transition takes effect right away.
  - BLEND: Fade / Bass Swap / Filter / Cut, with 4 / 8 / 16 bar length keys below
  - BUILD: None / Loop Roll / Riser / Swoosh
  - EXIT: None / Echo / Reverb / Downsweep / Vinyl Break (forces BLEND to Cut)
- **FX ring**: NONE / ECHO / REVERB / FLANGER / GATER / ROLL, with the FILTER knob in the center
- **Red lever (top right)**: effect amount (keyboard `[` lowers it, `]` raises it; hold for a smooth sweep)
- **Jog wheel**: scratch like a turntable (about 1.8 s per turn, spins back up to speed on release); hold SHIFT while turning to seek quickly (about 32 bars per turn, snaps to the bar); red center button plays / pauses
- **Bottom pads**: DRUM / BASS / MELODY / VOCAL samples (keys 1–4); the red side key on the right changes the sample set; press a pad then SHIFT (lower left side key / keyboard Shift) to loop it on the beat, press the pad again to stop
- **MIX key (bottom left)**: transition now; upper left side key: volume
- **Playlist**: songs get a detected key (Camelot) and are sorted by KEY / BPM automatically; reorder by hand or press "Re-sort by KEY / BPM"

## Audius

The playlist card has an **Add from Audius** panel: search by artist or song, or browse this week's trending tracks by genre, then press **Add**. Audius tracks are downloaded as MP3 and go through the same analysis and mixing as local files (they are marked AUDIUS in the playlist).

- API: `https://api.audius.co/v1` (`/tracks/search`, `/tracks/trending`, `/tracks/{id}/stream`), identified with `app_name=DJMAN`.
- Optional: put a free API key from https://api.audius.co/plans into `AUDIUS_API_KEY` in `engine.js` for higher rate limits. Never put an API secret or bearer token in this frontend code.
- Gated tracks (paid, follow-gated and so on) are hidden from the results.
- Check the Audius terms before releasing a product built on the catalog.

## Known limitations

- Beatmatching changes playback speed, so the pitch shifts slightly (no key lock).
- BPM detection is sometimes half or double the real tempo; fix it with ÷2 / ×2 in the playlist.
- Key detection uses spectral chroma and Krumhansl key profiles. It works well for music with clear harmony but occasionally confuses major and minor.
- The samples are synthesized placeholders.
- The jog wheel uses `ScriptProcessorNode` (deprecated but still supported by browsers).
