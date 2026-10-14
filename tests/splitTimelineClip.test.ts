import { describe, expect, it } from 'vitest';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, canSplitTimelineClip, moveProjectClip, removeClip, setVideoLayoutMode, splitTimelineClip, trimProjectClip, updateClip, updateVideoLayout } from '../src/editor/commands';
import { emptyProject, type Asset } from '../src/editor/types';

const video = (id: string, durationMs = 20_000): Asset => ({ id, name: `${id}.mp4`, type: 'video', mimeType: 'video/mp4', durationMs, width: 1280, height: 720 });
const audio = (id: string, durationMs = 20_000): Asset => ({ id, name: `${id}.mp3`, type: 'audio', mimeType: 'audio/mpeg', durationMs });

describe('splitTimelineClip', () => {
  it('splits a video with different source and timeline start times without losing visual or audio properties', () => {
    let project = addAsset(emptyProject(), video('source'));
    project = appendVideoClip(project, project.assets[0]);
    const originalId = project.clips[0].id;
    project = updateClip(project, originalId, {
      startMs: 5_000, sourceStartMs: 2_000, durationMs: 10_000, volume: 0.45, muted: true,
      videoLayout: { mode: 'custom', x: 790, y: 32, width: 320, height: 180, opacity: 0.65, keepAspectRatio: true },
    });

    project = splitTimelineClip(project, originalId, 9_000);
    const [left, right] = project.clips;
    expect(left).toMatchObject({ trackId: 'video', assetId: 'source', startMs: 5_000, sourceStartMs: 2_000, durationMs: 4_000, volume: 0.45, muted: true });
    expect(right).toMatchObject({ trackId: 'video', assetId: 'source', startMs: 9_000, sourceStartMs: 6_000, durationMs: 6_000, volume: 0.45, muted: true });
    expect(left.id).not.toBe(originalId);
    expect(right.id).not.toBe(left.id);
    expect(right.videoLayout).toEqual(left.videoLayout);
    expect(project.tracks.find((track) => track.id === 'video')?.clipIds).toEqual([left.id, right.id]);
  });

  it('splits an audio clip into source-contiguous independent clips and supports later trim, move and delete', () => {
    let project = addAsset(emptyProject(), video('picture'));
    project = addAsset(project, audio('music'));
    project = appendVideoClip(project, project.assets[0]);
    project = addAudioClip(project, project.assets[1], 'music');
    const audioId = project.clips.find((clip) => clip.type === 'audio')!.id;
    project = updateClip(project, audioId, { startMs: 5_000, sourceStartMs: 2_000, durationMs: 10_000 });

    project = splitTimelineClip(project, audioId, 9_000);
    const parts = project.clips.filter((clip) => clip.type === 'audio').sort((left, right) => left.startMs - right.startMs);
    expect(parts).toHaveLength(2);
    expect(parts.map(({ startMs, sourceStartMs, durationMs }) => ({ startMs, sourceStartMs, durationMs }))).toEqual([
      { startMs: 5_000, sourceStartMs: 2_000, durationMs: 4_000 },
      { startMs: 9_000, sourceStartMs: 6_000, durationMs: 6_000 },
    ]);
    project = trimProjectClip(project, parts[0].id, 3_000, 'right');
    project = moveProjectClip(project, parts[1].id, 12_000);
    project = removeClip(project, parts[0].id);
    expect(project.clips.find((clip) => clip.id === parts[1].id)).toMatchObject({ startMs: 12_000, sourceStartMs: 6_000, durationMs: 6_000 });
  });

  it('uses playbackRate for source offsets while retaining timeline durations for a future speed command', () => {
    let project = addAsset(emptyProject(), video('source'));
    project = appendVideoClip(project, project.assets[0]);
    const id = project.clips[0].id;
    project = updateClip(project, id, { startMs: 5_000, sourceStartMs: 2_000, durationMs: 5_000, playbackRate: 2 });

    project = splitTimelineClip(project, id, 7_000);
    const [, right] = project.clips;
    expect(right).toMatchObject({ startMs: 7_000, sourceStartMs: 6_000, durationMs: 3_000, playbackRate: 2 });
  });

  it('keeps clip fragments valid for a picture-in-picture clip on another video track', () => {
    let project = addAsset(emptyProject(), video('a'));
    project = addAsset(project, video('b'));
    project = appendVideoClip(project, project.assets[0]);
    project = addTrack(project, 'video', 'video-2');
    project = appendVideoClip(project, project.assets[1], 'video-2');
    const overlayId = project.clips.find((clip) => clip.trackId === 'video-2')!.id;
    project = updateClip(project, overlayId, { startMs: 2_000, sourceStartMs: 1_000, durationMs: 8_000, volume: 0.6 });
    project = setVideoLayoutMode(project, overlayId, 'pip');
    project = updateVideoLayout(project, overlayId, { opacity: 0.5 });

    project = splitTimelineClip(project, overlayId, 5_000);
    const overlayParts = project.clips.filter((clip) => clip.trackId === 'video-2');
    expect(overlayParts).toHaveLength(2);
    expect(overlayParts.map(({ startMs, sourceStartMs, durationMs }) => ({ startMs, sourceStartMs, durationMs }))).toEqual([
      { startMs: 2_000, sourceStartMs: 1_000, durationMs: 3_000 },
      { startMs: 5_000, sourceStartMs: 4_000, durationMs: 5_000 },
    ]);
    expect(overlayParts.every((clip) => clip.videoLayout?.mode === 'pip' && clip.videoLayout.opacity === 0.5 && clip.volume === 0.6)).toBe(true);
  });

  it('refuses captions, boundaries, and near-boundary split points without changing the project', () => {
    let project = addAsset(emptyProject(), video('source', 8_000));
    project = appendVideoClip(project, project.assets[0]);
    project = addCaption(project, 'caption', { text: '字幕', startMs: 1_000, endMs: 2_000 });
    const [videoClip, captionClip] = project.clips;
    expect(canSplitTimelineClip(project, videoClip.id, videoClip.startMs)).toBe(false);
    expect(canSplitTimelineClip(project, videoClip.id, videoClip.startMs + videoClip.durationMs)).toBe(false);
    expect(canSplitTimelineClip(project, captionClip.id, 1_500)).toBe(false);
    expect(splitTimelineClip(project, captionClip.id, 1_500)).toBe(project);
    expect(splitTimelineClip(project, videoClip.id, 50)).toBe(project);
  });
});
