import { AudioClip, MP4Clip } from '@webav/av-cliper';
import { getClipSourceDurationMs, msToUs, usToMs } from '../editor/timelineMath';
import type { Asset, TimelineClip } from '../editor/types';
import { AnalysisTaskQueue, buildWaveformPeaksAsync, peakForBucket, StreamingWaveformPeakAccumulator, type WaveformAnalysisStatus, type WaveformDiagnosticEntry, type WaveformTiming } from './waveformAnalysis';

export interface WaveformData {
  durationMs: number;
  peaks: number[];
}

export interface VideoThumbnail {
  timeMs: number;
  url: string;
}

export interface VideoThumbnailData {
  durationMs: number;
  frames: VideoThumbnail[];
}

export type MediaPreviewTask = Promise<WaveformData | VideoThumbnailData | undefined>;

const nextIdlePeriod = () => new Promise<void>((resolve) => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 250 });
  else setTimeout(resolve, 0);
});
const readableError = (error: unknown) => error instanceof Error ? error.message : String(error);
const waveformKey = (type: 'audio' | 'video', assetId: string) => `${type}:${assetId}`;

/** Reduces decoded multi-channel PCM to a compact, reusable peak envelope. */
export function buildWaveformPeaks(channels: Float32Array[], bucketCount = 1200): number[] {
  const frameCount = Math.max(0, ...channels.map((channel) => channel.length));
  if (!frameCount || !channels.length) return [];
  const buckets = Math.max(1, Math.min(bucketCount, frameCount));
  return Array.from({ length: buckets }, (_, bucket) => peakForBucket(channels, frameCount, buckets, bucket));
}

/** Samples the exact source window used by a timeline clip, after left/right trimming. */
export function sampleWaveformRange(data: WaveformData, sourceStartMs: number, durationMs: number, bucketCount: number): number[] {
  if (!data.peaks.length || !data.durationMs || durationMs <= 0) return [];
  const buckets = Math.max(1, bucketCount);
  return Array.from({ length: buckets }, (_, index) => {
    const timeMs = sourceStartMs + (index + 0.5) / buckets * durationMs;
    const peakIndex = Math.min(data.peaks.length - 1, Math.max(0, Math.floor(timeMs / data.durationMs * data.peaks.length)));
    return data.peaks[peakIndex] ?? 0;
  });
}

/** Selects cached source frames for exactly the source window used by a video clip. */
export function sampleThumbnailsForClip(data: VideoThumbnailData, clip: TimelineClip, count: number): VideoThumbnail[] {
  if (!data.frames.length || clip.durationMs <= 0) return [];
  const requested = Math.max(1, count);
  return Array.from({ length: requested }, (_, index) => {
    const sourceDurationMs = getClipSourceDurationMs(clip);
    const timeMs = clip.sourceStartMs + (index + 0.5) / requested * sourceDurationMs;
    return data.frames.reduce((closest, frame) => Math.abs(frame.timeMs - timeMs) < Math.abs(closest.timeMs - timeMs) ? frame : closest, data.frames[0]);
  });
}

/**
 * Runtime-only media analysis. Project state stores no PCM/Blob data; repeated timeline
 * clips share the one analysis result owned by their source Asset ID.
 */
export class TimelineMediaPreviewCache {
  private waveforms = new Map<string, WaveformData>();
  private thumbnails = new Map<string, VideoThumbnailData>();
  private waveformTasks = new Map<string, Promise<WaveformData | undefined>>();
  private thumbnailTasks = new Map<string, Promise<VideoThumbnailData>>();
  private waveformErrors = new Map<string, string>();
  private waveformStatus = new Map<string, WaveformAnalysisStatus>();
  private waveformVersions = new Map<string, number>();
  private importedAt = new Map<string, number>();
  private analysisAssets = new Map<string, Asset>();
  private diagnostics: WaveformDiagnosticEntry[] = [];
  private listeners = new Set<(asset: Asset) => void>();
  private waveformQueue = new AnalysisTaskQueue();
  private disposed = false;

  getWaveform(assetId: string | undefined) { return assetId ? this.waveforms.get(waveformKey('audio', assetId)) : undefined; }
  getVideoWaveform(assetId: string | undefined) { return assetId ? this.waveforms.get(waveformKey('video', assetId)) : undefined; }
  getWaveformError(assetId: string | undefined, type: 'audio' | 'video' = 'audio') { return assetId ? this.waveformErrors.get(waveformKey(type, assetId)) : undefined; }
  getWaveformStatus(assetId: string | undefined, type: 'audio' | 'video' = 'audio') {
    const status = assetId ? this.waveformStatus.get(waveformKey(type, assetId)) : undefined;
    return status && { ...status, timings: { ...status.timings } };
  }
  getWaveformDiagnostics() { return this.diagnostics.map((entry) => ({ ...entry, timings: entry.timings && { ...entry.timings } })); }
  subscribe(listener: (asset: Asset) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Called once an inspected audio Asset is placed into the project; it never blocks the card. */
  noteWaveformAssetImported(asset: Asset, fileSelectedAt: number) {
    const key = waveformKey(asset.type, asset.id);
    this.analysisAssets.set(key, asset);
    this.importedAt.set(key, fileSelectedAt);
    this.waveformVersions.set(key, this.waveformVersions.get(key) ?? 0);
    this.setWaveformStatus(asset, { phase: 'unscheduled', attempt: 0, message: '素材已登记，等待本地文件与分析调度', timings: {} }, '素材已登记，尚未创建分析任务');
  }
  noteAudioImported(asset: Asset, fileSelectedAt: number) { this.noteWaveformAssetImported(asset, fileSelectedAt); }
  /** Records why an Asset cannot be queued yet; a later scheduling pass may retry it. */
  markWaveformUnscheduled(asset: Asset, message: string) {
    const key = waveformKey(asset.type, asset.id);
    const current = this.waveformStatus.get(key);
    if (this.waveformTasks.has(key) || current?.phase === 'queued' || current?.phase === 'decoding' || current?.phase === 'sampling') return;
    if (current?.phase === 'unscheduled' && current.message === message) return;
    this.setWaveformStatus(asset, { phase: 'unscheduled', attempt: current?.attempt ?? 0, message, timings: current?.timings ?? {} }, message);
  }
  getThumbnails(assetId: string | undefined) { return assetId ? this.thumbnails.get(assetId) : undefined; }

  ensureWaveform(asset: Asset, file: File): Promise<WaveformData> {
    const key = waveformKey('audio', asset.id);
    const cached = this.waveforms.get(key);
    if (cached) {
      if (this.waveformStatus.get(key)?.phase !== 'ready') this.setWaveformStatus(asset, { phase: 'ready', attempt: 1, timings: {} }, '复用已缓存的波形');
      return Promise.resolve(cached);
    }
    const pending = this.waveformTasks.get(key);
    if (pending) return pending as Promise<WaveformData>;
    const queuedAt = performance.now();
    const version = this.waveformVersions.get(key) ?? 0;
    const previous = this.waveformStatus.get(key);
    const attempt = Math.max(1, (previous?.attempt ?? 0) + 1);
    const timings: WaveformTiming = { importToTaskMs: queuedAt - (this.importedAt.get(key) ?? queuedAt) };
    this.log(asset, 'analysis-requested', '已收到独立音频波形分析请求', timings);
    this.setWaveformStatus(asset, { phase: 'queued', attempt, timings }, `任务已创建，等待第 ${this.waveformQueue.pendingCount + 1} 个分析槽位`);
    const task = this.waveformQueue.enqueue(() => this.loadWaveform(asset, file, key, version, queuedAt, attempt, timings)).then((data) => {
      if (this.isCurrent(key, version)) this.waveformErrors.delete(key);
      return data;
    }).catch((error: unknown) => {
      if (this.isCurrent(key, version)) this.waveformErrors.set(key, readableError(error));
      throw error;
    }).finally(() => this.waveformTasks.delete(key));
    this.waveformTasks.set(key, task);
    return task;
  }

  /** Extracts only the MP4 audio track through splitTrack() + continuous tick() PCM. */
  ensureVideoWaveform(asset: Asset, file: File): Promise<WaveformData | undefined> {
    const key = waveformKey('video', asset.id);
    const cached = this.waveforms.get(key);
    if (cached) return Promise.resolve(cached);
    if (this.waveformStatus.get(key)?.phase === 'no-audio') return Promise.resolve(undefined);
    const pending = this.waveformTasks.get(key);
    if (pending) return pending;
    const queuedAt = performance.now();
    const version = this.waveformVersions.get(key) ?? 0;
    const previous = this.waveformStatus.get(key);
    const attempt = Math.max(1, (previous?.attempt ?? 0) + 1);
    const timings: WaveformTiming = { importToTaskMs: queuedAt - (this.importedAt.get(key) ?? queuedAt) };
    this.log(asset, 'analysis-requested', '已收到视频原声音频分析请求', timings);
    this.setWaveformStatus(asset, { phase: 'queued', attempt, timings }, `视频原声音频任务已创建，等待第 ${this.waveformQueue.pendingCount + 1} 个分析槽位`);
    const task = this.waveformQueue.enqueue(() => this.loadVideoWaveform(asset, file, key, version, queuedAt, attempt, timings)).then((data) => {
      if (this.isCurrent(key, version)) this.waveformErrors.delete(key);
      return data;
    }).catch((error: unknown) => {
      if (this.isCurrent(key, version)) this.waveformErrors.set(key, readableError(error));
      throw error;
    }).finally(() => this.waveformTasks.delete(key));
    this.waveformTasks.set(key, task);
    return task;
  }

  retryVideoWaveform(asset: Asset, file: File) {
    const key = waveformKey('video', asset.id);
    const pending = this.waveformTasks.get(key);
    if (pending) return pending;
    this.waveforms.delete(key);
    this.waveformErrors.delete(key);
    this.waveformVersions.set(key, (this.waveformVersions.get(key) ?? 0) + 1);
    this.setWaveformStatus(asset, { phase: 'queued', attempt: this.waveformStatus.get(key)?.attempt ?? 0, timings: {} }, '用户请求重新分析视频原声');
    return this.ensureVideoWaveform(asset, file);
  }

  retryWaveform(asset: Asset, file: File) {
    const key = waveformKey('audio', asset.id);
    const pending = this.waveformTasks.get(key);
    if (pending) return pending;
    this.waveforms.delete(key);
    this.waveformErrors.delete(key);
    this.waveformVersions.set(key, (this.waveformVersions.get(key) ?? 0) + 1);
    this.setWaveformStatus(asset, { phase: 'queued', attempt: this.waveformStatus.get(key)?.attempt ?? 0, timings: {} }, '用户请求重新分析');
    return this.ensureWaveform(asset, file);
  }

  /** WebCodecs decode cannot be cancelled midway; invalidated results are ignored. */
  forgetAsset(assetId: string, type: 'audio' | 'video' = 'audio') {
    const key = waveformKey(type, assetId);
    this.waveformVersions.set(key, (this.waveformVersions.get(key) ?? 0) + 1);
    this.waveforms.delete(key);
    this.waveformErrors.delete(key);
    this.waveformStatus.delete(key);
    this.importedAt.delete(key);
    this.analysisAssets.delete(key);
  }

  recordUiRendered(asset: Asset, scheduledAt: number) {
    const key = waveformKey(asset.type, asset.id);
    const status = this.waveformStatus.get(key);
    if (!status) return;
    const uiUpdateMs = performance.now() - scheduledAt;
    status.timings.uiUpdateMs = uiUpdateMs;
    this.pushDiagnostic({ at: performance.now(), assetId: asset.id, assetName: asset.name, assetType: asset.type, durationMs: asset.durationMs, attempt: status.attempt, phase: 'ui-rendered', message: `界面已更新（${uiUpdateMs.toFixed(1)} ms）`, timings: { ...status.timings } });
  }

  ensureThumbnails(asset: Asset, file: File): Promise<VideoThumbnailData> {
    const cached = this.thumbnails.get(asset.id);
    if (cached) return Promise.resolve(cached);
    const pending = this.thumbnailTasks.get(asset.id);
    if (pending) return pending;
    const task = this.loadThumbnails(asset, file).finally(() => this.thumbnailTasks.delete(asset.id));
    this.thumbnailTasks.set(asset.id, task);
    return task;
  }

  dispose() {
    this.disposed = true;
    this.waveformQueue.dispose();
    for (const data of this.thumbnails.values()) for (const frame of data.frames) URL.revokeObjectURL(frame.url);
    this.waveforms.clear();
    this.waveformErrors.clear();
    this.waveformStatus.clear();
    this.analysisAssets.clear();
    this.thumbnails.clear();
    this.listeners.clear();
  }

  private async loadWaveform(asset: Asset, file: File, key: string, version: number, queuedAt: number, attempt: number, timings: WaveformTiming): Promise<WaveformData> {
    const startedAt = performance.now();
    timings.queueWaitMs = startedAt - queuedAt;
    let phase: WaveformAnalysisStatus['phase'] = 'decoding';
    let clip: AudioClip | undefined;
    let pcm: Float32Array[] = [];
    await nextIdlePeriod();
    try {
      this.setWaveformStatus(asset, { phase, attempt, timings }, '开始创建 AudioClip');
      const clipCreateStartedAt = performance.now();
      clip = new AudioClip(file.stream());
      timings.clipCreateMs = performance.now() - clipCreateStartedAt;
      this.log(asset, 'clip-created', `AudioClip 已创建（${timings.clipCreateMs.toFixed(1)} ms）`, timings);
      const readyStartedAt = performance.now();
      await clip.ready;
      timings.readyMs = performance.now() - readyStartedAt;
      this.log(asset, 'decode-ready', `PCM 解码完成（${timings.readyMs.toFixed(1)} ms）`, timings);
      const pcmStartedAt = performance.now();
      pcm = clip.getPCMData();
      timings.pcmReadMs = performance.now() - pcmStartedAt;
      phase = 'sampling';
      this.setWaveformStatus(asset, { phase, attempt, timings }, '正在生成峰值波形');
      this.log(asset, 'pcm-read', `已获取 ${pcm.length} 个 PCM 声道（${timings.pcmReadMs.toFixed(1)} ms）`, timings);
      const peakStartedAt = performance.now();
      const peaks = await buildWaveformPeaksAsync(pcm);
      timings.peakBuildMs = performance.now() - peakStartedAt;
      this.log(asset, 'peak-built', `峰值降采样完成（${timings.peakBuildMs.toFixed(1)} ms）`, timings);
      const cacheStartedAt = performance.now();
      const data: WaveformData = { durationMs: asset.durationMs, peaks };
      if (this.isCurrent(key, version)) this.waveforms.set(key, data);
      timings.cacheWriteMs = performance.now() - cacheStartedAt;
      timings.totalMs = performance.now() - queuedAt;
      if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'ready', attempt, timings }, `分析完成，共 ${peaks.length} 个峰值`);
      this.log(asset, 'cached', `波形已缓存，总耗时 ${timings.totalMs.toFixed(1)} ms`, timings);
      return data;
    } catch (error) {
      timings.totalMs = performance.now() - queuedAt;
      const message = readableError(error);
      if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'failed', attempt, error: message, timings }, `分析在“${phase === 'sampling' ? '峰值生成' : '解码'}”阶段失败：${message}`);
      this.log(asset, 'failed', `阶段 ${phase} 失败：${message}`, timings);
      throw error;
    } finally {
      pcm = [];
      clip?.destroy();
    }
  }

  /**
   * WebAV 1.2.8 splitTrack() returns MP4Clip instances, not AudioClip. The audio-only
   * MP4Clip emits continuous PCM through tick(), provided calls remain within 100 ms.
   */
  private async loadVideoWaveform(asset: Asset, file: File, key: string, version: number, queuedAt: number, attempt: number, timings: WaveformTiming): Promise<WaveformData | undefined> {
    const startedAt = performance.now();
    timings.queueWaitMs = startedAt - queuedAt;
    let phase: WaveformAnalysisStatus['phase'] = 'decoding';
    let source: MP4Clip | undefined;
    let tracks: MP4Clip[] = [];
    try {
      await nextIdlePeriod();
      this.setWaveformStatus(asset, { phase, attempt, timings }, '正在检查视频原声音轨');
      const clipCreateStartedAt = performance.now();
      source = new MP4Clip(file.stream());
      timings.clipCreateMs = performance.now() - clipCreateStartedAt;
      const readyStartedAt = performance.now();
      await source.ready;
      const meta = source.meta;
      timings.readyMs = performance.now() - readyStartedAt;
      this.log(asset, 'video-metadata-ready', `视频元数据完成；音频声道 ${meta.audioChanCount}（${timings.readyMs.toFixed(1)} ms）`, timings);
      if (!meta.audioChanCount || !meta.audioSampleRate) {
        timings.totalMs = performance.now() - queuedAt;
        if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'no-audio', attempt, timings }, '视频没有可用音轨');
        return undefined;
      }

      const splitStartedAt = performance.now();
      tracks = await source.splitTrack();
      timings.trackSplitMs = performance.now() - splitStartedAt;
      const audioTrack = tracks.find((track) => track.meta.audioChanCount > 0);
      this.log(asset, 'audio-track-split', `音轨已拆分（${timings.trackSplitMs.toFixed(1)} ms）`, timings);
      if (!audioTrack) {
        timings.totalMs = performance.now() - queuedAt;
        if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'no-audio', attempt, timings }, '视频没有可解码的音轨');
        return undefined;
      }

      // The split track has no video samples, so its tick() never invokes VideoDecoder.
      phase = 'sampling';
      this.setWaveformStatus(asset, { phase, attempt, timings }, '正在解码视频原声并生成波形');
      const accumulator = new StreamingWaveformPeakAccumulator(audioTrack.meta.duration, audioTrack.meta.audioSampleRate);
      const tickStartedAt = performance.now();
      const tickStepUs = 100_000;
      for (let timeUs = tickStepUs; timeUs <= audioTrack.meta.duration; timeUs += tickStepUs) {
        const result = await audioTrack.tick(Math.min(timeUs, audioTrack.meta.duration));
        accumulator.push(result.audio);
      }
      if (audioTrack.meta.duration % tickStepUs !== 0) {
        const result = await audioTrack.tick(audioTrack.meta.duration);
        accumulator.push(result.audio);
      }
      timings.audioTickMs = performance.now() - tickStartedAt;
      timings.pcmReadMs = timings.audioTickMs;
      this.log(asset, 'video-audio-decoded', `音轨连续 PCM 已读取（${timings.audioTickMs.toFixed(1)} ms）`, timings);

      const peakStartedAt = performance.now();
      const peaks = accumulator.finish();
      timings.peakBuildMs = performance.now() - peakStartedAt;
      const cacheStartedAt = performance.now();
      const data: WaveformData = { durationMs: asset.durationMs, peaks };
      if (this.isCurrent(key, version)) this.waveforms.set(key, data);
      timings.cacheWriteMs = performance.now() - cacheStartedAt;
      timings.totalMs = performance.now() - queuedAt;
      if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'ready', attempt, timings }, `视频原声波形完成，共 ${peaks.length} 个峰值`);
      this.log(asset, 'video-waveform-cached', `视频原声波形已缓存，总耗时 ${timings.totalMs.toFixed(1)} ms`, timings);
      return data;
    } catch (error) {
      timings.totalMs = performance.now() - queuedAt;
      const message = readableError(error);
      if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'failed', attempt, error: message, timings }, `视频原声分析在“${phase === 'sampling' ? 'PCM 读取' : '音轨检查'}”阶段失败：${message}`);
      this.log(asset, 'video-waveform-failed', `阶段 ${phase} 失败：${message}`, timings);
      throw error;
    } finally {
      source?.destroy();
      for (const track of tracks) track.destroy();
    }
  }

  private async loadThumbnails(asset: Asset, file: File): Promise<VideoThumbnailData> {
    await nextIdlePeriod();
    const clip = new MP4Clip(file.stream());
    try {
      const meta = await clip.ready;
      const stepUs = Math.max(msToUs(500), Math.round(meta.duration / 16));
      const rendered = await clip.thumbnails(160, { start: 0, end: meta.duration, step: stepUs });
      const data: VideoThumbnailData = { durationMs: asset.durationMs, frames: rendered.map(({ ts, img }) => ({ timeMs: usToMs(ts), url: URL.createObjectURL(img) })) };
      if (this.disposed) {
        for (const frame of data.frames) URL.revokeObjectURL(frame.url);
      } else this.thumbnails.set(asset.id, data);
      return data;
    } finally {
      clip.destroy();
    }
  }

  private isCurrent(key: string, version: number) {
    return !this.disposed && (this.waveformVersions.get(key) ?? 0) === version;
  }

  private setWaveformStatus(asset: Asset, status: WaveformAnalysisStatus, message: string) {
    if (this.disposed) return;
    const key = waveformKey(asset.type, asset.id);
    this.waveformStatus.set(key, { ...status, message, timings: { ...status.timings } });
    if (status.phase === 'failed' && status.error) this.waveformErrors.set(key, status.error);
    this.log(asset, status.phase, message, status.timings);
    for (const listener of this.listeners) listener(asset);
  }

  private log(asset: Asset, phase: string, message: string, timings?: WaveformTiming) {
    const entry: WaveformDiagnosticEntry = {
      at: performance.now(), assetId: asset.id, assetName: asset.name, assetType: asset.type, durationMs: asset.durationMs,
      attempt: this.waveformStatus.get(waveformKey(asset.type, asset.id))?.attempt ?? 0,
      phase, message, timings: timings && { ...timings },
    };
    this.pushDiagnostic(entry);
    console.info('[WaveformAnalysis]', entry);
  }

  private pushDiagnostic(entry: WaveformDiagnosticEntry) {
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 200) this.diagnostics.splice(0, this.diagnostics.length - 200);
  }
}

/**
 * Runs after both project state and the runtime File registry have settled. The registry lives
 * outside serialisable Project data, so a later File registration must be able to schedule an
 * already-present Asset instead of leaving its card in a misleading pending state.
 */
export function scheduleMediaPreviewAnalysis(cache: TimelineMediaPreviewCache, assets: readonly Asset[], getFile: (assetId: string) => File | undefined): MediaPreviewTask[] {
  const tasks: MediaPreviewTask[] = [];
  for (const asset of assets) {
    const file = getFile(asset.id);
    if (!file) {
      cache.markWaveformUnscheduled(asset, '尚未调度：本地文件引用尚未准备好，将在资源注册后重试');
      continue;
    }
    if (asset.type === 'audio') tasks.push(cache.ensureWaveform(asset, file));
    else {
      tasks.push(cache.ensureThumbnails(asset, file));
      tasks.push(cache.ensureVideoWaveform(asset, file));
    }
  }
  return tasks;
}
