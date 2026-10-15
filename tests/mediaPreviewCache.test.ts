import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const waveformMock = vi.hoisted(() => ({
  calls: 0, fail: false, pcm: [new Float32Array([0, 0.25, -0.5, 1])],
  videoCalls: 0, videoSplitCalls: 0, videoTickCalls: 0, videoDestroyCalls: 0, videoHasAudio: true, videoFail: false,
  videoDurationUs: 200_000, videoSampleRate: 10, videoChunks: [[new Float32Array([0.1])], [new Float32Array([0.9])]] as Float32Array[][],
}));

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
  MP4Clip: class MockMP4Clip {
    private readonly audioOnly: boolean;
    private tickIndex = 0;
    constructor(_source?: unknown, audioOnly = false) {
      this.audioOnly = audioOnly;
      waveformMock.videoCalls += 1;
    }
    get meta() {
      return {
        duration: waveformMock.videoDurationUs, width: this.audioOnly ? 0 : 640, height: this.audioOnly ? 0 : 360,
        audioSampleRate: waveformMock.videoHasAudio ? waveformMock.videoSampleRate : 0,
        audioChanCount: waveformMock.videoHasAudio ? 2 : 0,
      };
    }
    get ready() { return Promise.resolve(this.meta); }
    async splitTrack() {
      waveformMock.videoSplitCalls += 1;
      return waveformMock.videoHasAudio ? [new MockMP4Clip(undefined, true)] : [];
    }
    async tick() {
      waveformMock.videoTickCalls += 1;
      if (waveformMock.videoFail) throw new Error('mock video audio decode failed');
      return { audio: waveformMock.videoChunks[this.tickIndex++] ?? [new Float32Array()], state: 'success' as const };
    }
    destroy() { waveformMock.videoDestroyCalls += 1; }
  },
}));

import { buildWaveformPeaks, sampleThumbnailsForClip, sampleWaveformEnvelope, sampleWaveformRange, scheduleMediaPreviewAnalysis, waveformBucketCount, waveformVisualAmplitude, type VideoThumbnailData } from '../src/timeline/mediaPreviewCache';
import { TimelineMediaPreviewCache } from '../src/timeline/mediaPreviewCache';
import type { TimelineClip } from '../src/editor/types';
import type { Asset } from '../src/editor/types';
import { AnalysisTaskQueue, buildWaveformEnvelopeAsync, buildWaveformPeaksAsync, StreamingWaveformPeakAccumulator } from '../src/timeline/waveformAnalysis';

const clip = (sourceStartMs: number, durationMs: number): TimelineClip => ({
  id: 'clip', trackId: 'music', type: 'audio', assetId: 'asset', name: 'asset', startMs: 0, sourceStartMs, durationMs, volume: 1,
});

describe('timeline media preview calculations', () => {
  beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reduces multi-channel PCM into bounded peak values', () => {
    const peaks = buildWaveformPeaks([new Float32Array([0, -0.2, 0.7, -1]), new Float32Array([0.1, 0.4, -0.3, 0.2])], 2);
    expect(peaks[0]).toBeCloseTo(0.4);
    expect(peaks[1]).toBe(1);
  });

  it('keeps yielding peak analysis numerically identical to the compact cached envelope', async () => {
    const pcm = [new Float32Array([0, -0.2, 0.7, -1, 0.1, 0.3]), new Float32Array([0.1, 0.4, -0.3, 0.2, -0.8, 0])];
    await expect(buildWaveformPeaksAsync(pcm, 3, 1)).resolves.toEqual(buildWaveformPeaks(pcm, 3));
  });

  it('builds high-resolution peak and RMS envelopes without stereo phase cancellation', async () => {
    const envelope = await buildWaveformEnvelopeAsync([new Float32Array([0.5, -0.25]), new Float32Array([-0.5, 0.25])], 2, 1);
    expect(envelope.peaks).toEqual([0.5, 0.25]);
    expect(envelope.rms).toEqual([0.5, 0.25]);
    expect(envelope.sampleCounts).toEqual([2, 2]);
    expect(waveformBucketCount(13_000)).toBe(2048);
    expect(waveformBucketCount(180_000)).toBe(8192);
  });

  it('aggregates only the selected source window and keeps visual silence at zero', () => {
    const data = { durationMs: 4000, peaks: [0, 0.1, 0.6, 1], rms: [0, 0.05, 0.3, 0.7], sampleCounts: [10, 10, 10, 10] };
    expect(sampleWaveformEnvelope(data, 1000, 2000, 2)).toEqual([{ peak: 0.1, rms: 0.05, sampleCount: 10 }, { peak: 0.6, rms: 0.3, sampleCount: 10 }]);
    expect(waveformVisualAmplitude(0, 0)).toBe(0);
    expect(waveformVisualAmplitude(0.6, 0.3)).toBeGreaterThan(waveformVisualAmplitude(0.1, 0.05));
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

  it('keeps an Asset explicitly unscheduled until its runtime File arrives, then creates one visible analysis task', async () => {
    const cache = new TimelineMediaPreviewCache();
    const asset: Asset = { id: 'late-file', name: 'late.mp3', type: 'audio', audioKind: 'music', mimeType: 'audio/mpeg', durationMs: 1000 };
    const files = new Map<string, File>();
    cache.noteAudioImported(asset, performance.now());
    expect(cache.getWaveformStatus(asset.id)?.phase).toBe('unscheduled');
    expect(scheduleMediaPreviewAnalysis(cache, [asset], (assetId) => files.get(assetId))).toHaveLength(0);
    expect(cache.getWaveformStatus(asset.id)?.message).toContain('本地文件引用');
    expect(cache.getWaveformDiagnostics().some((entry) => entry.phase === 'unscheduled')).toBe(true);

    waveformMock.calls = 0;
    waveformMock.fail = false;
    files.set(asset.id, new File(['audio'], 'late.mp3', { type: 'audio/mpeg' }));
    const tasks = scheduleMediaPreviewAnalysis(cache, [asset], (assetId) => files.get(assetId));
    expect(tasks).toHaveLength(1);
    await expect(tasks[0]).resolves.toMatchObject({ peaks: [0, 0.25, 0.5, 1] });
    expect(waveformMock.calls).toBe(1);
    expect(cache.getWaveformDiagnostics().some((entry) => entry.phase === 'analysis-requested')).toBe(true);
    expect(cache.getWaveformStatus(asset.id)?.phase).toBe('ready');
    cache.dispose();
  });

  it('streams an MP4 audio-only tick track into cached video peaks without decoding video frames', async () => {
    const cache = new TimelineMediaPreviewCache();
    const asset: Asset = { id: 'video-a', name: 'spoken.mp4', type: 'video', mimeType: 'video/mp4', durationMs: 200 };
    const file = new File(['video'], 'spoken.mp4', { type: 'video/mp4' });
    Object.assign(waveformMock, { videoCalls: 0, videoSplitCalls: 0, videoTickCalls: 0, videoDestroyCalls: 0, videoHasAudio: true, videoFail: false, videoDurationUs: 200_000, videoSampleRate: 10, videoChunks: [[new Float32Array([0.1])], [new Float32Array([0.9])]] });
    cache.noteWaveformAssetImported(asset, performance.now());
    const first = cache.ensureVideoWaveform(asset, file);
    const duplicate = cache.ensureVideoWaveform(asset, file);
    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({ peaks: [expect.closeTo(0.1), expect.closeTo(0.9)] });
    expect(waveformMock.videoSplitCalls).toBe(1);
    expect(waveformMock.videoTickCalls).toBe(2);
    expect(waveformMock.videoDestroyCalls).toBeGreaterThanOrEqual(2);
    expect(cache.getWaveformStatus(asset.id, 'video')?.phase).toBe('ready');
    cache.dispose();
  });

  it('marks no-audio video without fabricating a waveform and keeps silent audio near zero', async () => {
    const cache = new TimelineMediaPreviewCache();
    const file = new File(['video'], 'silent.mp4', { type: 'video/mp4' });
    const withoutAudio: Asset = { id: 'video-no-audio', name: 'mute-track.mp4', type: 'video', mimeType: 'video/mp4', durationMs: 200 };
    Object.assign(waveformMock, { videoHasAudio: false, videoSplitCalls: 0 });
    cache.noteWaveformAssetImported(withoutAudio, performance.now());
    await expect(cache.ensureVideoWaveform(withoutAudio, file)).resolves.toBeUndefined();
    expect(cache.getWaveformStatus(withoutAudio.id, 'video')?.phase).toBe('no-audio');
    expect(cache.getVideoWaveform(withoutAudio.id)).toBeUndefined();
    expect(waveformMock.videoSplitCalls).toBe(0);

    const silentAudio: Asset = { ...withoutAudio, id: 'video-silent', name: 'silent-audio.mp4' };
    Object.assign(waveformMock, { videoHasAudio: true, videoFail: false, videoDurationUs: 200_000, videoSampleRate: 10, videoChunks: [[new Float32Array([0])], [new Float32Array([0])]] });
    cache.noteWaveformAssetImported(silentAudio, performance.now());
    await expect(cache.ensureVideoWaveform(silentAudio, file)).resolves.toMatchObject({ peaks: [0, 0] });
    cache.dispose();
  });

  it('retries failed video audio analysis without affecting its cached source-window mapping', async () => {
    const cache = new TimelineMediaPreviewCache();
    const asset: Asset = { id: 'video-retry', name: 'retry.mp4', type: 'video', mimeType: 'video/mp4', durationMs: 200 };
    const file = new File(['video'], 'retry.mp4', { type: 'video/mp4' });
    Object.assign(waveformMock, { videoHasAudio: true, videoFail: true, videoDurationUs: 200_000, videoSampleRate: 10, videoChunks: [[new Float32Array([0.2])], [new Float32Array([0.8])]] });
    cache.noteWaveformAssetImported(asset, performance.now());
    await expect(cache.ensureVideoWaveform(asset, file)).rejects.toThrow('mock video audio decode failed');
    expect(cache.getWaveformStatus(asset.id, 'video')?.phase).toBe('failed');
    waveformMock.videoFail = false;
    await expect(cache.retryVideoWaveform(asset, file)).resolves.toMatchObject({ peaks: [expect.closeTo(0.2), expect.closeTo(0.8)] });
    expect(cache.getWaveformStatus(asset.id, 'video')?.phase).toBe('ready');
    cache.dispose();
  });

  it('accumulates continuous PCM chunks without retaining a full decoded audio buffer', () => {
    const accumulator = new StreamingWaveformPeakAccumulator(400_000, 10, 4);
    accumulator.push([new Float32Array([0.1, 0.2])]);
    accumulator.push([new Float32Array([0.8, 0])]);
    expect(accumulator.finish()).toEqual([expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.8), 0]);
  });

  it('samples only the source range selected after audio trimming', () => {
    const data = { durationMs: 1000, peaks: [0.1, 0.2, 0.3, 0.4, 0.5] };
    expect(sampleWaveformRange(data, 400, 400, 2)).toEqual([0.3, 0.4]);
    expect(sampleWaveformRange(data, 0, 400, 2)).toEqual([0.1, 0.2]);
  });

  it('keeps cached video source peaks correct across split, cross-track move, mute, and speed', () => {
    const data = { durationMs: 8000, peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] };
    // The left half is muted on V1; mute must affect playback only, never the source waveform.
    const left = { ...clip(2000, 2000), type: 'video' as const, trackId: 'video-1', muted: true };
    // The right half was moved to V2 and plays 2×, so 1000 ms of timeline covers 2000 ms of source.
    const right = { ...clip(4000, 1000), type: 'video' as const, trackId: 'video-2', playbackRate: 2, sourceDurationMs: 2000 };
    expect(sampleWaveformRange(data, left.sourceStartMs, left.durationMs, 2)).toEqual([0.3, 0.4]);
    expect(sampleWaveformRange(data, right.sourceStartMs, right.sourceDurationMs ?? right.durationMs, 2)).toEqual([0.5, 0.6]);
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
