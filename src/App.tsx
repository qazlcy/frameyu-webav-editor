import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, canSetClipPlaybackRate, canSplitTimelineClip, defaultVideoLayout, deleteEmptyTrack, getAsset, getProjectDuration, getTrack, moveClipToCompatibleTrack, moveProjectClip, PLAYBACK_RATE_PRESETS, removeClip, renameTrack, reorderTrack, resizedVideoLayout, resizeTrack, setClipPlaybackRate, setVideoLayoutMode, splitTimelineClip, trimProjectClip, updateClip, updateSourceCrop, updateVideoLayout } from './editor/commands';
import { emptyProject, type Asset, type AudioKind, type CaptionDraft, type EditorState, type Project, type SourceCrop, type TimelineClip, type Track, type TrackType, type VideoLayout, type VideoResizeHandle } from './editor/types';
import { DEFAULT_WORKSPACE_LAYOUT, MIN_PREVIEW_WIDTH, WORKSPACE_DIVIDER_SIZE, normaliseWorkspaceLayout, type WorkspaceLayout } from './editor/layoutMath';
import { TRACK_HEADER_WIDTH_PX, clamp, getClipSourceDurationMs, timelineContentWidth, timeToTimelineX, viewportXToTime } from './editor/timelineMath';
import { WebAVAdapter, type CapabilityReport } from './webav/WebAVAdapter';
import { scheduleMediaPreviewAnalysis, TimelineMediaPreviewCache } from './timeline/mediaPreviewCache';
import type { WaveformAnalysisStatus } from './timeline/waveformAnalysis';
import { WaveformCanvas, WAVEFORM_CANVAS_SELF_TEST_DATA } from './timeline/WaveformCanvas';
import { DEFAULT_WAVEFORM_DISPLAY_SETTINGS, normaliseWaveformDisplaySettings, type WaveformDisplaySettings } from './timeline/waveformDisplay';
import { hashVideoFile, VideoContentDeduplicator, MediaContentDeduplicator } from './editor/videoDedup';
import { ExportDialog } from './export/ExportDialog';
import { ExportController, getSavePicker, type ExportSettings } from './export/saveVideo';
import { VideoThumbnailStrip } from './timeline/VideoThumbnailStrip';
import { FULL_SOURCE_CROP, getSourceCrop, moveSourceCrop, resizeSourceCrop } from './editor/sourceCrop';

const initialEditor: EditorState = { playheadMs: 0, zoom: 100, playback: 'idle', status: 'ready', message: '等待导入视频素材' };
const formatTime = (timeMs: number) => `${String(Math.floor(timeMs / 60000)).padStart(2, '0')}:${String(Math.floor(timeMs / 1000) % 60).padStart(2, '0')}.${String(Math.floor(timeMs % 1000 / 10)).padStart(2, '0')}`;
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const LAYOUT_STORAGE_KEY = 'frameyu-workspace-layout-v1';
const WAVEFORM_DISPLAY_STORAGE_KEY = 'frameyu-waveform-display-v1';
type LayoutState = WorkspaceLayout;
type MaterialFilter = 'all' | 'video' | 'music' | 'sfx' | 'caption';
type LayoutDrag = { kind: 'asset' | 'property' | 'timeline'; pointerId: number; startClient: number; startValue: number };
type ClipContextMenu = { clipId: string; x: number; y: number };
type DuplicateVideoImport = { assetId: string; existingName: string; importedName: string };
type CropAspectPreset = 'free' | '16:9' | '9:16' | '1:1' | '4:3';
type CropSession = { clipId: string; initial: SourceCrop; draft: SourceCrop; aspectPreset: CropAspectPreset };

type DragState =
  | { kind: 'clip'; pointerId: number; clip: TimelineClip; mode: 'move' | 'left' | 'right'; pointerStartMs: number }
  | { kind: 'playhead'; pointerId: number }
  | { kind: 'track'; pointerId: number; trackId: string }
  | { kind: 'track-height'; pointerId: number; trackId: string; startHeight: number; startClientY: number }
  | { kind: 'canvas-video'; pointerId: number; clipId: string; mode: 'move' | VideoResizeHandle; pointerStartX: number; pointerStartY: number; layout: VideoLayout }
  | { kind: 'canvas-crop'; pointerId: number; clipId: string; mode: 'move' | VideoResizeHandle; pointerStartX: number; pointerStartY: number; crop: SourceCrop; layout: VideoLayout };

const VIDEO_RESIZE_HANDLES: ReadonlyArray<{ handle: VideoResizeHandle; label: string }> = [
  { handle: 'nw', label: '左上角缩放' }, { handle: 'n', label: '顶部缩放' }, { handle: 'ne', label: '右上角缩放' }, { handle: 'e', label: '右侧缩放' },
  { handle: 'se', label: '右下角缩放' }, { handle: 's', label: '底部缩放' }, { handle: 'sw', label: '左下角缩放' }, { handle: 'w', label: '左侧缩放' },
];

function readLayout(): LayoutState {
  try {
    const stored = JSON.parse(sessionStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null') as Partial<LayoutState> | null;
    if (stored && [stored.assetWidth, stored.propertyWidth, stored.timelineHeight].every(Number.isFinite)) return { assetWidth: stored.assetWidth!, propertyWidth: stored.propertyWidth!, timelineHeight: stored.timelineHeight! };
  } catch { /* Session layout is optional. */ }
  return DEFAULT_WORKSPACE_LAYOUT;
}

function readWaveformDisplaySettings(): WaveformDisplaySettings {
  try { return normaliseWaveformDisplaySettings(JSON.parse(sessionStorage.getItem(WAVEFORM_DISPLAY_STORAGE_KEY) ?? 'null')); } catch { return DEFAULT_WAVEFORM_DISPLAY_SETTINGS; }
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
  const videoDedupRef = useRef(new VideoContentDeduplicator(hashVideoFile));
  const audioDedupRef = useRef(new MediaContentDeduplicator(hashVideoFile, 'audio'));
  const timelinePreviewCacheRef = useRef(new TimelineMediaPreviewCache());
  const cacheDisposeTimerRef = useRef<number>();
  const adapterRef = useRef<WebAVAdapter>();
  const exportControllerRef = useRef(new ExportController());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const durationRef = useRef(0);
  const projectRef = useRef<Project>(emptyProject());
  const layoutDragRef = useRef<LayoutDrag>();
  const dragRef = useRef<DragState>();
  const cropSessionRef = useRef<CropSession>();
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
  const [waveformSelfTestVisible, setWaveformSelfTestVisible] = useState(false);
  const [waveformDisplaySettings, setWaveformDisplaySettings] = useState<WaveformDisplaySettings>(readWaveformDisplaySettings);
  const [runtimeAssetVersion, setRuntimeAssetVersion] = useState(0);
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenu>();
  const [duplicateVideoImport, setDuplicateVideoImport] = useState<DuplicateVideoImport>();
  const [cropSession, setCropSession] = useState<CropSession>();
  // URL-only Stage A validation switch; this is not persisted editor state.
  const sourceCropPrototypeEnabled = useMemo(() => new URLSearchParams(window.location.search).get('sourceCropPrototype') === '1', []);

  projectRef.current = project;
  const projectDuration = getProjectDuration(project);
  durationRef.current = projectDuration;
  const selected = project.clips.find((clip) => clip.id === editor.selectedClipId);
  const selectedAsset = selected?.assetId ? getAsset(project, selected.assetId) : undefined;
  const selectedVideoLayout = selected?.type === 'video' ? selected.videoLayout ?? defaultVideoLayout(project, selectedAsset) : undefined;
  const cropEditorLayout = cropSession?.clipId === selected?.id ? selectedVideoLayout : undefined;
  const timelineDuration = Math.max(projectDuration, 10000);
  const tracks = useMemo(() => sortedTracks(project.tracks), [project.tracks]);
  const assetsById = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const visibleMaterials = useMemo(() => {
    const assets = project.assets.filter((asset) => materialFilter === 'all' || materialFilter === 'video' && asset.type === 'video' || materialFilter === 'music' && asset.type === 'audio' && (asset.audioKind ?? 'music') === 'music' || materialFilter === 'sfx' && asset.type === 'audio' && asset.audioKind === 'sfx');
    const captions = project.clips.filter((clip) => clip.type === 'caption' && (materialFilter === 'all' || materialFilter === 'caption'));
    return { assets, captions };
  }, [materialFilter, project.assets, project.clips]);
  const waveformDiagnostics = timelinePreviewCacheRef.current.getWaveformDiagnostics();
  const contentWidth = timelineContentWidth(timelineDuration, editor.zoom);
  const mediaSignature = useMemo(() => JSON.stringify({
    width: project.width,
    height: project.height,
    videoTracks: project.tracks.filter((track) => track.type === 'video').map(({ id, order }) => ({ id, order })),
    clips: project.clips.map(({ id, trackId, type, assetId, name, startMs, sourceStartMs, sourceDurationMs, durationMs, playbackRate, volume, muted, videoLayout, sourceCrop, text, captionStyle }) => ({ id, trackId, type, assetId, name, startMs, sourceStartMs, sourceDurationMs, durationMs, playbackRate, volume, muted, videoLayout, sourceCrop, text, captionStyle })),
  }), [project.width, project.height, project.tracks, project.clips]);
  const mediaProject = useMemo(() => project, [mediaSignature]);

  useEffect(() => {
    if (cacheDisposeTimerRef.current !== undefined) {
      window.clearTimeout(cacheDisposeTimerRef.current);
      cacheDisposeTimerRef.current = undefined;
    }
    const adapter = new WebAVAdapter({ sourceCropPrototype: sourceCropPrototypeEnabled });
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
      // React 18 StrictMode intentionally runs effect cleanup/setup once in development.
      // Defer disposal so the immediate setup cancels it; a real unmount still releases media.
      cacheDisposeTimerRef.current = window.setTimeout(() => {
        timelinePreviewCacheRef.current.dispose();
        cacheDisposeTimerRef.current = undefined;
      }, 0);
    };
  }, [sourceCropPrototypeEnabled]);

  useEffect(() => timelinePreviewCacheRef.current.subscribe((asset) => {
    const updateRequestedAt = performance.now();
    setTimelinePreviewVersion((version) => version + 1);
    requestAnimationFrame(() => timelinePreviewCacheRef.current.recordUiRendered(asset, updateRequestedAt));
  }), []);

  useEffect(() => {
    let cancelled = false;
    const tasks = scheduleMediaPreviewAnalysis(timelinePreviewCacheRef.current, project.assets, (assetId) => assetFilesRef.current.get(assetId));
    for (const task of tasks) void task.then(() => {
      if (!cancelled) setTimelinePreviewVersion((version) => version + 1);
    }).catch((error: unknown) => {
      console.warn('[WebAV] timeline media preview unavailable', error);
      if (!cancelled) setTimelinePreviewVersion((version) => version + 1);
    });
    return () => { cancelled = true; };
  }, [project.assets, runtimeAssetVersion]);

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
    try { sessionStorage.setItem(WAVEFORM_DISPLAY_STORAGE_KEY, JSON.stringify(waveformDisplaySettings)); } catch { /* Session storage is optional. */ }
  }, [waveformDisplaySettings]);

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
    const fileSelectedAt = performance.now();
    let reservation: { abort: () => void; commit: (assetId: string) => void } | undefined;
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在后台计算视频内容指纹…' }));
    try {
      const claim = await videoDedupRef.current.claim(file, projectRef.current.assets);
      console.info('[VideoDedup]', { fileName: file.name, fileSize: file.size, candidateCount: claim.candidateCount, hashDurationMs: claim.hashDurationMs, outcome: claim.kind });
      if (claim.kind === 'duplicate') {
        const existing = projectRef.current.assets.find((asset) => asset.id === claim.assetId);
        if (!existing) throw new Error('重复素材的既有引用已不可用，请重新导入。');
        setDuplicateVideoImport({ assetId: existing.id, existingName: existing.name, importedName: file.name });
        setEditor((previous) => ({ ...previous, status: 'ready', message: `“${file.name}”与已有素材内容相同，未重复导入。` }));
        return;
      }
      reservation = claim;
      setEditor((previous) => ({ ...previous, status: 'loading', message: '视频指纹完成，正在解析媒体…' }));
      const info = await adapterRef.current!.inspectFile(file, 'video');
      const asset: Asset = { id: makeId('video'), name: file.name, type: 'video', mimeType: file.type, fileSize: claim.fingerprint.fileSize, contentHash: claim.fingerprint.contentHash, ...info };
      adapterRef.current!.registerAsset(asset, file);
      assetFilesRef.current.set(asset.id, file);
      setRuntimeAssetVersion((version) => version + 1);
      timelinePreviewCacheRef.current.noteWaveformAssetImported(asset, fileSelectedAt);
      const firstVideo = !projectRef.current.assets.some((item) => item.type === 'video');
      const withAsset = addAsset(projectRef.current, asset);
      projectRef.current = firstVideo ? appendVideoClip(withAsset, asset) : withAsset;
      setProject(projectRef.current);
      reservation.commit(asset.id);
      reservation = undefined;
      setEditor((previous) => ({ ...previous, playheadMs: 0, status: 'ready', message: `已导入 ${file.name}` }));
    } catch (error) {
      reservation?.abort();
      console.error('[WebAV] video import failed', error);
      setEditor((previous) => ({ ...previous, status: 'error', message: `视频导入失败：${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  function locateDuplicateVideo(assetId: string) {
    const asset = projectRef.current.assets.find((item) => item.id === assetId);
    setMaterialFilter(asset?.type === 'audio' ? asset.audioKind ?? 'music' : 'video');
    setDuplicateVideoImport(undefined);
    requestAnimationFrame(() => {
      const card = document.getElementById(`asset-card-${assetId}`);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      (card as HTMLElement | null)?.focus();
    });
  }

  async function importAudio(file: File, audioKind: AudioKind) {
    const fileSelectedAt = performance.now();
    let reservation: { abort: () => void; commit: (assetId: string) => void } | undefined;
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在后台计算音频内容指纹…' }));
    try {
      const claim = await audioDedupRef.current.claim(file, projectRef.current.assets);
      if (claim.kind === 'duplicate') {
        const existing = projectRef.current.assets.find((asset) => asset.id === claim.assetId);
        if (!existing) throw new Error('重复素材的既有引用已不可用，请重新导入。');
        setDuplicateVideoImport({ assetId: existing.id, existingName: existing.name, importedName: file.name });
        setEditor((previous) => ({ ...previous, status: 'ready', message: `“${file.name}”与已有素材内容相同，保留原素材分类。` }));
        return;
      }
      reservation = claim;
      const info = await adapterRef.current!.inspectFile(file, 'audio');
      const asset: Asset = { id: makeId('audio'), name: file.name, type: 'audio', audioKind, mimeType: file.type, ...info, ...claim.fingerprint };
      const previewUrl = URL.createObjectURL(file);
      adapterRef.current!.registerAsset(asset, file);
      assetFilesRef.current.set(asset.id, file);
      audioPreviewUrlsRef.current.set(asset.id, previewUrl);
      timelinePreviewCacheRef.current.noteAudioImported(asset, fileSelectedAt);
      projectRef.current = addAsset(projectRef.current, asset);
      setProject(projectRef.current);
      setRuntimeAssetVersion((version) => version + 1);
      reservation.commit(asset.id);
      reservation = undefined;
      setEditor((previous) => ({ ...previous, status: 'ready', message: `已导入${audioKind === 'music' ? '音乐' : '音效'} ${file.name}` }));
    } catch (error) {
      reservation?.abort();
      console.error('[WebAV] audio import failed', error);
      setEditor((previous) => ({ ...previous, status: 'error', message: `音频导入失败：${error instanceof Error ? error.message : String(error)}` }));
    }
  }
  function retryWaveform(asset: Asset) {
    const file = assetFilesRef.current.get(asset.id);
    if (!file) {
      setEditor((previous) => ({ ...previous, status: 'error', message: `找不到“${asset.name}”的本地文件，无法重新分析。` }));
      return;
    }
    const task = asset.type === 'audio'
      ? timelinePreviewCacheRef.current.retryWaveform(asset, file)
      : timelinePreviewCacheRef.current.retryVideoWaveform(asset, file);
    void task.catch((error: unknown) => {
      console.warn('[WebAV] waveform retry failed', asset.name, error);
    });
  }

  async function copyWaveformDiagnostics() {
    const text = JSON.stringify(timelinePreviewCacheRef.current.getWaveformDiagnostics(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setEditor((previous) => ({ ...previous, status: 'ready', message: '波形诊断日志已复制。' }));
    } catch {
      setEditor((previous) => ({ ...previous, status: 'error', message: '浏览器拒绝复制诊断日志；请从开发者工具的 [WaveformAnalysis] 日志复制。' }));
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

  async function exportVideo(settings: ExportSettings) {
    if (!projectDuration || exportBusy) return;
    const snapshot = projectRef.current;
    setExportBusy(true);
    setEditor((previous) => ({ ...previous, status: 'exporting', message: settings.method === 'picker' ? '请选择保存位置…' : '正在用 WebAV 合成 MP4…' }));
    try {
      const result = await exportControllerRef.current.start(settings, () => adapterRef.current!.export(snapshot, (progress) => setEditor((previous) => ({ ...previous, message: `正在导出 ${(progress * 100).toFixed(0)}%` }))), getSavePicker());
      if (result === 'busy') return;
      setEditor((previous) => ({ ...previous, status: 'ready', message: result === 'cancelled' ? '已取消保存，未开始编码。' : settings.method === 'picker' ? '视频已保存。' : '视频已交给浏览器下载。' }));
      if (result === 'saved') setExportOpen(false);
    } catch (error) {
      console.error('[WebAV] export failed', error);
      setEditor((previous) => ({ ...previous, status: 'error', message: `导出失败：${error instanceof Error ? error.message : String(error)}` }));
    } finally { setExportBusy(false); }
  }
  function targetTrack(type: TrackType) {
    const currentProject = projectRef.current;
    const selectedTrack = getTrack(currentProject, selectedTrackId);
    return selectedTrack?.type === type ? selectedTrack : sortedTracks(currentProject.tracks).find((track) => track.type === type);
  }

  function addAudio(asset: Asset, type: 'music' | 'sfx') {
    const track = targetTrack(type);
    const clickedAt = performance.now();
    console.info('[TimelineAdd]', { phase: 'click', assetId: asset.id, assetName: asset.name, type, trackId: track?.id });
    if (!track) {
      setEditor((previous) => ({ ...previous, status: 'error', message: `没有可用的${type === 'music' ? '背景音乐' : '音效'}轨道，请先新建轨道。` }));
      return;
    }
    setProject((previous) => addAudioClip(previous, asset, track.id));
    setEditor((previous) => ({ ...previous, status: 'ready', message: `${asset.name} 已加入${track.name}` }));
    console.info('[TimelineAdd]', { phase: 'project-update-requested', assetId: asset.id, trackId: track.id, elapsedMs: performance.now() - clickedAt });
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

  function openLocalAudioLibrary(filter: Extract<MaterialFilter, 'music' | 'sfx'>) {
    setMaterialFilter(filter);
    setEditor((previous) => ({ ...previous, status: 'ready', message: `请选择本地${filter === 'music' ? '音乐' : '音效'}文件导入` }));
    requestAnimationFrame(() => materialListRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
    (filter === 'music' ? musicInputRef : sfxInputRef).current?.click();
  }

  function showGenerationUnavailable(kind: 'music' | 'sfx') {
    setEditor((previous) => ({ ...previous, status: 'ready', message: `${kind === 'music' ? '音乐' : '音效'}生成功能待接入；可使用对应素材库导入本地文件。` }));
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

  function trimSelected(valueMs: number, edge: 'left' | 'right') {
    if (!selected) return;
    setProject((previous) => trimProjectClip(previous, selected.id, valueMs, edge));
  }

  function setSelectedPlaybackRate(playbackRate: number) {
    if (!selected) return;
    if (!canSetClipPlaybackRate(projectRef.current, selected.id, playbackRate)) {
      setEditor((previous) => ({ ...previous, status: 'error', message: '该速度会使同一视频轨片段重叠，或不在支持的速度范围内。' }));
      return;
    }
    adapterRef.current?.pause();
    setProject((previous) => setClipPlaybackRate(previous, selected.id, playbackRate));
    setEditor((previous) => ({ ...previous, playback: 'paused', status: 'ready', message: `已将片段速度设为 ${playbackRate}×。` }));
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

  function setSelectedVideoLayoutMode(mode: 'full' | 'fit' | 'fill' | 'pip') {
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

  function cropPoint(event: Pick<React.PointerEvent, 'clientX' | 'clientY'>, layout: VideoLayout) {
    const point = previewPoint(event);
    return { x: clamp((point.x - layout.x) / layout.width, 0, 1), y: clamp((point.y - layout.y) / layout.height, 0, 1) };
  }

  function cropLockRatio(session: CropSession) {
    const desired = session.aspectPreset === 'free' ? undefined : ({ '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 } as const)[session.aspectPreset];
    if (!desired) return undefined;
    const clip = projectRef.current.clips.find((item) => item.id === session.clipId);
    const asset = clip?.assetId ? getAsset(projectRef.current, clip.assetId) : undefined;
    const sourceAspect = asset?.width && asset.height ? asset.width / asset.height : 16 / 9;
    return desired / sourceAspect;
  }

  function setCropDraft(draft: SourceCrop) {
    const session = cropSessionRef.current;
    if (!session) return;
    const next = { ...session, draft };
    cropSessionRef.current = next;
    setCropSession(next);
  }

  function startCropMode() {
    if (!selected || selected.type !== 'video') return;
    const current = getSourceCrop(selected);
    const next: CropSession = { clipId: selected.id, initial: current, draft: current, aspectPreset: 'free' };
    cropSessionRef.current = next;
    setCropSession(next);
    adapterRef.current?.pause();
    // Editing always starts from the complete original source, so reopening a
    // crop edits its persisted rectangle rather than destructively recropping it.
    void adapterRef.current?.setPreviewSourceCropOverride(selected.id, { ...FULL_SOURCE_CROP }, editor.playheadMs).catch((error: unknown) => console.error('[SourceCrop] failed to open editor', error));
  }

  function cancelCropMode() {
    const session = cropSessionRef.current;
    if (session) void adapterRef.current?.setPreviewSourceCropOverride(session.clipId, undefined, editor.playheadMs).catch((error: unknown) => console.error('[SourceCrop] failed to restore crop', error));
    cropSessionRef.current = undefined;
    setCropSession(undefined);
  }

  function confirmCropMode() {
    const session = cropSessionRef.current;
    if (!session) return;
    void adapterRef.current?.setPreviewSourceCropOverride(session.clipId, undefined, editor.playheadMs).catch((error: unknown) => console.error('[SourceCrop] failed to apply crop', error));
    setProject((previous) => updateSourceCrop(previous, session.clipId, session.draft));
    cropSessionRef.current = undefined;
    setCropSession(undefined);
  }

  function resetCropDraft() {
    setCropDraft({ ...FULL_SOURCE_CROP });
  }

  function setCropPreset(aspectPreset: CropAspectPreset) {
    const session = cropSessionRef.current;
    if (!session) return;
    const next = { ...session, aspectPreset };
    cropSessionRef.current = next;
    setCropSession(next);
  }

  function startCanvasCropDrag(event: React.PointerEvent, mode: 'move' | VideoResizeHandle) {
    const session = cropSessionRef.current;
    if (!session || !selectedVideoLayout || session.clipId !== selected?.id) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = cropPoint(event, selectedVideoLayout);
    const nextDrag: DragState = { kind: 'canvas-crop', pointerId: event.pointerId, clipId: session.clipId, mode, pointerStartX: point.x, pointerStartY: point.y, crop: session.draft, layout: selectedVideoLayout };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  }

  function startCanvasVideoDrag(event: React.PointerEvent, mode: 'move' | VideoResizeHandle) {
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
      setProject((previous) => {
        if (activeDrag.mode === 'move') return updateVideoLayout(previous, activeDrag.clipId, { x: activeDrag.layout.x + deltaX, y: activeDrag.layout.y + deltaY, mode: 'custom' });
        const clip = previous.clips.find((item) => item.id === activeDrag.clipId);
        const asset = clip?.assetId ? getAsset(previous, clip.assetId) : undefined;
        return updateVideoLayout(previous, activeDrag.clipId, resizedVideoLayout(previous, asset, activeDrag.layout, activeDrag.mode, deltaX, deltaY));
      });
      return;
    }
    if (activeDrag.kind === 'canvas-crop') {
      const point = cropPoint(event, activeDrag.layout);
      const deltaX = point.x - activeDrag.pointerStartX;
      const deltaY = point.y - activeDrag.pointerStartY;
      const session = cropSessionRef.current;
      if (!session || session.clipId !== activeDrag.clipId) return;
      setCropDraft(activeDrag.mode === 'move'
        ? moveSourceCrop(activeDrag.crop, deltaX, deltaY)
        : resizeSourceCrop(activeDrag.crop, activeDrag.mode, deltaX, deltaY, cropLockRatio(session)));
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
      <button className="primary" disabled={!projectDuration || exportBusy || !!cropSession} onClick={() => setExportOpen(true)}>导出视频</button>
    </header>
    {!capability?.supported && <div className="capability-warning"><b>兼容性提示：</b>{capability ? capability.reasons.join(' ') : '正在检测 WebCodecs 与 WebAV…'}</div>}
    <div className="editor-body" ref={editorBodyRef}>
      <section className="workspace" style={workspaceStyle}>
        <aside className="asset-panel panel">
          <div className="material-actions">
            <div className="material-heading"><h2>素材库</h2><span>本地会话</span></div>
            <button className="material-entry material-primary-entry video-entry" onClick={() => videoInputRef.current?.click()}><i>▣</i><span>导入视频</span><small>本地 MP4</small></button>
            <div className="material-quick-grid">
              <button className="material-quick-entry music-entry" onClick={() => openLocalAudioLibrary('music')}>音乐素材库</button>
              <button className="material-quick-entry music-entry" onClick={() => showGenerationUnavailable('music')}>生成音乐</button>
              <button className="material-quick-entry sfx-entry" onClick={() => openLocalAudioLibrary('sfx')}>音效素材库</button>
              <button className="material-quick-entry sfx-entry" onClick={() => showGenerationUnavailable('sfx')}>生成音效</button>
            </div>
            <button className="material-entry material-caption-entry caption-entry" onClick={() => setCaptionComposerOpen((open) => !open)}><i>T</i><span>添加字幕</span><small>手动创建</small></button>
            <input ref={videoInputRef} aria-label="导入视频" className="visually-hidden" type="file" accept="video/mp4" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importVideo(file); }} />
            <input ref={musicInputRef} aria-label="导入音乐" className="visually-hidden" type="file" accept="audio/mpeg,audio/wav" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importAudio(file, 'music'); }} />
            <input ref={sfxInputRef} aria-label="导入音效" className="visually-hidden" type="file" accept="audio/mpeg,audio/wav" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importAudio(file, 'sfx'); }} />
            {captionComposerOpen && <div className="caption-composer"><label>字幕文字<textarea aria-label="新字幕文字" value={captionDraft.text} onChange={(event) => setCaptionDraft((previous) => ({ ...previous, text: event.target.value }))} placeholder="输入字幕文本" /></label><div><label>开始 <input aria-label="字幕开始时间" type="number" min="0" max={projectDuration} value={captionDraft.startMs} onChange={(event) => setCaptionDraft((previous) => ({ ...previous, startMs: Number(event.target.value) }))} /></label><label>结束 <input aria-label="字幕结束时间" type="number" min="0" max={projectDuration} value={captionDraft.endMs} onChange={(event) => setCaptionDraft((previous) => ({ ...previous, endMs: Number(event.target.value) }))} /></label></div><button className="caption-add" disabled={!projectDuration} onClick={addCaptionToSelectedTrack}>创建字幕</button></div>}
            <div className="material-filters" role="tablist" aria-label="素材筛选">{([['all', '全部'], ['video', '视频'], ['music', '音乐'], ['sfx', '音效'], ['caption', '字幕']] as const).map(([filter, label]) => <button key={filter} role="tab" aria-selected={materialFilter === filter} className={materialFilter === filter ? 'active' : ''} onClick={() => setMaterialFilter(filter)}>{label}</button>)}</div>
          </div>
          <div className="material-list" ref={materialListRef} aria-label="素材列表">
            {visibleMaterials.assets.map((asset) => <MaterialAssetCard key={asset.id} asset={asset} previewUrl={audioPreviewUrlsRef.current.get(asset.id)} projectDuration={projectDuration} analysisStatus={timelinePreviewCacheRef.current.getWaveformStatus(asset.id, asset.type)} onRetryWaveform={() => retryWaveform(asset)} onAddVideo={() => addVideo(asset)} onAddAudio={(kind) => addAudio(asset, kind)} />)}
            {visibleMaterials.captions.map((clip) => <button className="asset-card caption-material-card" key={clip.id} onClick={() => { setSelectedTrackId(clip.trackId); setEditor((previous) => ({ ...previous, selectedClipId: clip.id })); }}><span className="asset-icon">T</span><span className="asset-card-body"><b title={clip.text}>{clip.text || '空字幕'}</b><small>字幕 · {formatTime(clip.durationMs)} · 编辑</small></span></button>)}
            <details className="waveform-diagnostics"><summary>波形诊断日志（{waveformDiagnostics.length}）</summary><button onClick={() => void copyWaveformDiagnostics()}>复制诊断日志</button><button onClick={() => setWaveformSelfTestVisible((visible) => !visible)}>{waveformSelfTestVisible ? '隐藏 Canvas 自检' : '显示 Canvas 自检'}</button>{waveformSelfTestVisible && <div className="waveform-canvas-self-test"><WaveformCanvas data={WAVEFORM_CANVAS_SELF_TEST_DATA} sourceStartMs={0} sourceDurationMs={WAVEFORM_CANVAS_SELF_TEST_DATA.durationMs} color="#72e4cf" displaySettings={waveformDisplaySettings} /></div>}<pre>{waveformDiagnostics.slice(-24).map((entry) => `${entry.assetName} · ${entry.phase} · ${entry.message}${entry.details ? ` · ${JSON.stringify(entry.details)}` : ''}`).join('\n') || '尚未创建分析任务。'}</pre></details>
            {!visibleMaterials.assets.length && !visibleMaterials.captions.length && <p className="material-empty">暂无该类型素材。使用上方入口导入本地文件或手动创建字幕。</p>}
          </div>
        </aside>
        <Divider kind="asset" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, assetWidth: DEFAULT_WORKSPACE_LAYOUT.assetWidth }))} />
        <section className="preview-panel panel">
          <div className="preview-frame">{sourceCropPrototypeEnabled && <div className="source-crop-prototype-notice">裁切原型：所有视频仅保留源画面中央 50%</div>}<div ref={previewRef} className="webav-preview" />{cropSession && cropEditorLayout ? <SourceCropEditor layout={cropEditorLayout} crop={cropSession.draft} aspectPreset={cropSession.aspectPreset} onPointerDown={startCanvasCropDrag} onChangePreset={setCropPreset} onConfirm={confirmCropMode} onCancel={cancelCropMode} onReset={resetCropDraft} /> : selected?.type === 'video' && selectedVideoLayout && <div className="video-layout-overlay" aria-label="移动或缩放选中视频图层" style={{ left: `${selectedVideoLayout.x / project.width * 100}%`, top: `${selectedVideoLayout.y / project.height * 100}%`, width: `${selectedVideoLayout.width / project.width * 100}%`, height: `${selectedVideoLayout.height / project.height * 100}%` }} onPointerDown={(event) => startCanvasVideoDrag(event, 'move')}><span>{selected.name}</span>{VIDEO_RESIZE_HANDLES.map(({ handle, label }) => <button type="button" key={handle} aria-label={label} className={`video-resize-handle ${handle}`} onPointerDown={(event) => startCanvasVideoDrag(event, handle)} />)}</div>}</div>
          <div className="player-controls"><button aria-label="播放或暂停" disabled={!projectDuration} onClick={togglePlayback}>{editor.playback === 'playing' ? '❚❚ 暂停' : '▶ 播放'}</button><span data-testid="project-duration" data-duration-ms={projectDuration}>{formatTime(editor.playheadMs)} / {formatTime(projectDuration)}</span><input aria-label="播放位置" disabled={!projectDuration} type="range" min="0" max={projectDuration || 1} value={editor.playheadMs} onChange={(event) => void syncAndSeek(Number(event.target.value))} /></div>
        </section>
        <Divider kind="property" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, propertyWidth: DEFAULT_WORKSPACE_LAYOUT.propertyWidth }))} />
        <aside className="property-panel panel"><h2>属性</h2>{selected ? <Properties clip={selected} asset={selectedAsset} project={project} projectDuration={projectDuration} onUpdate={updateSelected} onTrim={trimSelected} onSetPlaybackRate={setSelectedPlaybackRate} onUpdateVideoLayout={updateSelectedVideoLayout} onSetVideoLayoutMode={setSelectedVideoLayoutMode} onStartCrop={startCropMode} cropEditing={cropSession?.clipId === selected.id} onDelete={() => { setProject((previous) => removeClip(previous, selected.id)); setEditor((previous) => ({ ...previous, selectedClipId: undefined })); }} /> : <p className="empty">选择时间轴片段以编辑属性</p>}</aside>
      </section>
      <Divider kind="timeline" onPointerDown={startLayoutDrag} onDoubleClick={() => setLayout((previous) => ({ ...previous, timelineHeight: DEFAULT_WORKSPACE_LAYOUT.timelineHeight }))} />
      <section className="timeline-panel panel" style={{ height: `${layout.timelineHeight}px` }}>
        <div className="timeline-toolbar"><b>时间轴</b><select aria-label="波形线条样式" value={waveformDisplaySettings.style} onChange={(event) => setWaveformDisplaySettings((previous) => ({ ...previous, style: event.target.value as WaveformDisplaySettings['style'] }))}><option value="outline">轮廓细线</option><option value="bars">间隔细线</option></select><div className="timeline-actions"><button aria-label="分割选中片段" disabled={!selected || !canSplitTimelineClip(project, selected.id, editor.playheadMs)} onClick={() => splitClipAtPlayhead()}>分割</button><button onClick={() => createTrack('caption')}>+ 字幕轨</button><button onClick={() => createTrack('video')}>+ 视频轨</button><button onClick={() => createTrack('music')}>+ 音乐轨</button><button onClick={() => createTrack('sfx')}>+ 音效轨</button><label>波形 <select aria-label="波形显示模式" value={waveformDisplaySettings.mode} onChange={(event) => setWaveformDisplaySettings((previous) => ({ ...previous, mode: event.target.value as WaveformDisplaySettings['mode'] }))}><option value="linear">线性</option><option value="enhanced">增强</option></select></label><label>增益 <input aria-label="波形显示增益" type="range" min="1" max="5" step="0.05" value={waveformDisplaySettings.gain} onChange={(event) => setWaveformDisplaySettings((previous) => ({ ...previous, gain: Number(event.target.value) }))} /></label><label>对比 <input aria-label="波形显示对比度" type="range" min="0.7" max="1.6" step="0.02" value={waveformDisplaySettings.contrast} onChange={(event) => setWaveformDisplaySettings((previous) => ({ ...previous, contrast: Number(event.target.value) }))} /></label><button aria-label="恢复默认波形显示" onClick={() => setWaveformDisplaySettings(DEFAULT_WAVEFORM_DISPLAY_SETTINGS)}>重置波形</button><label>缩放 <input aria-label="时间轴缩放" type="range" min="45" max="240" value={editor.zoom} onChange={(event) => setEditor((previous) => ({ ...previous, zoom: Number(event.target.value) }))} /></label></div></div>
        <div className="timeline-viewport">
          <div className="timeline-ruler-row"><div className="timeline-ruler-label">轨道</div><div className="timeline-ruler-scroll" ref={rulerScrollRef} onScroll={syncRulerScroll}><div className="ruler" style={{ width: `${contentWidth - TRACK_HEADER_WIDTH_PX}px` }}>{ticks.map((time) => <span key={time} style={{ left: `${timeToTimelineX(time, editor.zoom) - TRACK_HEADER_WIDTH_PX}px` }}>{formatTime(time).slice(0, 5)}</span>)}</div></div></div>
          <div className="timeline-body-viewport"><div className="timeline-scroll" ref={timelineScrollRef} onScroll={syncBodyScroll}><div className="timeline-content" style={{ width: `${contentWidth}px` }} onClick={clickTimeline}>{tracks.map((track) => <TrackRow key={track.id} track={track} clips={project.clips.filter((clip) => clip.trackId === track.id)} assetsById={assetsById} assetFiles={assetFilesRef.current} previewCache={timelinePreviewCacheRef.current} previewVersion={timelinePreviewVersion} waveformDisplaySettings={waveformDisplaySettings} selectedClipId={selected?.id} selectedTrackId={selectedTrackId} videoTrackCount={tracks.filter((item) => item.type === 'video').length} zoom={editor.zoom} onSelectTrack={setSelectedTrackId} onStartTrackDrag={startTrackDrag} onStartTrackResize={startTrackResize} onStartClipDrag={startClipDrag} onRename={(name) => setProject((previous) => renameTrack(previous, track.id, name))} onDelete={() => deleteTrack(track)} onSelectClip={(clip) => { setSelectedTrackId(track.id); setEditor((previous) => ({ ...previous, selectedClipId: clip.id })); }} onOpenContextMenu={openClipContextMenu} />)}</div></div><div className="playhead" style={{ left: `${timeToTimelineX(editor.playheadMs, editor.zoom) - timelineScrollLeft}px` }} onPointerDown={startPlayheadDrag} onClick={(event) => event.stopPropagation()} /></div>
        </div>
      </section>
      {clipContextMenu && <div className="clip-context-menu" role="menu" aria-label="片段操作菜单" style={{ left: `${clipContextMenu.x}px`, top: `${clipContextMenu.y}px` }} onPointerDown={(event) => event.stopPropagation()}><button role="menuitem" disabled={!canSplitTimelineClip(project, clipContextMenu.clipId, editor.playheadMs)} onClick={() => splitClipAtPlayhead(clipContextMenu.clipId)}>在播放头处分割</button></div>}
      {exportOpen && <ExportDialog busy={exportBusy} progress={editor.message} onStart={(settings) => void exportVideo(settings)} onClose={() => setExportOpen(false)} />}
      {duplicateVideoImport && <DuplicateVideoDialog duplicate={duplicateVideoImport} onLocate={() => locateDuplicateVideo(duplicateVideoImport.assetId)} onClose={() => setDuplicateVideoImport(undefined)} />}
    </div>
  </main>;
}

function MaterialAssetCard({ asset, previewUrl, projectDuration, analysisStatus, onRetryWaveform, onAddVideo, onAddAudio }: { asset: Asset; previewUrl?: string; projectDuration: number; analysisStatus?: WaveformAnalysisStatus; onRetryWaveform: () => void; onAddVideo: () => void; onAddAudio: (kind: AudioKind) => void }) {
  const audioKind = asset.audioKind ?? 'music';
  const kindLabel = asset.type === 'video' ? '视频' : audioKind === 'music' ? '音乐' : '音效';
  const resolution = asset.type === 'video' && asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : '';
  const analysisLabel = analysisStatus?.phase === 'queued' ? '等待分析' : analysisStatus?.phase === 'decoding' ? '正在解码' : analysisStatus?.phase === 'sampling' ? '正在生成波形' : analysisStatus?.phase === 'ready' ? '波形分析完成' : analysisStatus?.phase === 'no-audio' ? '无音轨' : analysisStatus?.phase === 'failed' ? '波形分析失败' : '尚未调度';
  return <article id={`asset-card-${asset.id}`} tabIndex={-1} className={`asset-card ${asset.type === 'video' ? 'video' : audioKind}`}>
    <span className="asset-icon" aria-hidden="true">{asset.type === 'video' ? '▣' : audioKind === 'music' ? '♫' : '✦'}</span>
    <div className="asset-card-body"><b title={asset.name}>{asset.name}</b><small>{kindLabel} · {formatTime(asset.durationMs)}{resolution}</small>
      <div className={`waveform-analysis-status ${analysisStatus?.phase ?? 'unscheduled'}`} aria-label={`${asset.name}波形${analysisLabel}`}><span>{analysisStatus?.phase === 'decoding' || analysisStatus?.phase === 'sampling' ? '◌ ' : ''}{analysisLabel}</span>{analysisStatus?.phase === 'unscheduled' && <small title={analysisStatus.message}>{analysisStatus.message || '尚未收到分析请求。'}</small>}{analysisStatus?.phase === 'failed' && <><small title={analysisStatus.error}>原因：{analysisStatus.error || '未知错误'}</small><button className="secondary" onClick={onRetryWaveform}>重新分析</button></>}</div>
      {asset.type === 'video' ? <button onClick={onAddVideo}>+ 视频轨</button> : <><div className="asset-card-actions"><button onClick={() => onAddAudio(audioKind)}>+ {audioKind === 'music' ? '音乐' : '音效'}</button><button className="secondary" onClick={() => onAddAudio(audioKind === 'music' ? 'sfx' : 'music')}>作为{audioKind === 'music' ? '音效' : '音乐'}</button></div>{previewUrl ? <audio aria-label={`试听 ${asset.name}`} controls preload="metadata" src={previewUrl} /> : <small className="audio-unavailable">本会话未保留试听源</small>}</>}
    </div>
  </article>;
}

function DuplicateVideoDialog({ duplicate, onLocate, onClose }: { duplicate: DuplicateVideoImport; onLocate: () => void; onClose: () => void }) {
  return <div className="duplicate-video-backdrop" role="presentation" onPointerDown={onClose}>
    <section className="duplicate-video-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-video-title" onPointerDown={(event) => event.stopPropagation()}>
      <h2 id="duplicate-video-title">检测到重复素材</h2>
      <p>当前文件“{duplicate.importedName}”与素材库中的“{duplicate.existingName}”内容相同，无需再次导入。</p>
      <div><button className="primary" onClick={onLocate}>定位已有素材</button><button className="secondary" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}

function Divider({ kind, onPointerDown, onDoubleClick }: { kind: LayoutDrag['kind']; onPointerDown: (event: React.PointerEvent, kind: LayoutDrag['kind']) => void; onDoubleClick: () => void }) {
  const horizontal = kind === 'timeline';
  const label = horizontal ? '调整时间轴高度' : kind === 'asset' ? '调整素材库宽度' : '调整属性面板宽度';
  return <div role="separator" aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} tabIndex={0} className={`layout-divider ${horizontal ? 'horizontal' : 'vertical'}`} onPointerDown={(event) => onPointerDown(event, kind)} onDoubleClick={onDoubleClick} />;
}

function TrackRow({ track, clips, assetsById, assetFiles, previewCache, previewVersion, waveformDisplaySettings, selectedClipId, selectedTrackId, videoTrackCount, zoom, onSelectTrack, onStartTrackDrag, onStartTrackResize, onStartClipDrag, onRename, onDelete, onSelectClip, onOpenContextMenu }: { track: Track; clips: TimelineClip[]; assetsById: ReadonlyMap<string, Asset>; assetFiles: ReadonlyMap<string, File>; previewCache: TimelineMediaPreviewCache; previewVersion: number; waveformDisplaySettings: WaveformDisplaySettings; selectedClipId?: string; selectedTrackId: string; videoTrackCount: number; zoom: number; onSelectTrack: (trackId: string) => void; onStartTrackDrag: (event: React.PointerEvent, track: Track) => void; onStartTrackResize: (event: React.PointerEvent, track: Track) => void; onStartClipDrag: (event: React.PointerEvent, clip: TimelineClip, mode: 'move' | 'left' | 'right') => void; onRename: (name: string) => void; onDelete: () => void; onSelectClip: (clip: TimelineClip) => void; onOpenContextMenu: (event: React.MouseEvent, clip: TimelineClip) => void }) {
  return <div className={`track ${selectedTrackId === track.id ? 'selected-track' : ''}`} id={`track-row-${track.id}`} style={{ height: `${track.heightPx}px` }} onClick={() => onSelectTrack(track.id)}>
    <div className="track-label" onClick={(event) => event.stopPropagation()}>
      <button className="track-grip" aria-label={`拖动${track.name}排序`} title="拖动排序" onPointerDown={(event) => onStartTrackDrag(event, track)}>⠿</button>
      <input aria-label={`${track.name}名称`} value={track.name} onChange={(event) => onRename(event.target.value)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} />
      <button className="track-delete" aria-label={`删除${track.name}`} title={track.clipIds.length ? '含有片段的轨道不能删除' : track.type === 'video' && videoTrackCount <= 1 ? '至少保留一条视频轨' : '删除空轨道'} disabled={track.clipIds.length > 0 || track.type === 'video' && videoTrackCount <= 1} onClick={onDelete}>×</button>
    </div>
    <div className="track-lane" data-preview-version={previewVersion} style={{ backgroundSize: `${zoom}px 100%` }}>{clips.map((clip) => <div role="button" tabIndex={0} className={`timeline-clip ${clip.type} ${selectedClipId === clip.id ? 'selected' : ''}`} key={clip.id} style={{ left: `${clip.startMs / 1000 * zoom}px`, width: `${Math.max(18, clip.durationMs / 1000 * zoom)}px` }} onPointerDown={(event) => onStartClipDrag(event, clip, 'move')} onClick={(event) => { event.stopPropagation(); onSelectClip(clip); }} onContextMenu={(event) => onOpenContextMenu(event, clip)}><i className="trim left" onPointerDown={(event) => onStartClipDrag(event, clip, 'left')} /><TimelineClipPreview file={clip.assetId ? assetFiles.get(clip.assetId) : undefined} clip={clip} asset={clip.assetId ? assetsById.get(clip.assetId) : undefined} cache={previewCache} displaySettings={waveformDisplaySettings} /><span className="timeline-clip-label">{clip.type === 'caption' ? clip.text : clip.name}</span><i className="trim right" onPointerDown={(event) => onStartClipDrag(event, clip, 'right')} /></div>)}</div>
    <div className="track-height-handle" aria-label={`调整${track.name}高度`} onPointerDown={(event) => onStartTrackResize(event, track)} />
  </div>;
}

function TimelineClipPreview({ clip, asset, file, cache, displaySettings }: { file?: File; clip: TimelineClip; asset?: Asset; cache: TimelineMediaPreviewCache; displaySettings: WaveformDisplaySettings }) {
  if (clip.type === 'audio') {
    const waveform = cache.getWaveform(clip.assetId);
    const error = cache.getWaveformError(clip.assetId);
    const status = cache.getWaveformStatus(clip.assetId);
    if (!waveform) {
      const label = error ? '波形不可用' : status?.phase === 'unscheduled' ? '尚未调度波形' : status?.phase === 'queued' ? '等待分析…' : status?.phase === 'decoding' ? '正在解码…' : status?.phase === 'sampling' ? '正在生成波形…' : '尚未调度波形';
      return <div className={`audio-waveform-placeholder ${error ? 'failed' : ''}`} aria-label={error ? '音频波形分析失败' : label}>{label}</div>;
    }
    const sourceDurationMs = getClipSourceDurationMs(clip);
    const color = asset?.audioKind === 'sfx' ? '#f4b75a' : '#72e4cf';
    return <WaveformCanvas className="audio-waveform" data={waveform} summary={cache.getWaveformSummary(clip.assetId)} displaySettings={displaySettings} sourceStartMs={clip.sourceStartMs} sourceDurationMs={sourceDurationMs} color={color} />;
  }
  if (clip.type === 'video' && asset) {
    return <VideoThumbnailStrip clip={clip} asset={asset} file={file} cache={cache} />;
  }
  return null;
}

function SourceCropEditor({ layout, crop, aspectPreset, onPointerDown, onChangePreset, onConfirm, onCancel, onReset }: { layout: VideoLayout; crop: SourceCrop; aspectPreset: CropAspectPreset; onPointerDown: (event: React.PointerEvent, mode: 'move' | VideoResizeHandle) => void; onChangePreset: (preset: CropAspectPreset) => void; onConfirm: () => void; onCancel: () => void; onReset: () => void }) {
  const cropStyle: CSSProperties = { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` };
  const outerStyle: CSSProperties = { left: `${layout.x / 1280 * 100}%`, top: `${layout.y / 720 * 100}%`, width: `${layout.width / 1280 * 100}%`, height: `${layout.height / 720 * 100}%` };
  return <div className="source-crop-editor" aria-label="视频源画面裁切编辑器" style={outerStyle}>
    <div className="source-crop-mask top" style={{ height: `${crop.y * 100}%` }} />
    <div className="source-crop-mask left" style={{ top: `${crop.y * 100}%`, height: `${crop.h * 100}%`, width: `${crop.x * 100}%` }} />
    <div className="source-crop-mask right" style={{ top: `${crop.y * 100}%`, height: `${crop.h * 100}%`, left: `${(crop.x + crop.w) * 100}%` }} />
    <div className="source-crop-mask bottom" style={{ top: `${(crop.y + crop.h) * 100}%` }} />
    <div className="source-crop-box" style={cropStyle} onPointerDown={(event) => onPointerDown(event, 'move')}>
      <span className="source-crop-label">裁切区域</span>
      {VIDEO_RESIZE_HANDLES.map(({ handle, label }) => <button type="button" key={handle} aria-label={`裁切${label}`} className={`source-crop-handle ${handle}`} onPointerDown={(event) => onPointerDown(event, handle)} />)}
    </div>
    <div className="source-crop-toolbar" onPointerDown={(event) => event.stopPropagation()}>
      <label>比例 <select aria-label="裁切比例" value={aspectPreset} onChange={(event) => onChangePreset(event.target.value as CropAspectPreset)}><option value="free">自由</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="4:3">4:3</option></select></label>
      <button type="button" onClick={onReset}>重置裁切</button><button type="button" onClick={onCancel}>取消</button><button type="button" className="primary" onClick={onConfirm}>确认</button>
    </div>
  </div>;
}

function Properties({ clip, asset, project, projectDuration, onUpdate, onTrim, onSetPlaybackRate, onUpdateVideoLayout, onSetVideoLayoutMode, onStartCrop, cropEditing, onDelete }: { clip: TimelineClip; asset?: Asset; project: Project; projectDuration: number; onUpdate: (patch: Partial<TimelineClip>) => void; onTrim: (valueMs: number, edge: 'left' | 'right') => void; onSetPlaybackRate: (playbackRate: number) => void; onUpdateVideoLayout: (patch: Partial<VideoLayout>) => void; onSetVideoLayoutMode: (mode: 'full' | 'fit' | 'fill' | 'pip') => void; onStartCrop: () => void; cropEditing: boolean; onDelete: () => void }) {
  const number = (label: string, value: number, update: (next: number) => void, min = 0, max = projectDuration) => <label className="field">{label}<input type="number" min={min} max={max} value={Math.round(value)} onChange={(event) => update(Number(event.target.value))} /></label>;
  const speed = clip.type === 'caption' ? null : <label className="field">播放速度<select aria-label="片段播放速度" value={clip.playbackRate ?? 1} onChange={(event) => onSetPlaybackRate(Number(event.target.value))}>{PLAYBACK_RATE_PRESETS.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select><small>变速会改变音调。</small></label>;
  if (clip.type === 'caption') return <div className="properties"><label className="field">字幕文字<textarea value={clip.text ?? ''} onChange={(event) => onUpdate({ text: event.target.value, name: event.target.value.slice(0, 18) || '字幕' })} /></label>{number('开始时间（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('结束时间（ms）', clip.startMs + clip.durationMs, (endMs) => onUpdate({ durationMs: clamp(endMs - clip.startMs, 100, projectDuration - clip.startMs) }), 100, projectDuration)}<label className="field">字号<input type="number" min="16" max="100" value={clip.captionStyle?.fontSize ?? 46} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, fontSize: Number(event.target.value) } })} /></label><label className="field">颜色<input type="color" value={clip.captionStyle?.color ?? '#ffffff'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, color: event.target.value } })} /></label><label className="field">位置<select value={clip.captionStyle?.position ?? 'bottom'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, position: event.target.value as 'top' | 'center' | 'bottom' } })}><option value="bottom">下方居中</option><option value="center">画面中央</option><option value="top">顶部居中</option></select></label><button className="danger" onClick={onDelete}>删除字幕</button></div>;
  if (clip.type === 'audio') return <div className="properties"><p><b>{clip.name}</b></p>{number('轨道开始（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('源文件起点（ms）', clip.sourceStartMs, (sourceStartMs) => onUpdate({ sourceStartMs: clamp(sourceStartMs, 0, Math.max(0, (asset?.durationMs ?? 0) - getClipSourceDurationMs(clip))) }), 0, asset?.durationMs ?? 0)}{number('时间轴时长（ms）', clip.durationMs, (durationMs) => onTrim(durationMs, 'right'), 100, projectDuration)}{speed}<label className="field">音量 {Math.round(clip.volume * 100)}%<input type="range" min="0" max="1" step="0.05" value={clip.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} /></label><button className="danger" onClick={onDelete}>删除片段</button></div>;
  const layout = clip.videoLayout ?? defaultVideoLayout(project, asset);
  const layoutNumber = (label: string, value: number, patch: (next: number) => Partial<VideoLayout>, max: number) => <label className="field">{label}<input type="number" min="0" max={max} value={Math.round(value)} onChange={(event) => onUpdateVideoLayout(patch(Number(event.target.value)))} /></label>;
  return <div className="properties"><p><b>{clip.name}</b></p><p>时间轴移动/裁剪会同步原声；预览画布可拖动图层，八个控制点可缩放。</p>{speed}<div className="video-layout-actions"><button onClick={() => onSetVideoLayoutMode('full')}>全画面</button><button onClick={() => onSetVideoLayoutMode('fit')}>Fit</button><button onClick={() => onSetVideoLayoutMode('fill')}>Fill</button><button onClick={() => onSetVideoLayoutMode('pip')}>画中画</button><button onClick={() => onSetVideoLayoutMode('fit')}>恢复默认</button><button className="crop-entry" onClick={onStartCrop}>{cropEditing ? '正在裁切…' : '裁切'}</button></div>{layoutNumber('X', layout.x, (x) => ({ x, mode: 'custom' }), project.width)}{layoutNumber('Y', layout.y, (y) => ({ y, mode: 'custom' }), project.height)}{layoutNumber('宽度', layout.width, (width) => ({ width, mode: 'custom' }), project.width)}{layoutNumber('高度', layout.height, (height) => ({ height, mode: 'custom' }), project.height)}<label className="field checkbox-field"><input type="checkbox" checked={layout.keepAspectRatio} onChange={(event) => onUpdateVideoLayout({ keepAspectRatio: event.target.checked })} />保持宽高比</label><label className="field">透明度 {Math.round(layout.opacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={layout.opacity} onChange={(event) => onUpdateVideoLayout({ opacity: Number(event.target.value), mode: 'custom' })} /></label><label className="field">原声音量 {Math.round(clip.volume * 100)}%<input type="range" min="0" max="1" step="0.05" disabled={clip.muted} value={clip.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} /></label><label className="field checkbox-field"><input type="checkbox" checked={clip.muted ?? false} onChange={(event) => onUpdate({ muted: event.target.checked })} />静音原声</label><button className="danger" onClick={onDelete}>删除视频片段</button></div>;
}
