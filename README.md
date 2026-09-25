# DJMAN 原型：本地歌单混音

一个用来验证 DJMAN 硬件交互的浏览器原型：导入本地音乐组成歌单，按面板上的 BLEND / BUILD / EXIT 推子自动过渡，屏幕同时显示正在播放和即将切入的两条音轨。所有音频都在浏览器里用 Web Audio API 处理，不上传任何文件。

## 运行

```bash
npm install
npm run dev     # http://localhost:8080
```

## 结构

| 文件 | 内容 |
|---|---|
| `src/djman/DjmanApp.tsx` | 页面结构（状态卡、操作说明、歌单等）。引擎按 `id` 查找元素，修改布局时请保留这些 id。 |
| `src/djman/engine.js` | 全部逻辑：音频引擎、BPM 与节拍分析、过渡调度（含过渡中实时修改）、设备面板 SVG、双音轨屏幕、采样合成、歌单 UI。 |
| `src/djman/djman.css` | 样式与明暗主题变量。 |

`engine.js` 内按注释分区：`definitions`、`deck`、`analysis`、`settings`、`scheduling`（`curvesFor` / `reschedule` 是过渡曲线和实时修改的核心）、`transport`、`jog`、`master fx`、`samples`、`device SVG`、`screen`、`companion UI`。

## 面板功能

- **BLEND / BUILD / EXIT 推子**：推子位置就是之后所有过渡的设定；过渡进行中拨动会立即生效。
  - BLEND：Fade / Bass Swap / Filter / Cut，下方 4 / 8 / 16 键选长度
  - BUILD：None / Loop Roll / Riser / Swoosh
  - EXIT：None / Echo / Reverb / Downsweep / Vinyl Break（选中时 BLEND 固定为 Cut）
- **效果转环**：NONE / ECHO / REVERB / FLANGER / GATER / ROLL；中间为 FILTER 旋钮
- **右上红色拨杆**：效果强度
- **转盘**：拖动前进 / 后退；中间红键播放 / 暂停
- **底部四键**：DRUM / BASS / MELODY / VOCAL 采样（键盘 1–4），右侧红键切换采样组
- **左下 MIX 键**：立即过渡；左侧上方侧键：音量

## 已知限制

- 对拍靠变速实现，变速期间音高会轻微变化（无 key lock）。
- BPM 自动检测可能是实际速度的一半或两倍，歌单里可用 ×2 / ÷2 修正。
- 采样为合成器生成的占位声音。
- 转盘使用 `ScriptProcessorNode`（已弃用但各浏览器仍支持）。

## 放进 Lovable 继续编辑

Lovable 不能导入已有的 GitHub 仓库，只能由 Lovable 自己创建仓库。所以做法是：先在 Lovable 建项目并连接 GitHub，再把这里的文件放进它创建的仓库。

1. 在 Lovable 新建一个空项目（随便输入一句提示，例如 “blank page”）。
2. 在项目里打开 GitHub 连接（Project settings → Git → GitHub），授权后 Lovable 会创建一个新仓库。
3. 在 GitHub 网页打开这个仓库，选 **Add file → Upload files**，把 `lovable-upload` 里的 `src` 文件夹整个拖进去，提交到 `main` 分支。这会新增 `src/djman/`，并覆盖 `src/App.tsx`。
4. 回到 Lovable，几秒后会同步到新代码，预览里就是 DJMAN 原型。

只需要上传这 5 个文件：`src/App.tsx`、`src/djman/DjmanApp.tsx`、`src/djman/engine.js`、`src/djman/engine.d.ts`、`src/djman/djman.css`。Lovable 模板自带的 `package.json`、`vite.config.ts`、`index.html` 等保持不动即可，它们已经包含所需的依赖。
