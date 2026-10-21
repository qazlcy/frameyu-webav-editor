# sourceCrop 交互与同步审计

审计日期：2026-10-19  
工程：`/home/lth/webav/v1.0/editor-demo`  
审计基线：`80af9fb`  
最小修复提交：`85e8a8c`  
范围：裁切工具栏、确认提交、WebAVAdapter 同步队列、导出保护；没有改动 VideoFrame 裁切算法。

## 1. 结论摘要

本轮确认了一个可直接复现的 UI 根因：旧工具栏是 `.source-crop-editor` 的子元素，CSS 使用 `top: calc(100% + 10px)`；全画面视频时编辑框与 `.preview-frame` 等高，而 `.preview-frame` 使用 `overflow: hidden`。因此工具栏虽然是 `display:flex`、`visibility:visible`、`pointer-events:auto`，实际位置完全落到预览框下方并被裁掉。

同时确认了一处同步风险：旧 `confirmCropMode()` 先异步清除 preview override，该调用会用 `WebAVAdapter.this.project` 中的旧工程快照开始同步；随后 React 才提交带新 `sourceCrop` 的 Project。同步队列最终通常会由 React Effect 再纠正，但确认后的短暂预览依赖第二次延迟 120ms 的同步，而且接口没有保证第一次同步使用已提交工程。

最小修复：

1. 工具栏改为 `.preview-frame` 的直接子元素，固定在画面底部居中。
2. 确认时先生成 `committedProject`，同步更新 `projectRef` 与 React state，再把同一个工程快照显式传给 `setPreviewSourceCropOverride()`。
3. 增加结构化交互日志，记录会话、裁切值、clipId、本地工程 revision 和退出状态。
4. 裁切会话存在时，导出入口和实际导出函数双重拒绝；导出读取 `projectRef.current` 的最新工程快照。

正式 H.264/AAC 预览和 MP4 导出仍未在远程环境执行，保持未验证状态。

## 2. 工具栏修复前的实际 DOM 证据

在 1440×900 Playwright viewport 中，使用应用真实 `.preview-frame` 和真实 CSS，按全画面视频布局插入与 React 一致的工具栏结构，测得：

```text
preview-frame: x=282.5, y=110.28125, width=850, height=467.71875
preview bottom: 578
source-crop-editor: x=282.5, y=110.28125, width=850, height=467.71875
source-crop-toolbar: x=283.5, y=587, width=73.40625, height=37
toolbar bottom: 624
display: flex
visibility: visible
z-index: 4
pointer-events: auto
```

工具栏顶部 `587` 已超过预览框底部 `578`，整个工具栏都位于裁切区域外。`.preview-frame` 的旧规则（`src/styles.css:5`）为 `overflow:hidden`，所以用户看不到按钮，也无法点击。

这说明问题不是 React 没有渲染、按钮回调未绑定或 pointer-events 被关闭，而是明确的几何裁切问题。

## 3. 修复后的 JSX 与回调绑定

文件：`src/App.tsx:1117-1135`，函数：`SourceCropEditor()`。

```tsx
function SourceCropEditor({ layout, crop, aspectPreset, onPointerDown, onChangePreset, onConfirm, onCancel, onReset }: { layout: VideoLayout; crop: SourceCrop; aspectPreset: CropAspectPreset; onPointerDown: (event: React.PointerEvent, mode: 'move' | VideoResizeHandle) => void; onChangePreset: (preset: CropAspectPreset) => void; onConfirm: () => void; onCancel: () => void; onReset: () => void }) {
  const cropStyle: CSSProperties = { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` };
  const outerStyle: CSSProperties = { left: `${layout.x / 1280 * 100}%`, top: `${layout.y / 720 * 100}%`, width: `${layout.width / 1280 * 100}%`, height: `${layout.height / 720 * 100}%` };
  return <>
    <div className="source-crop-editor" aria-label="视频源画面裁切编辑器" style={outerStyle}>
      <div className="source-crop-mask top" style={{ height: `${crop.y * 100}%` }} />
      <div className="source-crop-mask left" style={{ top: `${crop.y * 100}%`, height: `${crop.h * 100}%`, width: `${crop.x * 100}%` }} />
      <div className="source-crop-mask right" style={{ top: `${crop.y * 100}%`, height: `${crop.h * 100}%`, left: `${(crop.x + crop.w) * 100}%` }} />
      <div className="source-crop-mask bottom" style={{ top: `${(crop.y + crop.h) * 100}%` }} />
      <div className="source-crop-box" style={cropStyle} onPointerDown={(event) => onPointerDown(event, 'move')}>
        <span className="source-crop-label">裁切区域</span>
        {VIDEO_RESIZE_HANDLES.map(({ handle, label }) => <button type="button" key={handle} aria-label={`裁切${label}`} className={`source-crop-handle ${handle}`} onPointerDown={(event) => onPointerDown(event, handle)} />)}
      </div>
    </div>
    <div className="source-crop-toolbar" role="toolbar" aria-label="裁切操作" onPointerDown={(event) => event.stopPropagation()}>
      <label>比例 <select aria-label="裁切比例" value={aspectPreset} onChange={(event) => onChangePreset(event.target.value as CropAspectPreset)}><option value="free">自由</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="4:3">4:3</option></select></label>
      <button type="button" onClick={onReset}>重置裁切</button><button type="button" onClick={onCancel}>取消裁切</button><button type="button" className="primary" onClick={onConfirm}>确认裁切</button>
    </div>
  </>;
}
```

调用处在 `src/App.tsx:1002` 附近：`onConfirm={confirmCropMode}`、`onCancel={cancelCropMode}`、`onReset={resetCropDraft}`。确认按钮不是占位按钮，实际绑定 `confirmCropMode()`。

工具栏现在是 `.preview-frame` 的直接子元素，不再位于会随 videoLayout 缩小/移动的 `.source-crop-editor` 内。

## 4. 修复后的 CSS、层级和点击性

文件：`src/styles.css:21,24`。

```css
.preview-frame { position: relative; }
.source-crop-toolbar {
  position: absolute;
  z-index: 14;
  bottom: 10px;
  left: 50%;
  display: flex;
  width: max-content;
  max-width: calc(100% - 20px);
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px;
  overflow-x: auto;
  transform: translateX(-50%);
  pointer-events: auto;
}
```

修复后同一 viewport 的测量（回归测试只放确认/取消两个按钮）：

```text
preview-frame: x=282.5, y=110.28125, width=850, height=467.71875
source-crop-toolbar: x=657.59375, y=531, width=99.8125, height=37
toolbar bottom: 568（preview bottom=578）
display: flex
visibility: visible
z-index: 14
pointer-events: auto
elementFromPoint: 确认裁切
```

工具栏距预览底部 10px，真实命中目标是确认按钮。它高于裁切编辑器 `z-index:12`、图层缩放框 `z-index:9`、Canvas 默认层，不再被遮罩挡住。较窄预览下工具栏限制为画面宽度减 20px，并允许内部横向滚动。

## 5. 确认行为和状态记录

文件：`src/App.tsx:726-768`。

进入裁切时记录：

```ts
console.info('[SourceCropInteraction]', {
  phase: 'started', clipId: selected.id,
  initial: current, draft: current,
  projectRevision: projectRevisionRef.current,
});
```

确认的完整关键实现：

```ts
function confirmCropMode() {
  const session = cropSessionRef.current;
  if (!session) return;
  const currentProject = projectRef.current;
  const before = currentProject.clips.find((clip) => clip.id === session.clipId)?.sourceCrop ?? FULL_SOURCE_CROP;
  const committedProject = updateSourceCrop(currentProject, session.clipId, session.draft);
  const after = committedProject.clips.find((clip) => clip.id === session.clipId)?.sourceCrop ?? FULL_SOURCE_CROP;
  const previousRevision = projectRevisionRef.current;
  projectRevisionRef.current += 1;
  renderedProjectRef.current = committedProject;
  projectRef.current = committedProject;
  setProject(committedProject);
  cropSessionRef.current = undefined;
  setCropSession(undefined);
  console.info('[SourceCropInteraction]', {
    phase: 'confirmed', clipId: session.clipId,
    initial: session.initial, draft: session.draft,
    before, after,
    projectRevisionBefore: previousRevision,
    projectRevisionAfter: projectRevisionRef.current,
    exited: true,
  });
  void adapterRef.current?.setPreviewSourceCropOverride(
    session.clipId, undefined, editor.playheadMs, committedProject,
  ).then(() => {
    console.info('[SourceCropInteraction]', {
      phase: 'confirmed-preview-synchronized',
      clipId: session.clipId, sourceCrop: after,
      projectRevision: projectRevisionRef.current,
    });
  }).catch(/* 显式错误状态 */);
}
```

确认后 `cropSessionRef.current` 和 React `cropSession` 都变为 `undefined`，所以右侧“正在裁切…”恢复为“裁切”，遮罩与工具栏同时卸载。`before/after` 和 revision 能证明 draft 是否真正写入工程。

项目模型本身暂时没有持久化 version 字段；这里的 `projectRevisionRef` 是当前页面会话的单调递增诊断序号，不写入工程文件，也不改变媒体语义。

远程浏览器缺少真实视频解码能力，因此本报告没有伪造一次真实视频点击确认的 clipId 日志。用户本地执行后应看到 `started -> confirmed -> confirmed-preview-synchronized`。

## 6. React 媒体同步 Effect

文件：`src/App.tsx:137-143,199-209`。

```ts
const mediaSignature = useMemo(() => JSON.stringify({
  width: project.width,
  height: project.height,
  videoTracks: project.tracks.filter((track) => track.type === 'video').map(({ id, order }) => ({ id, order })),
  clips: project.clips.map(({ id, trackId, type, assetId, name, startMs, sourceStartMs, sourceDurationMs, durationMs, playbackRate, volume, muted, videoLayout, sourceCrop, text, captionStyle }) => ({ id, trackId, type, assetId, name, startMs, sourceStartMs, sourceDurationMs, durationMs, playbackRate, volume, muted, videoLayout, sourceCrop, text, captionStyle })),
}), [project.width, project.height, project.tracks, project.clips]);
const mediaProject = useMemo(() => project, [mediaSignature]);

useEffect(() => {
  if (!adapterReady || !projectDuration) return;
  let cancelled = false;
  const timer = window.setTimeout(() => {
    void adapterRef.current?.sync(mediaProject, editor.playheadMs).catch((error: unknown) => {
      if (!cancelled) setEditor(/* error */);
    });
  }, 120);
  return () => { cancelled = true; window.clearTimeout(timer); };
}, [adapterReady, mediaProject, projectDuration]);
```

`sourceCrop` 包含在 `mediaSignature` 中，所以确认会触发 Effect。120ms 延迟用于合并高频工程编辑；裁切拖动只改 draft，不触发媒体重建。

## 7. WebAVAdapter 串行同步与过时请求

文件：`src/webav/WebAVAdapter.ts:112-160`。

```ts
sync(project: Project, previewMs = 0, renderMode: RenderMode = 'preview'): Promise<void> {
  const request = ++this.latestSyncRequest;
  const applyIfCurrent = async () => {
    if (request !== this.latestSyncRequest) return;
    await this.applySync(project, previewMs, renderMode);
  };
  this.syncQueue = this.syncQueue.then(applyIfCurrent, applyIfCurrent);
  return this.syncQueue;
}

private async applySync(project: Project, previewMs: number, renderMode: RenderMode) {
  if (!this.canvas) throw new Error('预览画布尚未初始化');
  this.project = project;
  this.renderMode = renderMode;
  this.canvas.pause();
  for (const clip of project.clips.filter((item) => item.type === 'video')) await this.syncVideoSprite(clip, project);
  for (const clip of project.clips.filter((item) => item.type === 'audio')) await this.syncAudioSprite(clip);
  for (const clip of project.clips.filter((item) => item.type === 'caption')) await this.syncCaptionSprite(clip);
  await this.canvas.previewFrame(msToUs(Math.max(0, previewMs)));
}

async setPreviewSourceCropOverride(clipId: string, crop?: SourceCrop, previewMs = 0, project = this.project) {
  if (crop) this.previewCropOverrides.set(clipId, crop);
  else this.previewCropOverrides.delete(clipId);
  if (!project) return;
  await this.sync(project, previewMs, 'preview');
}
```

同步队列是串行的：后请求不会与前请求并发改写 Sprite。尚未开始的旧请求会因 `latestSyncRequest` 跳过；已经开始的请求不会中途取消，但必须完成后新请求才执行，因此最终状态由最后一次请求决定，不会出现旧任务在新任务完成后再覆盖。

旧确认逻辑的问题不是确定性的最终倒退，而是先用 `this.project` 旧快照触发一次同步，再依赖 React Effect 的新快照纠正。修复后确认调用显式传入 `committedProject`；即使 Effect 的重复同步被合并或跳过，直接同步本身也使用正式 sourceCrop。

## 8. 导出保护及工程快照

文件：`src/App.tsx:433-472,957-962`。

```ts
function requestExport() {
  if (cropSessionRef.current) {
    setEditor((previous) => ({ ...previous, status: 'ready', message: '请先确认或取消当前裁切，再导出视频。' }));
    return;
  }
  setExportDialogOpen(true);
}

async function exportVideo() {
  if (cropSessionRef.current) {
    setExportDialogOpen(false);
    setEditor((previous) => ({ ...previous, status: 'ready', message: '请先确认或取消当前裁切，再导出视频。' }));
    return;
  }
  const exportProject = projectRef.current;
  const exportDuration = getProjectDuration(exportProject);
  // 选择保存位置后：
  const blob = await adapterRef.current!.export(exportProject, onProgress);
}
```

保护有两层：顶部按钮不能在未确认裁切时打开导出设置；即使导出弹窗在进入裁切前已经打开，最终“开始导出”也会再次检查。确认后导出读取 `projectRef.current`，不是某次 render 闭包捕获的旧 `project`。

## 9. 根因、已修复和未确认事项

### 明确根因

1. **确认/取消不可见：已确认并修复。** 工具栏位于预览框下方且被 `overflow:hidden` 裁掉。
2. **确认同步旧快照风险：已修复。** 正式 Project 现在先生成并提交，同一个快照显式交给 adapter。
3. **未确认时可导出旧工程：已修复。** 入口与执行函数双重阻止。

### 未确认

1. 真实 MP4 片段在用户 Chrome 点击确认后的运行时日志。
2. `confirmed-preview-synchronized` 后画面是否在特定 GPU/浏览器组合中正确刷新。
3. Combinator 对真实 H.264/AAC 的最终逐帧裁切结果。
4. 导出 MP4 重新解码后的像素、原声和时长。

合成 VideoFrame 的像素测试只能证明底层裁切函数，不能替代上述真实媒体检查。

## 10. 本地 Chrome/Edge 追踪步骤

1. 导入视频并添加到轨道，选中片段。
2. 打开 DevTools Console，筛选 `SourceCropInteraction` 和 `SourceCrop`。
3. 点击“裁切”，确认底部工具栏始终可见。
4. 拖动裁切框，记下 draft；拖动期间不应出现 Sprite 重建日志。
5. 点击“确认裁切”。应依次出现：

```text
phase: started
phase: confirmed (before/after 不同，exited:true)
phase: confirmed-preview-synchronized
[SourceCrop] installed source crop (renderMode:preview)
[SourceCrop] first transformed frame
```

6. 确认右侧按钮恢复“裁切”，遮罩和工具栏消失。
7. 再进入裁切但不确认，点击“导出视频”；应提示先确认或取消，且不打开导出设置。
8. 确认后导出，检查 export 日志的 `path:canvas` 和 `exportFrameTransforms > 0`。
9. 重新播放导出的 MP4，检查裁掉区域、原声、时长和多视频下层画面。

## 11. 自动化证据

`tests/e2e/source-crop-toolbar-audit.spec.ts` 使用真实应用 CSS 测量工具栏边界、computed style 和 `elementFromPoint()` 命中目标。其目标是防止工具栏再次被放到预览可视范围之外。

真实媒体 E2E 继续受远程 Chromium 缺少完整 WebCodecs 限制；该用例必须保持 skipped，而不能计为通过。

本轮完整结果：

```text
npm run typecheck              通过
npm run test                   83/83 通过
npm run build                  通过
npm run test:e2e:local-libs    8 通过，1 跳过
```

跳过项是依赖完整 WebCodecs 的真实 MP4 合成测试；工具栏 DOM 几何和点击命中测试已执行通过。
