import type { Asset, Project, TimelineClip, TrackType } from './types';
import { MIN_DURATION_MS, moveClip, trimLeft, trimRight } from './timelineMath';

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const getAsset = (project: Project, assetId: string) => project.assets.find((asset) => asset.id === assetId);
export const getMainDuration = (project: Project) => {
  const asset = project.mainVideoAssetId ? getAsset(project, project.mainVideoAssetId) : undefined;
  return asset?.durationMs ?? 0;
};

export function upsertAsset(project: Project, asset: Asset, replaceMain = false): Project {
  const assets = [...project.assets.filter((item) => item.id !== asset.id), asset];
  if (!replaceMain) return { ...project, assets };
  const clips = project.clips.filter((clip) => clip.trackId !== 'video');
  const videoClip: TimelineClip = {
    id: id('video'), trackId: 'video', type: 'video', assetId: asset.id, name: asset.name,
    startMs: 0, sourceStartMs: 0, durationMs: asset.durationMs, volume: 1,
  };
  return { ...project, assets, mainVideoAssetId: asset.id, clips: [...clips, videoClip] };
}

export function addAudioClip(project: Project, asset: Asset, trackId: Extract<TrackType, 'music' | 'sfx'>): Project {
  const projectDuration = getMainDuration(project);
  if (!projectDuration) return project;
  const durationMs = Math.min(asset.durationMs, projectDuration);
  const clip: TimelineClip = {
    id: id('audio'), trackId, type: 'audio', assetId: asset.id, name: asset.name,
    startMs: 0, sourceStartMs: 0, durationMs, volume: 1,
  };
  return { ...project, clips: [...project.clips, clip] };
}

export function addCaption(project: Project): Project {
  const durationMs = Math.min(3000, getMainDuration(project));
  if (durationMs < MIN_DURATION_MS) return project;
  const clip: TimelineClip = {
    id: id('caption'), trackId: 'caption', type: 'caption', name: '新字幕', startMs: 0,
    sourceStartMs: 0, durationMs, volume: 1, text: '在这里输入字幕',
    captionStyle: { fontSize: 46, color: '#ffffff', position: 'bottom' },
  };
  return { ...project, clips: [...project.clips, clip] };
}

export function updateClip(project: Project, clipId: string, patch: Partial<TimelineClip>): Project {
  return { ...project, clips: project.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) };
}

export function removeClip(project: Project, clipId: string): Project {
  return { ...project, clips: project.clips.filter((clip) => clip.id !== clipId || clip.trackId === 'video') };
}

export function moveProjectClip(project: Project, clipId: string, startMs: number): Project {
  const duration = getMainDuration(project);
  return { ...project, clips: project.clips.map((clip) => clip.id === clipId && clip.type !== 'video' ? moveClip(clip, startMs, duration) : clip) };
}

export function trimProjectClip(project: Project, clipId: string, durationMs: number, edge: 'left' | 'right'): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.type === 'video') return project;
  const asset = clip.assetId ? getAsset(project, clip.assetId) : undefined;
  const assetDuration = asset?.durationMs ?? getMainDuration(project);
  const updated = edge === 'left'
    ? trimLeft(clip, durationMs, assetDuration, getMainDuration(project))
    : trimRight(clip, durationMs, assetDuration, getMainDuration(project));
  return updateClip(project, clipId, updated);
}
