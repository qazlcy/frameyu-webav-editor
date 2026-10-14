import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, canSplitTimelineClip, defaultVideoLayout, deleteEmptyTrack, getAsset, getProjectDuration, getTrack, moveClipToCompatibleTrack, moveProjectClip, removeClip, renameTrack, reorderTrack, resizeTrack, setVideoLayoutMode, splitTimelineClip, trimProjectClip, updateClip, updateVideoLayout } from './editor/commands';
import { emptyProject, type Asset, type AudioKind, type CaptionDraft, type EditorState, type Project, type TimelineClip, type Track, type TrackType, type VideoLayout } from './editor/types';
import { DEFAULT_WORKSPACE_LAYOUT, MIN_PREVIEW_WIDTH, WORKSPACE_DIVIDER_SIZE, normaliseWorkspaceLayout, type WorkspaceLayout } from './editor/layoutMath';
import { TRACK_HEADER_WIDTH_PX, clamp, timelineContentWidth, timeToTimelineX, viewportXToTime } from './editor/timelineMath';
import { WebAVAdapter, type CapabilityReport } from './webav/WebAVAdapter';
import { sampleThumbnailsForClip, sampleWaveformRange, TimelineMediaPreviewCache } from './timeline/mediaPreviewCache';

const initialEditor: EditorState = { playheadMs: 0, zoom: 100, playback: 'idle', status: 'ready', message: '等待导入视频素材' };
const formatTime = (timeMs: number) => `${String(Math.floor(timeMs / 60000)).padStart(2, '0')}:${String(Math.floor(timeMs / 1000) % 60).padStart(2, '0')}.${String(Math.floor(timeMs % 1000 / 10)).padStart(2, '0')}`;
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const LAYOUT_STORAGE_KEY = 'frameyu-workspace-layout-v1';
type LayoutState = WorkspaceLayout;
type MaterialFilter = 'all' | 'video' | 'music' | 'sfx' | 'caption';
type LayoutDrag = { kind: 'asset' | 'property' | 'timeline'; pointerId: number; startClient: number; startValue: number };
type ClipContextMenu = { clipId: string; x: number; y: number };

type DragState =
  | { kind: 'clip'; pointerId: number; clip: TimelineClip; mode: 'move' | 'left' | 'right'; pointerStartMs: number }
  | { kind: 'playhead'; pointerId: number }
  | { kind: 'track'; pointerId: number; trackId: string }
  | { kind: 'track-height'; pointerId: number; trackId: string; startHeight: number; startClientY: number }
  | { kind: 'canvas-video'; pointerId: number; clipId: string; mode: 'move' | 'resize'; pointerStartX: number; pointerStartY: number; layout: VideoLayout };

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
  const materialListRef = useRef<HTMLDivElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const sfxInputRef = useRef<HTMLInputElement>(null);
  const audioPreviewUrlsRef = useRef(new Map<string, string>());
  const assetFilesRef = useRef(new Map<string, File>());
  const timelinePreviewCacheRef = useRef(new TimelineMediaPreviewCache());
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
  const [materialFilter, setMaterialFilter] = useState<MaterialFilter>('all');
  const [captionDraft, setCaptionDraft] = useState<CaptionDraft>({ text: '', startMs: 0, endMs: 3000 });
  const [captionComposerOpen, setCaptionComposerOpen] = useState(false);
  const [timelinePreviewVersion, setTimelinePreviewVersion] = useState(0);
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenu>();

  projectRef.current = project;
  const projectDuration = getProjectDuration(project);
  durationRef.current = projectDuration;
  const selected = project.clips.find((clip) => clip.id === editor.selectedClipId);
  const selectedAsset = selected?.assetId ? getAsset(project, selected.assetId) : undefined;
  const selectedVideoLayout = selected?.type === 'video' ? selected.videoLayout ?? defaultVideoLayout(project, selectedAsset) : undefined;
  const timelineDuration = Math.max(projectDuration, 10000);
  const tracks = useMemo(() => sortedTracks(project.tracks), [project.tracks]);
  const assetsById = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const visibleMaterials = useMemo(() => {
    const assets = project.assets.filter((asset) => materialFilter === 'all' || materialFilter === 'video' && asset.type === 'video' || materialFilter === 'music' && asset.type === 'audio' && (asset.audioKind ?? 'music') === 'music' || materialFilter === 'sfx' && asset.type === 'audio' && asset.audioKind === 'sfx');
    const captions = project.clips.filter((clip) => clip.type === 'caption' && (materialFilter === 'all' || materialFilter === 'caption'));
    return { assets, captions };
  }, [materialFilter, project.assets, project.clips]);
  const contentWidth = timelineContentWidth(timelineDuration, editor.zoom);
  const mediaSignature = useMemo(() => JSON.stringify({
    width: project.width,
    height: project.height,
    videoTracks: project.tracks.filter((track) => track.type === 'video').map(({ id, order }) => ({ id, order })),
    clips: project.clips.map(({ id, trackId, type, assetId, name, startMs, sourceStartMs, durationMs, playbackRate, volume, muted, videoLayout, text, captionStyle }) => ({ id, trackId, type, assetId, name, startMs, sourceStartMs, durationMs, playbackRate, volume, muted, videoLayout, text, captionStyle })),
  }), [project.width, project.height, project.tracks, project.clips]);
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
    return () => {
      adapter.destroy();
      audioPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      audioPreviewUrlsRef.current.clear();
      assetFilesRef.current.clear();
      timelinePreviewCacheRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const asset of project.assets) {
      const file = assetFilesRef.current.get(asset.id);
      if (!file) continue;
      const task = asset.type === 'audio'
        ? timelinePreviewCacheRef.current.ensureWaveform(asset, file)
        : timelinePreviewCacheRef.current.ensureThumbnails(asset, file);
      void task.then(() => {
        if (!cancelled) setTimelinePreviewVersion((version) => version + 1);
      }).catch((error: unknown) => console.warn('[WebAV] timeline media preview unavailable', asset.name, error));
    }
    return () => { cancelled = true; };
  }, [project.assets]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select, button, [contenteditable="true"]'))) return;
      if (!selected || !canSplitTimelineClip(projectRef.current, selected.id, editor.playheadMs)) return;
      event.preventDefault();
      splitClipAtPlayhead(selected.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor.playheadMs, project, selected]);

  async function importVideo(file: File) {
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在解析视频…' }));
    try {
      const info = await adapterRef.current!.inspectFile(file, 'video');
      const asset: Asset = { id: makeId('video'), name: file.name, type: 'video', mimeType: file.type, ...info };
      adapterRef.current!.registerAsset(asset, file);
      assetFilesRef.current.set(asset.id, file);
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

  async function importAudio(file: File, audioKind: AudioKind) {
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在解析音频…' }));
    try {
      const info = await adapterRef.current!.inspectFile(file, 'audio');
      const asset: Asset = { id: makeId('audio'), name: file.name, type: 'audio', audioKind, mimeType: file.type, ...info };
      adapterRef.current!.registerAsset(asset, file);
      assetFilesRef.current.set(asset.id, file);
      audioPreviewUrlsRef.current.set(asset.id, URL.createObjectURL(file));
      setProject((previous) => ({ ...previous, assets: [...previous.assets, asset] }));
      setEditor((previous) => ({ ...previous, status: 'ready', message: `已导入${audioKind === 'music' ? '音乐' : '音效'} ${file.name}` }));
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

  function addVideo(asset: Asset) {
    const track = targetTrack('video');
    if (!track) return;
    setProject((previous) => appendVideoClip(previous, asset, track.id));
    setEditor((previous) => ({ ...previous, status: 'ready', message: `${asset.name} 已加入${track.name}` }));
  }

  function addCaptionToSelectedTrack() {
    const track = targetTrack('caption');
    if (!track) return;
    const safeEndMs = Math.min(Math.max(captionDraft.endMs, captionDraft.startMs + 100), projectDuration);
    setProject((previous) => addCaption(previous, track.id, { ...captionDraft, endMs: safeEndMs }));
    setCaptionDraft((previous) => ({ ...previous, startMs: safeEndMs, endMs: Math.min(projectDuration, safeEndMs + 3000) }));
    setCaptionComposerOpen(false);
    setEditor((previous) => ({ ...previous, status: 'ready', message: '已创建手动字幕' }));
  }

  function showMaterialLibrary() {
    setMaterialFilter('all');
    setEditor((previous) => ({ ...previous, status: 'ready', message: '请选择下方素材并添加到时间轴' }));
    requestAnimationFrame(() => materialListRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  function createTrack(type: TrackType) {
    const trackId = makeId('track');
    setProject((previous) => addTrack(previous, type, trackId));
    setSelectedTrackId(trackId);
    setPendingTrackFocusId(trackId);
    const label = ({ caption: '字幕', video: '视频', music: '背景音乐', sfx: '音效' } as const)[type];
    setEditor((previous) => ({ ...previous, status: 'ready', message: `已新增${label}轨` }));
  }

  function deleteTrack(track: Track) {
    if (track.type === 'video' && tracks.filter((item) => item.type === 'video').length <= 1) {
      setEditor((previous) => ({ ...previous, status: 'error', message: '至少保留一条视频轨。' }));
      return;
    }
    if (track.clipIds.length > 0) {
      setEditor((previous) => ({ ...previous, status: 'error', message: `“${track.name}”含有片段，请先移动或删除其中片段。` }));
      return;
    }
    setProject((previous) => deleteEmptyTrack(previous, track.id));
    setSelectedTrackId(tracks.find((item) => item.type === 'video' && item.id !== track.id)?.id ?? 'video');
  }

  function updateSelected(patch: Partial<TimelineClip>) {
    if (!selected) return;
    setProject((previous) => updateClip(previous, selected.id, patch));
  }

  function splitClipAtPlayhead(clipId = selected?.id) {
    if (!clipId) return;
    const current = projectRef.current;
    if (!canSplitTimelineClip(current, clipId, editor.playheadMs)) {
      setEditor((previous) => ({ ...previous, status: 'error', message: '播放头必须位于视频、音乐或音效片段的内部才能分割。' }));
      return;
    }
    adapterRef.current?.pause();
    setProject((previous) => splitTimelineClip(previous, clipId, editor.playheadMs));
    setEditor((previous) => ({ ...previous, selectedClipId: undefined, playback: 'paused', status: 'ready', message: '已在播放头位置分割片段。' }));
    setClipContextMenu(undefined);
  }

  function updateSelectedVideoLayout(patch: Partial<VideoLayout>) {
    if (!selected || selected.type !== 'video') return;
    setProject((previous) => updateVideoLayout(previous, selected.id, patch));
  }

  function setSelectedVideoLayoutMode(mode: 'full' | 'pip') {
    if (!selected || selected.type !== 'video') return;
    setProject((previous) => setVideoLayoutMode(previous, selected.id, mode));
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
    if (event.button !== 0) return;
    event.stopPropagation();
    setClipContextMenu(undefined);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSelectedTrackId(clip.trackId);
    setEditor((previous) => ({ ...previous, selectedClipId: clip.id, playback: 'paused' }));
    adapterRef.current?.pause();
    const nextDrag: DragState = { kind: 'clip', pointerId: event.pointerId, clip, mode, pointerStartMs: pointerTime(event) };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  }

  function previewPoint(event: Pick<React.PointerEvent, 'clientX' | 'clientY'>) {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / rect.width * project.width, y: (event.clientY - rect.top) / rect.height * project.height };
  }

  function startCanvasVideoDrag(event: React.PointerEvent, mode: 'move' | 'resize') {
    if (!selected || selected.type !== 'video' || !selectedVideoLayout) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = previewPoint(event);
    const nextDrag: DragState = { kind: 'canvas-video', pointerId: event.pointerId, clipId: selected.id, mode, pointerStartX: point.x, pointerStartY: point.y, layout: selectedVideoLayout };
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
    if (activeDrag.kind === 'canvas-video') {
      const point = previewPoint(event);
      const deltaX = point.x - activeDrag.pointerStartX;
      const deltaY = point.y - activeDrag.pointerStartY;
      const patch = activeDrag.mode === 'move'
        ? { x: activeDrag.layout.x + deltaX, y: activeDrag.layout.y + deltaY, mode: 'custom' as const }
        : { width: activeDrag.layout.width + deltaX, height: activeDrag.layout.height + deltaY, mode: 'custom' as const };
      setProject((previous) => updateVideoLayout(previous, activeDrag.clipId, patch));
      return;
    }
    const nextTimeMs = pointerTime(event);
    const deltaMs = nextTimeMs - activeDrag.pointerStartMs;
    if (activeDrag.clip.type === 'video') {
      const target = trackAtClientY(event.clientY);
      if (activeDrag.mode === 'move') setProject((previous) => moveClipToCompatibleTrack(previous, activeDrag.clip.id, activeDrag.clip.startMs + deltaMs, target?.type === 'video' ? target.id : activeDrag.clip.trackId));
      if (activeDrag.mode === 'left') setProject((previous) => trimProjectClip(previous, activeDrag.clip.id, activeDrag.clip.startMs + deltaMs, 'left'));
      if (activeDrag.mode === 'right') setProject((previous) => trimProjectClip(previous, activeDrag.clip.id, activeDrag.clip.durationMs + deltaMs, 'right'));
      return;
    }
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

  function openClipContextMenu(event: React.MouseEvent, clip: TimelineClip) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedTrackId(clip.trackId);
    setEditor((previous) => ({ ...previous, selectedClipId: clip.id, playback: 'paused' }));
    adapterRef.current?.pause();
    setClipContextMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
  }

  return <main className={`editor-shell ${layoutDrag ? 'is-resizing' : ''}`} onPointerDown={() => setClipContextMenu(undefined)} onPointerMove={moveInteractions} onPointerUp={endInteractions} onPointerCancel={endInteractions} onLostPointerCapture={() => endInteractions()}>
    <header className="topbar">
      <div><strong>帧语智能编辑器</strong><span className="tag">WebAV Demo</span></div>
      <div className={`status ${editor.status}`}>{editor.status === 'loading' ? '加载中' : editor.status === 'exporting' ? '导出中' : editor.status === 'error' ? '异常' : '就绪'} · {editor.message}</div>
      <button className="primary" disabled={!projectDuration || editor.status === 'exporting'} onClick={exportVideo}>导出 MP4</button>
    </header>
    {!capability?.supported && <div className="capability-warning"><b>兼容性提示：</b>{capability ? capability.reasons.join(' ') : '正在检测 WebCodecs 与 WebAV…'}</div>}
    <div className="editor-body" ref={editorBodyRef}>
      <section className="workspace" style={workspaceStyle}>
        <aside className="asset-panel panel">
          <div className="material-actions">
            <div className="material-heading"><h2>素材库</h2><span>本地会话</span></div>
            <div className="material-entry-grid">
              <button className="material-entry video-entry" onClick={() => videoInputRef.current?.click()}><i>▣</i><span>导入/生成视频</span><small>本地 MP4 · 生成待接入</small></button>
              <button className="material-entry music-entry" onClick={() => musicInputRef.current?.click()}><i>♫</i><span>导入/生成音乐</span><small>MP3/WAV · 生成待接入</small></button>
              <button className="material-entry sfx-entry" onClick={() => sfxInputRef.current?.click()}><i>✦</i><span>导入/生成音效</span><small>MP3/WAV · 生成待接入</small></button>
              <button className="material-entry caption-entry" onClick={() => setCaptionComposerOpen((open) => !open)}><i>T</i><span>导入/生成字幕</span><small>手动创建 · ASR 待接入</small></button>
            </div>
            <button className="material-library-entry" onClick={showMaterialLibrary}><i>⌘</i> 从素材库导入</button>
            <input ref={videoInputRef} aria-label="导入视频" className="visually-hidden" type="file" accept="video/mp4" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importVideo(file); }} />
            <input ref={musicInputRef} aria-label="导入音乐" className="visually-hidden" type="file" accept="audio/mpeg,audio/wav" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importAudio(file, 'music'); }} />
            <input ref={sfxInputRef} aria-label="导入音效" className="visually-hidden" type="file" accept="audio/mpeg,audio/wav" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importAudio(file, 'sfx'); }} />
            {captionComposerOpen && <div className="caption-composer"><label>字幕文字<textarea aria-label="新字幕文字" value={captionDraft.text} onChange={(event) => setCaptionDraft((previous) => ({ ...previous, text: event.target.value }))} placeholder="输入字幕文本" /></label><div><label>开始 <input aria-label="字幕开始时间" type="number" min="0" max={projectDuration} value={captionDraft.startMs} onChange={(event) => setCaptionDraft((previous) => ({ ...previous, startMs: Number(event.target.value) }))} /></label><label>结束 <input aria-label="字幕结束时间" type="number" min="0" max={projectDuration} value={captionDraft.endMs} onChange={(event) => setCaptionDraft((previous) => ({ ...previous, endMs: Number(event.target.value) }))} /></label></div><button className="caption-add" disabled={!projectDuration} onClick={addCaptionToSelectedTrack}>创建字幕</button></div>}
            <div className="material-filters" role="tablist" aria-label="素材筛选">{([['all', '全部'], ['video', '视频'], ['music', '音乐'], ['sfx', '音效'], ['caption', '字幕']] as const).map(([filter, label]) => <button key={filter} role="tab" aria-selected={materialFilter === filter} className={materialFilter === filter ? 'active' : ''} onClick={() => setMaterialFilter(filter)}>{label}</button>)}</div>
          </div>
          <div className="material-list" ref={materialListRef} aria-label="素材列表">
            {visibleMaterials.assets.map((asset) => <MaterialAssetCard key={asset.id} asset={asset} previewUrl={audioPreviewUrlsRef.current.get(asset.id)} projectDuration={projectDuration} onAddVideo={() => addVideo(asset)} onAddAudio={(kind) => addAudio(asset, kind)} />)}
            {visibleMaterials.captions.map((clip) => <button className="asset-card caption-material-card" key={clip.id} onClick={() => { setSelectedTrackId(clip.trackId); setEditor((previous) => ({ ...previous, selectedClipId: clip.id })); }}><span className="asset-icon">T</span><span className="asset-card-body"><b title={clip.text}>{clip.text || '空字幕'}</b><small>字幕 · {formatTime(clip.durationMs)} · 编辑</small></span></button>)}
            {!visibleMaterials.assets.length && !visibleMaterials.captions.length && <p className="material-empty">暂无该类型素材。使用上方入口导入本地文件或手动创建字幕。</p>}
          </div>
        </aside>
        <Divider kind="asset" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, assetWidth: DEFAULT_WORKSPACE_LAYOUT.assetWidth }))} />
        <section className="preview-panel panel">
          <div className="preview-frame"><div ref={previewRef} className="webav-preview" />{selected?.type === 'video' && selectedVideoLayout && <div className="video-layout-overlay" aria-label="拖动或缩放选中视频图层" style={{ left: `${selectedVideoLayout.x / project.width * 100}%`, top: `${selectedVideoLayout.y / project.height * 100}%`, width: `${selectedVideoLayout.width / project.width * 100}%`, height: `${selectedVideoLayout.height / project.height * 100}%` }} onPointerDown={(event) => startCanvasVideoDrag(event, 'move')}><span>{selected.name}</span><i aria-label="缩放选中视频图层" onPointerDown={(event) => startCanvasVideoDrag(event, 'resize')} /></div>}</div>
          <div className="player-controls"><button aria-label="播放或暂停" disabled={!projectDuration} onClick={togglePlayback}>{editor.playback === 'playing' ? '❚❚ 暂停' : '▶ 播放'}</button><span data-testid="project-duration" data-duration-ms={projectDuration}>{formatTime(editor.playheadMs)} / {formatTime(projectDuration)}</span><input aria-label="播放位置" disabled={!projectDuration} type="range" min="0" max={projectDuration || 1} value={editor.playheadMs} onChange={(event) => void syncAndSeek(Number(event.target.value))} /></div>
        </section>
        <Divider kind="property" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, propertyWidth: DEFAULT_WORKSPACE_LAYOUT.propertyWidth }))} />
        <aside className="property-panel panel"><h2>属性</h2>{selected ? <Properties clip={selected} asset={selectedAsset} project={project} projectDuration={projectDuration} onUpdate={updateSelected} onUpdateVideoLayout={updateSelectedVideoLayout} onSetVideoLayoutMode={setSelectedVideoLayoutMode} onDelete={() => { setProject((previous) => removeClip(previous, selected.id)); setEditor((previous) => ({ ...previous, selectedClipId: undefined })); }} /> : <p className="empty">选择时间轴片段以编辑属性</p>}</aside>
      </section>
      <Divider kind="timeline" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, timelineHeight: DEFAULT_WORKSPACE_LAYOUT.timelineHeight }))} />
      <section className="timeline-panel panel" style={{ height: `${layout.timelineHeight}px` }}>
        <div className="timeline-toolbar"><b>时间轴</b><div className="timeline-actions"><button aria-label="分割选中片段" disabled={!selected || !canSplitTimelineClip(project, selected.id, editor.playheadMs)} onClick={() => splitClipAtPlayhead()}>分割</button><button onClick={() => createTrack('caption')}>+ 字幕轨</button><button onClick={() => createTrack('video')}>+ 视频轨</button><button onClick={() => createTrack('music')}>+ 音乐轨</button><button onClick={() => createTrack('sfx')}>+ 音效轨</button><label>缩放 <input aria-label="时间轴缩放" type="range" min="45" max="240" value={editor.zoom} onChange={(event) => setEditor((previous) => ({ ...previous, zoom: Number(event.target.value) }))} /></label></div></div>
        <div className="timeline-viewport">
          <div className="timeline-ruler-row"><div className="timeline-ruler-label">轨道</div><div className="timeline-ruler-scroll" ref={rulerScrollRef} onScroll={syncRulerScroll}><div className="ruler" style={{ width: `${contentWidth - TRACK_HEADER_WIDTH_PX}px` }}>{ticks.map((time) => <span key={time} style={{ left: `${timeToTimelineX(time, editor.zoom) - TRACK_HEADER_WIDTH_PX}px` }}>{formatTime(time).slice(0, 5)}</span>)}</div></div></div>
          <div className="timeline-body-viewport"><div className="timeline-scroll" ref={timelineScrollRef} onScroll={syncBodyScroll}><div className="timeline-content" style={{ width: `${contentWidth}px` }} onClick={clickTimeline}>{tracks.map((track) => <TrackRow key={track.id} track={track} clips={project.clips.filter((clip) => clip.trackId === track.id)} assetsById={assetsById} previewCache={timelinePreviewCacheRef.current} previewVersion={timelinePreviewVersion} selectedClipId={selected?.id} selectedTrackId={selectedTrackId} videoTrackCount={tracks.filter((item) => item.type === 'video').length} zoom={editor.zoom} onSelectTrack={setSelectedTrackId} onStartTrackDrag={startTrackDrag} onStartTrackResize={startTrackResize} onStartClipDrag={startClipDrag} onRename={(name) => setProject((previous) => renameTrack(previous, track.id, name))} onDelete={() => deleteTrack(track)} onSelectClip={(clip) => { setSelectedTrackId(track.id); setEditor((previous) => ({ ...previous, selectedClipId: clip.id })); }} onOpenContextMenu={openClipContextMenu} />)}</div></div><div className="playhead" style={{ left: `${timeToTimelineX(editor.playheadMs, editor.zoom) - timelineScrollLeft}px` }} onPointerDown={startPlayheadDrag} onClick={(event) => event.stopPropagation()} /></div>
        </div>
      </section>
      {clipContextMenu && <div className="clip-context-menu" role="menu" aria-label="片段操作菜单" style={{ left: `${clipContextMenu.x}px`, top: `${clipContextMenu.y}px` }} onPointerDown={(event) => event.stopPropagation()}><button role="menuitem" disabled={!canSplitTimelineClip(project, clipContextMenu.clipId, editor.playheadMs)} onClick={() => splitClipAtPlayhead(clipContextMenu.clipId)}>在播放头处分割</button></div>}
    </div>
  </main>;
}

function MaterialAssetCard({ asset, previewUrl, projectDuration, onAddVideo, onAddAudio }: { asset: Asset; previewUrl?: string; projectDuration: number; onAddVideo: () => void; onAddAudio: (kind: AudioKind) => void }) {
  const audioKind = asset.audioKind ?? 'music';
  const kindLabel = asset.type === 'video' ? '视频' : audioKind === 'music' ? '音乐' : '音效';
  const resolution = asset.type === 'video' && asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : '';
  return <article className={`asset-card ${asset.type === 'video' ? 'video' : audioKind}`}>
    <span className="asset-icon" aria-hidden="true">{asset.type === 'video' ? '▣' : audioKind === 'music' ? '♫' : '✦'}</span>
    <div className="asset-card-body"><b title={asset.name}>{asset.name}</b><small>{kindLabel} · {formatTime(asset.durationMs)}{resolution}</small>
      {asset.type === 'video' ? <button onClick={onAddVideo}>+ 视频轨</button> : <><div className="asset-card-actions"><button onClick={() => onAddAudio(audioKind)}>+ {audioKind === 'music' ? '音乐' : '音效'}</button><button className="secondary" onClick={() => onAddAudio(audioKind === 'music' ? 'sfx' : 'music')}>作为{audioKind === 'music' ? '音效' : '音乐'}</button></div>{previewUrl ? <audio aria-label={`试听 ${asset.name}`} controls preload="metadata" src={previewUrl} /> : <small className="audio-unavailable">本会话未保留试听源</small>}</>}
    </div>
  </article>;
}

function Divider({ kind, onPointerDown, onDoubleClick }: { kind: LayoutDrag['kind']; onPointerDown: (event: React.PointerEvent, kind: LayoutDrag['kind']) => void; onDoubleClick: () => void }) {
  const horizontal = kind === 'timeline';
  const label = horizontal ? '调整时间轴高度' : kind === 'asset' ? '调整素材库宽度' : '调整属性面板宽度';
  return <div role="separator" aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} tabIndex={0} className={`layout-divider ${horizontal ? 'horizontal' : 'vertical'}`} onPointerDown={(event) => onPointerDown(event, kind)} onDoubleClick={onDoubleClick} />;
}

function TrackRow({ track, clips, assetsById, previewCache, previewVersion, selectedClipId, selectedTrackId, videoTrackCount, zoom, onSelectTrack, onStartTrackDrag, onStartTrackResize, onStartClipDrag, onRename, onDelete, onSelectClip, onOpenContextMenu }: { track: Track; clips: TimelineClip[]; assetsById: ReadonlyMap<string, Asset>; previewCache: TimelineMediaPreviewCache; previewVersion: number; selectedClipId?: string; selectedTrackId: string; videoTrackCount: number; zoom: number; onSelectTrack: (trackId: string) => void; onStartTrackDrag: (event: React.PointerEvent, track: Track) => void; onStartTrackResize: (event: React.PointerEvent, track: Track) => void; onStartClipDrag: (event: React.PointerEvent, clip: TimelineClip, mode: 'move' | 'left' | 'right') => void; onRename: (name: string) => void; onDelete: () => void; onSelectClip: (clip: TimelineClip) => void; onOpenContextMenu: (event: React.MouseEvent, clip: TimelineClip) => void }) {
  return <div className={`track ${selectedTrackId === track.id ? 'selected-track' : ''}`} id={`track-row-${track.id}`} style={{ height: `${track.heightPx}px` }} onClick={() => onSelectTrack(track.id)}>
    <div className="track-label" onClick={(event) => event.stopPropagation()}>
      <button className="track-grip" aria-label={`拖动${track.name}排序`} title="拖动排序" onPointerDown={(event) => onStartTrackDrag(event, track)}>⠿</button>
      <input aria-label={`${track.name}名称`} value={track.name} onChange={(event) => onRename(event.target.value)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} />
      <button className="track-delete" aria-label={`删除${track.name}`} title={track.clipIds.length ? '含有片段的轨道不能删除' : track.type === 'video' && videoTrackCount <= 1 ? '至少保留一条视频轨' : '删除空轨道'} disabled={track.clipIds.length > 0 || track.type === 'video' && videoTrackCount <= 1} onClick={onDelete}>×</button>
    </div>
    <div className="track-lane" data-preview-version={previewVersion} style={{ backgroundSize: `${zoom}px 100%` }}>{clips.map((clip) => <div role="button" tabIndex={0} className={`timeline-clip ${clip.type} ${selectedClipId === clip.id ? 'selected' : ''}`} key={clip.id} style={{ left: `${clip.startMs / 1000 * zoom}px`, width: `${Math.max(18, clip.durationMs / 1000 * zoom)}px` }} onPointerDown={(event) => onStartClipDrag(event, clip, 'move')} onClick={(event) => { event.stopPropagation(); onSelectClip(clip); }} onContextMenu={(event) => onOpenContextMenu(event, clip)}><i className="trim left" onPointerDown={(event) => onStartClipDrag(event, clip, 'left')} /><TimelineClipPreview clip={clip} asset={clip.assetId ? assetsById.get(clip.assetId) : undefined} cache={previewCache} zoom={zoom} /><span className="timeline-clip-label">{clip.type === 'caption' ? clip.text : clip.name}</span><i className="trim right" onPointerDown={(event) => onStartClipDrag(event, clip, 'right')} /></div>)}</div>
    <div className="track-height-handle" aria-label={`调整${track.name}高度`} onPointerDown={(event) => onStartTrackResize(event, track)} />
  </div>;
}

function TimelineClipPreview({ clip, asset, cache, zoom }: { clip: TimelineClip; asset?: Asset; cache: TimelineMediaPreviewCache; zoom: number }) {
  const clipWidthPx = Math.max(18, clip.durationMs / 1000 * zoom);
  if (clip.type === 'audio') {
    const waveform = cache.getWaveform(clip.assetId);
    if (!waveform) return null;
    const sourceDurationMs = clip.durationMs * (clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1);
    const peaks = sampleWaveformRange(waveform, clip.sourceStartMs, sourceDurationMs, Math.min(180, Math.max(12, Math.ceil(clipWidthPx / 3))));
    return <div className="audio-waveform" aria-label="音频波形" aria-hidden="true">{peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(8, peak * 100)}%` }} />)}</div>;
  }
  if (clip.type === 'video' && asset) {
    const thumbnails = cache.getThumbnails(clip.assetId);
    if (!thumbnails) return null;
    const frames = sampleThumbnailsForClip(thumbnails, clip, Math.min(16, Math.max(1, Math.ceil(clipWidthPx / 84))));
    return <div className="video-thumbnails" aria-label="视频缩略图" aria-hidden="true">{frames.map((frame, index) => <img key={`${frame.timeMs}-${index}`} src={frame.url} draggable={false} alt="" />)}</div>;
  }
  return null;
}

function Properties({ clip, asset, project, projectDuration, onUpdate, onUpdateVideoLayout, onSetVideoLayoutMode, onDelete }: { clip: TimelineClip; asset?: Asset; project: Project; projectDuration: number; onUpdate: (patch: Partial<TimelineClip>) => void; onUpdateVideoLayout: (patch: Partial<VideoLayout>) => void; onSetVideoLayoutMode: (mode: 'full' | 'pip') => void; onDelete: () => void }) {
  const number = (label: string, value: number, update: (next: number) => void, min = 0, max = projectDuration) => <label className="field">{label}<input type="number" min={min} max={max} value={Math.round(value)} onChange={(event) => update(Number(event.target.value))} /></label>;
  if (clip.type === 'caption') return <div className="properties"><label className="field">字幕文字<textarea value={clip.text ?? ''} onChange={(event) => onUpdate({ text: event.target.value, name: event.target.value.slice(0, 18) || '字幕' })} /></label>{number('开始时间（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('结束时间（ms）', clip.startMs + clip.durationMs, (endMs) => onUpdate({ durationMs: clamp(endMs - clip.startMs, 100, projectDuration - clip.startMs) }), 100, projectDuration)}<label className="field">字号<input type="number" min="16" max="100" value={clip.captionStyle?.fontSize ?? 46} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, fontSize: Number(event.target.value) } })} /></label><label className="field">颜色<input type="color" value={clip.captionStyle?.color ?? '#ffffff'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, color: event.target.value } })} /></label><label className="field">位置<select value={clip.captionStyle?.position ?? 'bottom'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, position: event.target.value as 'top' | 'center' | 'bottom' } })}><option value="bottom">下方居中</option><option value="center">画面中央</option><option value="top">顶部居中</option></select></label><button className="danger" onClick={onDelete}>删除字幕</button></div>;
  if (clip.type === 'audio') return <div className="properties"><p><b>{clip.name}</b></p>{number('轨道开始（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('源文件起点（ms）', clip.sourceStartMs, (sourceStartMs) => onUpdate({ sourceStartMs: clamp(sourceStartMs, 0, Math.max(0, (asset?.durationMs ?? 0) - clip.durationMs)) }), 0, asset?.durationMs ?? 0)}{number('使用时长（ms）', clip.durationMs, (durationMs) => onUpdate({ durationMs: clamp(durationMs, 100, Math.min(projectDuration - clip.startMs, (asset?.durationMs ?? 0) - clip.sourceStartMs)) }), 100, asset?.durationMs ?? projectDuration)}<label className="field">音量 {Math.round(clip.volume * 100)}%<input type="range" min="0" max="1" step="0.05" value={clip.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} /></label><button className="danger" onClick={onDelete}>删除片段</button></div>;
  const layout = clip.videoLayout ?? defaultVideoLayout(project, asset);
  const layoutNumber = (label: string, value: number, patch: (next: number) => Partial<VideoLayout>, max: number) => <label className="field">{label}<input type="number" min="0" max={max} value={Math.round(value)} onChange={(event) => onUpdateVideoLayout(patch(Number(event.target.value)))} /></label>;
  return <div className="properties"><p><b>{clip.name}</b></p><p>时间轴移动/裁剪会同步原声；预览画布中可拖动边框，右下角可缩放。</p><div className="video-layout-actions"><button onClick={() => onSetVideoLayoutMode('full')}>全画面</button><button onClick={() => onSetVideoLayoutMode('pip')}>画中画</button><button onClick={() => onSetVideoLayoutMode('full')}>恢复默认布局</button></div>{layoutNumber('X', layout.x, (x) => ({ x, mode: 'custom' }), project.width)}{layoutNumber('Y', layout.y, (y) => ({ y, mode: 'custom' }), project.height)}{layoutNumber('宽度', layout.width, (width) => ({ width, mode: 'custom' }), project.width)}{layoutNumber('高度', layout.height, (height) => ({ height, mode: 'custom' }), project.height)}<label className="field checkbox-field"><input type="checkbox" checked={layout.keepAspectRatio} onChange={(event) => onUpdateVideoLayout({ keepAspectRatio: event.target.checked })} />保持宽高比</label><label className="field">透明度 {Math.round(layout.opacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={layout.opacity} onChange={(event) => onUpdateVideoLayout({ opacity: Number(event.target.value), mode: 'custom' })} /></label><label className="field">原声音量 {Math.round(clip.volume * 100)}%<input type="range" min="0" max="1" step="0.05" disabled={clip.muted} value={clip.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} /></label><label className="field checkbox-field"><input type="checkbox" checked={clip.muted ?? false} onChange={(event) => onUpdate({ muted: event.target.checked })} />静音原声</label><button className="danger" onClick={onDelete}>删除视频片段</button></div>;
}
