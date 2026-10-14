import { AudioClip, MP4Clip } from '@webav/av-cliper';
import { getClipSourceDurationMs, msToUs, usToMs } from '../editor/timelineMath';
import type { Asset, TimelineClip } from '../editor/types';

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
  if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 250 });
  else setTimeout(resolve, 0);
});

/** Reduces decoded multi-channel PCM to a compact, reusable peak envelope. */
export function buildWaveformPeaks(channels: Float32Array[], bucketCount = 1200): number[] {
  const frameCount = Math.max(0, ...channels.map((channel) => channel.length));
  if (!frameCount || !channels.length) return [];
  const buckets = Math.max(1, Math.min(bucketCount, frameCount));
  return Array.from({ length: buckets }, (_, bucket) => {
    const start = Math.floor(bucket * frameCount / buckets);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * frameCount / buckets));
    let peak = 0;
    for (const channel of channels) for (let index = start; index < Math.min(end, channel.length); index += 1) peak = Math.max(peak, Math.abs(channel[index] ?? 0));
    return Math.min(1, peak);
  });
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
  private disposed = false;

  getWaveform(assetId: string | undefined) { return assetId ? this.waveforms.get(assetId) : undefined; }
  getThumbnails(assetId: string | undefined) { return assetId ? this.thumbnails.get(assetId) : undefined; }

  ensureWaveform(asset: Asset, file: File): Promise<WaveformData> {
    const cached = this.waveforms.get(asset.id);
    if (cached) return Promise.resolve(cached);
    const pending = this.waveformTasks.get(asset.id);
    if (pending) return pending;
    const task = this.loadWaveform(asset, file).finally(() => this.waveformTasks.delete(asset.id));
    this.waveformTasks.set(asset.id, task);
    return task;
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
    for (const data of this.thumbnails.values()) for (const frame of data.frames) URL.revokeObjectURL(frame.url);
    this.waveforms.clear();
    this.thumbnails.clear();
  }

  private async loadWaveform(asset: Asset, file: File): Promise<WaveformData> {
    await nextIdlePeriod();
    const clip = new AudioClip(file.stream());
    try {
      await clip.ready;
      const data: WaveformData = { durationMs: asset.durationMs, peaks: buildWaveformPeaks(clip.getPCMData()) };
      if (!this.disposed) this.waveforms.set(asset.id, data);
      return data;
    } finally {
      clip.destroy();
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
}
