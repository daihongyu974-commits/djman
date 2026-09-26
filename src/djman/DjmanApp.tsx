import { useEffect } from "react";
import { initDjman } from "./engine";
import "./djman.css";

/**
 * Page markup for the DJMAN prototype. The engine (engine.js) looks elements up
 * by id, so keep the ids below when restyling or moving things around.
 */
export default function DjmanApp() {
  useEffect(() => {
    const cleanup = initDjman();
    return cleanup;
  }, []);

  return (
    <main>
      <header className="mast">
        <h1>DJMAN<span>Local playlist mixing prototype</span></h1>
        <p>The screen shows the playing track and the next one side by side; the colored lines show the BLEND, BUILD and EXIT automation. Audio is processed only in this browser and never uploaded.</p>
      </header>

      <div className="stage">
        <div className="device" id="device">
          <svg id="dev" viewBox="0 0 1230 1201" aria-label="DJMAN device panel"></svg>
          <canvas id="screen" aria-label="Two-track screen"></canvas>
        </div>
        <aside className="side">
          <div className="card">
            <h2>Status</h2>
            <div className="status" id="status" aria-live="polite">Add music, then press the red button in the middle of the jog wheel to start.</div>
            <div className="helpers">
              <button className="hbtn primary" id="addBtn">Add local music</button>
              <button className="hbtn" id="jumpBtn">Jump to transition</button>
              <input type="file" id="fileIn" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.aiff,.aif" multiple className="sr" />
            </div>
          </div>
          <section className="card list-panel" aria-label="Playlist">
            <div className="list-head">
              <div>
                <h2>Playlist</h2>
                <p>New songs are sorted automatically by KEY (Camelot) and BPM; use the arrows to change the order afterwards. BPM is sometimes detected at half or double the real tempo; fix it with ÷2 / ×2.</p>
              </div>
              <button className="hbtn" id="sortBtn">Re-sort by KEY / BPM</button>
            </div>
            <div className="audius">
              <h3>Add from Audius</h3>
              <div className="audius-bar">
                <input id="audiusQ" type="search" placeholder="Search artists or songs" aria-label="Search Audius" />
                <button className="hbtn" id="audiusSearch">Search</button>
              </div>
              <div className="audius-bar">
                <select id="audiusGenre" aria-label="Genre"></select>
                <button className="hbtn" id="audiusTrending">Trending this week</button>
              </div>
              <div id="audiusResults"></div>
            </div>
            <div className="drop" id="drop"><strong>Drop music files here</strong>Any format your browser can decode, such as MP3, WAV, FLAC or M4A.</div>
            <ol className="tracks" id="tracks"></ol>
          </section>
          <div className="card">
            <h2>Current transition settings</h2>
            <div className="cur-set" id="curSet"></div>
          </div>
        </aside>
      </div>

      <section className="card manual-card" aria-label="User manual">
        <h2>User manual</h2>
        <div id="manual"></div>
      </section>
      <p className="foot">This is a software prototype. Beatmatching works by changing playback speed, so the pitch shifts slightly while tempos are matched. The samples are placeholder sounds made with a synthesizer (the vocals are especially rough); the real device should use recorded samples.</p>
    </main>
  );
}
