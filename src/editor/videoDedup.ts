import type { Asset } from './types';

export interface VideoFingerprint {
  fileSize: number;
  contentHash: string;
}

export type VideoHashFile = Pick<File, 'size'>;
export type VideoHashFunction = (file: File) => Promise<string>;

export type VideoImportClaim =
  | { kind: 'duplicate'; assetId: string; fingerprint: VideoFingerprint; candidateCount: number; hashDurationMs: number }
  | { kind: 'new'; fingerprint: VideoFingerprint; candidateCount: number; hashDurationMs: number; commit: (assetId: string) => void; abort: () => void };

/**
 * Serializes the small critical section after hashing. Hashing itself may run in
 * parallel, but exactly one import owns a content hash until it commits or aborts.
 */
export class MediaContentDeduplicator {
  private readonly hashByFile = new WeakMap<File, Promise<string>>();
  private readonly hashByAssetId = new Map<string, VideoFingerprint>();
  private readonly knownAssetByHash = new Map<string, string>();
  private readonly reservations = new Map<string, Promise<string | undefined>>();

  constructor(private readonly hashFile: VideoHashFunction, private readonly assetType: Asset['type'] = 'video') {}

  async claim(file: File, assets: readonly Asset[]): Promise<VideoImportClaim> {
    this.syncAssets(assets);
    const candidateCount = assets.filter((asset) => asset.type === this.assetType && asset.fileSize === file.size).length;
    const startedAt = performance.now();
    const contentHash = await this.hash(file);
    const hashDurationMs = performance.now() - startedAt;
    const fingerprint = { fileSize: file.size, contentHash };
    const duplicateAssetId = assets.find((asset) => asset.type === this.assetType && asset.fileSize === file.size && asset.contentHash === contentHash)?.id
      ?? this.knownAssetByHash.get(contentHash);
    if (duplicateAssetId) return { kind: 'duplicate', assetId: duplicateAssetId, fingerprint, candidateCount, hashDurationMs };

    const pending = this.reservations.get(contentHash);
    if (pending) {
      const resolvedAssetId = await pending;
      if (resolvedAssetId) return { kind: 'duplicate', assetId: resolvedAssetId, fingerprint, candidateCount, hashDurationMs };
      // The earlier import failed after claiming this hash. Retry the short critical section.
      return this.claim(file, assets);
    }

    let settle!: (assetId: string | undefined) => void;
    const reservation = new Promise<string | undefined>((resolve) => { settle = resolve; });
    this.reservations.set(contentHash, reservation);
    let settled = false;
    const finish = (assetId: string | undefined) => {
      if (settled) return;
      settled = true;
      this.reservations.delete(contentHash);
      if (assetId) {
        this.knownAssetByHash.set(contentHash, assetId);
        this.hashByAssetId.set(assetId, fingerprint);
      }
      settle(assetId);
    };
    return { kind: 'new', fingerprint, candidateCount, hashDurationMs, commit: (assetId) => finish(assetId), abort: () => finish(undefined) };
  }

  getFingerprint(assetId: string) { return this.hashByAssetId.get(assetId); }

  private syncAssets(assets: readonly Asset[]) {
    for (const asset of assets) {
      if (asset.type !== this.assetType || !asset.contentHash || asset.fileSize === undefined) continue;
      const fingerprint = { fileSize: asset.fileSize, contentHash: asset.contentHash };
      this.hashByAssetId.set(asset.id, fingerprint);
      this.knownAssetByHash.set(fingerprint.contentHash, asset.id);
    }
  }

  private hash(file: File) {
    let task = this.hashByFile.get(file);
    if (!task) {
      task = this.hashFile(file).catch((error: unknown) => {
        this.hashByFile.delete(file);
        throw error;
      });
      this.hashByFile.set(file, task);
    }
    return task;
  }
}

// Keep the existing video entry point and worker; audio shares the same algorithm.
export { MediaContentDeduplicator as VideoContentDeduplicator };

const hexDigest = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Worker keeps complete-file SHA-256 buffer allocation and digest work off the UI thread. */
export function hashVideoFile(file: File): Promise<string> {
  if (typeof Worker !== 'undefined') {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./videoHash.worker.ts', import.meta.url), { type: 'module' });
      const cleanup = () => worker.terminate();
      worker.onmessage = (event: MessageEvent<{ hash?: string; error?: string }>) => {
        cleanup();
        if (event.data.hash) resolve(event.data.hash);
        else reject(new Error(event.data.error ?? '后台 SHA-256 计算失败。'));
      };
      worker.onerror = () => { cleanup(); reject(new Error('无法启动后台媒体指纹任务。')); };
      worker.postMessage({ file });
    });
  }
  // WebCrypto digest is asynchronous. This fallback is for older browsers only;
  // Chromium/Edge use the worker path above.
  return file.arrayBuffer().then((buffer) => crypto.subtle.digest('SHA-256', buffer)).then(hexDigest);
}
