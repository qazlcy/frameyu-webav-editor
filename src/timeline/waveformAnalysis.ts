export type WaveformAnalysisPhase = 'unscheduled' | 'queued' | 'decoding' | 'sampling' | 'ready' | 'failed' | 'no-audio';

export interface WaveformTiming {
  importToTaskMs?: number;
  queueWaitMs?: number;
  clipCreateMs?: number;
  readyMs?: number;
  trackSplitMs?: number;
  audioTickMs?: number;
  pcmReadMs?: number;
  peakBuildMs?: number;
  cacheWriteMs?: number;
  uiUpdateMs?: number;
  totalMs?: number;
}

export interface WaveformAnalysisStatus {
  phase: WaveformAnalysisPhase;
  attempt: number;
  message?: string;
  error?: string;
  timings: WaveformTiming;
}

export interface WaveformDiagnosticEntry {
  at: number;
  assetId: string;
  assetName: string;
  assetType: 'audio' | 'video';
  durationMs: number;
  attempt: number;
  phase: string;
  message: string;
  timings?: WaveformTiming;
}

/** One complete PCM decode at a time keeps memory and CPU spikes bounded. */
export class AnalysisTaskQueue {
  private pending: Array<{ run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }> = [];
  private running = false;
  private disposed = false;

  get pendingCount() { return this.pending.length; }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('分析队列已释放。'));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ run, resolve: resolve as (value: unknown) => void, reject });
      void this.drain();
    });
  }

  dispose() {
    this.disposed = true;
    const error = new Error('分析任务已过期。');
    for (const task of this.pending.splice(0)) task.reject(error);
  }

  private async drain() {
    if (this.running || this.disposed) return;
    const task = this.pending.shift();
    if (!task) return;
    this.running = true;
    try { task.resolve(await task.run()); }
    catch (error) { task.reject(error); }
    finally {
      this.running = false;
      void this.drain();
    }
  }
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface WaveformEnvelope {
  peaks: number[];
  rms: number[];
  sampleCounts: number[];
}

/**
 * Scans PCM once to preserve both transient peak and sustained RMS energy. Channels are never
 * summed, so opposite-phase stereo samples cannot cancel each other out.
 */
export async function buildWaveformEnvelopeAsync(channels: Float32Array[], bucketCount: number, yieldEveryFrames = 16_384): Promise<WaveformEnvelope> {
  const frameCount = Math.max(0, ...channels.map((channel) => channel.length));
  if (!frameCount || !channels.length) return { peaks: [], rms: [], sampleCounts: [] };
  const buckets = Math.max(1, Math.min(bucketCount, frameCount));
  const peaks = Array.from({ length: buckets }, () => 0);
  const sumSquares = Array.from({ length: buckets }, () => 0);
  const sampleCounts = Array.from({ length: buckets }, () => 0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const bucket = Math.min(buckets - 1, Math.floor(frame / frameCount * buckets));
    for (const channel of channels) {
      if (frame >= channel.length) continue;
      const sample = channel[frame] ?? 0;
      peaks[bucket] = Math.max(peaks[bucket] ?? 0, Math.abs(sample));
      sumSquares[bucket] = (sumSquares[bucket] ?? 0) + sample * sample;
      sampleCounts[bucket] = (sampleCounts[bucket] ?? 0) + 1;
    }
    if ((frame + 1) % yieldEveryFrames === 0 && frame + 1 < frameCount) await yieldToBrowser();
  }
  return { peaks, rms: sumSquares.map((sum, index) => Math.sqrt(sum / Math.max(1, sampleCounts[index] ?? 1))), sampleCounts };
}

/**
 * Identical peak values to the synchronous helper, but returns to the browser after a
 * bounded batch. It does not clone PCM and therefore does not increase decoded-audio RAM.
 */
export async function buildWaveformPeaksAsync(channels: Float32Array[], bucketCount = 1200, yieldEvery = 96): Promise<number[]> {
  const frameCount = Math.max(0, ...channels.map((channel) => channel.length));
  if (!frameCount || !channels.length) return [];
  const buckets = Math.max(1, Math.min(bucketCount, frameCount));
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    peaks.push(peakForBucket(channels, frameCount, buckets, bucket));
    if ((bucket + 1) % yieldEvery === 0 && bucket + 1 < buckets) await yieldToBrowser();
  }
  return peaks;
}

export function peakForBucket(channels: Float32Array[], frameCount: number, buckets: number, bucket: number) {
  const start = Math.floor(bucket * frameCount / buckets);
  const end = Math.max(start + 1, Math.floor((bucket + 1) * frameCount / buckets));
  let peak = 0;
  for (const channel of channels) {
    for (let index = start; index < Math.min(end, channel.length); index += 1) peak = Math.max(peak, Math.abs(channel[index] ?? 0));
  }
  return Math.min(1, peak);
}

/**
 * Builds the same compact peak envelope without retaining a complete video audio track.
 * MP4Clip exposes original audio as consecutive tick() PCM chunks rather than AudioClip's
 * full getPCMData() buffer, so binning happens as each chunk arrives.
 */
export class StreamingWaveformPeakAccumulator {
  private readonly peaks: number[];
  private readonly sumSquares: number[];
  private readonly sampleCounts: number[];
  private processedFrames = 0;

  constructor(durationUs: number, sampleRate: number, bucketCount = 1200) {
    const totalFrames = Math.max(1, Math.ceil(durationUs / 1_000_000 * sampleRate));
    this.totalFrames = totalFrames;
    this.bucketCount = Math.max(1, Math.min(bucketCount, totalFrames));
    this.peaks = Array.from({ length: this.bucketCount }, () => 0);
    this.sumSquares = Array.from({ length: this.bucketCount }, () => 0);
    this.sampleCounts = Array.from({ length: this.bucketCount }, () => 0);
  }

  private readonly totalFrames: number;
  private readonly bucketCount: number;

  push(channels: Float32Array[]) {
    const frameCount = Math.max(0, ...channels.map((channel) => channel.length));
    for (let frame = 0; frame < frameCount; frame += 1) {
      const bucket = Math.min(this.bucketCount - 1, Math.floor((this.processedFrames + frame) / this.totalFrames * this.bucketCount));
      let peak = this.peaks[bucket] ?? 0;
      for (const channel of channels) {
        if (frame >= channel.length) continue;
        const sample = channel[frame] ?? 0;
        peak = Math.max(peak, Math.abs(sample));
        this.sumSquares[bucket] = (this.sumSquares[bucket] ?? 0) + sample * sample;
        this.sampleCounts[bucket] = (this.sampleCounts[bucket] ?? 0) + 1;
      }
      this.peaks[bucket] = Math.min(1, peak);
    }
    this.processedFrames += frameCount;
  }

  finish() { return [...this.peaks]; }
  finishEnvelope(): WaveformEnvelope {
    return {
      peaks: [...this.peaks],
      rms: this.sumSquares.map((sum, index) => Math.sqrt(sum / Math.max(1, this.sampleCounts[index] ?? 1))),
      sampleCounts: [...this.sampleCounts],
    };
  }
}
