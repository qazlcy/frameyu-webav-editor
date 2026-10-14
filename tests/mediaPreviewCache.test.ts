import { describe, expect, it, vi } from 'vitest';

const waveformMock = vi.hoisted(() => ({ calls: 0, fail: false, pcm: [new Float32Array([0, 0.25, -0.5, 1])] }));

vi.mock('@webav/av-cliper', () => ({
  AudioClip: class {
    ready: Promise<{ duration: number }>;
    constructor() {
      waveformMock.calls += 1;
      this.ready = waveformMock.fail ? Promise.reject(new Error('mock decode failed')) : Promise.resolve({ duration: 1_000_000 });
    }
    getPCMData() { return waveformMock.pcm; }
    destroy() { /* no browser decoder to release in the test double */ }
  },
  MP4Clip: class {},
}));

import { buildWaveformPeaks, sampleThumbnailsForClip, sampleWaveformRange, type VideoThumbnailData } from '../src/timeline/mediaPreviewCache';
import { TimelineMediaPreviewCache } from '../src/timeline/mediaPreviewCache';
import type { TimelineClip } from '../src/editor/types';
import type { Asset } from '../src/editor/types';
import { AnalysisTaskQueue, buildWaveformPeaksAsync } from '../src/timeline/waveformAnalysis';

const clip = (sourceStartMs: number, durationMs: number): TimelineClip => ({
  id: 'clip', trackId: 'music', type: 'audio', assetId: 'asset', name: 'asset', startMs: 0, sourceStartMs, durationMs, volume: 1,
});

describe('timeline media preview calculations', () => {
  it('reduces multi-channel PCM into bounded peak values', () => {
    const peaks = buildWaveformPeaks([new Float32Array([0, -0.2, 0.7, -1]), new Float32Array([0.1, 0.4, -0.3, 0.2])], 2);
    expect(peaks[0]).toBeCloseTo(0.4);
    expect(peaks[1]).toBe(1);
  });

  it('keeps yielding peak analysis numerically identical to the compact cached envelope', async () => {
    const pcm = [new Float32Array([0, -0.2, 0.7, -1, 0.1, 0.3]), new Float32Array([0.1, 0.4, -0.3, 0.2, -0.8, 0])];
    await expect(buildWaveformPeaksAsync(pcm, 3, 1)).resolves.toEqual(buildWaveformPeaks(pcm, 3));
  });

  it('serialises complete analysis jobs so a second decode starts only after the first settles', async () => {
    const queue = new AnalysisTaskQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queue.enqueue(async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push('first-end');
      return 'first';
    });
    const second = queue.enqueue(async () => { events.push('second-start'); return 'second'; });
    expect(events).toEqual(['first-start']);
    releaseFirst?.();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('continues queue processing after a failed analysis task so retry jobs are not blocked', async () => {
    const queue = new AnalysisTaskQueue();
    const failed = queue.enqueue(async () => { throw new Error('decode failed'); });
    const recovered = queue.enqueue(async () => 'recovered');
    await expect(failed).rejects.toThrow('decode failed');
    await expect(recovered).resolves.toBe('recovered');
  });

  it('deduplicates a queued Asset analysis, caches it, then permits an explicit retry after failure', async () => {
    const cache = new TimelineMediaPreviewCache();
    const asset: Asset = { id: 'audio-a', name: 'clip.mp3', type: 'audio', audioKind: 'music', mimeType: 'audio/mpeg', durationMs: 1000 };
    const file = new File(['audio'], 'clip.mp3', { type: 'audio/mpeg' });
    waveformMock.calls = 0;
    waveformMock.fail = false;
    cache.noteAudioImported(asset, performance.now());
    const first = cache.ensureWaveform(asset, file);
    const duplicate = cache.ensureWaveform(asset, file);
    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({ peaks: [0, 0.25, 0.5, 1] });
    expect(waveformMock.calls).toBe(1);
    expect(cache.getWaveformStatus(asset.id)?.phase).toBe('ready');

    const failingAsset = { ...asset, id: 'audio-b' };
    waveformMock.fail = true;
    cache.noteAudioImported(failingAsset, performance.now());
    await expect(cache.ensureWaveform(failingAsset, file)).rejects.toThrow('mock decode failed');
    expect(cache.getWaveformStatus(failingAsset.id)?.phase).toBe('failed');
    expect(cache.getWaveformError(failingAsset.id)).toContain('mock decode failed');

    waveformMock.fail = false;
    await expect(cache.retryWaveform(failingAsset, file)).resolves.toMatchObject({ peaks: [0, 0.25, 0.5, 1] });
    expect(cache.getWaveformStatus(failingAsset.id)?.phase).toBe('ready');
    cache.dispose();
  });

  it('samples only the source range selected after audio trimming', () => {
    const data = { durationMs: 1000, peaks: [0.1, 0.2, 0.3, 0.4, 0.5] };
    expect(sampleWaveformRange(data, 400, 400, 2)).toEqual([0.3, 0.4]);
    expect(sampleWaveformRange(data, 0, 400, 2)).toEqual([0.1, 0.2]);
  });

  it('uses cached source thumbnails nearest to a trimmed video interval', () => {
    const data: VideoThumbnailData = { durationMs: 6000, frames: [0, 2000, 4000, 6000].map((timeMs) => ({ timeMs, url: String(timeMs) })) };
    const frames = sampleThumbnailsForClip(data, { ...clip(1800, 2200), type: 'video', trackId: 'video' }, 2);
    expect(frames.map((frame) => frame.timeMs)).toEqual([2000, 4000]);
  });

  it('uses the speed-adjusted source window for a future non-1× clip', () => {
    const data: VideoThumbnailData = { durationMs: 10_000, frames: [0, 2000, 4000, 6000, 8000].map((timeMs) => ({ timeMs, url: String(timeMs) })) };
    const frames = sampleThumbnailsForClip(data, { ...clip(2000, 2000), type: 'video', trackId: 'video', playbackRate: 2 }, 2);
    expect(frames.map((frame) => frame.timeMs)).toEqual([2000, 4000]);
  });

  it('prefers an explicit source duration after a rate-aware split or trim', () => {
    const data: VideoThumbnailData = { durationMs: 10_000, frames: [0, 2000, 4000, 6000, 8000].map((timeMs) => ({ timeMs, url: String(timeMs) })) };
    const frames = sampleThumbnailsForClip(data, { ...clip(4000, 3000), type: 'video', trackId: 'video', playbackRate: 2, sourceDurationMs: 6000 }, 2);
    expect(frames.map((frame) => frame.timeMs)).toEqual([6000, 8000]);
  });
});
