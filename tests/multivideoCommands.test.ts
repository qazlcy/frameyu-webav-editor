import { describe, expect, it } from 'vitest';
import { addAsset, addAudioClip, addCaption, appendVideoClip, getProjectDuration, moveProjectClip, removeClip, trimProjectClip } from '../src/editor/commands';
import { emptyProject, type Asset } from '../src/editor/types';

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
});
