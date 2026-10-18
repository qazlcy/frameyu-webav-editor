import { AudioClip, MP4Clip } from '@webav/av-cliper';
import { getClipSourceDurationMs, msToUs, usToMs } from '../editor/timelineMath';
import type { Asset, TimelineClip } from '../editor/types';
import { AnalysisTaskQueue, buildWaveformEnvelopeAsync, peakForBucket, StreamingWaveformPeakAccumulator, type WaveformAnalysisStatus, type WaveformDiagnosticEntry, type WaveformTiming } from './waveformAnalysis';

export interface WaveformData {
  durationMs: number;
  peaks: number[];
  rms?: number[];
  sampleCounts?: number[];
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

/** Bounded high-resolution source envelope: 6–22 ms per bucket for ordinary long-form media. */
export const waveformBucketCount = (durationMs: number) => Math.min(8192, Math.max(2048, Math.ceil(Math.max(1, durationMs) / 8)));

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

export interface WaveformColumn { peak: number; rms: number; sampleCount: number; }

export interface WaveformSummary {
  bucketCount: number;
  maxPeak: number;
  averagePeak: number;
  p10Peak: number;
  p50Peak: number;
  p90Peak: number;
  p95Peak: number;
  p99Peak: number;
  maxRms: number;
  averageRms: number;
  nonZeroPeakBuckets: number;
  nonZeroPeakRatio: number;
}

const quantile = (sortedValues: readonly number[], percentile: number) => {
  if (!sortedValues.length) return 0;
  const position = Math.min(1, Math.max(0, percentile)) * (sortedValues.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (position - low);
};

export function summariseWaveform(data: WaveformData): WaveformSummary {
  const rms = data.rms ?? data.peaks;
  const total = data.peaks.reduce((sum, peak) => sum + peak, 0);
  const rmsTotal = rms.reduce((sum, value) => sum + value, 0);
  const nonZeroPeakBuckets = data.peaks.filter((peak) => peak > 0).length;
  const sortedPeaks = [...data.peaks].sort((left, right) => left - right);
  return {
    bucketCount: data.peaks.length,
    maxPeak: Math.max(0, ...data.peaks),
    averagePeak: data.peaks.length ? total / data.peaks.length : 0,
    p10Peak: quantile(sortedPeaks, .1),
    p50Peak: quantile(sortedPeaks, .5),
    p90Peak: quantile(sortedPeaks, .9),
    p95Peak: quantile(sortedPeaks, .95),
    p99Peak: quantile(sortedPeaks, .99),
    maxRms: Math.max(0, ...rms),
    averageRms: rms.length ? rmsTotal / rms.length : 0,
    nonZeroPeakBuckets,
    nonZeroPeakRatio: data.peaks.length ? nonZeroPeakBuckets / data.peaks.length : 0,
  };
}

/** Aggregates only the source time range covered by a visible timeline clip; no PCM is revisited. */
export function sampleWaveformEnvelope(data: WaveformData, sourceStartMs: number, durationMs: number, columnCount: number): WaveformColumn[] {
  if (!data.peaks.length || !data.durationMs || durationMs <= 0) return [];
  const columns = Math.max(1, columnCount);
  const sourceEndMs = Math.min(data.durationMs, Math.max(sourceStartMs, sourceStartMs + durationMs));
  const sourceStart = Math.max(0, Math.min(sourceStartMs, data.durationMs));
  const rms = data.rms ?? data.peaks;
  const counts = data.sampleCounts;
  return Array.from({ length: columns }, (_, column) => {
    const fromMs = sourceStart + (sourceEndMs - sourceStart) * column / columns;
    const toMs = sourceStart + (sourceEndMs - sourceStart) * (column + 1) / columns;
    const first = Math.max(0, Math.floor(fromMs / data.durationMs * data.peaks.length));
    const last = Math.min(data.peaks.length - 1, Math.max(first, Math.ceil(toMs / data.durationMs * data.peaks.length) - 1));
    let peak = 0;
    let squareSum = 0;
    let sampleCount = 0;
    for (let index = first; index <= last; index += 1) {
      peak = Math.max(peak, data.peaks[index] ?? 0);
      const count = counts?.[index] ?? 1;
      squareSum += (rms[index] ?? 0) ** 2 * count;
      sampleCount += count;
    }
    return { peak, rms: Math.sqrt(squareSum / Math.max(1, sampleCount)), sampleCount };
  });
}

/** Visual-only gain preserves zero and relative ordering without changing source audio or export. */
export function waveformVisualAmplitude(peak: number, rms: number) {
  const energy = Math.max(0, Math.max(peak * 0.46, rms * 1.08));
  return energy === 0 ? 0 : Math.min(1, Math.pow(energy, 0.68) * 0.94);
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
  /** Cached diagnostics are also the stable display reference shared by every clip of an Asset. */
  private waveformSummaries = new Map<string, WaveformSummary>();
  private thumbnails = new Map<string, VideoThumbnailData>();
  private waveformTasks = new Map<string, Promise<WaveformData | undefined>>();
  private thumbnailTasks = new Map<string, Promise<VideoThumbnailData>>();
  private thumbnailWindows = new Map<string, VideoThumbnailData>();
  private thumbnailErrors = new Set<string>();
  private thumbnailQueue = new AnalysisTaskQueue();
  private thumbnailVersions = new Map<string, number>();
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
  getWaveformSummary(assetId: string | undefined) { return assetId ? this.waveformSummaries.get(waveformKey('audio', assetId)) : undefined; }
  getVideoWaveformSummary(assetId: string | undefined) { return assetId ? this.waveformSummaries.get(waveformKey('video', assetId)) : undefined; }
  getWaveformError(assetId: string | undefined, type: 'audio' | 'video' = 'audio') { return assetId ? this.waveformErrors.get(waveformKey(type, assetId)) : undefined; }
  getWaveformStatus(assetId: string | undefined, type: 'audio' | 'video' = 'audio') {
    const status = assetId ? this.waveformStatus.get(waveformKey(type, assetId)) : undefined;
    return status && { ...status, timings: { ...status.timings } };
  }
  getWaveformDiagnostics() { return this.diagnostics.map((entry) => ({ ...entry, timings: entry.timings && { ...entry.timings }, details: entry.details && { ...entry.details } })); }
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
    this.waveformSummaries.delete(key);
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
    this.waveformSummaries.delete(key);
    this.waveformErrors.delete(key);
    this.waveformVersions.set(key, (this.waveformVersions.get(key) ?? 0) + 1);
    this.setWaveformStatus(asset, { phase: 'queued', attempt: this.waveformStatus.get(key)?.attempt ?? 0, timings: {} }, '用户请求重新分析');
    return this.ensureWaveform(asset, file);
  }

  /** WebCodecs decode cannot be cancelled midway; invalidated results are ignored. */
  forgetAsset(assetId: string, type: 'audio' | 'video' = 'audio') {
    this.thumbnailVersions.set(assetId, (this.thumbnailVersions.get(assetId) ?? 0) + 1);
    for (const [key, data] of this.thumbnailWindows) {
      if (!key.startsWith(`${assetId}:`)) continue;
      data.frames.forEach((frame) => URL.revokeObjectURL(frame.url));
      this.thumbnailWindows.delete(key);
    }
    this.thumbnails.delete(assetId);
    for (const key of this.thumbnailErrors) if (key.startsWith(`${assetId}:`)) this.thumbnailErrors.delete(key);
    const key = waveformKey(type, assetId);
    this.waveformVersions.set(key, (this.waveformVersions.get(key) ?? 0) + 1);
    this.waveforms.delete(key);
    this.waveformSummaries.delete(key);
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

  ensureThumbnails(asset: Asset, file: File, range = { startMs: 0, durationMs: asset.durationMs }): Promise<VideoThumbnailData> {
    // Stable 8-second windows at ordinary zoom; coarser power-of-two windows
    // bound long-video requests to at most 33 decoded frames each.
    const span = 8000 * 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, range.durationMs / 8000))));
    const startMs = Math.floor(Math.max(0, range.startMs) / span) * span;
    const endMs = Math.min(asset.durationMs, Math.ceil((range.startMs + range.durationMs) / span) * span);
    const key = `${asset.id}:${startMs}:${endMs}`;
    const cached = this.thumbnailWindows.get(key);
    if (cached) return Promise.resolve(cached);
    if (this.thumbnailErrors.has(key) || this.disposed) return Promise.resolve({ durationMs: asset.durationMs, frames: [] });
    const pending = this.thumbnailTasks.get(key);
    if (pending) return pending;
    const version = this.thumbnailVersions.get(asset.id) ?? 0;
    const task = this.thumbnailQueue.enqueue(() => this.loadThumbnails(asset, file, startMs, endMs)).then((data) => {
      if (this.disposed || version !== (this.thumbnailVersions.get(asset.id) ?? 0)) {
        data.frames.forEach((frame) => URL.revokeObjectURL(frame.url));
        return { durationMs: asset.durationMs, frames: [] };
      }
      this.thumbnailWindows.set(key, data);
      // Eight windows per source; repeated clips share URLs, crop never duplicates them.
      const keys = [...this.thumbnailWindows.keys()].filter((item) => item.startsWith(`${asset.id}:`));
      for (const expired of keys.slice(0, Math.max(0, keys.length - 8))) {
        this.thumbnailWindows.get(expired)?.frames.forEach((frame) => URL.revokeObjectURL(frame.url));
        this.thumbnailWindows.delete(expired);
      }
      const frames = [...this.thumbnailWindows.entries()].filter(([item]) => item.startsWith(`${asset.id}:`)).flatMap(([, window]) => window.frames);
      this.thumbnails.set(asset.id, { durationMs: asset.durationMs, frames });
      for (const listener of this.listeners) listener(asset);
      return data;
    }).catch((error: unknown) => { this.thumbnailErrors.add(key); throw error; }).finally(() => this.thumbnailTasks.delete(key));
    this.thumbnailTasks.set(key, task);
    return task;
  }

  dispose() {
    this.disposed = true;
    this.waveformQueue.dispose();
    this.thumbnailQueue.dispose();
    for (const data of this.thumbnails.values()) for (const frame of data.frames) URL.revokeObjectURL(frame.url);
    this.waveforms.clear();
    this.waveformSummaries.clear();
    this.waveformErrors.clear();
    this.waveformStatus.clear();
    this.analysisAssets.clear();
    this.thumbnails.clear();
    this.thumbnailWindows.clear();
    this.thumbnailErrors.clear();
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
      const envelope = await buildWaveformEnvelopeAsync(pcm, waveformBucketCount(asset.durationMs));
      timings.peakBuildMs = performance.now() - peakStartedAt;
      this.log(asset, 'peak-built', `峰值降采样完成（${timings.peakBuildMs.toFixed(1)} ms）`, timings);
      const cacheStartedAt = performance.now();
      const data: WaveformData = { durationMs: asset.durationMs, ...envelope };
      const summary = summariseWaveform(data);
      if (this.isCurrent(key, version)) {
        this.waveforms.set(key, data);
        this.waveformSummaries.set(key, summary);
      }
      this.log(asset, 'envelope-summary', `缓存 ${key} v${version}：${summary.bucketCount} 桶，非零 ${summary.nonZeroPeakBuckets}`, timings, { cacheKey: key, cacheVersion: version, durationMs: data.durationMs, ...summary });
      timings.cacheWriteMs = performance.now() - cacheStartedAt;
      timings.totalMs = performance.now() - queuedAt;
      if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'ready', attempt, timings }, `分析完成，共 ${envelope.peaks.length} 个峰值/RMS 桶`);
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
      const accumulator = new StreamingWaveformPeakAccumulator(audioTrack.meta.duration, audioTrack.meta.audioSampleRate, waveformBucketCount(asset.durationMs));
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
      const envelope = accumulator.finishEnvelope();
      timings.peakBuildMs = performance.now() - peakStartedAt;
      const cacheStartedAt = performance.now();
      const data: WaveformData = { durationMs: asset.durationMs, ...envelope };
      const summary = summariseWaveform(data);
      if (this.isCurrent(key, version)) {
        this.waveforms.set(key, data);
        this.waveformSummaries.set(key, summary);
      }
      this.log(asset, 'envelope-summary', `缓存 ${key} v${version}：${summary.bucketCount} 桶，非零 ${summary.nonZeroPeakBuckets}`, timings, { cacheKey: key, cacheVersion: version, durationMs: data.durationMs, ...summary });
      timings.cacheWriteMs = performance.now() - cacheStartedAt;
      timings.totalMs = performance.now() - queuedAt;
      if (this.isCurrent(key, version)) this.setWaveformStatus(asset, { phase: 'ready', attempt, timings }, `视频原声波形完成，共 ${envelope.peaks.length} 个峰值/RMS 桶`);
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

  private async loadThumbnails(asset: Asset, file: File, startMs: number, endMs: number): Promise<VideoThumbnailData> {
    await nextIdlePeriod();
    const clip = new MP4Clip(file.stream());
    try {
      const meta = await clip.ready;
      const start = msToUs(startMs);
      const end = Math.min(meta.duration - 1, msToUs(endMs));
      const stepUs = Math.max(msToUs(500), Math.ceil((end - start) / 32));
      const rendered = await clip.thumbnails(160, { start, end, step: stepUs });
      const data: VideoThumbnailData = { durationMs: asset.durationMs, frames: rendered.map(({ ts, img }) => ({ timeMs: usToMs(ts), url: URL.createObjectURL(img) })) };
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

  private log(asset: Asset, phase: string, message: string, timings?: WaveformTiming, details?: Record<string, string | number>) {
    const entry: WaveformDiagnosticEntry = {
      at: performance.now(), assetId: asset.id, assetName: asset.name, assetType: asset.type, durationMs: asset.durationMs,
      attempt: this.waveformStatus.get(waveformKey(asset.type, asset.id))?.attempt ?? 0,
      phase, message, timings: timings && { ...timings }, details,
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
    else tasks.push(cache.ensureVideoWaveform(asset, file));
  }
  return tasks;
}
