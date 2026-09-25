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
        <h1>DJMAN<span>本地歌单混音原型</span></h1>
        <p>屏幕同时显示正在播放和即将切入的两条音轨，彩色线条表示 BLEND、BUILD、EXIT 的自动化。音频只在本机浏览器里处理，不会上传。</p>
      </header>

      <div className="stage">
        <div className="device" id="device">
          <svg id="dev" viewBox="0 0 1230 1201" aria-label="DJMAN 设备面板"></svg>
          <canvas id="screen" aria-label="双音轨屏幕"></canvas>
        </div>
        <aside className="side">
          <div className="card">
            <h2>状态</h2>
            <div className="status" id="status" aria-live="polite">添加音乐后按转盘中间的红色按钮开始。</div>
            <div className="helpers">
              <button className="hbtn primary" id="addBtn">添加本地音乐</button>
              <button className="hbtn" id="jumpBtn">跳到过渡前</button>
              <input type="file" id="fileIn" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.aiff,.aif" multiple className="sr" />
            </div>
          </div>
          <div className="card">
            <h2>面板操作</h2>
            <ul className="legend">
              <li><b>BLEND / BUILD / EXIT 推子</b>：拖动推子或点文字。推子停在哪个选项，之后所有过渡都按这个选项进行，直到再次拨动。过渡进行中拨动会立即作用于这一次；已经发生的部分（比如铺垫结束后的 BUILD）来不及改，会留到下一次。BLEND 下方的数字键选交接长度（小节）。</li>
              <li><b>屏幕线条</b>：<span className="sw" style={{ background: "var(--c-blend)" }}></span>BLEND 音量交接<span className="sw" style={{ background: "var(--c-build)" }}></span>BUILD 铺垫强度<span className="sw" style={{ background: "var(--c-exit)" }}></span>EXIT 尾音。线越靠右数值越高。</li>
              <li><b>效果转环</b>：转到顶部“I”标记下的效果即开启，转回 NONE 关闭。中间是 FILTER 旋钮，向左低通、向右高通，双击回中，可以和其他效果同时用。</li>
              <li><b>右上红色拨杆</b>：效果强度。</li>
              <li><b>转盘</b>：拖动外圈前进或后退，一圈约 4 小节；中间红键播放 / 暂停。</li>
              <li><b>底部四键</b>：触发采样（键盘 1–4）。<b>右侧红键</b>切换到下一组采样。</li>
              <li><b>左下灰键</b>：立即过渡。<b>左侧上方侧键</b>：点上半部分加音量，下半部分减音量。</li>
            </ul>
          </div>
          <div className="card">
            <h2>当前过渡设定</h2>
            <div className="cur-set" id="curSet"></div>
          </div>
        </aside>
      </div>

      <section className="list-panel" aria-label="歌单">
        <div className="list-head">
          <h2>歌单</h2>
          <p>BPM 为自动检测，偶尔会是实际速度的一半或两倍，可用 ×2 / ÷2 修正。所有过渡都按面板推子的当前位置进行。</p>
        </div>
        <div className="drop" id="drop"><strong>把音乐文件拖到这里</strong>支持浏览器能解码的格式，如 MP3、WAV、FLAC、M4A。</div>
        <ol className="tracks" id="tracks"></ol>
      </section>
      <p className="foot">这是软件原型。对拍靠变速实现，变速期间音高会轻微变化。采样是用合成器临时生成的占位声音，人声尤其粗糙，真机应换成录制好的采样。</p>
    </main>
  );
}
