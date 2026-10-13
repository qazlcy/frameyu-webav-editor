import { AVCanvas } from '@webav/av-canvas';
import { AudioClip, Combinator, ImgClip, MP4Clip, renderTxt2ImgBitmap, VisibleSprite } from '@webav/av-cliper';
import { msToUs, usToMs } from '../editor/timelineMath';
import type { Asset, CaptionPosition, Project, TimelineClip } from '../editor/types';

export interface RuntimeAsset {
  asset: Asset;
  file: File;
}

export interface CapabilityReport {
  supported: boolean;
  reasons: string[];
}

const positionY = (position: CaptionPosition) => ({ top: 70, center: 330, bottom: 610 }[position]);

export class WebAVAdapter {
  private canvas: AVCanvas | null = null;
  private sprites: VisibleSprite[] = [];
  private assets = new Map<string, RuntimeAsset>();
  private project: Project | null = null;
  private onTimeChange?: (timeMs: number) => void;
  private unsubs: Array<() => void> = [];

  static async checkCapabilities(): Promise<CapabilityReport> {
    const reasons: string[] = [];
    if (!('VideoDecoder' in window) || !('VideoEncoder' in window)) reasons.push('浏览器未提供完整 WebCodecs 视频编解码能力。');
    if (!('AudioDecoder' in window) || !('AudioEncoder' in window)) reasons.push('浏览器未提供完整 WebCodecs 音频编解码能力。');
    if (!('OffscreenCanvas' in window)) reasons.push('浏览器未提供 OffscreenCanvas。');
    try {
      if (!(await Combinator.isSupported({ width: 1280, height: 720 }))) reasons.push('WebAV Combinator 不支持当前 1280×720 编码配置。');
    } catch (error) {
      reasons.push(`无法确认 WebAV 编码能力：${error instanceof Error ? error.message : String(error)}`);
    }
    return { supported: reasons.length === 0, reasons };
  }

  attach(container: HTMLElement, onTimeChange: (timeMs: number) => void) {
    if (this.canvas) return;
    this.onTimeChange = onTimeChange;
    this.canvas = new AVCanvas(container, { width: 1280, height: 720, bgColor: '#0b101a' });
    this.unsubs.push(this.canvas.on('timeupdate', (timeUs) => this.onTimeChange?.(usToMs(timeUs))));
    this.unsubs.push(this.canvas.on('paused', () => console.log('[WebAV] preview paused')));
    this.unsubs.push(this.canvas.on('playing', () => console.log('[WebAV] preview started')));
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

  async sync(project: Project, previewMs = 0) {
    if (!this.canvas) throw new Error('预览画布尚未初始化');
    this.project = project;
    this.canvas.pause();
    this.clearSprites();
    const videoClip = project.clips.find((clip) => clip.type === 'video');
    if (videoClip) await this.addVideoSprite(videoClip, project);
    for (const clip of project.clips.filter((item) => item.type === 'audio')) await this.addAudioSprite(clip);
    for (const clip of project.clips.filter((item) => item.type === 'caption')) await this.addCaptionSprite(clip);
    await this.canvas.previewFrame(msToUs(Math.max(0, previewMs)));
    console.log('[WebAV] project synchronized', { sprites: this.sprites.length, previewMs });
  }

  play(startMs: number, endMs: number) {
    if (!this.canvas) return;
    this.canvas.play({ start: msToUs(startMs), end: msToUs(endMs) });
  }

  pause() { this.canvas?.pause(); }
  async previewFrame(timeMs: number) { await this.canvas?.previewFrame(msToUs(Math.max(0, timeMs))); }

  async export(project: Project, onProgress?: (progress: number) => void): Promise<Blob> {
    if (!this.canvas) throw new Error('预览画布尚未初始化');
    await this.sync(project, 0);
    const durationMs = this.mainDuration(project);
    if (!durationMs) throw new Error('请先导入有效的主视频。');
    const combinator = await this.canvas.createCombinator({ width: project.width, height: project.height });
    const unsubscribeProgress = combinator.on('OutputProgress', onProgress ?? (() => undefined));
    try {
      const reader = combinator.output({ maxTime: msToUs(durationMs) }).getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      console.log('[WebAV] MP4 export completed', { chunks: chunks.length, durationMs });
      return new Blob(chunks, { type: 'video/mp4' });
    } finally {
      unsubscribeProgress();
      combinator.destroy();
    }
  }

  destroy() {
    this.clearSprites();
    this.unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
    this.canvas?.destroy();
    this.canvas = null;
    this.assets.clear();
    console.log('[WebAV] adapter destroyed');
  }

  private mainDuration(project: Project) {
    const id = project.mainVideoAssetId;
    return id ? project.assets.find((asset) => asset.id === id)?.durationMs ?? 0 : 0;
  }

  private async addVideoSprite(clip: TimelineClip, project: Project) {
    const runtime = clip.assetId ? this.assets.get(clip.assetId) : undefined;
    if (!runtime) throw new Error('主视频文件不存在，请重新导入。');
    const media = new MP4Clip(runtime.file.stream());
    const meta = await media.ready;
    const sprite = new VisibleSprite(media);
    const scale = Math.min(project.width / meta.width, project.height / meta.height);
    sprite.rect.w = Math.round(meta.width * scale);
    sprite.rect.h = Math.round(meta.height * scale);
    sprite.rect.x = Math.round((project.width - sprite.rect.w) / 2);
    sprite.rect.y = Math.round((project.height - sprite.rect.h) / 2);
    sprite.time = { offset: 0, duration: msToUs(clip.durationMs) };
    sprite.interactable = 'disabled';
    await this.addSprite(sprite);
  }

  private async addAudioSprite(clip: TimelineClip) {
    const runtime = clip.assetId ? this.assets.get(clip.assetId) : undefined;
    if (!runtime) throw new Error(`音频素材“${clip.name}”不存在，请重新导入。`);
    let audio = new AudioClip(runtime.file.stream(), { volume: clip.volume });
    await audio.ready;
    if (clip.sourceStartMs > 0) {
      const [discarded, remainder] = await audio.split(msToUs(clip.sourceStartMs));
      discarded.destroy();
      audio = remainder;
    }
    if (clip.durationMs < usToMs(audio.meta.duration)) {
      const [selected, discarded] = await audio.split(msToUs(clip.durationMs));
      discarded.destroy();
      audio = selected;
    }
    const sprite = new VisibleSprite(audio);
    sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs) };
    sprite.interactable = 'disabled';
    await this.addSprite(sprite);
  }

  private async addCaptionSprite(clip: TimelineClip) {
    const style = clip.captionStyle ?? { fontSize: 46, color: '#ffffff', position: 'bottom' as const };
    const bitmap = await renderTxt2ImgBitmap(clip.text ?? '', `font-size:${style.fontSize}px; color:${style.color}; font-weight:700; text-shadow: 2px 2px 5px #000; padding:8px 18px;`);
    const media = new ImgClip(bitmap);
    await media.ready;
    const sprite = new VisibleSprite(media);
    sprite.rect.x = Math.round((1280 - media.meta.width) / 2);
    sprite.rect.y = positionY(style.position);
    sprite.time = { offset: msToUs(clip.startMs), duration: msToUs(clip.durationMs) };
    sprite.zIndex = 10;
    sprite.interactable = 'selectable';
    await this.addSprite(sprite);
  }

  private async addSprite(sprite: VisibleSprite) {
    await this.canvas?.addSprite(sprite);
    this.sprites.push(sprite);
  }

  private clearSprites() {
    if (!this.canvas) return;
    for (const sprite of this.sprites) {
      this.canvas.removeSprite(sprite);
      sprite.destroy();
    }
    this.sprites = [];
  }
}
