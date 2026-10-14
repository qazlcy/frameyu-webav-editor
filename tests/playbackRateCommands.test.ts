import { describe, expect, it } from 'vitest';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, canSetClipPlaybackRate, getProjectDuration, setClipPlaybackRate, splitTimelineClip, trimProjectClip, updateClip } from '../src/editor/commands';
import { emptyProject, type Asset } from '../src/editor/types';

const video = (id: string, durationMs = 10_000): Asset => ({ id, name: `${id}.mp4`, type: 'video', mimeType: 'video/mp4', durationMs, width: 1280, height: 720 });
const audio = (id: string, durationMs = 10_000): Asset => ({ id, name: `${id}.mp3`, type: 'audio', mimeType: 'audio/mpeg', durationMs });

describe('playback-rate commands', () => {
  it('maps a ten-second source video to five seconds at 2× and twenty seconds at 0.5× without source loss', () => {
    let project = addAsset(emptyProject(), video('source'));
    project = appendVideoClip(project, project.assets[0]);
    const id = project.clips[0].id;
    project = setClipPlaybackRate(project, id, 2);
    expect(project.clips[0]).toMatchObject({ playbackRate: 2, sourceDurationMs: 10_000, durationMs: 5_000 });
    expect(getProjectDuration(project)).toBe(5_000);
    project = setClipPlaybackRate(project, id, 0.5);
    expect(project.clips[0]).toMatchObject({ playbackRate: 0.5, sourceDurationMs: 10_000, durationMs: 20_000 });
    expect(getProjectDuration(project)).toBe(20_000);
  });

  it('splits a 2× video at engineering time two seconds at source time four seconds', () => {
    let project = addAsset(emptyProject(), video('source'));
    project = appendVideoClip(project, project.assets[0]);
    const id = project.clips[0].id;
    project = setClipPlaybackRate(project, id, 2);
    project = splitTimelineClip(project, id, 2_000);
    const [left, right] = project.clips;
    expect(left).toMatchObject({ startMs: 0, sourceStartMs: 0, sourceDurationMs: 4_000, durationMs: 2_000, playbackRate: 2 });
    expect(right).toMatchObject({ startMs: 2_000, sourceStartMs: 4_000, sourceDurationMs: 6_000, durationMs: 3_000, playbackRate: 2 });
  });

  it('uses rate-aware left and right trims without changing the selected source interval incorrectly', () => {
    let project = addAsset(emptyProject(), video('source'));
    project = appendVideoClip(project, project.assets[0]);
    const id = project.clips[0].id;
    project = setClipPlaybackRate(project, id, 2);
    project = trimProjectClip(project, id, 3_000, 'right');
    project = trimProjectClip(project, id, 1_000, 'left');
    expect(project.clips[0]).toMatchObject({ startMs: 1_000, sourceStartMs: 2_000, sourceDurationMs: 4_000, durationMs: 2_000, playbackRate: 2 });
  });

  it('blocks a rate change that would overlap another video on the same track', () => {
    let project = addAsset(emptyProject(), video('a', 10_000));
    project = addAsset(project, video('b', 5_000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[1]);
    const firstId = project.clips[0].id;
    project = updateClip(project, firstId, { durationMs: 6_000, sourceDurationMs: 6_000 });
    expect(canSetClipPlaybackRate(project, firstId, 0.5)).toBe(false);
    expect(setClipPlaybackRate(project, firstId, 0.5)).toBe(project);
  });

  it('keeps independent audio source intervals and leaves caption timing unchanged', () => {
    let project = addAsset(emptyProject(), video('picture', 12_000));
    project = addAsset(project, audio('music', 10_000));
    project = appendVideoClip(project, project.assets[0]);
    project = addAudioClip(project, project.assets[1], 'music');
    project = addCaption(project, 'caption', { text: '不变', startMs: 2_000, endMs: 4_000 });
    const audioId = project.clips.find((clip) => clip.type === 'audio')!.id;
    const caption = project.clips.find((clip) => clip.type === 'caption')!;
    project = setClipPlaybackRate(project, audioId, 2);
    expect(project.clips.find((clip) => clip.id === audioId)).toMatchObject({ sourceDurationMs: 10_000, durationMs: 5_000, playbackRate: 2 });
    expect(project.clips.find((clip) => clip.id === caption.id)).toMatchObject({ startMs: 2_000, durationMs: 2_000 });
    expect(canSetClipPlaybackRate(project, caption.id, 2)).toBe(false);
  });

  it('preserves exact source duration when repeatedly switching rates and supports a 2× overlay beside a 1× video', () => {
    let project = addAsset(emptyProject(), video('a', 10_000));
    project = addAsset(project, video('b', 10_000));
    project = appendVideoClip(project, project.assets[0]);
    project = addTrack(project, 'video', 'video-2');
    project = appendVideoClip(project, project.assets[1], 'video-2');
    const [base, overlay] = project.clips;
    project = setClipPlaybackRate(project, overlay.id, 2);
    for (const rate of [1, 2, 0.5, 1, 2, 1] as const) project = setClipPlaybackRate(project, overlay.id, rate);
    expect(project.clips.find((clip) => clip.id === overlay.id)).toMatchObject({ sourceDurationMs: 10_000, durationMs: 10_000, playbackRate: 1 });
    expect(project.clips.find((clip) => clip.id === base.id)).toMatchObject({ durationMs: 10_000, playbackRate: 1 });
  });
});
