import { describe, expect, it } from 'vitest';
import { appendVideoClip, splitTimelineClip, updateSourceCrop } from '../src/editor/commands';
import { FULL_SOURCE_CROP, getSourceCrop, moveSourceCrop, resizeSourceCrop, sourceCropDisplayLayout } from '../src/editor/sourceCrop';
import { emptyProject, type Asset, type VideoLayout } from '../src/editor/types';

const asset: Asset = { id: 'v1', name: 'video.mp4', type: 'video', mimeType: 'video/mp4', durationMs: 10_000, width: 1280, height: 720 };

describe('sourceCrop project commands', () => {
  it('creates a full independent crop and preserves it when splitting', () => {
    const initial = appendVideoClip({ ...emptyProject(), assets: [asset] }, asset);
    expect(initial.clips[0]?.sourceCrop).toEqual(FULL_SOURCE_CROP);
    const cropped = updateSourceCrop(initial, initial.clips[0]!.id, { x: 0.2, y: 0.1, w: 0.5, h: 0.6 });
    const split = splitTimelineClip(cropped, cropped.clips[0]!.id, 4000);
    expect(split.clips).toHaveLength(2);
    expect(split.clips[0]?.sourceCrop).toEqual({ x: 0.2, y: 0.1, w: 0.5, h: 0.6 });
    expect(split.clips[1]?.sourceCrop).toEqual({ x: 0.2, y: 0.1, w: 0.5, h: 0.6 });
    expect(split.clips[0]).toMatchObject({ sourceStartMs: 0, durationMs: 4000 });
    expect(split.clips[1]).toMatchObject({ sourceStartMs: 4000, durationMs: 6000 });
  });

  it('bounds crop movement and eight-handle resize in source coordinates', () => {
    const moved = moveSourceCrop({ x: 0.7, y: 0.6, w: 0.3, h: 0.4 }, 0.3, 0.3);
    expect(moved).toEqual({ x: 0.7, y: 0.6, w: 0.3, h: 0.4 });
    const resized = resizeSourceCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'nw', -0.4, -0.4);
    expect(resized).toEqual({ x: 0, y: 0, w: 0.7, h: 0.7 });
  });

  it('fits a non-16:9 crop inside an aspect-locked layout instead of stretching it', () => {
    const layout: VideoLayout = { mode: 'fit', x: 0, y: 0, width: 1280, height: 720, opacity: 1, keepAspectRatio: true };
    const result = sourceCropDisplayLayout(layout, { x: 0.25, y: 0, w: 0.5, h: 1 }, asset);
    expect(result).toMatchObject({ x: 320, y: 0, width: 640, height: 720 });
  });

  it('treats legacy clips without sourceCrop as a full source frame', () => {
    expect(getSourceCrop({ sourceCrop: undefined })).toEqual(FULL_SOURCE_CROP);
  });
});
