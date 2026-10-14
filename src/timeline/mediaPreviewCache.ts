import { AudioClip, MP4Clip } from '@webav/av-cliper';
import { getClipSourceDurationMs, msToUs, usToMs } from '../editor/timelineMath';
import type { Asset, TimelineClip } from '../editor/types';
import { AnalysisTaskQueue, buildWaveformPeaksAsync, peakForBucket, type WaveformAnalysisStatus, type WaveformDiagnosticEntry, type WaveformTiming } from './waveformAnalysis';

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

const nextIdlePeriod = () => new Promise<void>((resolve) => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 250 });
  else setTimeout(resolve, 0);
});
const readableError = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  private waveformTasks = new Map<string, Promise<WaveformData>>();
  private thumbnailTasks = new Map<string, Promise<VideoThumbnailData>>();
  private waveformErrors = new Map<string, string>();
  private waveformStatus = new Map<string, WaveformAnalysisStatus>();
  private waveformVersions = new Map<string, number>();
  private importedAt = new Map<string, number>();
  private diagnostics: WaveformDiagnosticEntry[] = [];
  private listeners = new Set<(assetId: string) => void>();
  private waveformQueue = new AnalysisTaskQueue();
  private disposed = false;

  getWaveform(assetId: string | undefined) { return assetId ? this.waveforms.get(assetId) : undefined; }
  getWaveformError(assetId: string | undefined) { return assetId ? this.waveformErrors.get(assetId) : undefined; }
  getWaveformStatus(assetId: string | undefined) {
    const status = assetId ? this.waveformStatus.get(assetId) : undefined;
    return status && { ...status, timings: { ...status.timings } };
  }
  getWaveformDiagnostics() { return this.diagnostics.map((entry) => ({ ...entry, timings: entry.timings && { ...entry.timings } })); }
  subscribe(listener: (assetId: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Called once an inspected audio Asset is placed into the project; it never blocks the card. */
  noteAudioImported(asset: Asset, fileSelectedAt: number) {
    if (asset.type !== 'audio') return;
    this.importedAt.set(asset.id, fileSelectedAt);
    this.waveformVersions.set(asset.id, this.waveformVersions.get(asset.id) ?? 0);
    this.setWaveformStatus(asset, { phase: 'queued', attempt: 0, timings: {} }, '素材已进入分析队列');
  }
  getThumbnails(assetId: string | undefined) { return assetId ? this.thumbnails.get(assetId) : undefined; }

  ensureWaveform(asset: Asset, file: File): Promise<WaveformData> {
    const cached = this.waveforms.get(asset.id);
    if (cached) {
      if (this.waveformStatus.get(asset.id)?.phase !== 'ready') this.setWaveformStatus(asset, { phase: 'ready', attempt: 1, timings: {} }, '复用已缓存的波形');
      return Promise.resolve(cached);
    }
    const pending = this.waveformTasks.get(asset.id);
    if (pending) return pending;
    const queuedAt = performance.now();
    const version = this.waveformVersions.get(asset.id) ?? 0;
    const previous = this.waveformStatus.get(asset.id);
    const attempt = Math.max(1, (previous?.attempt ?? 0) + 1);
    const timings: WaveformTiming = { importToTaskMs: queuedAt - (this.importedAt.get(asset.id) ?? queuedAt) };
    this.setWaveformStatus(asset, { phase: 'queued', attempt, timings }, `任务已创建，等待第 ${this.waveformQueue.pendingCount + 1} 个分析槽位`);
    const task = this.waveformQueue.enqueue(() => this.loadWaveform(asset, file, version, queuedAt, attempt, timings)).then((data) => {
      if (this.isCurrent(asset.id, version)) this.waveformErrors.delete(asset.id);
      return data;
    }).catch((error: unknown) => {
      if (this.isCurrent(asset.id, version)) this.waveformErrors.set(asset.id, readableError(error));
      throw error;
    }).finally(() => this.waveformTasks.delete(asset.id));
    this.waveformTasks.set(asset.id, task);
    return task;
  }

  retryWaveform(asset: Asset, file: File) {
    const pending = this.waveformTasks.get(asset.id);
    if (pending) return pending;
    this.waveforms.delete(asset.id);
    this.waveformErrors.delete(asset.id);
    this.waveformVersions.set(asset.id, (this.waveformVersions.get(asset.id) ?? 0) + 1);
    this.setWaveformStatus(asset, { phase: 'queued', attempt: this.waveformStatus.get(asset.id)?.attempt ?? 0, timings: {} }, '用户请求重新分析');
    return this.ensureWaveform(asset, file);
  }

  /** WebCodecs decode cannot be cancelled midway; invalidated results are ignored. */
  forgetAsset(assetId: string) {
    this.waveformVersions.set(assetId, (this.waveformVersions.get(assetId) ?? 0) + 1);
    this.waveforms.delete(assetId);
    this.waveformErrors.delete(assetId);
    this.waveformStatus.delete(assetId);
    this.importedAt.delete(assetId);
  }

  recordUiRendered(assetId: string, scheduledAt: number) {
    const status = this.waveformStatus.get(assetId);
    if (!status) return;
    const uiUpdateMs = performance.now() - scheduledAt;
    status.timings.uiUpdateMs = uiUpdateMs;
    this.pushDiagnostic({ at: performance.now(), assetId, assetName: assetId, assetType: 'audio', durationMs: 0, attempt: status.attempt, phase: 'ui-rendered', message: `界面已更新（${uiUpdateMs.toFixed(1)} ms）`, timings: { ...status.timings } });
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
    this.thumbnails.clear();
    this.listeners.clear();
  }

  private async loadWaveform(asset: Asset, file: File, version: number, queuedAt: number, attempt: number, timings: WaveformTiming): Promise<WaveformData> {
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
      if (this.isCurrent(asset.id, version)) this.waveforms.set(asset.id, data);
      timings.cacheWriteMs = performance.now() - cacheStartedAt;
      timings.totalMs = performance.now() - queuedAt;
      if (this.isCurrent(asset.id, version)) this.setWaveformStatus(asset, { phase: 'ready', attempt, timings }, `分析完成，共 ${peaks.length} 个峰值`);
      this.log(asset, 'cached', `波形已缓存，总耗时 ${timings.totalMs.toFixed(1)} ms`, timings);
      return data;
    } catch (error) {
      timings.totalMs = performance.now() - queuedAt;
      const message = readableError(error);
      if (this.isCurrent(asset.id, version)) this.setWaveformStatus(asset, { phase: 'failed', attempt, error: message, timings }, `分析在“${phase === 'sampling' ? '峰值生成' : '解码'}”阶段失败：${message}`);
      this.log(asset, 'failed', `阶段 ${phase} 失败：${message}`, timings);
      throw error;
    } finally {
      pcm = [];
      clip?.destroy();
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

  private isCurrent(assetId: string, version: number) {
    return !this.disposed && (this.waveformVersions.get(assetId) ?? 0) === version;
  }

  private setWaveformStatus(asset: Asset, status: WaveformAnalysisStatus, message: string) {
    if (this.disposed) return;
    this.waveformStatus.set(asset.id, { ...status, timings: { ...status.timings } });
    if (status.phase === 'failed' && status.error) this.waveformErrors.set(asset.id, status.error);
    this.log(asset, status.phase, message, status.timings);
    for (const listener of this.listeners) listener(asset.id);
  }

  private log(asset: Asset, phase: string, message: string, timings?: WaveformTiming) {
    const entry: WaveformDiagnosticEntry = {
      at: performance.now(), assetId: asset.id, assetName: asset.name, assetType: 'audio', durationMs: asset.durationMs,
      attempt: this.waveformStatus.get(asset.id)?.attempt ?? 0,
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
