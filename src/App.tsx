import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, deleteEmptyTrack, getAsset, getProjectDuration, getTrack, moveClipToCompatibleTrack, removeClip, renameTrack, reorderTrack, resizeTrack, trimProjectClip, updateClip } from './editor/commands';
import { emptyProject, type Asset, type EditorState, type Project, type TimelineClip, type Track, type TrackType } from './editor/types';
import { DEFAULT_WORKSPACE_LAYOUT, MIN_PREVIEW_WIDTH, WORKSPACE_DIVIDER_SIZE, normaliseWorkspaceLayout, type WorkspaceLayout } from './editor/layoutMath';
import { TRACK_HEADER_WIDTH_PX, clamp, timelineContentWidth, timeToTimelineX, viewportXToTime } from './editor/timelineMath';
import { WebAVAdapter, type CapabilityReport } from './webav/WebAVAdapter';

const initialEditor: EditorState = { playheadMs: 0, zoom: 100, playback: 'idle', status: 'ready', message: '等待导入视频素材' };
const formatTime = (timeMs: number) => `${String(Math.floor(timeMs / 60000)).padStart(2, '0')}:${String(Math.floor(timeMs / 1000) % 60).padStart(2, '0')}.${String(Math.floor(timeMs % 1000 / 10)).padStart(2, '0')}`;
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const LAYOUT_STORAGE_KEY = 'frameyu-workspace-layout-v1';
type LayoutState = WorkspaceLayout;
type LayoutDrag = { kind: 'asset' | 'property' | 'timeline'; pointerId: number; startClient: number; startValue: number };

type DragState =
  | { kind: 'clip'; pointerId: number; clip: TimelineClip; mode: 'move' | 'left' | 'right'; pointerStartMs: number }
  | { kind: 'playhead'; pointerId: number }
  | { kind: 'track'; pointerId: number; trackId: string }
  | { kind: 'track-height'; pointerId: number; trackId: string; startHeight: number; startClientY: number };

function readLayout(): LayoutState {
  try {
    const stored = JSON.parse(sessionStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null') as Partial<LayoutState> | null;
    if (stored && [stored.assetWidth, stored.propertyWidth, stored.timelineHeight].every(Number.isFinite)) return { assetWidth: stored.assetWidth!, propertyWidth: stored.propertyWidth!, timelineHeight: stored.timelineHeight! };
  } catch { /* Session layout is optional. */ }
  return DEFAULT_WORKSPACE_LAYOUT;
}

const sortedTracks = (tracks: Track[]) => [...tracks].sort((left, right) => left.order - right.order);

export default function App() {
  const previewRef = useRef<HTMLDivElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const rulerScrollRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<WebAVAdapter>();
  const durationRef = useRef(0);
  const projectRef = useRef<Project>(emptyProject());
  const layoutDragRef = useRef<LayoutDrag>();
  const dragRef = useRef<DragState>();
  const [project, setProject] = useState<Project>(emptyProject);
  const [editor, setEditor] = useState<EditorState>(initialEditor);
  const [capability, setCapability] = useState<CapabilityReport>();
  const [adapterReady, setAdapterReady] = useState(false);
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const [layoutDrag, setLayoutDrag] = useState<LayoutDrag>();
  const [drag, setDrag] = useState<DragState>();
  const [selectedTrackId, setSelectedTrackId] = useState('video');
  const [pendingTrackFocusId, setPendingTrackFocusId] = useState<string>();
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);

  projectRef.current = project;
  const projectDuration = getProjectDuration(project);
  durationRef.current = projectDuration;
  const selected = project.clips.find((clip) => clip.id === editor.selectedClipId);
  const selectedAsset = selected?.assetId ? getAsset(project, selected.assetId) : undefined;
  const timelineDuration = Math.max(projectDuration, 10000);
  const tracks = useMemo(() => sortedTracks(project.tracks), [project.tracks]);
  const contentWidth = timelineContentWidth(timelineDuration, editor.zoom);
  const mediaSignature = useMemo(() => JSON.stringify({
    width: project.width,
    height: project.height,
    clips: project.clips.map(({ id, type, assetId, name, startMs, sourceStartMs, durationMs, volume, text, captionStyle }) => ({ id, type, assetId, name, startMs, sourceStartMs, durationMs, volume, text, captionStyle })),
  }), [project.width, project.height, project.clips]);
  const mediaProject = useMemo(() => project, [mediaSignature]);

  useEffect(() => {
    const adapter = new WebAVAdapter();
    adapterRef.current = adapter;
    if (previewRef.current) {
      adapter.attach(previewRef.current, {
        onTimeChange: (playheadMs) => {
          setEditor((previous) => ({ ...previous, playheadMs: clamp(playheadMs, 0, durationRef.current) }));
        },
        onPlaybackChange: (playing) => {
          setEditor((previous) => ({ ...previous, playback: playing ? 'playing' : 'paused' }));
        },
      });
      setAdapterReady(true);
    }
    void WebAVAdapter.checkCapabilities().then((report) => {
      setCapability(report);
      if (!report.supported) setEditor((previous) => ({ ...previous, status: 'error', message: report.reasons[0] }));
    });
    return () => adapter.destroy();
  }, []);

  useEffect(() => {
    if (!adapterReady || !projectDuration) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void adapterRef.current?.sync(mediaProject, editor.playheadMs).catch((error: unknown) => {
        if (!cancelled) setEditor((previous) => ({ ...previous, status: 'error', message: error instanceof Error ? error.message : String(error) }));
        console.error('[WebAV] synchronization failed', error);
      });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [adapterReady, mediaProject, projectDuration]);

  useEffect(() => {
    try { sessionStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Session storage is optional. */ }
  }, [layout]);

  useEffect(() => {
    const container = editorBodyRef.current;
    if (!container) return;
    const correctLayout = () => {
      const rect = container.getBoundingClientRect();
      setLayout((previous) => {
        const next = normaliseWorkspaceLayout(previous, rect.width, rect.height);
        return previous.assetWidth === next.assetWidth && previous.propertyWidth === next.propertyWidth && previous.timelineHeight === next.timelineHeight ? previous : next;
      });
    };
    const observer = new ResizeObserver(correctLayout);
    observer.observe(container);
    correctLayout();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pendingTrackFocusId) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`track-row-${pendingTrackFocusId}`)?.scrollIntoView({ block: 'nearest' });
      setPendingTrackFocusId(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingTrackFocusId, project.tracks]);

  async function importVideo(file: File) {
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在解析视频…' }));
    try {
      const info = await adapterRef.current!.inspectFile(file, 'video');
      const asset: Asset = { id: makeId('video'), name: file.name, type: 'video', mimeType: file.type, ...info };
      adapterRef.current!.registerAsset(asset, file);
      setProject((previous) => {
        const firstVideo = !previous.assets.some((item) => item.type === 'video');
        const withAsset = addAsset(previous, asset);
        return firstVideo ? appendVideoClip(withAsset, asset) : withAsset;
      });
      setEditor((previous) => ({ ...previous, playheadMs: 0, status: 'ready', message: `已导入 ${file.name}` }));
    } catch (error) {
      console.error('[WebAV] video import failed', error);
      setEditor((previous) => ({ ...previous, status: 'error', message: `视频无法解码：${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  async function importAudio(file: File) {
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在解析音频…' }));
    try {
      const info = await adapterRef.current!.inspectFile(file, 'audio');
      const asset: Asset = { id: makeId('audio'), name: file.name, type: 'audio', mimeType: file.type, ...info };
      adapterRef.current!.registerAsset(asset, file);
      setProject((previous) => ({ ...previous, assets: [...previous.assets, asset] }));
      setEditor((previous) => ({ ...previous, status: 'ready', message: `已导入 ${file.name}` }));
    } catch (error) {
      console.error('[WebAV] audio import failed', error);
      setEditor((previous) => ({ ...previous, status: 'error', message: `音频无法解码：${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  const syncAndSeek = async (timeMs: number) => {
    const safeTime = clamp(timeMs, 0, projectDuration);
    setEditor((previous) => ({ ...previous, playheadMs: safeTime }));
    try { await adapterRef.current?.previewFrame(safeTime); }
    catch (error) { console.error('[WebAV] seek failed', error); }
  };

  function togglePlayback() {
    if (!projectDuration) return;
    if (editor.playback === 'playing') {
      adapterRef.current?.pause();
      setEditor((previous) => ({ ...previous, playback: 'paused' }));
      return;
    }
    const start = editor.playheadMs >= projectDuration ? 0 : editor.playheadMs;
    adapterRef.current?.play(start, projectDuration);
    setEditor((previous) => ({ ...previous, playheadMs: start, playback: 'playing' }));
  }

  async function exportVideo() {
    if (!projectDuration || editor.status === 'exporting') return;
    setEditor((previous) => ({ ...previous, status: 'exporting', message: '正在用 WebAV 合成 MP4…' }));
    try {
      const blob = await adapterRef.current!.export(project, (progress) => setEditor((previous) => ({ ...previous, message: `正在导出 ${(progress * 100).toFixed(0)}%` })));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'frameyu-demo.mp4';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setEditor((previous) => ({ ...previous, status: 'ready', message: `导出成功（${(blob.size / 1024 / 1024).toFixed(1)} MB）` }));
    } catch (error) {
      console.error('[WebAV] export failed', error);
      setEditor((previous) => ({ ...previous, status: 'error', message: `导出失败：${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  function targetTrack(type: TrackType) {
    const selectedTrack = getTrack(project, selectedTrackId);
    return selectedTrack?.type === type ? selectedTrack : tracks.find((track) => track.type === type);
  }

  function addAudio(asset: Asset, type: 'music' | 'sfx') {
    const track = targetTrack(type);
    if (!track) return;
    setProject((previous) => addAudioClip(previous, asset, track.id));
    setEditor((previous) => ({ ...previous, status: 'ready', message: `${asset.name} 已加入${track.name}` }));
  }

  function addCaptionToSelectedTrack() {
    const track = targetTrack('caption');
    if (track) setProject((previous) => addCaption(previous, track.id));
  }

  function createTrack(type: Exclude<TrackType, 'video'>) {
    const trackId = makeId('track');
    setProject((previous) => addTrack(previous, type, trackId));
    setSelectedTrackId(trackId);
    setPendingTrackFocusId(trackId);
    const label = ({ caption: '字幕', music: '背景音乐', sfx: '音效' } as const)[type];
    setEditor((previous) => ({ ...previous, status: 'ready', message: `已新增${label}轨` }));
  }

  function deleteTrack(track: Track) {
    if (track.type === 'video') {
      setEditor((previous) => ({ ...previous, status: 'error', message: '默认视频轨不能删除。' }));
      return;
    }
    if (track.clipIds.length > 0) {
      setEditor((previous) => ({ ...previous, status: 'error', message: `“${track.name}”含有片段，请先移动或删除其中片段。` }));
      return;
    }
    setProject((previous) => deleteEmptyTrack(previous, track.id));
    setSelectedTrackId('video');
  }

  function updateSelected(patch: Partial<TimelineClip>) {
    if (!selected) return;
    setProject((previous) => updateClip(previous, selected.id, patch));
  }

  function pointerTime(event: Pick<React.PointerEvent, 'clientX'>) {
    const viewport = timelineScrollRef.current;
    if (!viewport) return 0;
    const { left } = viewport.getBoundingClientRect();
    return clamp(viewportXToTime(event.clientX, left, viewport.scrollLeft, editor.zoom), 0, projectDuration);
  }

  function trackAtClientY(clientY: number) {
    const viewport = timelineScrollRef.current;
    if (!viewport) return undefined;
    const { top } = viewport.getBoundingClientRect();
    let offset = clientY - top + viewport.scrollTop;
    for (const track of sortedTracks(projectRef.current.tracks)) {
      if (offset < track.heightPx) return track;
      offset -= track.heightPx;
    }
    return undefined;
  }

  function autoScrollTracks(clientY: number) {
    const viewport = timelineScrollRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (clientY < rect.top + 34) viewport.scrollTop = Math.max(0, viewport.scrollTop - 14);
    if (clientY > rect.bottom - 34) viewport.scrollTop += 14;
  }

  function startClipDrag(event: React.PointerEvent, clip: TimelineClip, mode: Extract<DragState, { kind: 'clip' }>['mode']) {
    if (clip.type === 'video') return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSelectedTrackId(clip.trackId);
    setEditor((previous) => ({ ...previous, selectedClipId: clip.id, playback: 'paused' }));
    adapterRef.current?.pause();
    const nextDrag: DragState = { kind: 'clip', pointerId: event.pointerId, clip, mode, pointerStartMs: pointerTime(event) };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  }

  function startPlayheadDrag(event: React.PointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    adapterRef.current?.pause();
    setEditor((previous) => ({ ...previous, playback: 'paused' }));
    const nextDrag: DragState = { kind: 'playhead', pointerId: event.pointerId };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  }

  function startTrackDrag(event: React.PointerEvent, track: Track) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSelectedTrackId(track.id);
    const nextDrag: DragState = { kind: 'track', pointerId: event.pointerId, trackId: track.id };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  }

  function startTrackResize(event: React.PointerEvent, track: Track) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const nextDrag: DragState = { kind: 'track-height', pointerId: event.pointerId, trackId: track.id, startHeight: track.heightPx, startClientY: event.clientY };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  }

  function startLayoutDrag(event: React.PointerEvent, kind: LayoutDrag['kind']) {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const startValue = kind === 'asset' ? layout.assetWidth : kind === 'property' ? layout.propertyWidth : layout.timelineHeight;
    const nextDrag: LayoutDrag = { kind, pointerId: event.pointerId, startClient: kind === 'timeline' ? event.clientY : event.clientX, startValue };
    layoutDragRef.current = nextDrag;
    setLayoutDrag(nextDrag);
  }

  function moveInteractions(event: React.PointerEvent) {
    const activeLayoutDrag = layoutDragRef.current;
    if (activeLayoutDrag?.pointerId === event.pointerId) {
      const container = editorBodyRef.current;
      if (!container) return;
      const delta = (activeLayoutDrag.kind === 'timeline' ? event.clientY : event.clientX) - activeLayoutDrag.startClient;
      const next = activeLayoutDrag.kind === 'asset'
        ? { ...layout, assetWidth: activeLayoutDrag.startValue + delta }
        : activeLayoutDrag.kind === 'property'
          ? { ...layout, propertyWidth: activeLayoutDrag.startValue - delta }
          : { ...layout, timelineHeight: activeLayoutDrag.startValue - delta };
      const rect = container.getBoundingClientRect();
      setLayout(normaliseWorkspaceLayout(next, rect.width, rect.height));
      return;
    }
    const activeDrag = dragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    if (activeDrag.kind === 'playhead') {
      setEditor((previous) => ({ ...previous, playheadMs: pointerTime(event) }));
      return;
    }
    if (activeDrag.kind === 'track-height') {
      setProject((previous) => resizeTrack(previous, activeDrag.trackId, activeDrag.startHeight + event.clientY - activeDrag.startClientY));
      return;
    }
    if (activeDrag.kind === 'track') {
      autoScrollTracks(event.clientY);
      const target = trackAtClientY(event.clientY);
      if (target) {
        const index = sortedTracks(projectRef.current.tracks).findIndex((track) => track.id === target.id);
        setProject((previous) => reorderTrack(previous, activeDrag.trackId, index));
      }
      return;
    }
    const nextTimeMs = pointerTime(event);
    const deltaMs = nextTimeMs - activeDrag.pointerStartMs;
    if (activeDrag.mode === 'move') {
      const target = trackAtClientY(event.clientY);
      setProject((previous) => moveClipToCompatibleTrack(previous, activeDrag.clip.id, activeDrag.clip.startMs + deltaMs, target?.id ?? activeDrag.clip.trackId));
    }
    if (activeDrag.mode === 'left') setProject((previous) => trimProjectClip(previous, activeDrag.clip.id, activeDrag.clip.startMs + deltaMs, 'left'));
    if (activeDrag.mode === 'right') setProject((previous) => trimProjectClip(previous, activeDrag.clip.id, activeDrag.clip.durationMs + deltaMs, 'right'));
  }

  function endInteractions(event?: React.PointerEvent) {
    const activeLayoutDrag = layoutDragRef.current;
    const activeDrag = dragRef.current;
    if (activeLayoutDrag && (!event || activeLayoutDrag.pointerId === event.pointerId)) {
      layoutDragRef.current = undefined;
      setLayoutDrag(undefined);
    }
    if (activeDrag && (!event || activeDrag.pointerId === event.pointerId)) {
      if (activeDrag.kind === 'playhead' && event) void syncAndSeek(pointerTime(event));
      dragRef.current = undefined;
      setDrag(undefined);
    }
  }

  function clickTimeline(event: React.MouseEvent<HTMLDivElement>) {
    if (dragRef.current || !projectDuration) return;
    void syncAndSeek(pointerTime(event));
  }

  function syncBodyScroll(event: React.UIEvent<HTMLDivElement>) {
    const left = event.currentTarget.scrollLeft;
    if (rulerScrollRef.current && rulerScrollRef.current.scrollLeft !== left) rulerScrollRef.current.scrollLeft = left;
    setTimelineScrollLeft(left);
  }

  function syncRulerScroll(event: React.UIEvent<HTMLDivElement>) {
    const left = event.currentTarget.scrollLeft;
    if (timelineScrollRef.current && timelineScrollRef.current.scrollLeft !== left) timelineScrollRef.current.scrollLeft = left;
    setTimelineScrollLeft(left);
  }

  const ticks = useMemo(() => Array.from({ length: Math.ceil(timelineDuration / 1000) + 1 }, (_, index) => index * 1000), [timelineDuration]);

  const workspaceStyle: CSSProperties = { gridTemplateColumns: `${layout.assetWidth}px ${WORKSPACE_DIVIDER_SIZE}px minmax(${MIN_PREVIEW_WIDTH}px, 1fr) ${WORKSPACE_DIVIDER_SIZE}px ${layout.propertyWidth}px` };

  return <main className={`editor-shell ${layoutDrag ? 'is-resizing' : ''}`} onPointerMove={moveInteractions} onPointerUp={endInteractions} onPointerCancel={endInteractions} onLostPointerCapture={() => endInteractions()}>
    <header className="topbar">
      <div><strong>帧语智能编辑器</strong><span className="tag">WebAV Demo</span></div>
      <div className={`status ${editor.status}`}>{editor.status === 'loading' ? '加载中' : editor.status === 'exporting' ? '导出中' : editor.status === 'error' ? '异常' : '就绪'} · {editor.message}</div>
      <button className="primary" disabled={!projectDuration || editor.status === 'exporting'} onClick={exportVideo}>导出 MP4</button>
    </header>
    {!capability?.supported && <div className="capability-warning"><b>兼容性提示：</b>{capability ? capability.reasons.join(' ') : '正在检测 WebCodecs 与 WebAV…'}</div>}
    <div className="editor-body" ref={editorBodyRef}>
      <section className="workspace" style={workspaceStyle}>
        <aside className="asset-panel panel">
          <h2>素材库</h2>
          <label className="import-button">导入视频<input aria-label="导入视频" type="file" accept="video/mp4" onChange={(event) => event.target.files?.[0] && void importVideo(event.target.files[0])} /></label>
          <div className="asset-list">{project.assets.filter((asset) => asset.type === 'video').map((asset) => <div className="asset-card" key={asset.id}><b title={asset.name}>{asset.name}</b><small>视频 · {formatTime(asset.durationMs)}</small><button onClick={() => { setProject((previous) => appendVideoClip(previous, asset)); setEditor((previous) => ({ ...previous, status: 'ready', message: `${asset.name} 已追加到视频轨` })); }}>+ 视频轨</button></div>)}</div>
          <label className="import-button subtle">导入音乐 / 音效<input aria-label="导入音频" type="file" accept="audio/mpeg,audio/wav" onChange={(event) => event.target.files?.[0] && void importAudio(event.target.files[0])} /></label>
          <div className="asset-list">{project.assets.filter((asset) => asset.type === 'audio').map((asset) => <div className="asset-card" key={asset.id}><b title={asset.name}>{asset.name}</b><small>{formatTime(asset.durationMs)}</small><div><button onClick={() => addAudio(asset, 'music')} disabled={!projectDuration}>+ 音乐</button><button onClick={() => addAudio(asset, 'sfx')} disabled={!projectDuration}>+ 音效</button></div></div>)}</div>
          <button className="caption-add" disabled={!projectDuration} onClick={addCaptionToSelectedTrack}>＋ 添加字幕</button>
        </aside>
        <Divider kind="asset" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, assetWidth: DEFAULT_WORKSPACE_LAYOUT.assetWidth }))} />
        <section className="preview-panel panel">
          <div className="preview-frame"><div ref={previewRef} className="webav-preview" /></div>
          <div className="player-controls"><button aria-label="播放或暂停" disabled={!projectDuration} onClick={togglePlayback}>{editor.playback === 'playing' ? '❚❚ 暂停' : '▶ 播放'}</button><span data-testid="project-duration" data-duration-ms={projectDuration}>{formatTime(editor.playheadMs)} / {formatTime(projectDuration)}</span><input aria-label="播放位置" disabled={!projectDuration} type="range" min="0" max={projectDuration || 1} value={editor.playheadMs} onChange={(event) => void syncAndSeek(Number(event.target.value))} /></div>
        </section>
        <Divider kind="property" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, propertyWidth: DEFAULT_WORKSPACE_LAYOUT.propertyWidth }))} />
        <aside className="property-panel panel"><h2>属性</h2>{selected ? <Properties clip={selected} asset={selectedAsset} projectDuration={projectDuration} onUpdate={updateSelected} onDelete={() => { setProject((previous) => removeClip(previous, selected.id)); setEditor((previous) => ({ ...previous, selectedClipId: undefined })); }} /> : <p className="empty">选择时间轴片段以编辑属性</p>}</aside>
      </section>
      <Divider kind="timeline" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, timelineHeight: DEFAULT_WORKSPACE_LAYOUT.timelineHeight }))} />
      <section className="timeline-panel panel" style={{ height: `${layout.timelineHeight}px` }}>
        <div className="timeline-toolbar"><b>时间轴</b><div className="timeline-actions"><button onClick={() => createTrack('caption')}>+ 字幕轨</button><button onClick={() => createTrack('music')}>+ 音乐轨</button><button onClick={() => createTrack('sfx')}>+ 音效轨</button><label>缩放 <input aria-label="时间轴缩放" type="range" min="45" max="240" value={editor.zoom} onChange={(event) => setEditor((previous) => ({ ...previous, zoom: Number(event.target.value) }))} /></label></div></div>
        <div className="timeline-viewport">
          <div className="timeline-ruler-row"><div className="timeline-ruler-label">轨道</div><div className="timeline-ruler-scroll" ref={rulerScrollRef} onScroll={syncRulerScroll}><div className="ruler" style={{ width: `${contentWidth - TRACK_HEADER_WIDTH_PX}px` }}>{ticks.map((time) => <span key={time} style={{ left: `${timeToTimelineX(time, editor.zoom) - TRACK_HEADER_WIDTH_PX}px` }}>{formatTime(time).slice(0, 5)}</span>)}</div></div></div>
          <div className="timeline-body-viewport"><div className="timeline-scroll" ref={timelineScrollRef} onScroll={syncBodyScroll}><div className="timeline-content" style={{ width: `${contentWidth}px` }} onClick={clickTimeline}>{tracks.map((track) => <TrackRow key={track.id} track={track} clips={project.clips.filter((clip) => clip.trackId === track.id)} selectedClipId={selected?.id} selectedTrackId={selectedTrackId} zoom={editor.zoom} onSelectTrack={setSelectedTrackId} onStartTrackDrag={startTrackDrag} onStartTrackResize={startTrackResize} onStartClipDrag={startClipDrag} onRename={(name) => setProject((previous) => renameTrack(previous, track.id, name))} onDelete={() => deleteTrack(track)} onSelectClip={(clip) => { setSelectedTrackId(track.id); setEditor((previous) => ({ ...previous, selectedClipId: clip.id })); }} />)}</div></div><div className="playhead" style={{ left: `${timeToTimelineX(editor.playheadMs, editor.zoom) - timelineScrollLeft}px` }} onPointerDown={startPlayheadDrag} onClick={(event) => event.stopPropagation()} /></div>
        </div>
      </section>
    </div>
  </main>;
}

function Divider({ kind, onPointerDown, onDoubleClick }: { kind: LayoutDrag['kind']; onPointerDown: (event: React.PointerEvent, kind: LayoutDrag['kind']) => void; onDoubleClick: () => void }) {
  const horizontal = kind === 'timeline';
  const label = horizontal ? '调整时间轴高度' : kind === 'asset' ? '调整素材库宽度' : '调整属性面板宽度';
  return <div role="separator" aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} tabIndex={0} className={`layout-divider ${horizontal ? 'horizontal' : 'vertical'}`} onPointerDown={(event) => onPointerDown(event, kind)} onDoubleClick={onDoubleClick} />;
}

function TrackRow({ track, clips, selectedClipId, selectedTrackId, zoom, onSelectTrack, onStartTrackDrag, onStartTrackResize, onStartClipDrag, onRename, onDelete, onSelectClip }: { track: Track; clips: TimelineClip[]; selectedClipId?: string; selectedTrackId: string; zoom: number; onSelectTrack: (trackId: string) => void; onStartTrackDrag: (event: React.PointerEvent, track: Track) => void; onStartTrackResize: (event: React.PointerEvent, track: Track) => void; onStartClipDrag: (event: React.PointerEvent, clip: TimelineClip, mode: 'move' | 'left' | 'right') => void; onRename: (name: string) => void; onDelete: () => void; onSelectClip: (clip: TimelineClip) => void }) {
  return <div className={`track ${selectedTrackId === track.id ? 'selected-track' : ''}`} id={`track-row-${track.id}`} style={{ height: `${track.heightPx}px` }} onClick={() => onSelectTrack(track.id)}>
    <div className="track-label" onClick={(event) => event.stopPropagation()}>
      <button className="track-grip" aria-label={`拖动${track.name}排序`} title="拖动排序" onPointerDown={(event) => onStartTrackDrag(event, track)}>⠿</button>
      <input aria-label={`${track.name}名称`} value={track.name} onChange={(event) => onRename(event.target.value)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} />
      <button className="track-delete" aria-label={`删除${track.name}`} title={track.type === 'video' ? '默认视频轨不能删除' : track.clipIds.length ? '含有片段的轨道不能删除' : '删除空轨道'} disabled={track.type === 'video'} onClick={onDelete}>×</button>
    </div>
    <div className="track-lane" style={{ backgroundSize: `${zoom}px 100%` }}>{clips.map((clip) => <div role="button" tabIndex={0} className={`timeline-clip ${clip.type} ${selectedClipId === clip.id ? 'selected' : ''}`} key={clip.id} style={{ left: `${clip.startMs / 1000 * zoom}px`, width: `${Math.max(18, clip.durationMs / 1000 * zoom)}px` }} onPointerDown={(event) => onStartClipDrag(event, clip, 'move')} onClick={(event) => { event.stopPropagation(); onSelectClip(clip); }}><i className="trim left" onPointerDown={(event) => onStartClipDrag(event, clip, 'left')} /><span>{clip.type === 'caption' ? clip.text : clip.name}</span>{clip.type !== 'video' && <i className="trim right" onPointerDown={(event) => onStartClipDrag(event, clip, 'right')} />}</div>)}</div>
    <div className="track-height-handle" aria-label={`调整${track.name}高度`} onPointerDown={(event) => onStartTrackResize(event, track)} />
  </div>;
}

function Properties({ clip, asset, projectDuration, onUpdate, onDelete }: { clip: TimelineClip; asset?: Asset; projectDuration: number; onUpdate: (patch: Partial<TimelineClip>) => void; onDelete: () => void }) {
  const number = (label: string, value: number, update: (next: number) => void, min = 0, max = projectDuration) => <label className="field">{label}<input type="number" min={min} max={max} value={Math.round(value)} onChange={(event) => update(Number(event.target.value))} /></label>;
  if (clip.type === 'caption') return <div className="properties"><label className="field">字幕文字<textarea value={clip.text ?? ''} onChange={(event) => onUpdate({ text: event.target.value, name: event.target.value.slice(0, 18) || '字幕' })} /></label>{number('开始时间（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('结束时间（ms）', clip.startMs + clip.durationMs, (endMs) => onUpdate({ durationMs: clamp(endMs - clip.startMs, 100, projectDuration - clip.startMs) }), 100, projectDuration)}<label className="field">字号<input type="number" min="16" max="100" value={clip.captionStyle?.fontSize ?? 46} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, fontSize: Number(event.target.value) } })} /></label><label className="field">颜色<input type="color" value={clip.captionStyle?.color ?? '#ffffff'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, color: event.target.value } })} /></label><label className="field">位置<select value={clip.captionStyle?.position ?? 'bottom'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, position: event.target.value as 'top' | 'center' | 'bottom' } })}><option value="bottom">下方居中</option><option value="center">画面中央</option><option value="top">顶部居中</option></select></label><button className="danger" onClick={onDelete}>删除字幕</button></div>;
  if (clip.type === 'audio') return <div className="properties"><p><b>{clip.name}</b></p>{number('轨道开始（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('源文件起点（ms）', clip.sourceStartMs, (sourceStartMs) => onUpdate({ sourceStartMs: clamp(sourceStartMs, 0, Math.max(0, (asset?.durationMs ?? 0) - clip.durationMs)) }), 0, asset?.durationMs ?? 0)}{number('使用时长（ms）', clip.durationMs, (durationMs) => onUpdate({ durationMs: clamp(durationMs, 100, Math.min(projectDuration - clip.startMs, (asset?.durationMs ?? 0) - clip.sourceStartMs)) }), 100, asset?.durationMs ?? projectDuration)}<label className="field">音量 {Math.round(clip.volume * 100)}%<input type="range" min="0" max="1" step="0.05" value={clip.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} /></label><button className="danger" onClick={onDelete}>删除片段</button></div>;
  return <div className="properties"><p><b>{clip.name}</b></p><p>视频片段保留原声。移动与左右裁剪将在下一阶段开放。</p></div>;
}
