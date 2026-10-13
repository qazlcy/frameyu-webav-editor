# 帧语智能编辑器 WebAV Demo

浏览器本地视频编辑 Demo：导入一个 MP4 主视频，添加 MP3/WAV 背景音乐或音效、手动字幕，在 WebAV 画布预览后导出烧录字幕和混音的 MP4。媒体不会上传到服务端。

## 启动

当前开发环境的 Node 22 安装在 `/home/lth/.local/node/bin`。新终端先执行：

```bash
export PATH=/home/lth/.local/node/bin:$PATH
cd /home/lth/webav/v1.0/editor-demo
npm install
npm run dev -- --host 0.0.0.0
```

通过 VS Code Remote 的端口转发，在桌面 Chrome 或 Edge 打开 `http://localhost:5173`。首次验证使用短 H.264/AAC MP4（≤30 秒、720p）及 MP3/WAV（≤60 秒）。

## 功能范围

- 固定 1280×720 / 30 FPS / 16:9 导出；非 16:9 视频等比缩放并保留黑边。
- 固定字幕、主视频、背景音乐、音效四条轨道；主视频保持在 0 ms 并保留原声。
- 音频/字幕支持 100 ms 吸附移动、左右裁剪；音频裁剪使用 `AudioClip.split`，不是单纯缩短时间轴矩形。
- 右侧可编辑字幕文字、样式、位置、时间及音频起点、时长、音量。
- 不包含多视频拼接、自动字幕、FFmpeg、云端保存、撤销重做、波形或移动端适配。

## 架构

- `src/editor`：工程数据、编辑命令与时间计算；内部时间统一为毫秒。
- `src/webav/WebAVAdapter.ts`：本地 `File` 与 WebAV 运行时对象的隔离、画布预览、音频切片、字幕位图和 MP4 输出；仅在这一层转换微秒。
- `src/App.tsx`：工作台、素材导入、属性面板和自定义轻量时间轴。连续拖拽会节流同步至 WebAV，导出前总是根据最新工程快照重建合成器。

## 检查

```bash
npm run typecheck
npm run test
npm run build
PLAYWRIGHT_BROWSERS_PATH=0 npm run test:e2e
```

Playwright 的 Chromium 已下载到项目内，但当前远程 Ubuntu 缺少 `libgbm1`、`libasound2`，无法启动浏览器。安装这些宿主依赖后才能运行端到端测试；在此之前请用本机 Chrome/Edge 经端口转发执行下列手工验证。

## 手工验证清单

1. 导入 MP4，确认画面、播放、暂停、拖动播放位置及原声正常。
2. 导入 MP3 和 WAV，分别添加为背景音乐与音效，移动到不同时间位置并确认可叠加播放。
3. 添加字幕，编辑文字、颜色、字号、位置和时长，确认预览与时间轴同步。
4. 右、左裁剪音频后确认听到的音频源内容确实改变；调整音量后确认预览变化。
5. 导出，重新播放 `frameyu-demo.mp4`，对照原声、两类音频和字幕的时间/位置。

详细 API 和阶段测试记录见 [`docs/verification.md`](docs/verification.md)。
