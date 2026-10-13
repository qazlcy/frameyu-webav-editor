import { useEffect, useMemo, useRef, useState } from 'react';
import { addAudioClip, addCaption, getAsset, getMainDuration, moveProjectClip, removeClip, trimProjectClip, updateClip, upsertAsset } from './editor/commands';
import { emptyProject, TRACKS, type Asset, type EditorState, type Project, type TimelineClip, type TrackType } from './editor/types';
import { clamp, timelineContentWidth, timeToTimelineX, viewportXToTime } from './editor/timelineMath';
import { WebAVAdapter, type CapabilityReport } from './webav/WebAVAdapter';

const initialEditor: EditorState = { playheadMs: 0, zoom: 100, playback: 'idle', status: 'ready', message: '等待导入主视频' };
const formatTime = (timeMs: number) => `${String(Math.floor(timeMs / 60000)).padStart(2, '0')}:${String(Math.floor(timeMs / 1000) % 60).padStart(2, '0')}.${String(Math.floor(timeMs % 1000 / 10)).padStart(2, '0')}`;
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

type DragState =
  | { kind: 'clip'; clip: TimelineClip; mode: 'move' | 'left' | 'right'; pointerStartMs: number }
  | { kind: 'playhead' };

export default function App() {
  const previewRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<WebAVAdapter>();
  const durationRef = useRef(0);
  const [project, setProject] = useState<Project>(emptyProject);
  const [editor, setEditor] = useState<EditorState>(initialEditor);
  const [capability, setCapability] = useState<CapabilityReport>();
  const [adapterReady, setAdapterReady] = useState(false);
  const [drag, setDrag] = useState<DragState>();

  const mainDuration = getMainDuration(project);
  durationRef.current = mainDuration;
  const selected = project.clips.find((clip) => clip.id === editor.selectedClipId);
  const selectedAsset = selected?.assetId ? getAsset(project, selected.assetId) : undefined;
  const timelineDuration = Math.max(mainDuration, 10000);

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
    if (!adapterReady || !project.mainVideoAssetId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void adapterRef.current?.sync(project, editor.playheadMs).catch((error: unknown) => {
        if (!cancelled) setEditor((previous) => ({ ...previous, status: 'error', message: error instanceof Error ? error.message : String(error) }));
        console.error('[WebAV] synchronization failed', error);
      });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [adapterReady, project]);

  async function importVideo(file: File) {
    setEditor((previous) => ({ ...previous, status: 'loading', message: '正在解析主视频…' }));
    try {
      const info = await adapterRef.current!.inspectFile(file, 'video');
      const asset: Asset = { id: makeId('video'), name: file.name, type: 'video', mimeType: file.type, ...info };
      adapterRef.current!.registerAsset(asset, file);
      setProject((previous) => upsertAsset(previous, asset, true));
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
    const safeTime = clamp(timeMs, 0, mainDuration);
    setEditor((previous) => ({ ...previous, playheadMs: safeTime }));
    try { await adapterRef.current?.previewFrame(safeTime); }
    catch (error) { console.error('[WebAV] seek failed', error); }
  };

  function togglePlayback() {
    if (!mainDuration) return;
    if (editor.playback === 'playing') {
      adapterRef.current?.pause();
      setEditor((previous) => ({ ...previous, playback: 'paused' }));
      return;
    }
    const start = editor.playheadMs >= mainDuration ? 0 : editor.playheadMs;
    adapterRef.current?.play(start, mainDuration);
    setEditor((previous) => ({ ...previous, playheadMs: start, playback: 'playing' }));
  }

  async function exportVideo() {
    if (!mainDuration || editor.status === 'exporting') return;
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

  function addAudio(asset: Asset, trackId: Extract<TrackType, 'music' | 'sfx'>) {
    setProject((previous) => addAudioClip(previous, asset, trackId));
    setEditor((previous) => ({ ...previous, status: 'ready', message: `${asset.name} 已加入${trackId === 'music' ? '背景音乐' : '音效'}轨` }));
  }

  function updateSelected(patch: Partial<TimelineClip>) {
    if (!selected) return;
    setProject((previous) => updateClip(previous, selected.id, patch));
  }

  function pointerTime(event: Pick<React.PointerEvent, 'clientX'>) {
    const viewport = timelineScrollRef.current;
    if (!viewport) return 0;
    const { left } = viewport.getBoundingClientRect();
    return clamp(viewportXToTime(event.clientX, left, viewport.scrollLeft, editor.zoom), 0, mainDuration);
  }

  function startClipDrag(event: React.PointerEvent, clip: TimelineClip, mode: Extract<DragState, { kind: 'clip' }>['mode']) {
    if (clip.type === 'video') return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setEditor((previous) => ({ ...previous, selectedClipId: clip.id, playback: 'paused' }));
    adapterRef.current?.pause();
    setDrag({ kind: 'clip', clip, mode, pointerStartMs: pointerTime(event) });
  }

  function startPlayheadDrag(event: React.PointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    adapterRef.current?.pause();
    setEditor((previous) => ({ ...previous, playback: 'paused' }));
    setDrag({ kind: 'playhead' });
  }

  function moveTimeline(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const nextTimeMs = pointerTime(event);
    if (drag.kind === 'playhead') {
      setEditor((previous) => ({ ...previous, playheadMs: nextTimeMs }));
      return;
    }
    const deltaMs = nextTimeMs - drag.pointerStartMs;
    if (drag.mode === 'move') setProject((previous) => moveProjectClip(previous, drag.clip.id, drag.clip.startMs + deltaMs));
    if (drag.mode === 'left') setProject((previous) => trimProjectClip(previous, drag.clip.id, drag.clip.startMs + deltaMs, 'left'));
    if (drag.mode === 'right') setProject((previous) => trimProjectClip(previous, drag.clip.id, drag.clip.durationMs + deltaMs, 'right'));
  }

  function endTimelineDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag?.kind === 'playhead') void syncAndSeek(pointerTime(event));
    setDrag(undefined);
  }

  function clickTimeline(event: React.MouseEvent<HTMLDivElement>) {
    if (drag || !mainDuration) return;
    void syncAndSeek(pointerTime(event));
  }

  const ticks = useMemo(() => Array.from({ length: Math.ceil(timelineDuration / 1000) + 1 }, (_, index) => index * 1000), [timelineDuration]);

  return <main className="editor-shell">
    <header className="topbar">
      <div><strong>帧语智能编辑器</strong><span className="tag">WebAV Demo</span></div>
      <div className={`status ${editor.status}`}>{editor.status === 'loading' ? '加载中' : editor.status === 'exporting' ? '导出中' : editor.status === 'error' ? '异常' : '就绪'} · {editor.message}</div>
      <button className="primary" disabled={!mainDuration || editor.status === 'exporting'} onClick={exportVideo}>导出 MP4</button>
    </header>
    {!capability?.supported && <div className="capability-warning"><b>兼容性提示：</b>{capability ? capability.reasons.join(' ') : '正在检测 WebCodecs 与 WebAV…'}</div>}
    <section className="workspace">
      <aside className="asset-panel panel">
        <h2>素材库</h2>
        <label className="import-button">导入主视频<input aria-label="导入主视频" type="file" accept="video/mp4" onChange={(event) => event.target.files?.[0] && void importVideo(event.target.files[0])} /></label>
        {project.mainVideoAssetId && <div className="asset-card"><b>{getAsset(project, project.mainVideoAssetId)?.name}</b><small>主视频 · {formatTime(mainDuration)}</small></div>}
        <label className="import-button subtle">导入音乐 / 音效<input aria-label="导入音频" type="file" accept="audio/mpeg,audio/wav" onChange={(event) => event.target.files?.[0] && void importAudio(event.target.files[0])} /></label>
        <div className="asset-list">{project.assets.filter((asset) => asset.type === 'audio').map((asset) => <div className="asset-card" key={asset.id}><b title={asset.name}>{asset.name}</b><small>{formatTime(asset.durationMs)}</small><div><button onClick={() => addAudio(asset, 'music')} disabled={!mainDuration}>+ 音乐</button><button onClick={() => addAudio(asset, 'sfx')} disabled={!mainDuration}>+ 音效</button></div></div>)}</div>
        <button className="caption-add" disabled={!mainDuration} onClick={() => setProject((previous) => addCaption(previous))}>＋ 添加字幕</button>
      </aside>
      <section className="preview-panel panel">
        <div className="preview-frame"><div ref={previewRef} className="webav-preview" /></div>
        <div className="player-controls"><button aria-label="播放或暂停" disabled={!mainDuration} onClick={togglePlayback}>{editor.playback === 'playing' ? '❚❚ 暂停' : '▶ 播放'}</button><span>{formatTime(editor.playheadMs)} / {formatTime(mainDuration)}</span><input aria-label="播放位置" disabled={!mainDuration} type="range" min="0" max={mainDuration || 1} value={editor.playheadMs} onChange={(event) => void syncAndSeek(Number(event.target.value))} /></div>
      </section>
      <aside className="property-panel panel"><h2>属性</h2>{selected ? <Properties clip={selected} asset={selectedAsset} projectDuration={mainDuration} onUpdate={updateSelected} onDelete={() => { setProject((previous) => removeClip(previous, selected.id)); setEditor((previous) => ({ ...previous, selectedClipId: undefined })); }} /> : <p className="empty">选择时间轴片段以编辑属性</p>}</aside>
    </section>
    <section className="timeline-panel panel">
      <div className="timeline-toolbar"><b>时间轴</b><label>缩放 <input aria-label="时间轴缩放" type="range" min="45" max="240" value={editor.zoom} onChange={(event) => setEditor((previous) => ({ ...previous, zoom: Number(event.target.value) }))} /></label></div>
      <div className="timeline-scroll" ref={timelineScrollRef}><div className="timeline-content" style={{ width: `${timelineContentWidth(timelineDuration, editor.zoom)}px` }} onPointerMove={moveTimeline} onPointerUp={endTimelineDrag} onPointerCancel={() => setDrag(undefined)} onClick={clickTimeline}>
        <div className="ruler">{ticks.map((time) => <span key={time} style={{ left: `${timeToTimelineX(time, editor.zoom)}px` }}>{formatTime(time).slice(0, 5)}</span>)}</div>
        <div className="playhead" style={{ left: `${timeToTimelineX(editor.playheadMs, editor.zoom)}px` }} onPointerDown={startPlayheadDrag} onClick={(event) => event.stopPropagation()} />
        {TRACKS.map((track) => <div className="track" key={track.id}><div className="track-label">{track.label}</div><div className="track-lane" style={{ backgroundSize: `${editor.zoom}px 100%` }}>{project.clips.filter((clip) => clip.trackId === track.id).map((clip) => <div role="button" tabIndex={0} className={`timeline-clip ${clip.type} ${selected?.id === clip.id ? 'selected' : ''}`} key={clip.id} style={{ left: `${clip.startMs / 1000 * editor.zoom}px`, width: `${Math.max(18, clip.durationMs / 1000 * editor.zoom)}px` }} onPointerDown={(event) => startClipDrag(event, clip, 'move')} onClick={(event) => { event.stopPropagation(); setEditor((previous) => ({ ...previous, selectedClipId: clip.id })); }}><i className="trim left" onPointerDown={(event) => startClipDrag(event, clip, 'left')} /><span>{clip.type === 'caption' ? clip.text : clip.name}</span>{clip.type !== 'video' && <i className="trim right" onPointerDown={(event) => startClipDrag(event, clip, 'right')} />}</div>)}</div></div>)}
      </div></div>
    </section>
  </main>;
}

function Properties({ clip, asset, projectDuration, onUpdate, onDelete }: { clip: TimelineClip; asset?: Asset; projectDuration: number; onUpdate: (patch: Partial<TimelineClip>) => void; onDelete: () => void }) {
  const number = (label: string, value: number, update: (next: number) => void, min = 0, max = projectDuration) => <label className="field">{label}<input type="number" min={min} max={max} value={Math.round(value)} onChange={(event) => update(Number(event.target.value))} /></label>;
  if (clip.type === 'caption') return <div className="properties"><label className="field">字幕文字<textarea value={clip.text ?? ''} onChange={(event) => onUpdate({ text: event.target.value, name: event.target.value.slice(0, 18) || '字幕' })} /></label>{number('开始时间（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('结束时间（ms）', clip.startMs + clip.durationMs, (endMs) => onUpdate({ durationMs: clamp(endMs - clip.startMs, 100, projectDuration - clip.startMs) }), 100, projectDuration)}<label className="field">字号<input type="number" min="16" max="100" value={clip.captionStyle?.fontSize ?? 46} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, fontSize: Number(event.target.value) } })} /></label><label className="field">颜色<input type="color" value={clip.captionStyle?.color ?? '#ffffff'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, color: event.target.value } })} /></label><label className="field">位置<select value={clip.captionStyle?.position ?? 'bottom'} onChange={(event) => onUpdate({ captionStyle: { ...clip.captionStyle!, position: event.target.value as 'top' | 'center' | 'bottom' } })}><option value="bottom">下方居中</option><option value="center">画面中央</option><option value="top">顶部居中</option></select></label><button className="danger" onClick={onDelete}>删除字幕</button></div>;
  if (clip.type === 'audio') return <div className="properties"><p><b>{clip.name}</b></p>{number('轨道开始（ms）', clip.startMs, (startMs) => onUpdate({ startMs: clamp(startMs, 0, projectDuration - clip.durationMs) }))}{number('源文件起点（ms）', clip.sourceStartMs, (sourceStartMs) => onUpdate({ sourceStartMs: clamp(sourceStartMs, 0, Math.max(0, (asset?.durationMs ?? 0) - clip.durationMs)) }), 0, asset?.durationMs ?? 0)}{number('使用时长（ms）', clip.durationMs, (durationMs) => onUpdate({ durationMs: clamp(durationMs, 100, Math.min(projectDuration - clip.startMs, (asset?.durationMs ?? 0) - clip.sourceStartMs)) }), 100, asset?.durationMs ?? projectDuration)}<label className="field">音量 {Math.round(clip.volume * 100)}%<input type="range" min="0" max="1" step="0.05" value={clip.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} /></label><button className="danger" onClick={onDelete}>删除片段</button></div>;
  return <div className="properties"><p><b>{clip.name}</b></p><p>主视频固定从 0 ms 开始，保留原声。</p></div>;
}
