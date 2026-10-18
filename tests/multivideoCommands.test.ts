import { describe, expect, it } from 'vitest';
import { addAsset, addAudioClip, addCaption, addTrack, appendVideoClip, defaultVideoLayout, deleteEmptyTrack, getProjectDuration, getVideoLayerZIndex, moveClipToCompatibleTrack, moveProjectClip, removeClip, renameTrack, reorderTrack, resizedVideoLayout, resizeTrack, setVideoLayoutMode, trimProjectClip, updateVideoLayout } from '../src/editor/commands';
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

  it('rejects a video trim that would overlap another clip and keeps later clips in place after deletion', () => {
    let project = addAsset(emptyProject(), video('a', 7000));
    project = addAsset(project, video('b', 4000));
    project = appendVideoClip(project, project.assets[0]);
    project = appendVideoClip(project, project.assets[1]);
    const [first, second] = project.clips;
    project = trimProjectClip(project, first.id, 6000, 'right');
    project = moveProjectClip(project, second.id, 6500);
    const rejected = trimProjectClip(project, first.id, 6600, 'right');
    expect(rejected).toBe(project);
    const afterDelete = removeClip(project, first.id);
    expect(afterDelete.clips.find((clip) => clip.id === second.id)?.startMs).toBe(6500);
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

  it('stages audio immediately before a video exists and permits repeated source references', () => {
    let project = addAsset(emptyProject(), audio);
    project = addAudioClip(project, audio, 'music');
    project = addAudioClip(project, audio, 'music');
    expect(project.clips.filter((clip) => clip.type === 'audio')).toHaveLength(2);
    expect(project.clips.every((clip) => clip.durationMs === audio.durationMs)).toBe(true);
    expect(getProjectDuration(project)).toBe(0);
  });

  it('creates a manual caption from explicit text and timeline bounds', () => {
    let project = addAsset(emptyProject(), video('a', 6000));
    project = appendVideoClip(project, project.assets[0]);
    project = addCaption(project, 'caption', { text: '手动字幕', startMs: 1200, endMs: 3600 });
    expect(project.clips.find((clip) => clip.type === 'caption')).toMatchObject({
      trackId: 'caption', text: '手动字幕', name: '手动字幕', startMs: 1200, durationMs: 2400,
    });
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

  it('allows overlapping video clips on distinct video tracks but not on the same track', () => {
    let project = addAsset(emptyProject(), video('a', 5000));
    project = addAsset(project, video('b', 4000));
    project = appendVideoClip(project, project.assets[0]);
    project = addTrack(project, 'video', 'video-2');
    project = appendVideoClip(project, project.assets[1], 'video-2');
    const [first, second] = project.clips;
    expect(second.startMs).toBe(0);
    const moved = moveClipToCompatibleTrack(project, second.id, 2000, 'video');
    expect(moved).toBe(project);
    expect(moveProjectClip(project, second.id, 2000).clips.find((clip) => clip.id === second.id)?.startMs).toBe(2000);
    expect(getProjectDuration(project)).toBe(5000);
    expect(first.videoLayout).toEqual(defaultVideoLayout(project, project.assets[0]));
  });

  it('preserves video layout when crossing video tracks and maps upper timeline tracks to higher zIndex', () => {
    let project = addAsset(emptyProject(), video('a', 5000));
    project = appendVideoClip(project, project.assets[0]);
    project = addTrack(project, 'video', 'video-2');
    const original = project.clips[0];
    project = setVideoLayoutMode(project, original.id, 'pip');
    project = updateVideoLayout(project, original.id, { x: 800, opacity: 0.6 });
    project = moveClipToCompatibleTrack(project, original.id, 1200, 'video-2');
    const moved = project.clips[0];
    expect(moved).toMatchObject({ trackId: 'video-2', startMs: 1200, sourceStartMs: 0, durationMs: 5000, videoLayout: { mode: 'pip', x: 800, opacity: 0.6 } });
    // The original V1 is visually above the newly appended V2, therefore V1 covers V2.
    expect(getVideoLayerZIndex(project, 'video')).toBe(1);
    expect(getVideoLayerZIndex(project, 'video-2')).toBe(0);
    project = reorderTrack(project, 'video-2', 0);
    expect(getVideoLayerZIndex(project, 'video-2')).toBe(1);
    expect(getVideoLayerZIndex(project, 'video')).toBe(0);
  });

  it('maps three video tracks uniquely from UI top-to-bottom into WebAV top-to-bottom layers', () => {
    let project = emptyProject();
    project = addTrack(project, 'video', 'video-2');
    project = addTrack(project, 'video', 'video-3');
    expect(getVideoLayerZIndex(project, 'video')).toBe(2);
    expect(getVideoLayerZIndex(project, 'video-2')).toBe(1);
    expect(getVideoLayerZIndex(project, 'video-3')).toBe(0);
    project = reorderTrack(project, 'video-3', 0);
    expect(getVideoLayerZIndex(project, 'video-3')).toBe(2);
    expect(getVideoLayerZIndex(project, 'video')).toBe(1);
    expect(getVideoLayerZIndex(project, 'video-2')).toBe(0);
  });

  it('keeps video layout in project canvas coordinates and preserves aspect ratio when resized', () => {
    let project = addAsset(emptyProject(), video('a', 5000));
    project = appendVideoClip(project, project.assets[0]);
    const clipId = project.clips[0].id;
    project = updateVideoLayout(project, clipId, { width: 320, mode: 'custom' });
    expect(project.clips[0].videoLayout).toMatchObject({ mode: 'custom', width: 320, height: 180, x: 0, y: 0 });
    project = updateVideoLayout(project, clipId, { width: 480, height: 999 });
    expect(project.clips[0].videoLayout).toMatchObject({ width: 480, height: 270 });
    project = updateVideoLayout(project, clipId, { x: 2000, y: 1000, opacity: 3 });
    expect(project.clips[0].videoLayout).toMatchObject({ x: 800, y: 450, opacity: 1 });
  });

  it('calculates anchored eight-handle resizing with locked and unlocked aspect ratios', () => {
    const project = emptyProject();
    const asset = video('a', 5000);
    const layout = { mode: 'custom' as const, x: 320, y: 180, width: 320, height: 180, opacity: 1, keepAspectRatio: true };
    const northwest = resizedVideoLayout(project, asset, layout, 'nw', -40, -10);
    expect(northwest).toMatchObject({ x: 280, y: 158, width: 360, height: 203, keepAspectRatio: true, mode: 'custom' });
    expect(northwest.x + northwest.width).toBe(640);
    expect(northwest.y + northwest.height).toBe(361);
    const north = resizedVideoLayout(project, asset, layout, 'n', 0, -45);
    expect(north.width / north.height).toBeCloseTo(16 / 9, 2);
    expect(north.y + north.height).toBe(360);
    const unlocked = resizedVideoLayout(project, asset, { ...layout, keepAspectRatio: false }, 'e', 80, 0);
    expect(unlocked).toMatchObject({ x: 320, y: 180, width: 400, height: 180, keepAspectRatio: false });
  });

  it('keeps fit within the canvas and lets fill cover the output canvas without source-media mutation', () => {
    const project = emptyProject();
    const portrait = { ...video('portrait', 5000), width: 800, height: 600 };
    expect(defaultVideoLayout(project, portrait, 'fit')).toMatchObject({ mode: 'fit', x: 160, y: 0, width: 960, height: 720, keepAspectRatio: true });
    const fill = defaultVideoLayout(project, portrait, 'fill');
    expect(fill).toMatchObject({ mode: 'fill', x: 0, y: -120, width: 1280, height: 960, keepAspectRatio: true });
    let withClip = addAsset(project, portrait);
    withClip = appendVideoClip(withClip, portrait);
    withClip = setVideoLayoutMode(withClip, withClip.clips[0].id, 'fill');
    expect(withClip.clips[0].videoLayout).toMatchObject({ mode: 'fill', y: -120, width: 1280, height: 960 });
    expect(defaultVideoLayout(project, portrait, 'full')).toMatchObject({ mode: 'full', x: 0, y: 0, width: 1280, height: 720, keepAspectRatio: false });
  });

  it('protects the final or non-empty video track from deletion', () => {
    let project = emptyProject();
    expect(deleteEmptyTrack(project, 'video')).toBe(project);
    project = addTrack(project, 'video', 'video-2');
    expect(deleteEmptyTrack(project, 'video-2').tracks.some((track) => track.id === 'video-2')).toBe(false);
    project = addAsset(project, video('a', 2000));
    project = appendVideoClip(project, project.assets.at(-1)!, 'video');
    expect(deleteEmptyTrack(project, 'video')).toBe(project);
  });
});
