import type { TimelineClip } from './types';

export const SNAP_MS = 100;
export const MIN_DURATION_MS = 100;
export const TRACK_HEADER_WIDTH_PX = 110;
export const msToUs = (ms: number) => Math.round(ms * 1000);
export const usToMs = (us: number) => Math.round(us / 1000);
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
  const durationMs = clamp(snapMs(requestedDurationMs), MIN_DURATION_MS, Math.min(sourceRemaining, projectRemaining));
  return { ...clip, durationMs };
}

export function trimLeft(clip: TimelineClip, requestedStartMs: number, assetDurationMs: number, projectDurationMs: number): TimelineClip {
  const startMs = clamp(snapMs(requestedStartMs), 0, clip.startMs + clip.durationMs - MIN_DURATION_MS);
  const consumed = startMs - clip.startMs;
  const durationMs = clip.durationMs - consumed;
  const sourceStartMs = clamp(clip.sourceStartMs + consumed, 0, assetDurationMs - MIN_DURATION_MS);
  return trimRight({ ...clip, startMs, sourceStartMs, durationMs }, durationMs, assetDurationMs, projectDurationMs);
}
