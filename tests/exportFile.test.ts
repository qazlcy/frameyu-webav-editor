import { describe, expect, it } from 'vitest';
import { normaliseMp4Filename } from '../src/export/exportFile';

describe('MP4 export filename', () => {
  it('always uses the actual MP4 extension without duplicating it', () => {
    expect(normaliseMp4Filename('demo')).toBe('demo.mp4');
    expect(normaliseMp4Filename(' demo.MP4 ')).toBe('demo.mp4');
    expect(normaliseMp4Filename('')).toBe('frameyu-demo.mp4');
  });
});
