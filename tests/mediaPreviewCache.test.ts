import { describe, expect, it } from 'vitest';
import { buildWaveformPeaks, sampleThumbnailsForClip, sampleWaveformRange, type VideoThumbnailData } from '../src/timeline/mediaPreviewCache';
import type { TimelineClip } from '../src/editor/types';

const clip = (sourceStartMs: number, durationMs: number): TimelineClip => ({
  id: 'clip', trackId: 'music', type: 'audio', assetId: 'asset', name: 'asset', startMs: 0, sourceStartMs, durationMs, volume: 1,
});

describe('timeline media preview calculations', () => {
  it('reduces multi-channel PCM into bounded peak values', () => {
    const peaks = buildWaveformPeaks([new Float32Array([0, -0.2, 0.7, -1]), new Float32Array([0.1, 0.4, -0.3, 0.2])], 2);
    expect(peaks[0]).toBeCloseTo(0.4);
    expect(peaks[1]).toBe(1);
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
});
