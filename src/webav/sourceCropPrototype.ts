import type { MP4Clip } from '@webav/av-cliper';
import type { SourceCrop } from '../editor/types';

/**
 * Stage A only: a fixed, opt-in crop used to validate WebAV's decoded-frame
 * interception path. This is deliberately not persisted in Project.
 */
export type NormalizedSourceCrop = SourceCrop;

export const CENTER_HALF_SOURCE_CROP: Readonly<NormalizedSourceCrop> = Object.freeze({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

export interface SourceCropPixels { sx: number; sy: number; sw: number; sh: number; }

export function normaliseSourceCrop(crop: NormalizedSourceCrop): NormalizedSourceCrop {
  const x = Math.min(1, Math.max(0, crop.x));
  const y = Math.min(1, Math.max(0, crop.y));
  return { x, y, w: Math.min(1 - x, Math.max(0.001, crop.w)), h: Math.min(1 - y, Math.max(0.001, crop.h)) };
}

export function sourceCropPixels(crop: NormalizedSourceCrop, width: number, height: number): SourceCropPixels {
  const safe = normaliseSourceCrop(crop);
  return { sx: Math.round(safe.x * width), sy: Math.round(safe.y * height), sw: Math.max(1, Math.round(safe.w * width)), sh: Math.max(1, Math.round(safe.h * height)) };
}

interface FrameCanvas { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D; width: number; height: number; }

/**
 * MP4Clip.clone() copies tickInterceptor in WebAV 1.2.8. As a result the
 * AVCanvas preview and the OffscreenSprite used by createCombinator use this
 * same decoded-frame transform.
 */
export function installSourceCropFrameTransform(clip: MP4Clip, crop: NormalizedSourceCrop) {
  let frameCanvas: FrameCanvas | undefined;
  const fixedCrop = normaliseSourceCrop(crop);
  clip.tickInterceptor = async (_timeUs, tickResult) => {
    const sourceFrame = tickResult.video;
    if (!sourceFrame) return tickResult;
    const width = sourceFrame.displayWidth || sourceFrame.codedWidth;
    const height = sourceFrame.displayHeight || sourceFrame.codedHeight;
    if (width <= 0 || height <= 0) return tickResult;
    if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('当前浏览器无法执行真实源画面裁切：缺少 OffscreenCanvas 或 VideoFrame。');
    const { sx, sy, sw, sh } = sourceCropPixels(fixedCrop, width, height);
    if (!frameCanvas || frameCanvas.width !== sw || frameCanvas.height !== sh) {
      const canvas = new OffscreenCanvas(sw, sh);
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('无法创建源画面裁切所需的 2D Canvas 上下文。');
      frameCanvas = { canvas, context, width: sw, height: sh };
    }
    try {
      frameCanvas.context.clearRect(0, 0, sw, sh);
      frameCanvas.context.drawImage(sourceFrame, sx, sy, sw, sh, 0, 0, sw, sh);
      const init: VideoFrameInit = { timestamp: sourceFrame.timestamp };
      if (sourceFrame.duration !== null) init.duration = sourceFrame.duration;
      const croppedFrame = new VideoFrame(frameCanvas.canvas, init);
      // Sprite will receive only the replacement frame, so this interceptor owns
      // the decoded input frame after drawImage has synchronously consumed it.
      sourceFrame.close();
      return { ...tickResult, video: croppedFrame };
    } catch (error) {
      // If drawing/construction failed, retain WebAV's normal ownership of the
      // original return frame rather than closing it prematurely.
      throw error;
    }
  };
}

export function installFixedSourceCropPrototype(clip: MP4Clip, crop: NormalizedSourceCrop = CENTER_HALF_SOURCE_CROP) {
  installSourceCropFrameTransform(clip, crop);
}
