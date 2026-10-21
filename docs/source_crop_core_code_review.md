# sourceCrop 核心代码审计

审计日期：2026-10-19  
工程：`/home/lth/webav/v1.0/editor-demo`  
审计实现提交：`7383e531b73a23e39e99ee00cc05f82fc8f178d1`  
WebAV：`@webav/av-cliper@1.2.8`、`@webav/av-canvas@1.2.8`

> 2026-10-19 交互审计更新：裁切工具栏已移到预览框内，确认操作现在用已提交的 Project 快照同步适配器，并新增未确认裁切的导出保护。交互与同步的最新源码、坐标和日志以 `docs/source_crop_interaction_and_sync_audit.md` 为准；本文其余 VideoFrame/Combinator 审计结论不变。

## 1. 当前实现的总体架构

`sourceCrop` 是每个视频 `TimelineClip` 的归一化源画面矩形；`videoLayout` 是裁切结果在 1280×720 工程画布中的位置、尺寸、透明度和 Fit/Fill 语义。两者互不替代。

裁切编辑采用可逆会话：进入时保存初始值并临时让 WebAV 预览完整源图；拖动仅更新 React `CropSession.draft` 和遮罩；确认时把草稿写入 `TimelineClip.sourceCrop`，随后媒体签名变化，只重建目标视频 Sprite。正常预览优先使用 `VideoFrame.visibleRect`；导出显式使用 OffscreenCanvas 像素拷贝，以避免编码端仅消费 coded frame 而忽略 visibleRect 的不确定性。

调用链索引：

```text
Properties 裁切按钮
  -> App.startCropMode
  -> SourceCropEditor / startCanvasCropDrag / setCropDraft
  -> App.confirmCropMode
  -> commands.updateSourceCrop
  -> App mediaSignature 改变
  -> WebAVAdapter.sync/applySync
  -> syncVideoSprite/createVideoSprite
  -> installSourceCropFrameTransform
  -> MP4Clip.tickInterceptor
  -> VisibleSprite/OffscreenSprite drawImage
  -> AVCanvas 预览或 Combinator MP4
```

## 2. 关键文件清单

| 文件 | 职责 | 关键位置 |
|---|---|---|
| `src/editor/types.ts` | `SourceCrop`、`TimelineClip.sourceCrop`、`VideoLayout` 类型 | 43–79 |
| `src/editor/sourceCrop.ts` | 默认值、归一化、移动、八方向缩放、裁切后显示比例 | 4–87 |
| `src/editor/commands.ts` | 将确认值写回指定视频片段 | 285–290 |
| `src/App.tsx` | 裁切会话、坐标换算、确认/取消、遮罩和八控制点 | 677–754、1080–1106 |
| `src/webav/WebAVAdapter.ts` | 项目同步、预览覆盖、媒体实例、预览/导出裁切策略 | 153–275 |
| `src/webav/sourceCropPrototype.ts` | 像素矩形、tickInterceptor、visibleRect、Canvas 回退、帧诊断 | 15–128 |
| `tests/e2e/source-crop-frame.spec.ts` | 合成三色/双色帧的真实浏览器像素验证 | 全文件 |
| `node_modules/@webav/av-cliper/dist/av-cliper.js` | `MP4Clip.tick/clone`、OffscreenSprite 绘制/clone、Combinator clone | 586–608、718–731、2334–2347、2850–2873 |
| `node_modules/@webav/av-canvas/dist/av-canvas.js` | `AVCanvas.createCombinator()` | 730–738 |

## 3. 裁切按钮和确认逻辑

文件：`src/App.tsx`，`startCropMode/cancelCropMode/confirmCropMode`，约 705–731。调用者是右侧 `Properties` 的裁切按钮；下游分别是适配器临时覆盖和 `updateSourceCrop()`。

```ts
function startCropMode() {
  if (!selected || selected.type !== 'video') return;
  const current = getSourceCrop(selected);
  const next: CropSession = { clipId: selected.id, initial: current, draft: current, aspectPreset: 'free' };
  cropSessionRef.current = next;
  setCropSession(next);
  adapterRef.current?.pause();
  void adapterRef.current?.setPreviewSourceCropOverride(selected.id, { ...FULL_SOURCE_CROP }, editor.playheadMs)
    .catch((error: unknown) => console.error('[SourceCrop] failed to open editor', error));
}

function cancelCropMode() {
  const session = cropSessionRef.current;
  if (session) void adapterRef.current?.setPreviewSourceCropOverride(session.clipId, undefined, editor.playheadMs)
    .catch((error: unknown) => console.error('[SourceCrop] failed to restore crop', error));
  cropSessionRef.current = undefined;
  setCropSession(undefined);
}

function confirmCropMode() {
  const session = cropSessionRef.current;
  if (!session) return;
  void adapterRef.current?.setPreviewSourceCropOverride(session.clipId, undefined, editor.playheadMs)
    .catch((error: unknown) => console.error('[SourceCrop] failed to apply crop', error));
  setProject((previous) => updateSourceCrop(previous, session.clipId, session.draft));
  cropSessionRef.current = undefined;
  setCropSession(undefined);
}
```

右侧“正在裁切…”仅表示 `cropSession?.clipId === selected.id`。确认、取消和重置位于预览画布上的 `.source-crop-toolbar`，不在右侧滚动属性栏中。编辑态看到暗化的框外原图是预期交互；确认后 `SourceCropEditor` 卸载，不应继续显示遮罩。

## 4. sourceCrop 数据结构及更新命令

文件：`src/editor/types.ts`，54–79：

```ts
export interface SourceCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimelineClip {
  id: string;
  trackId: string;
  type: 'audio' | 'caption' | 'video';
  assetId?: string;
  name: string;
  startMs: number;
  sourceStartMs: number;
  sourceDurationMs?: number;
  durationMs: number;
  playbackRate?: number;
  volume: number;
  muted?: boolean;
  videoLayout?: VideoLayout;
  sourceCrop?: SourceCrop;
  text?: string;
  captionStyle?: CaptionStyle;
}
```

文件：`src/editor/commands.ts`，286–290：

```ts
export function updateSourceCrop(project: Project, clipId: string, crop: SourceCrop): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.type !== 'video') return project;
  const sourceCrop = normaliseSourceCrop(crop);
  return withClips(project, project.clips.map((item) => item.id === clipId ? { ...item, sourceCrop } : item));
}
```

此命令只替换匹配 `clipId` 的视频片段，不修改时间、倍率、音量、轨道或 `videoLayout`。分割命令对片段进行属性复制，因此左右片段继承同一个数值裁切矩形，随后可独立修改。

## 5. 裁切框及坐标转换

文件：`src/App.tsx`，677–685。浏览器 Pointer 坐标先映射到工程 1280×720，再映射到当前 `videoLayout` 的 `[0,1]` 源选区空间：

```ts
function previewPoint(event: Pick<React.PointerEvent, 'clientX' | 'clientY'>) {
  const rect = previewRef.current?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: (event.clientX - rect.left) / rect.width * project.width, y: (event.clientY - rect.top) / rect.height * project.height };
}

function cropPoint(event: Pick<React.PointerEvent, 'clientX' | 'clientY'>, layout: VideoLayout) {
  const point = previewPoint(event);
  return { x: clamp((point.x - layout.x) / layout.width, 0, 1), y: clamp((point.y - layout.y) / layout.height, 0, 1) };
}
```

文件：`src/editor/sourceCrop.ts`，33–70 的 `resizeSourceCrop()` 根据 `nw/n/ne/e/se/s/sw/w` 修改对应边界，所有边界限制在 `[0,1]`，最小尺寸为 `0.04`。比例预设先通过源素材宽高比换算为归一化源坐标比例，避免把 16:9 目标错误当作单位正方形坐标。

`SourceCropEditor`（`src/App.tsx` 1080–1096）只负责编辑态遮罩、框、八控制点及确认/取消/重置。拖动时不写 Project、不调用 WebAV，也不会重建 MP4Clip。

安装版 WebAV 会在 `MP4Clip.tick()` 返回并进入项目的 `tickInterceptor` 之前，通过内部旋转辅助函数把带旋转元数据的帧画到 OffscreenCanvas。因此当前 `sourceCrop` 的坐标语义是“解码并按元数据旋正后的可见画面”，不是编码文件未旋转的 coded plane；这与用户在预览中看到的方向一致。每个视频片段都有独立的 interceptor 和透明 Canvas，裁掉的区域不会被黑色矩形填充，能露出背景或下层视频。

## 6. WebAVAdapter 预览逻辑

文件：`src/webav/WebAVAdapter.ts`，201–224：

```ts
private async syncVideoSprite(clip: TimelineClip, project: Project) {
  const sourceCrop = this.renderMode === 'preview'
    ? this.previewCropOverrides.get(clip.id) ?? getSourceCrop(clip)
    : getSourceCrop(clip);
  const mediaSignature = JSON.stringify({
    assetId: clip.assetId,
    sourceStartMs: clip.sourceStartMs,
    sourceDurationMs: clip.sourceDurationMs,
    durationMs: clip.durationMs,
    playbackRate: clip.playbackRate,
    volume: clip.volume,
    muted: clip.muted,
    sourceCrop,
    renderMode: this.renderMode,
    sourceCropPrototype: this.sourceCropPrototype,
  });
  const current = this.sprites.get(clip.id);
  if (current?.mediaSignature === mediaSignature) {
    this.applyVideoSprite(current.sprite, clip, project, sourceCrop);
    return;
  }
  this.removeSprite(clip.id);
  if (this.renderMode === 'export') this.cropMetrics.exportSpriteRebuilds += 1;
  else this.cropMetrics.previewSpriteRebuilds += 1;
  const sprite = await this.createVideoSprite(clip, project, sourceCrop);
  await this.addSprite(clip.id, sprite, mediaSignature);
}
```

确认后 `sourceCrop` 进入媒体签名，只重建该 clip ID 的 Sprite。进入裁切编辑时临时覆盖为完整矩形；取消或确认时移除覆盖。正常预览的非完整 crop 安装 `visibleRect` 变换；布局由 `sourceCropDisplayLayout()` 按裁切后宽高比 Fit/Fill，避免静默拉伸。画中画、多视频层级和透明度仍由片段自己的 `videoLayout`/所属轨道控制，不会复用其他片段的裁切状态。

## 7. tickInterceptor 安装和执行

文件：`src/webav/WebAVAdapter.ts`，237–275。时间裁剪的 `MP4Clip.split()` 先完成，然后才安装拦截器，因此回调绑定到最终加入 Sprite 的媒体实例：

```ts
if (!isFullSourceCrop(sourceCrop)) {
  const renderMode = this.renderMode;
  const runtimeId = `${clip.id}:${renderMode}:${this.nextCropRuntimeId++}`;
  installSourceCropFrameTransform(media, sourceCrop, (trace) => {
    if (renderMode === 'export') this.cropMetrics.exportFrameTransforms += 1;
    else this.cropMetrics.previewFrameTransforms += 1;
    this.cropMetrics.cropFrameTransformMs += trace.elapsedMs;
    if (trace.invocation === 1) console.info('[SourceCrop] first transformed frame', {
      runtimeId, clipId: clip.id, renderMode, sourceCrop, ...trace,
    });
    if (trace.path === 'canvas' && trace.invocation === 1) console.warn(
      '[SourceCrop] using Canvas fallback for decoded frames', { runtimeId, clipId: clip.id, renderMode },
    );
  }, { forceCanvas: renderMode === 'export' });
  console.info('[SourceCrop] installed source crop', { runtimeId, clipId: clip.id, sourceCrop, renderMode });
}
```

安装版 WebAV 的 `MP4Clip.tick()`（`av-cliper.js` 591–608）对有/无视频帧结果都调用 `tickInterceptor`。`MP4Clip.clone()`（718–731）显式执行 `t.tickInterceptor = this.tickInterceptor`，复制的是同一个闭包；该闭包捕获安装时归一化后的 `fixedCrop`，不会读取之后变化的旧 React 状态。

## 8. visibleRect 裁切函数

文件：`src/webav/sourceCropPrototype.ts`，57–105。决定实际行为的完整分支：

```ts
const codedWidth = sourceFrame.codedWidth || sourceFrame.displayWidth;
const codedHeight = sourceFrame.codedHeight || sourceFrame.displayHeight;
const displayWidth = sourceFrame.displayWidth || codedWidth;
const displayHeight = sourceFrame.displayHeight || codedHeight;
if (codedWidth <= 0 || codedHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) return tickResult;
if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') {
  throw new Error('当前浏览器无法执行真实源画面裁切：缺少 OffscreenCanvas 或 VideoFrame。');
}
const sourceVisibleRect = sourceFrame.visibleRect ?? { x: 0, y: 0, width: codedWidth, height: codedHeight };
const cropPixels = sourceCropPixelsWithin(fixedCrop, sourceVisibleRect);
const displayCropPixels = sourceCropPixels(fixedCrop, displayWidth, displayHeight);
const { sx, sy, sw, sh } = cropPixels;

try {
  if (options.forceCanvas) throw new Error('Canvas crop explicitly requested');
  const croppedFrame = new VideoFrame(sourceFrame, {
    ...frameInit(sourceFrame),
    visibleRect: { x: sx, y: sy, width: sw, height: sh },
    displayWidth: displayCropPixels.sw,
    displayHeight: displayCropPixels.sh,
  });
  sourceFrame.close();
  report(croppedFrame, 'visible-rect', startedAt);
  return { ...tickResult, video: croppedFrame };
} catch (visibleRectError) {
  if (!options.forceCanvas) console.warn(
    '[SourceCrop] VideoFrame.visibleRect unavailable; using Canvas fallback', visibleRectError,
  );
}
```

裁切坐标不是盲目从 coded frame 的 `(0,0)` 开始，而是相对于解码帧已有的 `visibleRect` 计算；这避免了编码对齐填充或非零可见区域导致裁切偏移。显示尺寸则在 `displayWidth/displayHeight` 坐标内单独计算，避免 coded 与 display 尺寸不一致时意外拉伸。

浏览器像素实验已证明当前 Chromium 的 Canvas2D `drawImage(VideoFrame)` 遵守新帧的 visibleRect：300×100 三色源帧保留左侧 200×100 后，右侧采样由蓝色变为绿色，详见运行记录。WebAV 的 Visible/Offscreen Sprite 同样以 Canvas2D `drawImage` 绘制帧，因此预览路径有直接的 API 与像素证据；正式 MP4 编码仍需真实 WebCodecs 环境复核。

## 9. OffscreenCanvas 裁切函数

同文件 107–121。Canvas 按裁切后的显示尺寸缓存复用，不逐帧创建；源矩形采用显示坐标，目标矩形明确传入：

```ts
const { sx: displayX, sy: displayY, sw: displayW, sh: displayH } = displayCropPixels;
if (!frameCanvas || frameCanvas.width !== displayW || frameCanvas.height !== displayH) {
  const canvas = new OffscreenCanvas(displayW, displayH);
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('无法创建源画面裁切所需的 2D Canvas 上下文。');
  frameCanvas = { canvas, context, width: displayW, height: displayH };
}
frameCanvas.context.clearRect(0, 0, displayW, displayH);
frameCanvas.context.drawImage(sourceFrame, displayX, displayY, displayW, displayH, 0, 0, displayW, displayH);
const croppedFrame = new VideoFrame(frameCanvas.canvas, frameInit(sourceFrame));
sourceFrame.close();
report(croppedFrame, 'canvas', startedAt);
return { ...tickResult, video: croppedFrame };
```

导出现在以 `{ forceCanvas: true }` 强制使用此路径。因此交给 Combinator 的帧 coded/display 尺寸就是裁切尺寸，而不是只携带原 coded frame 加 visibleRect 元数据。双色 200×80 测试裁掉右半蓝色后，输出尺寸为 100×80，右侧像素为红 `[255,0,0]`。

## 10. createCombinator 导出逻辑

项目代码 `src/webav/WebAVAdapter.ts`，163–188：先 `sync(project, 0, 'export')`，这会以最新工程快照和强制 Canvas 路径重建裁切视频 Sprite；然后创建 Combinator 并读取完整流；最终销毁并恢复 preview 图。

```ts
await this.sync(project, 0, 'export');
const durationMs = getProjectDuration(project);
if (!durationMs) throw new Error('请先向视频轨添加有效视频。');
const combinator = await this.canvas.createCombinator({ width: project.width, height: project.height });
const reader = combinator.output({ maxTime: msToUs(durationMs) }).getReader();
const chunks: Uint8Array[] = [];
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
}
return new Blob(chunks, { type: 'video/mp4' });
```

安装版 `AVCanvas.createCombinator()`（`av-canvas.js` 730–738）取得当前 VisibleSprite 的 Clip，创建 OffscreenSprite 并调用 `Combinator.addSprite()`。后者在 `av-cliper.js` 2334–2347 调用 `t.clone()`；OffscreenSprite.clone（2868–2870）调用底层 `MP4Clip.clone()`；MP4Clip.clone（718–731）复制 `tickInterceptor`。所以导出对象不是绕过拦截器的新原始 MP4Clip。

## 11. VideoFrame 生命周期

- MP4Clip 解码返回的原始 `sourceFrame` 由拦截器接管。
- visibleRect 构造或 Canvas `drawImage` 同步完成并成功创建替换帧后，拦截器关闭原始帧。
- 构造/绘制失败时原始帧尚未关闭，异常向上传递，避免双重关闭。
- 返回的新帧由 WebAV Sprite 保存为最近帧；安装源码 `OffscreenSprite.offscreenRender()` 在新帧到达时关闭旧帧，并在 destroy 时关闭最后帧（`av-cliper.js` 2862–2873）。
- 每个 crop runtime 的 Canvas 只在尺寸变化时重建，闭包随 MP4Clip/Sprite 销毁后可回收。

## 12. 裁切确认前后状态对比

| 状态 | Project sourceCrop | preview override | 可见 UI | 媒体路径 |
|---|---|---|---|---|
| 进入前 | 已保存值或完整矩形 | 无 | 正常视频布局框 | 非完整时 visibleRect |
| 编辑中 | 不变 | 当前 clip 强制完整矩形 | 原图 + 框外遮罩 + 八控制点 + 工具栏 | 完整源图，无 crop interceptor |
| 拖动中 | 不变 | 完整矩形 | 遮罩和草稿变化 | 不重建媒体 |
| 确认后 | 写入归一化草稿 | 移除 | 遮罩卸载，只显示实际裁切构图 | preview visibleRect |
| 导出中 | 读取确认后的工程快照 | 忽略 | 导出状态 | export Canvas 实体像素裁切 |
| 取消后 | 保持原值 | 移除 | 恢复原裁切构图 | 原保存值对应路径 |

## 13. 输出像素的验证结果

- 底层 visibleRect：**已执行并通过**。真实 Chromium VideoFrame，三色像素，右侧被排除蓝区消失；时间戳和 duration 保留。
- 底层 OffscreenCanvas：**已执行并通过**。强制 Canvas 路径，双色像素，蓝色右半区消失，输出 coded/display 宽度为裁切宽度。
- 正式项目预览：**未在远程真实 MP4 上执行**。远程 Chromium 缺少 VideoDecoder；代码链和 Canvas2D消费方式已核查，但不能等同真实媒体通过。
- 正式 MP4 导出：**未执行**。远程 Chromium缺 VideoEncoder/AudioEncoder，现有真实媒体 E2E 明确 skipped。
- 预览/导出几何一致：**逻辑检查通过，真实媒体未验证**。两者共享 `sourceCropDisplayLayout`，帧像素路径不同但裁切矩形相同。

## 14. 根因结论

有代码证据支持的既有问题：

1. `684d77a` 后普通预览曾明确排除 sourceCrop，预览 override 也是 no-op，因此确认后只能看到提示/遮罩，真实构图不变。`38959f3` 已恢复预览帧变换。
2. 上一版导出默认使用 visibleRect；虽然当前 Chromium Canvas2D像素测试通过，但没有真实 VideoEncoder 证据证明所有编码环境都正确消费可见区域。`faef33b` 将导出改为强制 Canvas 实体像素裁切，降低该风险。
3. 早期像素换算把归一化矩形直接映射到 coded frame 的 `(0,0)`，没有考虑解码帧自带非零 `visibleRect` 或编码填充。`7383e53` 改为相对原可见区域计算 coded crop，并为 Canvas 路径单独使用 display 坐标。
4. 用户截图若右侧显示“正在裁切…”，说明仍处于编辑态；框外暗化原画在此状态属于设计行为。真正判断点是点击预览工具栏“确认”后遮罩是否消失、画面是否重构。

尚未确认：真实 H.264/AAC MP4 在用户 Chrome 中的预览像素和最终导出像素。由于环境能力缺失，本报告不把功能标为完全验收。

## 15. 建议的后续验证/修复路径

1. **当前首选：本地 Chrome 验收现实现。** 预览 visibleRect 低复制，导出 Canvas 实体裁切；改动局部、预览性能最好。
2. 若个别浏览器预览不遵守 visibleRect，可为 preview 也启用 Canvas，但只在确认后重建一次；播放期间仍有逐帧复制成本。
3. 若真实导出仍异常，保存 `[SourceCrop] installed source crop`、`first transformed frame` 和 `export-crop-metrics` 日志；重点核对 export runtime 的 path 必须为 `canvas`、调用次数大于零、输出尺寸等于 cropPixels。此时再评估自定义 IClip，而不是继续修改 UI 遮罩。

当前结论：代码级根因和底层像素路径已经修复并验证；正式预览与最终 MP4 仍属于需要用户本地 Chrome/Edge 完成的真实媒体验收，整体状态应标记为“部分修复 / 待真实媒体确认”。

## 16. 本轮自动检查

```text
npm run typecheck              通过
npm run test                   83/83 通过
npm run build                  通过
npm run test:e2e:local-libs    7 通过，1 跳过
```

跳过项是依赖完整 WebCodecs 的真实 MP4 合成用例；合成 VideoFrame 的两条裁切像素测试均通过。跳过项不计为真实媒体通过。
