import { DEFAULT_TRACK_HEIGHT_PX, MAX_TRACK_HEIGHT_PX, MIN_TRACK_HEIGHT_PX, type Asset, type CaptionDraft, type Project, type TimelineClip, type Track, type TrackType, type VideoLayout, type VideoLayoutMode } from './types';
import { MIN_DURATION_MS, clamp, getClipPlaybackRate, getClipSourceDurationMs, moveClip, snapMs, sourceOffsetForTimelineOffset, timelineDurationForSourceDuration, trimLeft, trimRight } from './timelineMath';

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const getAsset = (project: Project, assetId: string) => project.assets.find((asset) => asset.id === assetId);
export const getTrack = (project: Project, trackId: string) => project.tracks.find((track) => track.id === trackId);
export const getVideoClips = (project: Project) => project.clips.filter((clip) => clip.type === 'video');
export const getProjectDuration = (project: Project) => getVideoClips(project).reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
export { getClipPlaybackRate, getClipSourceDurationMs, sourceOffsetForTimelineOffset } from './timelineMath';
export const PLAYBACK_RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function withTrackClipIds(tracks: Track[], clips: TimelineClip[]) {
  return tracks.map((track) => ({ ...track, clipIds: clips.filter((clip) => clip.trackId === track.id).map((clip) => clip.id) }));
}

function normaliseTrackOrders(tracks: Track[]): Track[] {
  return tracks.map((track, order) => ({ ...track, order }));
}

function withTracks(project: Project, tracks: Track[]): Project {
  const normalisedTracks = normaliseTrackOrders(tracks);
  return { ...project, tracks: withTrackClipIds(normalisedTracks, project.clips) };
}

function normaliseToVideoDuration(project: Project, clips: TimelineClip[]): TimelineClip[] {
  const videoDuration = clips.filter((clip) => clip.type === 'video').reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
  // Keep staged audio/captions while the project has no video yet. As soon as a video clip is
  // added, the normal bounds pass below trims non-video clips to the actual project duration.
  if (!videoDuration) return clips;
  return clips.flatMap((clip) => {
    if (clip.type === 'video') return [clip];
    if (clip.startMs >= videoDuration) return [];
    const assetDuration = clip.assetId ? getAsset(project, clip.assetId)?.durationMs : undefined;
    const sourceRemaining = assetDuration === undefined ? Number.POSITIVE_INFINITY : assetDuration - clip.sourceStartMs;
    const durationMs = Math.min(clip.durationMs, videoDuration - clip.startMs, Math.floor(sourceRemaining / getClipPlaybackRate(clip)));
    if (durationMs < MIN_DURATION_MS) return [];
    return clip.type === 'caption'
      ? [{ ...clip, durationMs }]
      : [{ ...clip, durationMs, sourceDurationMs: Math.min(getClipSourceDurationMs(clip), Math.round(durationMs * getClipPlaybackRate(clip))) }];
  });
}

function withClips(project: Project, clips: TimelineClip[]): Project {
  const validClips = normaliseToVideoDuration(project, clips);
  return { ...project, clips: validClips, tracks: withTrackClipIds(project.tracks, validClips) };
}

function videoOverlaps(project: Project, candidate: TimelineClip): boolean {
  return getVideoClips(project).some((clip) => clip.id !== candidate.id && clip.trackId === candidate.trackId && candidate.startMs < clip.startMs + clip.durationMs && clip.startMs < candidate.startMs + candidate.durationMs);
}

export function defaultVideoLayout(project: Project, asset?: Asset, mode: VideoLayoutMode = 'full'): VideoLayout {
  const aspect = asset?.width && asset?.height ? asset.width / asset.height : 16 / 9;
  if (mode === 'pip') {
    const width = Math.round(project.width / 4);
    const height = Math.round(width / aspect);
    return { mode, x: project.width - width - 32, y: 32, width, height, opacity: 1, keepAspectRatio: true };
  }
  const scale = Math.min(project.width / (asset?.width ?? project.width), project.height / (asset?.height ?? project.height));
  const width = Math.round((asset?.width ?? project.width) * scale);
  const height = Math.round((asset?.height ?? project.height) * scale);
  return { mode, x: Math.round((project.width - width) / 2), y: Math.round((project.height - height) / 2), width, height, opacity: 1, keepAspectRatio: true };
}

function videoTrackEnd(project: Project, trackId: string) {
  return getVideoClips(project).filter((clip) => clip.trackId === trackId).reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
}

export function addAsset(project: Project, asset: Asset): Project {
  return { ...project, assets: [...project.assets.filter((item) => item.id !== asset.id), asset] };
}

export function appendVideoClip(project: Project, asset: Asset, trackId = project.tracks.find((track) => track.type === 'video')?.id): Project {
  const videoTrack = trackId ? getTrack(project, trackId) : undefined;
  if (videoTrack?.type !== 'video') return project;
  const clip: TimelineClip = {
    id: id('video'), trackId: videoTrack.id, type: 'video', assetId: asset.id, name: asset.name,
    startMs: videoTrackEnd(project, videoTrack.id), sourceStartMs: 0, sourceDurationMs: asset.durationMs, durationMs: asset.durationMs, playbackRate: 1, volume: 1,
    videoLayout: defaultVideoLayout(project, asset),
  };
  return withClips(project, [...project.clips, clip]);
}

export function addAudioClip(project: Project, asset: Asset, trackId: string): Project {
  const projectDuration = getProjectDuration(project);
  const track = getTrack(project, trackId);
  if (track?.type !== 'music' && track?.type !== 'sfx') return project;
  // Audio can be staged before the first video arrives. It remains a normal editable clip;
  // video duration still exclusively controls preview/export duration once video is present.
  const usedDurationMs = Math.min(asset.durationMs, projectDuration || asset.durationMs);
  if (usedDurationMs <= 0) return project;
  const clip: TimelineClip = {
    id: id('audio'), trackId, type: 'audio', assetId: asset.id, name: asset.name,
    startMs: 0, sourceStartMs: 0, sourceDurationMs: usedDurationMs, durationMs: usedDurationMs, playbackRate: 1, volume: 1,
  };
  return withClips(project, [...project.clips, clip]);
}

export function addCaption(project: Project, trackId = project.tracks.find((track) => track.type === 'caption')?.id, draft?: CaptionDraft): Project {
  const projectDuration = getProjectDuration(project);
  const startMs = clamp(snapMs(draft?.startMs ?? 0), 0, projectDuration);
  const endMs = clamp(snapMs(draft?.endMs ?? Math.min(3000, projectDuration)), startMs + MIN_DURATION_MS, projectDuration);
  const durationMs = endMs - startMs;
  const track = trackId ? getTrack(project, trackId) : undefined;
  if (durationMs < MIN_DURATION_MS || track?.type !== 'caption') return project;
  const clip: TimelineClip = {
    id: id('caption'), trackId: track.id, type: 'caption', name: draft?.text.trim().slice(0, 18) || '新字幕', startMs,
    sourceStartMs: 0, durationMs, playbackRate: 1, volume: 1, text: draft?.text.trim() || '在这里输入字幕',
    captionStyle: { fontSize: 46, color: '#ffffff', position: 'bottom' },
  };
  return withClips(project, [...project.clips, clip]);
}

export function updateClip(project: Project, clipId: string, patch: Partial<TimelineClip>): Project {
  return withClips(project, project.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip));
}

export function canSetClipPlaybackRate(project: Project, clipId: string, playbackRate: number): boolean {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.type === 'caption' || !PLAYBACK_RATE_PRESETS.includes(playbackRate as (typeof PLAYBACK_RATE_PRESETS)[number])) return false;
  const sourceDurationMs = getClipSourceDurationMs(clip);
  const durationMs = timelineDurationForSourceDuration(sourceDurationMs, playbackRate);
  if (durationMs < MIN_DURATION_MS) return false;
  const candidate = { ...clip, playbackRate, sourceDurationMs, durationMs };
  return candidate.type !== 'video' || !videoOverlaps(project, candidate);
}

/** Preserves the exact source interval and recomputes only its project-time duration. */
export function setClipPlaybackRate(project: Project, clipId: string, playbackRate: number): Project {
  if (!canSetClipPlaybackRate(project, clipId, playbackRate)) return project;
  return withClips(project, project.clips.map((clip) => clip.id === clipId
    ? { ...clip, playbackRate, sourceDurationMs: getClipSourceDurationMs(clip), durationMs: timelineDurationForSourceDuration(getClipSourceDurationMs(clip), playbackRate) }
    : clip));
}

export function removeClip(project: Project, clipId: string): Project {
  return withClips(project, project.clips.filter((clip) => clip.id !== clipId));
}

export function canSplitTimelineClip(project: Project, clipId: string, splitTimeMs: number): boolean {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.type === 'caption') return false;
  return splitTimeMs > clip.startMs + MIN_DURATION_MS && splitTimeMs < clip.startMs + clip.durationMs - MIN_DURATION_MS;
}

/**
 * Replaces one video/audio timeline instance with two source-contiguous instances.
 * durationMs is timeline time; source offsets are rate-aware for the Phase 5.5 model.
 */
export function splitTimelineClip(project: Project, clipId: string, splitTimeMs: number): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || !canSplitTimelineClip(project, clipId, splitTimeMs)) return project;
  const splitAtMs = Math.round(splitTimeMs);
  const leftDurationMs = splitAtMs - clip.startMs;
  const sourceOffsetMs = sourceOffsetForTimelineOffset(clip, leftDurationMs);
  const sourceDurationMs = getClipSourceDurationMs(clip);
  const left: TimelineClip = { ...clip, id: id(clip.type), durationMs: leftDurationMs, sourceDurationMs: sourceOffsetMs };
  const right: TimelineClip = {
    ...clip,
    id: id(clip.type),
    startMs: splitAtMs,
    sourceStartMs: clip.sourceStartMs + sourceOffsetMs,
    durationMs: clip.durationMs - leftDurationMs,
    sourceDurationMs: sourceDurationMs - sourceOffsetMs,
  };
  return withClips(project, project.clips.flatMap((item) => item.id === clipId ? [left, right] : [item]));
}

export function addTrack(project: Project, type: TrackType, trackId = id('track')): Project {
  const sameTypeCount = project.tracks.filter((track) => track.type === type).length;
  const baseName = ({ caption: '字幕', video: '视频', music: '背景音乐', sfx: '音效' } as const)[type];
  const track: Track = {
    id: trackId,
    type,
    name: `${baseName} ${sameTypeCount + 1}`,
    order: project.tracks.length,
    locked: false,
    heightPx: DEFAULT_TRACK_HEIGHT_PX,
    clipIds: [],
  };
  return withTracks(project, [...project.tracks, track]);
}

export function renameTrack(project: Project, trackId: string, name: string): Project {
  const trimmed = name.trim();
  if (!trimmed) return project;
  return withTracks(project, project.tracks.map((track) => track.id === trackId ? { ...track, name: trimmed } : track));
}

export function resizeTrack(project: Project, trackId: string, heightPx: number): Project {
  return withTracks(project, project.tracks.map((track) => track.id === trackId
    ? { ...track, heightPx: clamp(Math.round(heightPx), MIN_TRACK_HEIGHT_PX, MAX_TRACK_HEIGHT_PX) }
    : track));
}

export function reorderTrack(project: Project, trackId: string, targetIndex: number): Project {
  const tracks = [...project.tracks].sort((left, right) => left.order - right.order);
  const currentIndex = tracks.findIndex((track) => track.id === trackId);
  if (currentIndex < 0) return project;
  const [track] = tracks.splice(currentIndex, 1);
  tracks.splice(clamp(targetIndex, 0, tracks.length), 0, track);
  return withTracks(project, tracks);
}

export function deleteEmptyTrack(project: Project, trackId: string): Project {
  const track = getTrack(project, trackId);
  const videoTrackCount = project.tracks.filter((item) => item.type === 'video').length;
  if (!track || track.clipIds.length > 0 || track.type === 'video' && videoTrackCount <= 1) return project;
  return withTracks(project, project.tracks.filter((item) => item.id !== trackId));
}

export function moveClipToCompatibleTrack(project: Project, clipId: string, startMs: number, targetTrackId: string): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  const sourceTrack = clip ? getTrack(project, clip.trackId) : undefined;
  const targetTrack = getTrack(project, targetTrackId);
  if (!clip || !sourceTrack || !targetTrack || sourceTrack.type !== targetTrack.type) return project;
  const moved = clip.type === 'video'
    ? { ...clip, trackId: targetTrack.id, startMs: Math.max(0, snapMs(startMs)) }
    : moveClip({ ...clip, trackId: targetTrack.id }, startMs, getProjectDuration(project));
  if (moved.type === 'video' && videoOverlaps(project, moved)) return project;
  return withClips(project, project.clips.map((item) => item.id === clipId ? moved : item));
}

export function moveProjectClip(project: Project, clipId: string, startMs: number): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return project;
  if (clip.type !== 'video') return withClips(project, project.clips.map((item) => item.id === clipId ? moveClip(item, startMs, getProjectDuration(project)) : item));
  const candidate = { ...clip, startMs: Math.max(0, snapMs(startMs)) };
  return videoOverlaps(project, candidate) ? project : withClips(project, project.clips.map((item) => item.id === clipId ? candidate : item));
}

export function trimProjectClip(project: Project, clipId: string, valueMs: number, edge: 'left' | 'right'): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return project;
  const asset = clip.assetId ? getAsset(project, clip.assetId) : undefined;
  const assetDuration = asset?.durationMs ?? getProjectDuration(project);
  if (clip.type !== 'video') {
    const updated = edge === 'left'
      ? trimLeft(clip, valueMs, assetDuration, getProjectDuration(project))
      : trimRight(clip, valueMs, assetDuration, getProjectDuration(project));
    return updateClip(project, clipId, updated);
  }
  const candidate = edge === 'left'
    ? trimLeft(clip, valueMs, assetDuration, getProjectDuration(project))
    : trimRight(clip, valueMs, assetDuration, getProjectDuration(project));
  return videoOverlaps(project, candidate) ? project : withClips(project, project.clips.map((item) => item.id === clipId ? candidate : item));
}

export function updateVideoLayout(project: Project, clipId: string, patch: Partial<VideoLayout>): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.type !== 'video') return project;
  const asset = clip.assetId ? getAsset(project, clip.assetId) : undefined;
  const current = clip.videoLayout ?? defaultVideoLayout(project, asset);
  const next = { ...current, ...patch };
  const aspect = asset?.width && asset?.height ? asset.width / asset.height : current.width / current.height;
  // Corner dragging supplies both dimensions; width is the canonical edge when aspect lock is on.
  if (next.keepAspectRatio && patch.width !== undefined) next.height = Math.round(next.width / aspect);
  else if (next.keepAspectRatio && patch.height !== undefined) next.width = Math.round(next.height * aspect);
  next.width = clamp(Math.round(next.width), 40, project.width);
  next.height = clamp(Math.round(next.height), 40, project.height);
  next.x = clamp(Math.round(next.x), 0, project.width - next.width);
  next.y = clamp(Math.round(next.y), 0, project.height - next.height);
  next.opacity = clamp(next.opacity, 0, 1);
  return withClips(project, project.clips.map((item) => item.id === clipId ? { ...item, videoLayout: next } : item));
}

export function setVideoLayoutMode(project: Project, clipId: string, mode: Extract<VideoLayoutMode, 'full' | 'pip'>): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.type !== 'video') return project;
  return updateVideoLayout(project, clipId, defaultVideoLayout(project, clip.assetId ? getAsset(project, clip.assetId) : undefined, mode));
}

export function getVideoLayerZIndex(project: Project, trackId: string): number {
  // Timeline order is UI top-to-bottom. The visually upper video track must also
  // cover lower tracks, so invert its index into WebAV's ascending zIndex space.
  const videoTracks = project.tracks.filter((track) => track.type === 'video').sort((left, right) => left.order - right.order);
  const index = videoTracks.findIndex((track) => track.id === trackId);
  return index < 0 ? 0 : videoTracks.length - 1 - index;
}
