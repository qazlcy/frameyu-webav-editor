import type { TimelineClip } from './types';

export const SNAP_MS = 100;
export const MIN_DURATION_MS = 100;
export const TRACK_HEADER_WIDTH_PX = 110;
export const msToUs = (ms: number) => Math.round(ms * 1000);
export const usToMs = (us: number) => Math.round(us / 1000);
export const getClipPlaybackRate = (clip: TimelineClip) => clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
export const sourceDurationForTimelineDuration = (durationMs: number, playbackRate: number) => Math.round(durationMs * playbackRate);
export const timelineDurationForSourceDuration = (sourceDurationMs: number, playbackRate: number) => Math.round(sourceDurationMs / playbackRate);
/** Supports legacy projects that stored only project duration while treating source duration as derived. */
export const getClipSourceDurationMs = (clip: TimelineClip) => clip.sourceDurationMs ?? sourceDurationForTimelineDuration(clip.durationMs, getClipPlaybackRate(clip));
export const sourceOffsetForTimelineOffset = (clip: TimelineClip, timelineOffsetMs: number) => sourceDurationForTimelineDuration(timelineOffsetMs, getClipPlaybackRate(clip));
export const snapMs = (ms: number) => Math.round(ms / SNAP_MS) * SNAP_MS;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Converts a project time to an x coordinate in the full scrollable timeline content. */
export const timeToTimelineX = (timeMs: number, pixelsPerSecond: number) =>
  TRACK_HEADER_WIDTH_PX + (timeMs / 1000) * pixelsPerSecond;

/** Converts a full scroll-content x coordinate to project time. It may return a negative value before clamping. */
export const timelineXToTime = (timelineX: number, pixelsPerSecond: number) =>
  ((timelineX - TRACK_HEADER_WIDTH_PX) / pixelsPerSecond) * 1000;

/**
 * Converts an x coordinate from the visible scrolling viewport to project time.
 * Scroll offset is accounted for exactly once at the boundary between viewport and content.
 */
export const viewportXToTime = (
  clientX: number,
  viewportLeft: number,
  scrollLeft: number,
  pixelsPerSecond: number,
) => timelineXToTime(clientX - viewportLeft + scrollLeft, pixelsPerSecond);

export const timelineContentWidth = (durationMs: number, pixelsPerSecond: number, minimumWidth = 1000) =>
  Math.max(minimumWidth, timeToTimelineX(durationMs, pixelsPerSecond) + 48);

export function moveClip(clip: TimelineClip, nextStartMs: number, projectDurationMs: number): TimelineClip {
  const startMs = clamp(snapMs(nextStartMs), 0, Math.max(0, projectDurationMs - clip.durationMs));
  return { ...clip, startMs };
}

export function trimRight(clip: TimelineClip, requestedDurationMs: number, assetDurationMs: number, projectDurationMs: number): TimelineClip {
  const sourceRemaining = assetDurationMs - clip.sourceStartMs;
  const projectRemaining = projectDurationMs - clip.startMs;
  const playbackRate = getClipPlaybackRate(clip);
  const durationMs = clamp(snapMs(requestedDurationMs), MIN_DURATION_MS, Math.min(Math.floor(sourceRemaining / playbackRate), projectRemaining));
  return clip.type === 'caption'
    ? { ...clip, durationMs }
    : { ...clip, durationMs, sourceDurationMs: sourceDurationForTimelineDuration(durationMs, playbackRate) };
}

export function trimLeft(clip: TimelineClip, requestedStartMs: number, assetDurationMs: number, projectDurationMs: number): TimelineClip {
  const startMs = clamp(snapMs(requestedStartMs), 0, clip.startMs + clip.durationMs - MIN_DURATION_MS);
  const consumed = startMs - clip.startMs;
  const requestedDurationMs = clip.durationMs - consumed;
  const sourceConsumed = sourceOffsetForTimelineOffset(clip, consumed);
  const sourceStartMs = clamp(clip.sourceStartMs + sourceConsumed, 0, assetDurationMs - MIN_DURATION_MS);
  const sourceDurationMs = Math.max(MIN_DURATION_MS, getClipSourceDurationMs(clip) - sourceConsumed);
  const playbackRate = getClipPlaybackRate(clip);
  const durationMs = Math.min(requestedDurationMs, projectDurationMs - startMs, Math.floor(sourceDurationMs / playbackRate));
  return clip.type === 'caption'
    ? { ...clip, startMs, sourceStartMs, durationMs }
    : { ...clip, startMs, sourceStartMs, sourceDurationMs: sourceDurationForTimelineDuration(durationMs, playbackRate), durationMs };
}
