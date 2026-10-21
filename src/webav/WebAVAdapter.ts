import { AVCanvas } from '@webav/av-canvas';
import { AudioClip, Combinator, ImgClip, MP4Clip, renderTxt2ImgBitmap, VisibleSprite } from '@webav/av-cliper';
import { defaultVideoLayout, getProjectDuration, getVideoLayerZIndex } from '../editor/commands';
import { getClipPlaybackRate, getClipSourceDurationMs, msToUs, usToMs } from '../editor/timelineMath';
import type { Asset, CaptionPosition, Project, TimelineClip } from '../editor/types';
import { CENTER_HALF_SOURCE_CROP, installFixedSourceCropPrototype } from './sourceCropPrototype';
import { getSourceCrop, isFullSourceCrop, sourceCropDisplayLayout } from '../editor/sourceCrop';
import { installSourceCropFrameTransform } from './sourceCropPrototype';

export interface RuntimeAsset {
  asset: Asset;
  file: File;
}

export interface CapabilityReport {
  supported: boolean;
  reasons: string[];
}

export interface PreviewCallbacks {
  onTimeChange: (timeMs: number) => void;
  onPlaybackChange?: (playing: boolean) => void;
}

export interface WebAVAdapterOptions {
  /** Stage A only: URL-gated real-frame crop validation, not editor state. */
  sourceCropPrototype?: boolean;
}

interface RuntimeSprite {
  sprite: VisibleSprite;
  mediaSignature: string;
}

type RenderMode = 'preview' | 'export';

const positionY = (position: CaptionPosition) => ({ top: 70, center: 330, bottom: 610 }[position]);

export class WebAVAdapter {
  private canvas: AVCanvas | null = null;
  private sprites = new Map<string, RuntimeSprite>();
  private assets = new Map<string, RuntimeAsset>();
  private project: Project | null = null;
  private callbacks?: PreviewCallbacks;
  private unsubs: Array<() => void> = [];
  private latestSyncRequest = 0;
  private syncQueue: Promise<void> = Promise.resolve();
  private readonly sourceCropPrototype: boolean;
  private renderMode: RenderMode = 'preview';
  /** Only populated while opening/cancelling the crop editor. It never mutates Project. */
  private previewCropOverrides = new Map<string, import('../editor/types').SourceCrop>();
  private cropMetrics = { previewSpriteRebuilds: 0, exportSpriteRebuilds: 0, previewFrameTransforms: 0, exportFrameTransforms: 0, cropFrameTransformMs: 0 };
  private nextCropRuntimeId = 1;

  constructor(options: WebAVAdapterOptions = {}) {
    this.sourceCropPrototype = options.sourceCropPrototype === true;
  }

  static async checkCapabilities(): Promise<CapabilityReport> {
    const reasons: string[] = [];
    const hasVideoCodecs = 'VideoDecoder' in window && 'VideoEncoder' in window;
    const hasAudioCodecs = 'AudioDecoder' in window && 'AudioEncoder' in window;
    const hasOffscreenCanvas = 'OffscreenCanvas' in window;
    if (!hasVideoCodecs) reasons.push('浏览器未提供完整 WebCodecs 视频编解码能力。');
    if (!hasAudioCodecs) reasons.push('浏览器未提供完整 WebCodecs 音频编解码能力。');
    if (!hasOffscreenCanvas) reasons.push('浏览器未提供 OffscreenCanvas。');
    if (reasons.length > 0) return { supported: false, reasons };
    try {
      if (!(await Combinator.isSupported({ width: 1280, height: 720 }))) reasons.push('WebAV Combinator 不支持当前 1280×720 编码配置。');
    } catch (error) {
      reasons.push(`无法确认 WebAV 编码能力：${error instanceof Error ? error.message : String(error)}`);
    }
    return { supported: reasons.length === 0, reasons };
  }

  attach(container: HTMLElement, callbacks: PreviewCallbacks) {
    if (this.canvas) return;
    this.callbacks = callbacks;
    this.canvas = new AVCanvas(container, { width: 1280, height: 720, bgColor: '#0b101a' });
    this.unsubs.push(this.canvas.on('timeupdate', (timeUs) => this.callbacks?.onTimeChange(usToMs(timeUs))));
    this.unsubs.push(this.canvas.on('paused', () => {
      this.callbacks?.onPlaybackChange?.(false);
      console.log('[WebAV] preview paused');
    }));
    this.unsubs.push(this.canvas.on('playing', () => {
      this.callbacks?.onPlaybackChange?.(true);
      console.log('[WebAV] preview started');
    }));
    console.log('[WebAV] canvas initialized');
  }

  async inspectFile(file: File, type: 'video' | 'audio'): Promise<Omit<Asset, 'id' | 'name' | 'type' | 'mimeType'>> {
    if (type === 'video') {
      const clip = new MP4Clip(file.stream());
      try {
        const meta = await clip.ready;
        return { durationMs: usToMs(meta.duration), width: meta.width, height: meta.height };
      } finally { clip.destroy(); }
    }
    const clip = new AudioClip(file.stream());
    try {
      const meta = await clip.ready;
      return { durationMs: usToMs(meta.duration) };
    } finally { clip.destroy(); }
  }

  registerAsset(asset: Asset, file: File) {
    this.assets.set(asset.id, { asset, file });
    console.log('[WebAV] asset registered', asset.name, asset.durationMs);
  }

  sync(project: Project, previewMs = 0, renderMode: RenderMode = 'preview'): Promise<void> {
    const request = ++this.latestSyncRequest;
    const applyIfCurrent = async () => {
      if (request !== this.latestSyncRequest) return;
      await this.applySync(project, previewMs, renderMode);
    };
    this.syncQueue = this.syncQueue.then(applyIfCurrent, applyIfCurrent);
    return this.syncQueue;
  }

  private async applySync(project: Project, previewMs: number, renderMode: RenderMode) {
    if (!this.canvas) throw new Error('预览画布尚未初始化');
    this.project = project;
    this.renderMode = renderMode;
    this.canvas.pause();
    const expectedIds = new Set<string>();
    for (const clip of project.clips.filter((item) => item.type === 'video')) {
      expectedIds.add(clip.id);
      await this.syncVideoSprite(clip, project);
    }
    for (const clip of project.clips.filter((item) => item.type === 'audio')) {
      expectedIds.add(clip.id);
      await this.syncAudioSprite(clip);
    }
    for (const clip of project.clips.filter((item) => item.type === 'caption')) {
      expectedIds.add(clip.id);
      await this.syncCaptionSprite(clip);
    }
    for (const clipId of this.sprites.keys()) if (!expectedIds.has(clipId)) this.removeSprite(clipId);
    await this.canvas.previewFrame(msToUs(Math.max(0, previewMs)));
    console.log('[WebAV] project synchronized', { sprites: this.sprites.size, previewMs });
  }

  play(startMs: number, endMs: number) {
    if (!this.canvas) return;
    this.canvas.play({ start: msToUs(startMs), end: msToUs(endMs) });
  }

  pause() { this.canvas?.pause(); }
  async previewFrame(timeMs: number) { await this.canvas?.previewFrame(msToUs(Math.max(0, timeMs))); }

  async setPreviewSourceCropOverride(clipId: string, crop?: import('../editor/types').SourceCrop, previewMs = 0, project = this.project) {
    if (crop) this.previewCropOverrides.set(clipId, crop);
    else this.previewCropOverrides.delete(clipId);
    if (!project) return;
    // Called only when entering, cancelling, or confirming crop mode — never
    // from pointermove — so just the affected video sprite is rebuilt.
    await this.sync(project, previewMs, 'preview');
    console.info('[SourceCrop]', { phase: 'preview-override-updated', clipId, crop, previewMs });
  }

  async export(project: Project, onProgress?: (progress: number) => void): Promise<Blob> {
    if (!this.canvas) throw new Error('预览画布尚未初始化');
    // Export rebuilds cropped video sprites with a physical pixel-copy crop;
    // preview uses the lighter VideoFrame.visibleRect path.
    await this.sync(project, 0, 'export');
    const durationMs = getProjectDuration(project);
    if (!durationMs) throw new Error('请先向视频轨添加有效视频。');
    const combinator = await this.canvas.createCombinator({ width: project.width, height: project.height });
    const unsubscribeProgress = combinator.on('OutputProgress', onProgress ?? (() => undefined));
    let outputError: Error | undefined;
    const unsubscribeError = combinator.on('error', (error) => { outputError = error; });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = combinator.output({ maxTime: msToUs(durationMs) }).getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      if (outputError) throw outputError;
      console.log('[WebAV] MP4 export completed', { chunks: chunks.length, durationMs });
      return new Blob(chunks, { type: 'video/mp4' });
    } finally {
      unsubscribeProgress();
      unsubscribeError();
      if (reader) {
        try { await reader.cancel(); } catch { /* Preserve the encoding error. */ }
        reader.releaseLock();
      }
      combinator.destroy();
      // Return to a decode-light editor graph even if encoding or file writing fails.
      await this.sync(project, 0, 'preview');
      console.info('[CropPerformance]', { phase: 'export-crop-metrics', ...this.cropMetrics });
    }
  }

  destroy() {
    this.clearSprites();
    this.unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
    this.canvas?.destroy();
    this.canvas = null;
    this.callbacks = undefined;
    this.assets.clear();
    console.log('[WebAV] adapter destroyed');
  }

  private async syncVideoSprite(clip: TimelineClip, project: Project) {
    const sourceCrop = this.renderMode === 'preview'
      ? this.previewCropOverrides.get(clip.id) ?? getSourceCrop(clip)
      : getSourceCrop(clip);
    const mediaSignature = JSON.stringify({ assetId: clip.assetId, sourceStartMs: clip.sourceStartMs, sourceDurationMs: clip.sourceDurationMs, durationMs: clip.durationMs, playbackRate: clip.playbackRate, volume: clip.volume, muted: clip.muted, sourceCrop, renderMode: this.renderMode, sourceCropPrototype: this.sourceCropPrototype });
    const current = this.sprites.get(clip.id);
    if (current?.mediaSignature === mediaSignature) {
      this.applyVideoSprite(current.sprite, clip, project, sourceCrop);
      return;
    }
    this.removeSprite(clip.id);
    if (this.renderMode === 'export') this.cropMetrics.exportSpriteRebuilds += 1;
    else this.cropMetrics.previewSpriteRebuilds += 1;
    const sprite = await this.createVideoSprite(clip, project, sourceCrop);
    await this.addSprite(clip.id, sprite, mediaSignature);
  }

  private applyVideoSprite(sprite: VisibleSprite, clip: TimelineClip, project: Project, sourceCrop = getSourceCrop(clip)) {
    const asset = clip.assetId ? this.assets.get(clip.assetId)?.asset : undefined;
    const layout = clip.videoLayout ?? defaultVideoLayout(project, asset);
    // The same source crop is used by preview and the temporary export graph.
    // VideoFrame.visibleRect keeps the common preview path lightweight; a Canvas
    // frame copy is only used when that WebCodecs operation is unsupported.
    const displayLayout = sourceCropDisplayLayout(layout, sourceCrop, asset);
    sprite.rect.x = displayLayout.x;
    sprite.rect.y = displayLayout.y;
    sprite.rect.w = displayLayout.width;
    sprite.rect.h = displayLayout.height;
    sprite.opacity = layout.opacity;
    // Track order is UI top-to-bottom. `getVideoLayerZIndex` inverts that order so
    // the upper timeline video track gets the higher WebAV zIndex. This is called
    // for an unchanged media signature too, so reordering tracks does not rebuild media.
    sprite.zIndex = getVideoLayerZIndex(project, clip.trackId);
    sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs), playbackRate: getClipPlaybackRate(clip) };
  }

  private async createVideoSprite(clip: TimelineClip, project: Project, sourceCrop = getSourceCrop(clip)) {
    const runtime = clip.assetId ? this.assets.get(clip.assetId) : undefined;
    if (!runtime) throw new Error(`视频素材“${clip.name}”不存在，请重新导入。`);
    let media = new MP4Clip(runtime.file.stream(), { audio: { volume: clip.muted ? 0 : clip.volume } });
    await media.ready;
    if (clip.sourceStartMs > 0) {
      const source = media;
      const [discarded, remainder] = await source.split(msToUs(clip.sourceStartMs));
      source.destroy();
      discarded.destroy();
      media = remainder;
    }
    const sourceDurationMs = getClipSourceDurationMs(clip);
    if (sourceDurationMs < usToMs(media.meta.duration)) {
      const source = media;
      const [selected, discarded] = await source.split(msToUs(sourceDurationMs));
      source.destroy();
      discarded.destroy();
      media = selected;
    }
    if (this.sourceCropPrototype) {
      installFixedSourceCropPrototype(media, CENTER_HALF_SOURCE_CROP);
      console.info('[SourceCropPrototype] installed fixed central 50% source crop', { clipId: clip.id, crop: CENTER_HALF_SOURCE_CROP });
    } else if (!isFullSourceCrop(sourceCrop)) {
      const renderMode = this.renderMode;
      const runtimeId = `${clip.id}:${renderMode}:${this.nextCropRuntimeId++}`;
      installSourceCropFrameTransform(media, sourceCrop, (trace) => {
        if (renderMode === 'export') this.cropMetrics.exportFrameTransforms += 1;
        else this.cropMetrics.previewFrameTransforms += 1;
        this.cropMetrics.cropFrameTransformMs += trace.elapsedMs;
        if (trace.invocation === 1) console.info('[SourceCrop] first transformed frame', { runtimeId, clipId: clip.id, renderMode, sourceCrop, ...trace });
        if (trace.path === 'canvas' && trace.invocation === 1) console.warn('[SourceCrop] using Canvas fallback for decoded frames', { runtimeId, clipId: clip.id, renderMode });
      }, { forceCanvas: renderMode === 'export' });
      console.info('[SourceCrop] installed source crop', { runtimeId, clipId: clip.id, sourceCrop, renderMode });
    }
    const sprite = new VisibleSprite(media);
    this.applyVideoSprite(sprite, clip, project, sourceCrop);
    sprite.interactable = 'disabled';
    return sprite;
  }

  private async syncAudioSprite(clip: TimelineClip) {
    const mediaSignature = JSON.stringify({ assetId: clip.assetId, sourceStartMs: clip.sourceStartMs, sourceDurationMs: clip.sourceDurationMs, durationMs: clip.durationMs, playbackRate: clip.playbackRate, volume: clip.volume, muted: clip.muted });
    const current = this.sprites.get(clip.id);
    if (current?.mediaSignature === mediaSignature) {
      current.sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs), playbackRate: getClipPlaybackRate(clip) };
      return;
    }
    this.removeSprite(clip.id);
    const runtime = clip.assetId ? this.assets.get(clip.assetId) : undefined;
    if (!runtime) throw new Error(`音频素材“${clip.name}”不存在，请重新导入。`);
    let audio = new AudioClip(runtime.file.stream(), { volume: clip.muted ? 0 : clip.volume });
    await audio.ready;
    if (clip.sourceStartMs > 0) {
      const source = audio;
      const [discarded, remainder] = await source.split(msToUs(clip.sourceStartMs));
      source.destroy();
      discarded.destroy();
      audio = remainder;
    }
    const sourceDurationMs = getClipSourceDurationMs(clip);
    if (sourceDurationMs < usToMs(audio.meta.duration)) {
      const source = audio;
      const [selected, discarded] = await source.split(msToUs(sourceDurationMs));
      source.destroy();
      discarded.destroy();
      audio = selected;
    }
    const sprite = new VisibleSprite(audio);
    sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs), playbackRate: getClipPlaybackRate(clip) };
    sprite.interactable = 'disabled';
    await this.addSprite(clip.id, sprite, mediaSignature);
  }

  private async syncCaptionSprite(clip: TimelineClip) {
    const mediaSignature = JSON.stringify({ text: clip.text, captionStyle: clip.captionStyle });
    const current = this.sprites.get(clip.id);
    if (current?.mediaSignature === mediaSignature) {
      current.sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs) };
      return;
    }
    this.removeSprite(clip.id);
    const style = clip.captionStyle ?? { fontSize: 46, color: '#ffffff', position: 'bottom' as const };
    const bitmap = await renderTxt2ImgBitmap(clip.text ?? '', `font-size:${style.fontSize}px; color:${style.color}; font-weight:700; text-shadow: 2px 2px 5px #000; padding:8px 18px;`);
    const media = new ImgClip(bitmap);
    await media.ready;
    const sprite = new VisibleSprite(media);
    sprite.rect.x = Math.round((1280 - media.meta.width) / 2);
    sprite.rect.y = positionY(style.position);
    sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs) };
    sprite.zIndex = 10_000;
    sprite.interactable = 'selectable';
    await this.addSprite(clip.id, sprite, mediaSignature);
  }

  private async addSprite(clipId: string, sprite: VisibleSprite, mediaSignature: string) {
    await this.canvas?.addSprite(sprite);
    this.sprites.set(clipId, { sprite, mediaSignature });
  }

  private removeSprite(clipId: string) {
    const runtime = this.sprites.get(clipId);
    if (!runtime) return;
    this.canvas?.removeSprite(runtime.sprite);
    runtime.sprite.destroy();
    this.sprites.delete(clipId);
  }

  private clearSprites() {
    if (!this.canvas) return;
    for (const clipId of this.sprites.keys()) this.removeSprite(clipId);
  }
}
