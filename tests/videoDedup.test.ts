import { describe, expect, it } from 'vitest';
import { VideoContentDeduplicator } from '../src/editor/videoDedup';
import type { Asset } from '../src/editor/types';

const file = (name: string, size: number) => ({ name, size } as File);
const video = (id: string, size: number, hash: string): Asset => ({ id, name: `${id}.mp4`, type: 'video', mimeType: 'video/mp4', durationMs: 1000, fileSize: size, contentHash: hash });

describe('video content deduplication', () => {
  it('uses size as a candidate filter but confirms a same-size duplicate by SHA-256 content hash', async () => {
    const dedup = new VideoContentDeduplicator(async (input) => input.name === 'renamed.mp4' ? 'same-content' : 'different-content');
    const assets = [video('existing', 32, 'same-content')];
    await expect(dedup.claim(file('renamed.mp4', 32), assets)).resolves.toMatchObject({ kind: 'duplicate', assetId: 'existing', candidateCount: 1 });
    const fresh = await dedup.claim(file('same-name.mp4', 32), assets);
    expect(fresh).toMatchObject({ kind: 'new', candidateCount: 1, fingerprint: { contentHash: 'different-content' } });
    if (fresh.kind === 'new') fresh.abort();
  });

  it('does not reject equal file names when their content differs', async () => {
    const dedup = new VideoContentDeduplicator(async (input) => input.name === 'clip.mp4' ? 'second' : 'first');
    const assets = [video('existing', 10, 'first')];
    const claim = await dedup.claim(file('clip.mp4', 10), assets);
    expect(claim.kind).toBe('new');
    if (claim.kind === 'new') claim.abort();
  });

  it('allows the first concurrent claimant to register and turns the second into a duplicate', async () => {
    let releaseHash!: () => void;
    const hashReady = new Promise<void>((resolve) => { releaseHash = resolve; });
    const dedup = new VideoContentDeduplicator(async () => { await hashReady; return 'shared'; });
    const firstPromise = dedup.claim(file('first.mp4', 20), []);
    const secondPromise = dedup.claim(file('second.mp4', 20), []);
    releaseHash();
    const first = await firstPromise;
    expect(first.kind).toBe('new');
    if (first.kind !== 'new') throw new Error('expected reservation owner');
    first.commit('asset-first');
    await expect(secondPromise).resolves.toMatchObject({ kind: 'duplicate', assetId: 'asset-first' });
    expect(dedup.getFingerprint('asset-first')).toEqual({ fileSize: 20, contentHash: 'shared' });
  });

  it('releases an aborted reservation so a later import can proceed', async () => {
    const dedup = new VideoContentDeduplicator(async () => 'retryable');
    const first = await dedup.claim(file('failed.mp4', 20), []);
    if (first.kind !== 'new') throw new Error('expected reservation owner');
    first.abort();
    const second = await dedup.claim(file('retry.mp4', 20), []);
    expect(second.kind).toBe('new');
    if (second.kind === 'new') second.abort();
  });
});
