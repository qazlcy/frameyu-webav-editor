# 帧语智能编辑器 WebAV Demo

浏览器本地视频编辑 Demo：导入多个 MP4 视频素材，将其按顺序加入单一视频轨；再添加 MP3/WAV 背景音乐或音效、手动字幕，在 WebAV 画布预览后导出烧录字幕和混音的 MP4。媒体不会上传到服务端。

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
- 固定字幕、视频、背景音乐、音效四条轨道。首个视频默认从 0 ms 开始，后续视频素材可按当前视频轨末尾追加；每个片段保留原声。
- 同一视频素材可多次引用。工程时长只由视频片段的最晚结束时间决定，音频和字幕不会延长画面。
- 音频/字幕支持 100 ms 吸附移动、左右裁剪；音频裁剪使用 `AudioClip.split`，不是单纯缩短时间轴矩形。
- 右侧可编辑字幕文字、样式、位置、时间及音频起点、时长、音量。
- 当前不包含多视频轨、画中画、转场、波纹编辑、自动字幕、FFmpeg、云端保存、撤销重做、波形或移动端适配。视频片段的移动、左右裁剪和删除 UI 将在下一阶段实现。

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

远程 Ubuntu 无 sudo 权限，因此可先在项目内解包 Chromium 所需运行库，再执行：

```bash
./scripts/setup-playwright-libs.sh
npm run test:e2e:local-libs
```

该方案已使 Playwright Chromium 成功启动。但当前远程无头 Chromium 不提供完整 WebCodecs（`VideoDecoder`、`VideoEncoder`、`AudioDecoder`、`AudioEncoder` 均缺失），E2E 会明确显示为 **skipped**，而不应当当作真实导出通过。请使用本机 Chrome/Edge 经端口转发执行下列手工验证。

## 手工验证清单

1. 连续导入两个内容明显不同的 MP4；确认第二个只进入素材库，点击其“+ 视频轨”后，两个片段在同一视频轨首尾相接，且总时长等于两者之和。
2. 播放或跳转至拼接边界，确认片段 A 后出现片段 B，各自原声同步；若人为形成空白区间（后续交互阶段），画面应为黑色而非残帧。
3. 导入 MP3 和 WAV，分别添加为背景音乐与音效，移动到不同时间位置并确认可叠加播放。
4. 添加字幕，编辑文字、颜色、字号、位置和时长，确认预览与时间轴同步。
5. 右、左裁剪音频后确认听到的音频源内容确实改变；调整音量后确认预览变化。
6. 导出，重新播放 `frameyu-demo.mp4`，确认两段视频及各自原声、两类音频和字幕的时间/位置；输出时长应与视频片段最晚结束时间一致。

详细 API 和阶段测试记录见 [`docs/verification.md`](docs/verification.md)。

## 当前阶段

当前分支为 `phase3-multivideo`。阶段 3.1 已完成多视频素材、动态 `Track`/`TimelineClip` 模型和项目时长计算；阶段 3.2 已接入 WebAV 多视频 Sprite 及 `MP4Clip.split` 的真实源区间处理。远程真实多视频导出仍因无头 Chromium 缺少 WebCodecs 而未验收；在本地 Chrome/Edge 清单完成前，不应将其标记为通过。
