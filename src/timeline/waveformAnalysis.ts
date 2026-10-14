export type WaveformAnalysisPhase = 'queued' | 'decoding' | 'sampling' | 'ready' | 'failed';

export interface WaveformTiming {
  importToTaskMs?: number;
  queueWaitMs?: number;
  clipCreateMs?: number;
  readyMs?: number;
  pcmReadMs?: number;
  peakBuildMs?: number;
  cacheWriteMs?: number;
  uiUpdateMs?: number;
  totalMs?: number;
}

export interface WaveformAnalysisStatus {
  phase: WaveformAnalysisPhase;
  attempt: number;
  error?: string;
  timings: WaveformTiming;
}

export interface WaveformDiagnosticEntry {
  at: number;
  assetId: string;
  assetName: string;
  assetType: 'audio';
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
