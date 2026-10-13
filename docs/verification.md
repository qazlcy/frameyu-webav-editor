# WebAV 验证记录

日期：2026-10-13。所有时间均以浏览器客户端的本地 WebCodecs 能力为准。

## 阶段 A：环境与 API

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| Node.js | 通过 | 用户级 Node `v22.14.0`，npm 使用该运行时。 |
| 依赖锁定 | 通过 | `package-lock.json` 固定 React 18、Vite 6、WebAV 1.2.8、Vitest、Playwright。 |
| TypeScript | 通过 | `npm run typecheck`。 |
| WebAV 画布 API | 已验证 | `AVCanvas(container, { width, height, bgColor })`、`play`、`pause`、`previewFrame`、`createCombinator`。 |
| WebAV 媒体 API | 已验证 | `MP4Clip(stream)`、`AudioClip(stream, { volume })`、`AudioClip.split(us)`、`VisibleSprite`、`ImgClip`、`renderTxt2ImgBitmap`。 |
| MP4 输出 API | 已验证 | `await canvas.createCombinator()` 后读取 `combinator.output({ maxTime })` 的 `ReadableStream`。 |

SDK 类型来源：`node_modules/@webav/av-canvas/dist/av-canvas.d.ts` 与 `node_modules/@webav/av-cliper/dist/av-cliper.d.ts`。未使用 `any` 或 `@ts-ignore` 绕过接口差异。

## 阶段 B：真实媒体链路

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 官方公开 MP4 夹具 | 已准备 | `tests/fixtures/webav-bunny_0.mp4`，来源 WebAV GitHub Pages。 |
| 官方公开 MP3 夹具 | 已准备 | `tests/fixtures/webav-44.1kHz-2chan.mp3`，来源 WebAV GitHub Pages。 |
| 导入、预览、混音、字幕、导出实现 | 已实现 / 待浏览器验证 | 适配器使用 WebAV 实际 Clip、Sprite 和 Combinator，不提供模拟结果。 |
| Playwright Chromium 下载 | 通过 | 下载到项目 `node_modules/playwright-core/.local-browsers`。 |
| Playwright Chromium 启动 | 通过（项目内降级） | `scripts/setup-playwright-libs.sh` 在项目内解包 `libgbm1`、`libasound2` 与其依赖；`npm run test:e2e:local-libs` 能启动无头 Chromium。 |
| Playwright 真实导出 | 未验证（浏览器能力阻断） | 启动后的远程 Chromium 不存在 `VideoDecoder`、`VideoEncoder`、`AudioDecoder`、`AudioEncoder`。E2E 明确跳过，不将其标记为导出成功。 |

## 阶段 C/D：编辑工程和裁剪

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 工程/运行时分离 | 已实现 | `Project` 只保存可序列化数据；`WebAVAdapter` 私有保存 File 和 WebAV 实例。 |
| 时间换算和边界 | 通过 | Vitest 覆盖毫秒/微秒、100ms 吸附、移动边界和左右裁剪。 |
| 音频源裁剪 | 已实现 / 待浏览器听感验证 | 对每一片段使用 `AudioClip.split` 丢弃前置/尾部音频，预览与导出共享路径。 |
| 工作台 | 已实现 | 素材库、预览、属性、四轨时间轴、选中/拖动/裁剪。 |

## 阶段 E：交付检查

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test` | 通过：15/15（阶段 3.1 后） |
| `npm run build` | 通过：Vite 生产构建完成 |
| `npm run test:e2e:local-libs` | 远程结果：1 skipped（Chromium 可启动，但缺完整 WebCodecs），见阶段 B / 3.2 |

## 已知限制

1. 项目内浏览器运行库已补齐，但远程无头 Chromium 缺失完整 WebCodecs，尚不能在该容器中声明真实 MP4 导出已验证；请按 README 清单在 Chrome/Edge 复核。
2. 为优先保证状态正确，编辑同步会在 120ms 节流后重建当前 WebAV Sprite 集合，但不会重建 AVCanvas 实例；长视频或高频编辑的性能不属于首版承诺。
3. 支持范围受浏览器 WebCodecs 编解码器限制；遇到不支持输入会给出错误，不会回退到 FFmpeg。

## 第一阶段：时间轴基线与坐标修复

分支：`phase1-timeline-fixes`。可回退基线：`ecab22b`（`chore: snapshot v1.0 baseline`）。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 时间轴零点 | 已修复 | 标签区 `110px` 现在是唯一的内容坐标原点；刻度、片段和播放头的 `00:00` 均从同一位置开始。 |
| 横向滚动定位 | 已修复 | 指针坐标通过“视口左边界 + scrollLeft”转换为内容坐标，标签宽度只在纯函数中计算一次。 |
| 播放头 | 已实现 | 红色播放头可拖动，逻辑与视觉均限制在 `0ms ～ 工程时长`。 |
| 网格/缩放 | 已修复 | 网格间距跟随每秒像素值，和时间刻度使用同一个缩放比例。 |
| 播放状态 | 已修复 | WebAV `playing` / `paused` 事件同步 React 按钮状态。 |
| 异步同步 | 已改善 | WebAV 同步请求串行化，已过期的排队请求直接跳过，避免旧编辑快照在新状态后完成。 |
| 单元测试 | 通过 | `npm run test`：8/8；覆盖零点、缩放、横向滚动、内容宽度、吸附与裁剪边界。 |
| 类型/构建 | 通过 | `npm run typecheck`、`npm run build`。 |

未验证：浏览器中的拖动手感、实际媒体预览和导出仍待第二阶段 Chrome 验收。远程 Playwright 已可启动，但无头 Chromium 缺失完整 WebCodecs。

## 阶段 3.1：多视频工程数据与素材库

分支：`phase3-multivideo`，起点：`d111049`。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 单一主视频约束移除 | 已完成 | 移除了 `mainVideoAssetId`；所有视频均为 `Asset`，由 `TimelineClip.assetId` 引用。 |
| 动态 Track | 已完成 | `Track` 包含 `id`、`type`、`name`、`order`、`locked`、`clipIds`；当前 UI 仍固定显示字幕、视频、音乐、音效四轨。 |
| 多视频素材库 | 已完成 | 连续导入不会覆盖既有素材；首个素材自动加入 0 ms，后续素材须点击“+ 视频轨”追加，同一素材可重复引用。 |
| 工程时长 | 已完成 | `getProjectDuration` 取所有视频片段的最晚结束，音频与字幕只会被限制在该范围内。 |
| 数据逻辑测试 | 通过 | `tests/multivideoCommands.test.ts` 覆盖导入保留、追加、重复引用、防重叠、源/工程时间分离、时长和删除共享引用。 |

## 阶段 3.2：WebAV 多视频顺序合成

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| WebAV 1.2.8 裁剪路径 | 已验证（源码/类型） | `MP4Clip.split(timeUs)` 返回两个独立 MP4Clip；安装包源码同时按 `videoSamples` 与 `audioSamples` 分割，故画面和原声共享同一源区间。 |
| 多视频预览/导出实现 | 已完成 / 待真实浏览器验收 | 适配器按视频片段的 `startMs` 创建独立 `MP4Clip` 与 `VisibleSprite`；先丢弃 `sourceStartMs` 前段，再保留 `durationMs` 段，并设置 Sprite 时间偏移。导出使用全部 Sprite 和 `Combinator.output({ maxTime })`。 |
| 顺序片段 E2E | 已编写 / 远程跳过 | 使用官方 `webav-123.mp4` 与 `webav-223.mp4`，再叠加 MP3 和字幕；在完整 WebCodecs 浏览器中检查两片段、下载、输出可重新读取元数据、输出时长。远程结果：`1 skipped`。 |
| `typecheck` / 单测 / 构建 | 通过 | `npm run typecheck`；`npm run test`：15/15；`npm run build`。 |

未验证：远程环境尚未生成或复播含两个视频片段的 MP4，因此不能声称实际多视频拼接已验收。下一步先在本地 Chrome/Edge 执行 README 的拼接清单；确认后才进入阶段 3.3 的视频片段移动、左右裁剪和删除 UI。

## 第二阶段：本地 Chrome 验收清单

1. 通过端口转发打开 `http://localhost:5173`，确认没有 WebCodecs 兼容性警告。
2. 导入 `tests/fixtures/webav-bunny_0.mp4`，确认视频片段左边缘、`00:00` 刻度和红色播放头重合在标签区右侧；点击标签区不得将播放头显示在时间零点左侧。
3. 改变缩放滑块并横向滚动时间轴；点击可视区域、拖动播放头，确认定位仍准确且不会因滚动产生固定偏移。
4. 播放至结尾，确认按钮恢复“播放”；在播放、暂停和时间轴跳转之间反复切换，确认播放头、画面和按钮状态一致。
5. 导入 `tests/fixtures/webav-44.1kHz-2chan.mp3`，分别添加为背景音乐、音效；移动、左/右裁剪并试听，确认源音频起点和音量真实生效。
6. 添加字幕，修改文字、颜色、字号、位置和起止时间，确认画布显示和时间轴一致。
7. 导出 `frameyu-demo.mp4`，在新标签页或本地播放器复播；确认视频、原声、背景音乐、音效、字幕、时间位置和总时长均正确。
8. 如任一步失败，记录浏览器版本、输入文件、控制台 `[WebAV]` 日志和可复现步骤；不要将步骤标记为通过。
