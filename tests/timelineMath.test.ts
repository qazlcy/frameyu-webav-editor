import { describe, expect, it } from 'vitest';
import { moveClip, msToUs, snapMs, timeToTimelineX, timelineContentWidth, timelineXToTime, trimLeft, trimRight, usToMs, viewportXToTime } from '../src/editor/timelineMath';
import type { TimelineClip } from '../src/editor/types';

const clip: TimelineClip = {
  id: 'audio-1', trackId: 'music', type: 'audio', assetId: 'asset-1', name: 'music.mp3',
  startMs: 1000, sourceStartMs: 500, durationMs: 3000, volume: 1,
};

describe('timeline math', () => {
  it('converts the WebAV microsecond boundary explicitly', () => {
    expect(msToUs(1234)).toBe(1_234_000);
    expect(usToMs(1_234_000)).toBe(1234);
  });
  it('snaps timeline operations to 100 ms', () => expect(snapMs(1049)).toBe(1000));
  it('uses the track header as the single zero-time origin', () => {
    expect(timeToTimelineX(0, 100)).toBe(110);
    expect(timeToTimelineX(1000, 100)).toBe(210);
    expect(timelineXToTime(110, 100)).toBe(0);
  });
  it('accounts for horizontal scrolling once when mapping a pointer to time', () => {
    expect(viewportXToTime(210, 200, 300, 100)).toBe(2000);
  });
  it('keeps the scroll-content width aligned with the same coordinate system', () => {
    expect(timelineContentWidth(15_000, 100)).toBe(1658);
  });
  it('does not move a clip beyond the project boundary', () => {
    expect(moveClip(clip, 9000, 10000).startMs).toBe(7000);
  });
  it('limits right trim to both source and project duration', () => {
    expect(trimRight(clip, 10000, 5000, 6000).durationMs).toBe(4500);
  });
  it('left trim advances timeline and source positions together', () => {
    expect(trimLeft(clip, 1600, 10000, 10000)).toMatchObject({ startMs: 1600, sourceStartMs: 1100, durationMs: 2400 });
  });
});
