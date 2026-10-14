import { DEFAULT_TRACK_HEIGHT_PX, MAX_TRACK_HEIGHT_PX, MIN_TRACK_HEIGHT_PX, type Asset, type CaptionDraft, type Project, type TimelineClip, type Track, type TrackType } from './types';
import { MIN_DURATION_MS, clamp, moveClip, snapMs, trimLeft, trimRight } from './timelineMath';

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const getAsset = (project: Project, assetId: string) => project.assets.find((asset) => asset.id === assetId);
export const getTrack = (project: Project, trackId: string) => project.tracks.find((track) => track.id === trackId);
export const getVideoClips = (project: Project) => project.clips.filter((clip) => clip.type === 'video');
export const getProjectDuration = (project: Project) => getVideoClips(project).reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);

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
  const videoTrack = project.tracks.find((track) => track.type === 'video');
  if (!videoTrack) return project;
  const clip: TimelineClip = {
    id: id('video'), trackId: videoTrack.id, type: 'video', assetId: asset.id, name: asset.name,
    startMs: getProjectDuration(project), sourceStartMs: 0, durationMs: asset.durationMs, volume: 1,
  };
  return withClips(project, [...project.clips, clip]);
}

export function addAudioClip(project: Project, asset: Asset, trackId: string): Project {
  const projectDuration = getProjectDuration(project);
  const track = getTrack(project, trackId);
  if (track?.type !== 'music' && track?.type !== 'sfx') return project;
  if (!projectDuration) return project;
  const clip: TimelineClip = {
    id: id('audio'), trackId, type: 'audio', assetId: asset.id, name: asset.name,
    startMs: 0, sourceStartMs: 0, durationMs: Math.min(asset.durationMs, projectDuration), volume: 1,
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
    sourceStartMs: 0, durationMs, volume: 1, text: draft?.text.trim() || '在这里输入字幕',
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

export function addTrack(project: Project, type: Exclude<TrackType, 'video'>, trackId = id('track')): Project {
  const sameTypeCount = project.tracks.filter((track) => track.type === type).length;
  const baseName = ({ caption: '字幕', music: '背景音乐', sfx: '音效' } as const)[type];
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
  if (!track || track.type === 'video' || track.clipIds.length > 0) return project;
  return withTracks(project, project.tracks.filter((item) => item.id !== trackId));
}

export function moveClipToCompatibleTrack(project: Project, clipId: string, startMs: number, targetTrackId: string): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  const sourceTrack = clip ? getTrack(project, clip.trackId) : undefined;
  const targetTrack = getTrack(project, targetTrackId);
  if (!clip || !sourceTrack || !targetTrack || sourceTrack.type !== targetTrack.type || clip.type === 'video') return project;
  const moved = moveClip({ ...clip, trackId: targetTrack.id }, startMs, getProjectDuration(project));
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
    ? (() => {
      const startMs = clamp(snapMs(valueMs), 0, clip.startMs + clip.durationMs - MIN_DURATION_MS);
      const consumed = startMs - clip.startMs;
      return { ...clip, startMs, sourceStartMs: clip.sourceStartMs + consumed, durationMs: clip.durationMs - consumed };
    })()
    : { ...clip, durationMs: clamp(snapMs(valueMs), MIN_DURATION_MS, assetDuration - clip.sourceStartMs) };
  return videoOverlaps(project, candidate) ? project : withClips(project, project.clips.map((item) => item.id === clipId ? candidate : item));
}
