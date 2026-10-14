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
| `npm run test` | 通过：23/23（含视频片段交互边界） |
| `npm run build` | 通过：Vite 生产构建完成 |
| `npm run test:e2e:local-libs` | 通过：1 个工作台交互 E2E；另有 1 个真实媒体 E2E 因 WebCodecs 环境限制 skipped。 |

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

未验证：远程环境尚未生成或复播含两个视频片段的 MP4，因此不能声称实际多视频拼接已验收。本地 Chrome/Edge 仍须执行 README 的拼接、裁剪和导出清单。

## 阶段 4：可调工作台与动态非视频轨道

分支：`phase4-workspace-tracks`，基线：`25a3875`。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 三栏与时间轴尺寸 | 通过 | CSS Grid + Pointer Events 实现左右栏与底部时间轴调整；最小尺寸为 200px、230px、440px、180px。双击分隔条复位，`ResizeObserver` 在窗口变化时校正保存的会话尺寸。 |
| 运行时资源稳定性 | 已实现 | 面板尺寸、轨道高度、排序和空轨增删不进入媒体签名，因而不会触发 `AVCanvas` 或 Sprite 同步重建；预览仍固定使用 1280×720 内部画布。 |
| 动态轨道 | 通过 | `Track` 新增 `heightPx`；可新增、重命名、上下排序及调整字幕/音乐/音效轨。仅空非视频轨可删除，视频轨和非空轨均有保护提示。 |
| 跨轨片段移动 | 通过（状态逻辑） | 字幕只能移至字幕轨，背景音乐只能移至背景音乐轨，音效同理；一次命令更新 `trackId` 并保留所有媒体时间/素材属性。 |
| 时间轴滚动 | 通过 | 固定标尺、单一可纵向滚动轨道视口、左侧 sticky 标签列与右侧片段区共享 `scrollTop`；标尺与片段区同步 `scrollLeft`，播放头以统一时间坐标覆盖可见轨道区。 |
| WebAV 多轨遍历 | 已验证（代码） | `WebAVAdapter` 按全部 `clip.type` 遍历视频、音频和字幕，不依赖 `music`、`sfx`、`caption` 的固定 ID；新轨中的有效片段会进入预览与导出。 |
| 回归 | 通过 | `typecheck`、Vitest 22/22、生产构建通过。Playwright 工作台 E2E 通过，真实媒体 E2E 仍 skipped。 |

未验证：本地 Chrome/Edge 尚需实际试听两条背景音乐、音效及多字幕轨混合后的预览/导出。远程 Chromium 不具备完整 WebCodecs，不能替代这一媒体验收。

## 阶段 3.3：单视频轨片段交互

基线：`62b2800`。本阶段未新增第二视频轨、画中画或波纹编辑。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 视频片段移动 | 通过（状态逻辑/UI） | 已开放唯一视频轨内的片段拖动；继续通过 `moveProjectClip` 校验工程起点、源区间和同轨防重叠。空隙合法，不会自动吸附或波纹移动。 |
| 视频左右裁剪 | 通过（状态逻辑/UI） | 两个白色边缘分别调用 `trimProjectClip`；左裁剪同步增加 `startMs`、`sourceStartMs` 并缩短时长，右裁剪仅修改时长。适配器现有 `MP4Clip.split` 实现会对画面与原声执行相同源区间裁剪。 |
| 删除 | 通过（状态逻辑/UI） | 属性栏可删除视频片段；删除仅移除该片段，不会移动后续片段，其他对同一 Asset 的引用不受影响。 |
| 防重叠回归 | 通过 | 新增单测覆盖：裁剪进入后续片段时命令被拒绝，删除前片段后剩余片段保留原 `startMs`。 |
| 质量检查 | 通过 | `npm run typecheck`、Vitest 23/23、`npm run build` 均通过；Playwright 工作台测试通过，真实媒体 E2E 仍因 WebCodecs 缺失而跳过。 |

未验证：拖动后真实 WebAV 预览和导出的裁剪内容、原声音画同步，以及两个源视频的成片拼接仍需在具备完整 WebCodecs 的 Chrome/Edge 按 README 清单复核；不得以远程无头结果替代该验收。

## Phase 5.1：素材面板与工作台 UI 重构

分支：`phase5-material-panel`，基线：`36a5183`。本阶段仅调整素材管理界面与对应的可序列化素材分类，不改变 `WebAVAdapter` 的媒体创建、预览或导出调用链。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 固定入口与独立滚动 | 通过（UI E2E） | 左侧面板拆为固定 `material-actions` 与可纵向滚动的 `material-list`。五个入口、筛选器和字幕创建表单不会随素材列表滚动；左栏尺寸调整仍由已有 CSS Grid 分隔条管理。 |
| 五类入口 | 通过 | 视频、音乐、音效入口分别选择本地 MP4、MP3/WAV；字幕入口创建手动字幕；“从素材库导入”只聚焦当前会话的同一素材列表。未接入的 AI 生成/ASR 显示“待接入”，不发起不存在的请求或伪造结果。 |
| 素材分类与卡片 | 通过（状态/UI） | 新增可选 `Asset.audioKind: 'music' | 'sfx'`，旧音频素材未设置时按音乐显示。视频、音乐、音效和字幕分别使用蓝、青绿、琥珀、紫色卡片；字幕卡片由真实 caption 片段派生，删除时间轴片段不会删除源音视频 Asset。 |
| 本地试听与资源释放 | 已实现 / 待浏览器试听 | 音频导入时创建本地 Object URL 供原生 `<audio>` 控件试听；组件卸载时统一 revoke，未进入 Project 或 WebAV 运行时状态。 |
| 手动字幕时间 | 通过（单测） | `addCaption` 支持 `CaptionDraft` 的文本、起止毫秒；命令会 100 ms 吸附并约束在视频工程时长内。 |
| WebAV 1.2.8 API 审查 | 已验证（声明文件） | 读取 `dist/av-cliper.d.ts`：`AudioClip.getPCMData()`、`MP4Clip.thumbnails()`、`MP4Clip.split()`、`VisibleSprite.rect/zIndex/opacity/time` 均存在。本期不调用波形、缩略图、画中画或倍速接口，这些留给 5.2～5.5。 |
| 自动检查 | 通过 | `npm run typecheck`、Vitest 24/24、`npm run build` 通过；Playwright 工作台 2 项通过，真实媒体导出 1 项因无头 Chromium 无完整 WebCodecs 而 skipped。 |

未验证：远程无头 Chromium 不能完成 MP4/音频 WebCodecs 解码编码，因此本地音频试听、手动字幕实际画面，以及添加后的真实预览/MP4 导出均须在 Chrome/Edge 执行 README 第 5、6、12 项；它们不能因结构 E2E 通过而标为已验证。

## 第二阶段：本地 Chrome 验收清单

1. 通过端口转发打开 `http://localhost:5173`，确认没有 WebCodecs 兼容性警告。
2. 导入 `tests/fixtures/webav-bunny_0.mp4`，确认视频片段左边缘、`00:00` 刻度和红色播放头重合在标签区右侧；点击标签区不得将播放头显示在时间零点左侧。
3. 改变缩放滑块并横向滚动时间轴；点击可视区域、拖动播放头，确认定位仍准确且不会因滚动产生固定偏移。
4. 播放至结尾，确认按钮恢复“播放”；在播放、暂停和时间轴跳转之间反复切换，确认播放头、画面和按钮状态一致。
5. 导入 `tests/fixtures/webav-44.1kHz-2chan.mp3`，分别添加为背景音乐、音效；移动、左/右裁剪并试听，确认源音频起点和音量真实生效。
6. 添加字幕，修改文字、颜色、字号、位置和起止时间，确认画布显示和时间轴一致。
7. 导出 `frameyu-demo.mp4`，在新标签页或本地播放器复播；确认视频、原声、背景音乐、音效、字幕、时间位置和总时长均正确。
8. 如任一步失败，记录浏览器版本、输入文件、控制台 `[WebAV]` 日志和可复现步骤；不要将步骤标记为通过。
