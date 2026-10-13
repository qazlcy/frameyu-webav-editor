import type { Asset, Project, TimelineClip, Track, TrackType } from './types';
import { MIN_DURATION_MS, clamp, moveClip, snapMs, trimLeft, trimRight } from './timelineMath';

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const getAsset = (project: Project, assetId: string) => project.assets.find((asset) => asset.id === assetId);
export const getVideoClips = (project: Project) => project.clips.filter((clip) => clip.type === 'video');
export const getProjectDuration = (project: Project) => getVideoClips(project).reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);

function withTrackClipIds(tracks: Track[], clips: TimelineClip[]) {
  return tracks.map((track) => ({ ...track, clipIds: clips.filter((clip) => clip.trackId === track.id).map((clip) => clip.id) }));
}

function normaliseToVideoDuration(project: Project, clips: TimelineClip[]): TimelineClip[] {
  const videoDuration = clips.filter((clip) => clip.type === 'video').reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
  if (!videoDuration) return clips.filter((clip) => clip.type === 'video');
  return clips.flatMap((clip) => {
    if (clip.type === 'video') return [clip];
    if (clip.startMs >= videoDuration) return [];
    const assetDuration = clip.assetId ? getAsset(project, clip.assetId)?.durationMs : undefined;
    const sourceRemaining = assetDuration === undefined ? Number.POSITIVE_INFINITY : assetDuration - clip.sourceStartMs;
    const durationMs = Math.min(clip.durationMs, videoDuration - clip.startMs, sourceRemaining);
    return durationMs >= MIN_DURATION_MS ? [{ ...clip, durationMs }] : [];
  });
}

function withClips(project: Project, clips: TimelineClip[]): Project {
  const validClips = normaliseToVideoDuration(project, clips);
  return { ...project, clips: validClips, tracks: withTrackClipIds(project.tracks, validClips) };
}

function videoOverlaps(project: Project, candidate: TimelineClip): boolean {
  return getVideoClips(project).some((clip) => clip.id !== candidate.id && candidate.startMs < clip.startMs + clip.durationMs && clip.startMs < candidate.startMs + candidate.durationMs);
}

export function addAsset(project: Project, asset: Asset): Project {
  return { ...project, assets: [...project.assets.filter((item) => item.id !== asset.id), asset] };
}

export function appendVideoClip(project: Project, asset: Asset): Project {
  const clip: TimelineClip = {
    id: id('video'), trackId: 'video', type: 'video', assetId: asset.id, name: asset.name,
    startMs: getProjectDuration(project), sourceStartMs: 0, durationMs: asset.durationMs, volume: 1,
  };
  return withClips(project, [...project.clips, clip]);
}

export function addAudioClip(project: Project, asset: Asset, trackId: Extract<TrackType, 'music' | 'sfx'>): Project {
  const projectDuration = getProjectDuration(project);
  if (!projectDuration) return project;
  const clip: TimelineClip = {
    id: id('audio'), trackId, type: 'audio', assetId: asset.id, name: asset.name,
    startMs: 0, sourceStartMs: 0, durationMs: Math.min(asset.durationMs, projectDuration), volume: 1,
  };
  return withClips(project, [...project.clips, clip]);
}

export function addCaption(project: Project): Project {
  const projectDuration = getProjectDuration(project);
  const durationMs = Math.min(3000, projectDuration);
  if (durationMs < MIN_DURATION_MS) return project;
  const clip: TimelineClip = {
    id: id('caption'), trackId: 'caption', type: 'caption', name: '新字幕', startMs: 0,
    sourceStartMs: 0, durationMs, volume: 1, text: '在这里输入字幕',
    captionStyle: { fontSize: 46, color: '#ffffff', position: 'bottom' },
  };
  return withClips(project, [...project.clips, clip]);
}

export function updateClip(project: Project, clipId: string, patch: Partial<TimelineClip>): Project {
  return withClips(project, project.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip));
}

export function removeClip(project: Project, clipId: string): Project {
  return withClips(project, project.clips.filter((clip) => clip.id !== clipId));
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
    ? (() => {
      const startMs = clamp(snapMs(valueMs), 0, clip.startMs + clip.durationMs - MIN_DURATION_MS);
      const consumed = startMs - clip.startMs;
      return { ...clip, startMs, sourceStartMs: clip.sourceStartMs + consumed, durationMs: clip.durationMs - consumed };
    })()
    : { ...clip, durationMs: clamp(snapMs(valueMs), MIN_DURATION_MS, assetDuration - clip.sourceStartMs) };
  return videoOverlaps(project, candidate) ? project : withClips(project, project.clips.map((item) => item.id === clipId ? candidate : item));
}
