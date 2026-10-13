import { describe, expect, it } from 'vitest';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, deleteEmptyTrack, getProjectDuration, moveClipToCompatibleTrack, moveProjectClip, removeClip, renameTrack, reorderTrack, resizeTrack, trimProjectClip } from '../src/editor/commands';
import { MAX_TRACK_HEIGHT_PX, MIN_TRACK_HEIGHT_PX, emptyProject, type Asset } from '../src/editor/types';

const video = (id: string, durationMs: number): Asset => ({ id, name: `${id}.mp4`, type: 'video', mimeType: 'video/mp4', durationMs, width: 1280, height: 720 });
const audio: Asset = { id: 'music', name: 'music.mp3', type: 'audio', mimeType: 'audio/mpeg', durationMs: 9000 };

describe('multi-video project commands', () => {
  it('keeps multiple imported video assets instead of replacing an earlier asset', () => {
    const project = addAsset(addAsset(emptyProject(), video('a', 4000)), video('b', 5000));
    expect(project.assets.map((asset) => asset.id)).toEqual(['a', 'b']);
    expect(project.tracks.find((track) => track.id === 'video')?.clipIds).toEqual([]);
  });

  it('appends independent video clips and calculates duration from videos only', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = addAsset(project, video('b', 5000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[1]);
    expect(project.clips.filter((clip) => clip.type === 'video').map((clip) => clip.startMs)).toEqual([0, 4000]);
    expect(getProjectDuration(project)).toBe(9000);
    expect(project.tracks.find((track) => track.id === 'video')?.clipIds).toHaveLength(2);
  });

  it('allows the same source asset to be referenced by multiple clips', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[0]);
    expect(project.clips.filter((clip) => clip.type === 'video')).toHaveLength(2);
    expect(new Set(project.clips.map((clip) => clip.assetId))).toEqual(new Set(['a']));
  });

  it('rejects overlapping moves on the single video track', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = addAsset(project, video('b', 5000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[1]);
    const second = project.clips[1];
    expect(moveProjectClip(project, second.id, 3000).clips.find((clip) => clip.id === second.id)?.startMs).toBe(4000);
  });

  it('uses source and project time independently when left-trimming then moving a video', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = addAsset(project, video('b', 5000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[1]);
    const secondId = project.clips[1].id;
    project = trimProjectClip(project, secondId, 6000, 'left');
    project = moveProjectClip(project, secondId, 4000);
    expect(project.clips.find((clip) => clip.id === secondId)).toMatchObject({ startMs: 4000, sourceStartMs: 2000, durationMs: 3000 });
    expect(getProjectDuration(project)).toBe(7000);
  });

  it('does not let audio or captions extend the project and preserves valid editing paths', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = addAsset(project, audio);
    project = appendVideoClip(project, project.assets[0]);
    project = addAudioClip(project, audio, 'music');
    project = addCaption(project);
    expect(getProjectDuration(project)).toBe(4000);
    expect(project.clips.filter((clip) => clip.type === 'audio' || clip.type === 'caption')).toHaveLength(2);
  });

  it('deletes one video clip without releasing the shared source or another clip', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[0]);
    const firstId = project.clips[0].id;
    project = removeClip(project, firstId);
    expect(project.assets).toHaveLength(1);
    expect(project.clips).toHaveLength(1);
    expect(project.clips[0].assetId).toBe('a');
  });

  it('adds, names, resizes and reorders non-video tracks with continuous order values', () => {
    let project = emptyProject();
    project = addTrack(project, 'music');
    const added = project.tracks.at(-1)!;
    project = renameTrack(project, added.id, '氛围音乐');
    project = resizeTrack(project, added.id, 999);
    project = reorderTrack(project, added.id, 0);
    expect(project.tracks.map((track) => track.order)).toEqual([0, 1, 2, 3, 4]);
    expect(project.tracks[0]).toMatchObject({ id: added.id, name: '氛围音乐', heightPx: MAX_TRACK_HEIGHT_PX });
    expect(resizeTrack(project, added.id, 1).tracks[0].heightPx).toBe(MIN_TRACK_HEIGHT_PX);
  });

  it('only removes empty non-video tracks and keeps non-empty tracks protected', () => {
    let project = addTrack(emptyProject(), 'caption');
    const captionTrack = project.tracks.at(-1)!;
    expect(deleteEmptyTrack(project, captionTrack.id).tracks).toHaveLength(4);
    project = addAsset(project, video('a', 4000));
    project = appendVideoClip(project, project.assets[0]);
    project = addCaption(project, captionTrack.id);
    expect(deleteEmptyTrack(project, captionTrack.id)).toBe(project);
    expect(deleteEmptyTrack(project, 'video')).toBe(project);
  });

  it('moves clips only to a compatible track without changing media timing or identity', () => {
    let project = addAsset(emptyProject(), video('a', 4000));
    project = addAsset(project, audio);
    project = appendVideoClip(project, project.assets[0]);
    project = addTrack(project, 'music');
    const secondMusic = project.tracks.find((track) => track.type === 'music' && track.id !== 'music')!;
    project = addAudioClip(project, audio, 'music');
    const musicClip = project.clips.find((clip) => clip.trackId === 'music')!;
    const moved = moveClipToCompatibleTrack(project, musicClip.id, musicClip.startMs, secondMusic.id);
    expect(moved.clips.find((clip) => clip.id === musicClip.id)).toMatchObject({
      id: musicClip.id,
      trackId: secondMusic.id,
      assetId: musicClip.assetId,
      startMs: musicClip.startMs,
      sourceStartMs: musicClip.sourceStartMs,
      durationMs: musicClip.durationMs,
    });
    expect(moveClipToCompatibleTrack(moved, musicClip.id, musicClip.startMs, 'sfx')).toBe(moved);
  });
});
