# WebAV 验证记录

日期：2026-10-13。所有时间均以浏览器客户端的本地 WebCodecs 能力为准。

## Phase 6.3 A：真实源画面裁切原型

分支：`phase6-source-crop`，基线：`200a9ab`。本提交刻意**未**添加 `TimelineClip.sourceCrop`、裁切 UI 或 CSS 伪裁切；它只建立一个以 `?sourceCropPrototype=1` 显式启用的固定验证路径，处理的裁切矩形为 `{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }`。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| WebAV 帧路径核查 | 已验证（安装源码） | `MP4Clip.tick()` 同时返回 `VideoFrame` 与音频 PCM；`VisibleSprite`/`OffscreenSprite` 都调用 Clip 的 `tick()`。`AVCanvas.createCombinator()` 将当前 Sprite 转成 `OffscreenSprite`，其 `clone()` 最终调用 `MP4Clip.clone()`。WebAV 1.2.8 的 `MP4Clip.clone()` 显式复制 `tickInterceptor`，因此预览与 Combinator 会使用同一帧处理规则。 |
| 实际变换 | 已实现 / 待本地媒体验证 | 适配器在切分源时间区间后为每个视频 MP4Clip 安装 `tickInterceptor`；它复用同尺寸 `OffscreenCanvas`，以 `drawImage` 从原始帧复制中央区域至完整输出尺寸，并使用原 `timestamp` / `duration` 创建替换 `VideoFrame`。原帧在同步 `drawImage` 后由拦截器关闭；替换帧仍由 Sprite 生命周期释放。 |
| 音频、时长与层级 | 已实现（代码） | 拦截器仅替换 `video` 字段，保留原 `audio` PCM、时间戳、Sprite `time.playbackRate`、布局、透明度和 zIndex；因此不改变原声混音、倍速或视频层级。 |
| 自动检查 | 通过 | `sourceCropPrototype` 单测验证归一化边界及 1280×720 中央 50% 对应的 `(320,180,640,360)` 源像素矩形；`npm run typecheck`、Vitest 72/72、`npm run build` 均通过。工作台 Playwright 为 5 passed / 1 skipped，其中新增 URL 开关可见性与默认关闭检查。 |

限制：远程 Chromium 缺少完整 WebCodecs，无法实际解码或编码视频，故本记录不能宣称真实预览/导出已经通过。必须以 README 第 28、29 项在本地 Chrome/Edge 检查中央内容、边缘排除、原声与导出一致性。

## Phase 6.3 B：sourceCrop 工程模型与适配器集成

`TimelineClip.sourceCrop?` 新增为 `{ x, y, w, h }` 的归一化源图矩形；新视频片段显式写入完整矩形，旧工程缺字段时由 `getSourceCrop()` 回退为完整画面。`updateSourceCrop()` 只更新该视频片段，分割通过既有浅复制自然继承相同裁切；时间、源区间、倍率、音量与 `videoLayout` 均不变。

WebAVAdapter 将有效 `sourceCrop` 放入视频媒体签名，因此只会重建受影响视频 Sprite；它在源时间 `MP4Clip.split()` 完成后安装逐帧裁切拦截器。裁切帧以裁切区域自身像素尺寸构造新的 `VideoFrame`，避免先放大到源画幅导致自由比例裁切变形。`sourceCropDisplayLayout()` 在 `keepAspectRatio` 下将裁切后的实际比例 Fit/Fill 到既有 `videoLayout` 目标盒；`keepAspectRatio: false` 则保留用户显式指定的拉伸行为。预览与导出同样通过 Clip clone 复制拦截器。

自动检查：新增 sourceCrop 默认值、边界移动/八方向缩放、非 16:9 裁切无变形布局、分割继承与旧工程兼容单测。真实 WebCodecs 预览/MP4 仍待本地 Chrome/Edge 验收，不能因这些逻辑检查而标记通过。

## Phase 6.3 C：可逆裁切模式与八控制点

选中视频后，右侧属性面板的“裁切”进入独立会话。会话期间适配器以临时完整 `sourceCrop` 重建**仅该视频**的 Sprite，使用户始终在完整原画上编辑当前保存的选区；遮罩、裁切框、八个边/角手柄与内部移动均使用现有 Pointer Events 和同步 ref 拖拽会话，CSS 像素先转换到 1280×720 工程坐标，再换算为该视频布局盒的归一化源坐标。

确认会调用 `updateSourceCrop()` 并退出临时覆盖，随后由已验证的 MP4Clip 帧拦截路径重建目标 Sprite；取消只移除覆盖而不写项目，重置只修改会话草稿。裁切比例提供自由、16:9、9:16、1:1、4:3；比例锁定时手柄使用源坐标中的等效比例。裁切模式和既有 `videoLayout` 八控制点互斥：前者修改源画面，后者仅修改画布位置/尺寸。

自动检查覆盖默认/旧工程、移动边界、自由与锁定比例手柄、Fit 无变形、分割继承。最终回归：`npm run typecheck`、Vitest 77/77、`npm run build` 均通过；本地库 Playwright 为 5 passed / 1 skipped。真实裁切 UI、两视频独立裁切、画中画、取消/重置、变速/分割组合与导出仍必须按 README 第 29 项在本地 Chrome/Edge 验收；远程 E2E 不得标记为媒体通过。

## Phase 6.2.2：波形振幅显示优化

分支：`phase6-waveform-amplitude`，基线：`687c6e9`。本阶段只修改缓存 Peak/RMS 的统计、显示映射与 Canvas 绘制；不修改 PCM 解码、任务队列、WebAV 预览、真实音量或 MP4 导出。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 振幅诊断 | 已实现 | 分析完成日志与 Canvas 绘制日志记录最大 Peak、P10/P50/P90/P95/P99、最大/平均 RMS、非零比例、有效绘制高度和实际 Peak/RMS 高度。远程环境无完整 WebCodecs，真实素材数值待本地 Chrome 采集。 |
| 显示映射 | 已实现 | 线性模式按 PCM 满量程和视觉增益绘制；增强模式以每个 Asset 的 P95/P99 稳健参考值归一化，再施加有上限的增益与对比度曲线。零振幅严格保持零，映射单调且不生成随机或虚构峰谷。 |
| Peak/RMS 图层 | 已实现 | Canvas 先画低透明度外层 Peak 包络，再画内层 RMS 能量包络；文本和裁剪手柄位于波形之上，Canvas 保持 `pointer-events: none`。 |
| 同源一致性 | 已实现 / 单测 | 参考统计按素材缓存；同一 Asset 的裁剪、分割、多次引用和倍速片段使用同一归一化比例，仅重采样当前源区间，不重新解码。 |
| 自动检查 | 待本次命令复跑 | 已新增零值、恒定值、递增值、离群峰值稳健性和同源引用一致性测试；真实媒体视觉与导出仍须在本地 Chrome/Edge 验证。 |

本地验收：对同一素材分别截取线性、增强两种模式的截图；记录诊断日志中分位数与实际高度。确认增强模式提升低电平可读性，但静音仍为空白、恒定音量仍平直、Peak 外层与 RMS 内层均反映真实强弱变化。此显示层不应产生新的解码任务，也不得改变试听、预览或导出结果。

## Phase 7.1：统一视频轨道层级

分支：`phase7-video-layers-interaction`，提交：`35b2fbd`。`Track.order` 现在明确表示时间轴 UI 从上到下（越小越靠上）。`getVideoLayerZIndex(project, trackId)` 将其唯一地反向映射到 WebAV zIndex，故 UI 顶部视频轨拥有更高图层并覆盖下方视频轨；字幕继续使用 zIndex `10000`。轨道排序只使已有视频 Sprite 更新 `zIndex`，其媒体签名不变，因此不会重建 MP4Clip；跨视频轨移动也在同一映射下更新。音乐和音效轨排序不参与混音语义。类型检查、64 项 Vitest、生产构建均通过；本地库 Playwright 为 4 passed / 1 skipped。真实三视频覆盖和导出一致性待本地 Chrome/Edge 验收。

## Phase 7.2：视频画布交互与大小编辑

在现有 `videoLayout` 上新增八个画布控制点（四角、四边中点）与可测试的 `resizedVideoLayout()` 锚点计算。图层内部可移动；锁定比例时角点锚定对角、边点调整另一维，解除后宽/高独立变化。右侧属性与画布共用同一 `videoLayout` 命令路径，坐标始终是 1280×720 工程坐标。新增 Fit、Fill、全画面、画中画和恢复默认入口：Fit（默认/恢复）完整等比适配，Fill 用可超出输出画布的等比 Sprite rect 覆盖画布，全画面以 1280×720 rect 直接填满。Fill 属于真实预览/导出布局裁切，不是源素材裁切，Phase 6.3 sourceCrop 并未在本期实现。布局更新不改变时间、源音频、倍速、静音或图层关系；Adapter 对仅布局变化保留现有媒体对象。新增锚点和预设单测后，`npm run typecheck`、Vitest 66/66、生产构建和本地库 Playwright（4 passed / 1 skipped）均通过。真实拖拽、两视频独立调整及 MP4 几何一致性待本地 Chrome/Edge 验收。

## Phase 7.3：视频素材内容去重

分支：`phase7-video-content-dedup`。仅视频素材启用去重；`Asset` 增加可序列化的 `fileSize` 与 `contentHash`，用于按 Asset ID 缓存导入指纹。导入时先以大小筛出候选素材，再在后台 Worker 以 SHA-256 核实内容：同内容、不同文件名会被识别，同名不同内容不会被拒绝。确认重复前不会调用 `inspectFile`、`registerAsset`、Object URL 或波形/媒体缓存，因此不会留下孤立运行时资源。

`VideoContentDeduplicator` 对哈希建立保留席位：多个相同内容文件同时导入时，首个任务可完成注册；其他任务等待其提交后转为重复，失败则释放席位供后续任务继续。发现重复时工作台显示可定位既有素材的对话框，且不会自动加入时间轴；已有 Asset 依然可反复创建 TimelineClip。Worker 规避主线程摘要计算；但原生 WebCrypto SHA-256 需要完整 `ArrayBuffer`，超大文件仍有 Worker 内存开销，未来若需要真正分块流式哈希应引入专门的增量 SHA-256/WASM 实现。

自动检查：新增 4 项去重单测，覆盖内容相同改名、同名异内容、并发同内容、失败后重试；当前 `npm run typecheck` 与 Vitest 70/70 已通过。待本阶段最终构建/E2E 后补录；远程 Chromium 的真实视频导入/导出仍因 WebCodecs 缺失不能标为通过，本地 Chrome/Edge 请按 README 第 27 项验收。

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

未验证：远程无头 Chromium 不能完成 MP4/音频 WebCodecs 解码编码，因此本地音频试听、手动字幕实际画面，以及添加后的真实预览/MP4 导出均须在 Chrome/Edge 执行 README 中对应的素材、字幕和导出项目；它们不能因结构 E2E 通过而标为已验证。

## Phase 5.2：多视频轨道与画中画叠加

分支：`phase5-multivideo-overlay`，数据与 WebAV 基线提交：`e94efff`。本阶段未加入转场、遮罩、关键帧或 AI 能力。

| 子阶段 | 结果 | 记录 |
| --- | --- | --- |
| 5.2.1 数据与命令层 | 通过（纯逻辑测试） | `addTrack` 支持视频轨；`appendVideoClip` 可指定视频轨并在该轨末尾追加；同轨才禁止重叠，跨视频轨允许重叠与移动。最后一条视频轨及任何非空轨都不能删除。`TimelineClip` 新增 `videoLayout` 与可选 `muted`。 |
| 5.2.2 WebAV 图层处理 | 已实现 / 待真实媒体验收 | 每个视频片段拥有按 TimelineClip ID 管理的 `MP4Clip + VisibleSprite`。`videoLayout` 直接映射为 Sprite `rect`/`opacity`，轨道顺序映射为递增 zIndex；AVCanvas 源码已确认会在 Sprite `propsChange` 后按 zIndex 重排，Combinator 克隆同一 Sprite 状态输出。 |
| 5.2.3 UI 交互 | 通过（工作台 E2E） | 可新增、重命名、排序、调整高度和删除空视频轨；片段可跨兼容视频轨移动。视频属性提供全画面、右上角画中画、X/Y、宽高、保持比例、透明度、原声音量/静音和恢复默认布局。预览覆盖层把 CSS 指针坐标换算到 1280×720 项目坐标，再写回 `videoLayout`。 |
| 5.2.4 音频与导出回归 | 已实现 / 待真实媒体验收 | 读取 WebAV 1.2.8 源码确认 `MP4Clip(stream, { audio: { volume } })` 会将该视频原声 PCM 乘以音量；视频静音传入 0。每个视频仅创建一个含画面和原声的 Sprite，不额外创建 AudioClip，避免重复声音；背景音乐、音效与字幕仍走原有独立 Sprite。 |
| 自动检查 | 通过 | `npm run typecheck`、Vitest（28 项）、`npm run build` 通过；工作台 Playwright 3 项通过。真实媒体导出 E2E 因远程 Chromium 缺完整 WebCodecs 而 skipped。 |

图层规则（Phase 7.1 更新）：视频轨 `Track.order` 从小到大即时间轴 UI 从上到下；通过唯一的 `getVideoLayerZIndex(project, trackId)` 反向映射为 WebAV `zIndex`，因此数值较小、UI 更上方的视频轨拥有更高图层并覆盖下方轨道。字幕固定为 `zIndex 10000`，始终位于所有视频之上。图层排序只影响视频画面，不影响音乐/音效混音；预览同步和 `Combinator` 导出使用同一个工程快照与映射函数。

未验证：尚未能在远程浏览器实际解码两个带声视频并生成 MP4，因而视频 A/B 的重叠画面、真实混音、裁剪后原声、层级遮挡及导出可播放性必须由本地 Chrome/Edge 按 README 第 4～6、17 项确认，不能将逻辑/E2E 结果替代这些媒体结论。

## Phase 5.3：音频波形与视频缩略图

分支：`phase5-waveform-thumbnails`，基线：`18bce98`。本阶段是运行时显示辅助层，不改变 Project 的媒体合成语义，也不增加 FFmpeg、服务端或 AI 依赖。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| PCM 波形 | 已实现 / 待真实浏览器验收 | `TimelineMediaPreviewCache` 以 Asset ID 创建 `AudioClip(file.stream())`，在 `ready` 后调用 `getPCMData()`，把多声道 PCM 降采样为最多 1200 个峰值。完整 PCM 不写入 React 或 Project。 |
| 视频缩略图 | 已实现 / 待真实浏览器验收 | 缓存以 Asset ID 创建 `MP4Clip(file.stream())`，调用 `thumbnails(160, { start: 0, end: durationUs, step })`。帧 Blob 转为 Object URL，仅在编辑器卸载时释放。 |
| 裁剪与缩放映射 | 通过（纯逻辑测试） | 波形和缩略图按 `sourceStartMs + durationMs` 选择对应源窗口；时间轴缩放仅改变显示采样密度，轨高与滚动由现有 CSS 布局自适应。展示层 `pointer-events: none`，不会覆盖移动、裁剪、跨轨或播放头操作。 |
| 缓存与生命周期 | 已实现 | 同一 Asset 的多个 TimelineClip 共享一份 Promise/分析结果；删除片段不会释放缓存，因而不会破坏仍引用同一素材的其他片段。无素材删除入口，缓存及缩略图 Object URL 在编辑器卸载时统一释放。 |
| 视频原声波形 | 未实现（明确降级） | 本期优先完成独立音乐/音效的真实 PCM 波形与视频缩略图；视频原声波形留作后续性能评估，不影响视频原声预览或导出。 |
| 自动检查 | 通过 | 新增 3 个缓存/源窗口单测；总计 `npm run test` 31/31，`typecheck`、生产构建通过；工作台 Playwright 3 项通过，真实媒体导出仍 skipped。 |

未验证：远程 Chromium 缺完整 WebCodecs，无法在容器中确认 PCM 解码、真实帧抽取和时间轴视觉结果。请在本地 Chrome/Edge 按 README 第 7、8 项检查波形幅度、缩略图源区间、裁剪/缩放/拖拽后的对齐，以及不会影响预览和 MP4 导出。

## Phase 5.4：视频与音频片段分割

分支：`phase5-clip-split`，基线：`76c3ab0`。本阶段只新增片段级编辑命令与入口，不变更 WebAV 的合成语义，也不开始 5.5 倍速功能。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 可测试分割命令 | 通过（纯逻辑测试） | `splitTimelineClip(project, clipId, playheadMs)` 只接受视频/音频片段内部位置；以两个新 ID 替换原片段，不移动其他片段。左段保留源起点，右段源起点按 `sourceStartMs + 工程偏移 × playbackRate` 计算；两者的工程时长相加等于原时长。字幕、端点及最小时长保护均拒绝分割。 |
| 倍速数据语义预留 | 已实现（尚未启用倍速） | `TimelineClip.playbackRate?` 缺省为 `1`，兼容已有工程。`durationMs` 始终表示工程时间；源时间偏移由 `getClipPlaybackRate` / `sourceOffsetForTimelineOffset` 计算。当前 WebAV 适配器尚未实现非 1× 变速，因此该字段没有 UI 写入入口；5.5 必须在验证 WebAV 能力后再接入实际媒体速度。 |
| 编辑入口 | 已实现 / 工作台结构待浏览器验收 | 工具栏“分割”、右键“在播放头处分割”以及非输入焦点下的 `S` 都走同一命令。片段右键会先选中并暂停；输入框、文本域、选择框、按钮及可编辑元素内的 `S` 不触发。 |
| WebAV 与资源处理 | 已实现 / 待真实媒体验收 | 分割后旧 TimelineClip ID 对应 Sprite 会在同步时移除，两个新 ID 分别以既有 `MP4Clip.split` / `AudioClip.split` 源裁剪路径创建；视频画面和其同一 MP4Clip 内的原声使用同样的源区间。Asset/File 缓存没有按片段释放，因此同源的其他引用不受影响。 |
| 波形和缩略图 | 通过（纯逻辑测试） | 缓存继续只按 Asset ID 保存；新片段以各自的 `sourceStartMs`、时长（以及预留的播放倍率）采样，分割不重新解码整个素材，也不会回收仍被引用的缓存。 |
| 自动检查 | 通过 | `npm run typecheck`、Vitest 37/37、`npm run build` 通过；`npm run test:e2e:local-libs` 为 3 passed / 1 skipped。跳过项是需要完整 WebCodecs 的真实媒体合成测试。 |

未验证：远程无头 Chromium 没有完整 WebCodecs，不能在容器内确认分割后的视频画面、视频原声、独立音频的连续性、PIP 继承效果、波形/缩略图实际渲染及导出 MP4。请在本地 Chrome/Edge 按 README 第 17、18 项操作；仅在确认预览与导出内容连续后，才能将真实媒体分割标为通过。

## 第二阶段：本地 Chrome 验收清单

1. 通过端口转发打开 `http://localhost:5173`，确认没有 WebCodecs 兼容性警告。
2. 导入 `tests/fixtures/webav-bunny_0.mp4`，确认视频片段左边缘、`00:00` 刻度和红色播放头重合在标签区右侧；点击标签区不得将播放头显示在时间零点左侧。
3. 改变缩放滑块并横向滚动时间轴；点击可视区域、拖动播放头，确认定位仍准确且不会因滚动产生固定偏移。
4. 播放至结尾，确认按钮恢复“播放”；在播放、暂停和时间轴跳转之间反复切换，确认播放头、画面和按钮状态一致。
5. 导入 `tests/fixtures/webav-44.1kHz-2chan.mp3`，分别添加为背景音乐、音效；移动、左/右裁剪并试听，确认源音频起点和音量真实生效。
6. 添加字幕，修改文字、颜色、字号、位置和起止时间，确认画布显示和时间轴一致。
7. 导出 `frameyu-demo.mp4`，在新标签页或本地播放器复播；确认视频、原声、背景音乐、音效、字幕、时间位置和总时长均正确。
8. 如任一步失败，记录浏览器版本、输入文件、控制台 `[WebAV]` 日志和可复现步骤；不要将步骤标记为通过。

## Phase 5.5：音视频片段倍速与 Phase 5 回归

分支：`phase5-playback-rate`，基线：`c4fdf1b`。本阶段只新增片段倍速及其必要的时间映射修正；没有接入速度曲线、倒放、变速不变调、ASR、AI 或工程持久化。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| WebAV 1.2.8 实现核查 | 已验证（本地安装源码） | `av-cliper/dist/av-cliper.js` 的 `VisibleSprite`/`OffscreenSprite` 均以 `tick(time * sprite.time.playbackRate)` 取得视频与音频；非 1× 音频经内部线性插值重采样。`Combinator.addSprite` 调用 `clone()`，而 `copyStateTo` 复制 `time`，所以预览和 MP4 合成保留相同倍率。源码注释明确要求调用方自行修正 `time.duration`，并说明音调会变化。 |
| 数据模型与旧工程兼容 | 通过（纯逻辑测试） | `TimelineClip` 增加可选 `sourceDurationMs`：`durationMs` 始终是工程时间，`sourceStartMs + sourceDurationMs` 是实际源区间。旧工程没有该字段时按 `durationMs × playbackRate` 推导，倍率缺失仍视为 1×。 |
| 命令与时间映射 | 通过（纯逻辑测试） | `setClipPlaybackRate` 只接受 0.5、0.75、1、1.25、1.5、2，保留源时长而以 `sourceDuration / rate` 重算工程时长。分割、左右裁剪、移动、波形和缩略图均依据源/工程的倍率映射；同视频轨变速造成重叠会拒绝，不移动其他片段。 |
| WebAV 实际接入 | 已实现 / 待真实媒体验收 | 适配器先按 `sourceStartMs` 与 `sourceDurationMs` 对 `MP4Clip`/`AudioClip` 执行真实 `split` 裁剪，再把工程 `durationMs` 与 `playbackRate` 写入同一个 `VisibleSprite.time`。视频画面和其 MP4Clip 原声共享 Sprite，因此速度、静音、音量与图层布局一致；独立音频同样走实际 Sprite 倍速路径。 |
| UI 与时间轴 | 已实现 / 工作台结构待浏览器验收 | 视频、背景音乐、音效属性面板均提供六档速度选择；片段宽度、工程时长、缩略图和波形随工程时长/源区间更新。字幕没有速度控件，其时间不会被倍率命令修改。 |
| 自动检查 | 通过 | `npm run typecheck`、Vitest 44/44、`npm run build` 通过；`npm run test:e2e:local-libs` 为 3 passed / 1 skipped。跳过的是要求完整 WebCodecs 的真实媒体合成测试。 |

### Phase 5 统一回归矩阵

| 功能 | 自动回归 | 真实媒体状态 |
| --- | --- | --- |
| 5.1 固定素材入口、分类与可调布局 | Playwright 工作台通过 | 本地 Chrome 待检查导入与音频试听 |
| 5.2 多视频轨、画中画、混音与字幕层 | 命令/构建通过 | 本地 Chrome 待检查叠加、原声混音与 MP4 |
| 5.3 PCM 波形与视频缩略图缓存 | 源窗口单测通过 | 本地 Chrome 待检查真实 PCM/缩略图渲染 |
| 5.4 视频/音频分割 | 分割、裁剪、移动、删除单测通过 | 本地 Chrome 待检查分割后音画连续与 MP4 |
| 5.5 倍速及其组合 | 倍率、分割、裁剪、重叠、叠加、缓存、字幕稳定性单测通过 | 本地 Chrome 待检查实际画面/原声、混音和 MP4 |

未验证：远程无头 Chromium 仍不提供 `VideoDecoder`、`VideoEncoder`、`AudioDecoder`、`AudioEncoder`，因此不能把源码核查、命令测试或工作台 E2E 视为真实变速媒体通过。请在本地 Chrome/Edge 按 README 第 19、20 项验收：特别记录输入素材、速度档位、分割/裁剪位置、输出 MP4 时长、画面与原声同步，以及音调随速度变化的预期现象。

## Phase 6.1：波形任务诊断、队列与错误反馈

分支：`phase6-waveform-crop`，基线：`5def32c`。本阶段只改进独立音乐/音效的运行时波形分析；未改动 WebAV 合成、视频缩略图、视频原声波形或画面裁切。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 触发时机 | 已实现 | 保留既有“音频 Asset 加入 `project.assets` 后触发”语义。导入完成后先登记为“尚未调度”，随后 effect 在本地 `File` 可用时调用 `ensureWaveform` 入队；不需要先创建时间轴片段。 |
| 串行任务与去重 | 通过（单测） | 新增 `AnalysisTaskQueue`，完整 PCM 解码默认仅并发一项。既有 `waveformTasks` 与 Asset ID 缓存保留，同一素材的重复引用/重复请求返回同一个 Promise；失败不会阻塞后续任务，失败后可显式重新分析。 |
| 状态与错误反馈 | 已实现 / 工作台待浏览器验收 | 音频素材卡显示等待、正在解码、正在生成波形、完成、失败；失败显示原始可理解原因，并提供“重新分析”。时间轴仍可在分析期间添加片段，随后由缓存通知自动刷新。 |
| 分阶段性能日志 | 已实现 / 待本地实测 | `[WaveformAnalysis]` 日志与素材卡下方可展开、可复制的诊断面板记录 Asset ID、素材名、时长，以及导入到任务创建、排队、AudioClip 创建、`ready` 解码、PCM 获取、峰值计算、缓存、UI 通知、总耗时。远程环境缺完整 WebCodecs，不能据此编造真实音频耗时。 |
| 主线程计算 | 已实现 / 待本地实测 | 保持不复制 PCM 的分块计算；是否主要受益于计算阶段需以 `readyMs` 和 `peakBuildMs` 的本地测量判断；若 `readyMs` 占主导，瓶颈仍是 WebAV 完整解码而非峰值循环。 |
| 生命周期 | 已实现 | 每任务在 `finally` 中释放临时 `AudioClip` 与 PCM 引用；`forgetAsset` 通过版本号忽略无法中途取消的过期 WebCodecs 结果；编辑器卸载会释放队列和缓存。当前没有素材删除入口，因此该失效路径预留给后续素材管理。 |
| 自动检查 | 通过 | `npm run typecheck`、Vitest 48/48、`npm run build` 通过。新增覆盖异步峰值等价性、串行队列、失败不阻塞、Asset 任务去重、缓存与失败重试。 |

本地 Chrome/Edge 性能验收：依次导入约 10 秒 MP3、30～60 秒 WAV、约 3 分钟 MP3；每次展开素材列表的“波形诊断日志”并复制 JSON，记录 `readyMs`、`peakBuildMs`、`totalMs`。随后连续导入三条音频，确认卡片依次排队且页面仍可操作；将同一素材反复加入时间轴，确认不产生新的 `decode-ready` 条目。对不支持或损坏的文件确认失败文案和重试入口。真实 PCM 波形显示、实际解码耗时、内存峰值及卡顿情况均为本地浏览器待验证，不能标为远程通过。

## Phase 6.2：视频原声音频波形

分支：`phase6-waveform-crop`，基线：`f85c5c5`。本阶段只新增视频原声音频分析与时间轴展示；未开始八控制点画面裁切，也未改变 AVCanvas 或 MP4 导出的媒体实例。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| WebAV 1.2.8 路径核查 | 已验证（安装源码） | `MP4Clip.meta` 的 `audioChanCount`/`audioSampleRate` 用于判断是否存在音轨。`splitTrack()` 返回的是仅含视频或仅含音频 samples 的 **`MP4Clip[]`**，不是 `AudioClip`，因此不存在 `getPCMData()`。源码中纯音频轨 `tick()` 不调用 VideoDecoder。 |
| PCM 获取 | 已实现 / 待真实浏览器验收 | 对拆出的音频 MP4Clip 每 100 ms 连续调用 `tick(timeUs)`；WebAV 源码规定间隔超过 100 ms 会重置音频 finder，故该步长确保返回连续 PCM。PCM 抵达时直接累积到固定 1200 桶峰值，不保留完整音轨数组。 |
| 无音轨与静音 | 通过（单测） | 元数据没有有效声道/采样率时写入“无音轨”且不调用 `splitTrack`；静音 PCM 正常生成接近零的峰值，不会被误判为无音轨。 |
| 统一队列、状态和缓存 | 通过（单测） | 视频任务复用 Phase 6.1 的单并发 `AnalysisTaskQueue`、状态、失败重试和诊断日志。缓存键为 `video:<assetId>`，独立音频为 `audio:<assetId>`；相同视频重复引用返回同一任务/缓存。缩略图任务仍独立，任一失败不阻断另一项。 |
| 资源与媒体隔离 | 已实现 | 分析专用的源 MP4Clip 和所有 `splitTrack` 结果在 `finally` 中销毁；它们不注册 Sprite、不连接 AVCanvas，因此不会增加可播放音轨、影响时间轴分割或导出混音。 |
| 时间轴显示 | 已实现 / 工作台待浏览器验收 | 有缓存时视频片段上半显示缩略图、下半显示原声波形；取样继续使用既有 `sourceStartMs`、`sourceDurationMs` 与 playbackRate 映射。无音轨只显示缩略图；视频 `muted` 不影响素材原声波形。 |
| 自动检查 | 通过 | 新增有声/无声/静音视频、连续 tick、缓存去重、失败重试、分割/跨轨/静音/倍速源窗口映射和流式峰值单测；`npm run typecheck`、Vitest 53/53 通过。 |
| Playwright 工作台回归 | 部分通过 | 直接运行 `npm run test:e2e` 时用户缓存内缺少 `chromium_headless_shell`，4 项均未启动。项目本地浏览器依赖命令 `npm run test:e2e:local-libs` 为 3 通过、1 跳过；跳过项需要完整 WebCodecs 的真实 MP4 合成，不能视为媒体功能通过。 |

### Phase 6.2 补丁：任务创建链路修复

本地 Chrome 截图显示“等待分析”但诊断为 0，根因不是 PCM 解码：`src/main.tsx` 启用的 React 18 `StrictMode` 会执行一次开发用 effect cleanup/setup；`App.tsx` 原先在 cleanup 中立即销毁 `TimelineMediaPreviewCache`，而同一 ref 在第二次 setup 后仍被使用。队列因而处于已释放状态，状态写入和诊断日志被忽略，后续入队请求被拒绝。

- 缓存释放改为延迟一个宏任务；StrictMode 的立即重设会取消释放，实际卸载仍会销毁缓存及媒体资源。
- 素材卡状态新增“尚未调度”，不再把无任务误显示为“等待分析”；`analysis-requested` 在 `ensureWaveform`/`ensureVideoWaveform` 首次调用时立即写入诊断。
- 集中调度函数会在 Project 已有 Asset 但运行时 `File` 暂缺时记录具体原因；运行时 File 注册版本变化后自动重新调度。
- 自动回归：`npm run typecheck`、Vitest 54/54、`npm run build` 通过。新增“先 Asset 后 File”时序用例，验证补调度、可见诊断、缓存写入和单次解码。

本地 Chrome/Edge 验收：导入有明显说话声的 MP4、带背景音乐的 MP4、无音轨 MP4、静音 MP4；检查素材卡状态、视频片段上下分层显示及诊断字段 `trackSplitMs`、`audioTickMs`。随后测试左/右裁剪、分割、同源重复引用、跨轨、静音及 0.5×/2×；波形必须保持对应源区间，静音不能清除它。预览与导出应保持原声只播放一次。远程 Chromium 缺 WebCodecs，实际 MP4 解码、视觉分层与导出仍为未验证。

## 波形视觉与分辨率优化

分支：`phase6-waveform-visuals`，基线：`4d97e1b`。本阶段不改变 PCM 解码队列、WebAV 预览或导出；只更换缓存包络表达和时间轴绘制。

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 绘制器 | 已实现 / 待本地视觉验收 | 原 DOM 竖线改为 Canvas 2D 对称填充包络。Canvas 使用 `ResizeObserver`、`IntersectionObserver`、滚动帧调度与 `requestAnimationFrame`，按 devicePixelRatio 绘制；屏幕外片段不绘制，超长片段 backing store 限制为 4096 px，且 `pointer-events: none`，不会遮挡片段移动、裁剪和分割。 |
| 缓存分辨率 | 通过（单测） | 缓存从固定 1200 Peak 桶扩展为有界的 Peak+RMS+样本数：最少 2048、最多 8192 桶，长素材仍有上界。时间轴按可见片段的源区间和像素列聚合缓存，不会重新读取 PCM。 |
| 声道与振幅 | 通过（单测） | Peak 取跨声道最大绝对值，RMS 按各声道平方能量合并，避免相位抵消。视觉增益仅作用于 Canvas，高度为有效区域约 80%，零振幅仍保持为零，分割片段不单独归一化。 |
| 图层与颜色 | 已实现 | 音乐青绿色、音效琥珀色、视频原声低对比浅蓝；视频保持上缩略图、下紧凑波形。片段标签和裁剪手柄位于波形上层，选中边框独立于波形颜色。 |
| 自动检查 | 通过 | 新增 Peak+RMS、立体声反相、源窗口聚合、静音与有界分辨率测试；`npm run typecheck`、Vitest 56/56、`npm run build` 通过。 |

本地 Chrome/Edge 视觉验收：使用相同 `webav-44.1kHz-2chan.mp3` 截取优化前后截图；在 45/100/240 缩放及低/高轨高下检查连续对称填充包络、静音零线、弱音细节和强弱顺序。再检查带淡入淡出音频、视频原声、裁剪、分割、跨轨、倍速和同源多引用；这些操作必须仅重采样缓存而不生成新的 `decode-ready` 诊断条目。远程无头 Chromium 缺完整 WebCodecs，不能据此标记真实媒体视觉或导出为已验证。

## Phase 6.2.1 提交 A：Canvas 与音频添加修复

本地 Chrome 中“`ready`/`cached` 且 2048 桶已生成、时间轴却空白”的根因已经定位为 Canvas CSS：Canvas 是替换元素，原来的 `width: auto; height: auto` 使其采用约 300×150 的内在尺寸；波形中线绘制在片段的可见裁剪区之外，并非缓存或 React 通知没有更新。现改为每个波形 Canvas 显式填充它的音频/视频可视区域，Canvas 自检入口在不依赖 WebCodecs 的情况下以像素读取验证了非透明绘制结果。

- 完成诊断新增 `envelope-summary`：包含 Asset、`audio:/video:` 缓存键、版本、素材时长、桶数、最大/平均 Peak、最大 RMS 与非零桶数；Canvas 首次绘制输出尺寸、DPR、可见区间、列数和振幅范围。
- 修复前 `addAudioClip` 在没有视频时被 `normaliseToVideoDuration` 静默移除，App 却显示“已加入”；现在允许在首条视频前暂存音频，视频出现后才应用时长裁剪。目标轨使用最新 `projectRef` 查询，并记录 `[TimelineAdd]` 点击/工程更新事件。
- 自动检查：Vitest 58/58 通过；`test:e2e:local-libs` 新增合成 Canvas 像素测试，通过 4 项、真实媒体合成 1 项因 WebCodecs 跳过。真实 MP3/MP4 视觉仍需本地 Chrome 验收。

## Phase 6.2.1 提交 B：视频时间轴原声波形

- `scheduleMediaPreviewAnalysis()` 对视频只创建 `ensureVideoWaveform()`；保留缩略图缓存 API 以便未来素材封面用途，但不再自动运行 `MP4Clip.thumbnails()`，避免导入时额外的视频帧解码。
- 视频时间轴默认展示文件名和占据主要高度的浅蓝色原声 Canvas 波形；没有音轨时明确显示“无音轨”，分析中或失败时显示相应占位。视频静音仅影响预览/导出，不影响原始波形。
- 继续使用 `sourceStartMs`、`sourceDurationMs` 和 `playbackRate` 的既有映射，不增加实际播放音轨，因此不会造成原声重复。
- 自动回归新增“视频调度不启动缩略图任务”测试；真实视频原声波形及预览/导出仍待本地 Chrome 验收。
