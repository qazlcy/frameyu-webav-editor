import { describe, expect, it } from 'vitest';
import { CENTER_HALF_SOURCE_CROP, normaliseSourceCrop, sourceCropPixels } from '../src/webav/sourceCropPrototype';

describe('Stage A source-crop prototype math', () => {
  it('maps the fixed central 50% crop into source pixels', () => {
    expect(sourceCropPixels(CENTER_HALF_SOURCE_CROP, 1280, 720)).toEqual({ sx: 320, sy: 180, sw: 640, sh: 360 });
  });

  it('keeps prototype input inside the normalized source frame', () => {
    expect(normaliseSourceCrop({ x: -1, y: 0.9, w: 8, h: 1 })).toEqual({ x: 0, y: 0.9, w: 1, h: 0.09999999999999998 });
  });
});
