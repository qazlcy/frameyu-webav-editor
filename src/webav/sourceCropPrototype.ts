import type { MP4Clip } from '@webav/av-cliper';
import type { SourceCrop } from '../editor/types';

/**
 * Stage A only: a fixed, opt-in crop used to validate WebAV's decoded-frame
 * interception path. This is deliberately not persisted in Project.
 */
export type NormalizedSourceCrop = SourceCrop;

export const CENTER_HALF_SOURCE_CROP: Readonly<NormalizedSourceCrop> = Object.freeze({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });

export interface SourceCropPixels { sx: number; sy: number; sw: number; sh: number; }
export interface SourceCropPixelBase { x: number; y: number; width: number; height: number; }

export function normaliseSourceCrop(crop: NormalizedSourceCrop): NormalizedSourceCrop {
  const x = Math.min(1, Math.max(0, crop.x));
  const y = Math.min(1, Math.max(0, crop.y));
  return { x, y, w: Math.min(1 - x, Math.max(0.001, crop.w)), h: Math.min(1 - y, Math.max(0.001, crop.h)) };
}

export function sourceCropPixels(crop: NormalizedSourceCrop, width: number, height: number): SourceCropPixels {
  const safe = normaliseSourceCrop(crop);
  return { sx: Math.round(safe.x * width), sy: Math.round(safe.y * height), sw: Math.max(1, Math.round(safe.w * width)), sh: Math.max(1, Math.round(safe.h * height)) };
}

/** Maps a normalized crop inside an existing coded-frame visible rectangle. */
export function sourceCropPixelsWithin(crop: NormalizedSourceCrop, base: SourceCropPixelBase): SourceCropPixels {
  const relative = sourceCropPixels(crop, base.width, base.height);
  return { ...relative, sx: Math.round(base.x + relative.sx), sy: Math.round(base.y + relative.sy) };
}

interface FrameCanvas { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D; width: number; height: number; }

export interface SourceCropFrameTrace {
  invocation: number;
  path: 'visible-rect' | 'canvas';
  cropPixels: SourceCropPixels;
  displayCropPixels: SourceCropPixels;
  input: { codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number; visibleRect: DOMRectReadOnly | null };
  output: { codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number; visibleRect: DOMRectReadOnly | null };
  elapsedMs: number;
}

export interface SourceCropFrameTransformOptions { forceCanvas?: boolean; }

function frameInit(sourceFrame: VideoFrame): VideoFrameInit {
  const init: VideoFrameInit = { timestamp: sourceFrame.timestamp };
  if (sourceFrame.duration !== null) init.duration = sourceFrame.duration;
  return init;
}

/**
 * MP4Clip.clone() copies tickInterceptor in WebAV 1.2.8. As a result the
 * AVCanvas preview and the OffscreenSprite used by createCombinator use this
 * same decoded-frame transform.
 */
export function installSourceCropFrameTransform(clip: MP4Clip, crop: NormalizedSourceCrop, onFrameProcessed?: (trace: SourceCropFrameTrace) => void, options: SourceCropFrameTransformOptions = {}) {
  let frameCanvas: FrameCanvas | undefined;
  let invocation = 0;
  const fixedCrop = normaliseSourceCrop(crop);
  clip.tickInterceptor = async (_timeUs, tickResult) => {
    const sourceFrame = tickResult.video;
    if (!sourceFrame) return tickResult;
    // visibleRect is expressed in the frame's coded coordinate space. It is a
    // zero-copy crop in Chromium/WebCodecs and is consequently suitable for
    // the normal editor preview too. The Canvas path below remains the
    // compatibility fallback for implementations that reject a visible rect.
    const codedWidth = sourceFrame.codedWidth || sourceFrame.displayWidth;
    const codedHeight = sourceFrame.codedHeight || sourceFrame.displayHeight;
    const displayWidth = sourceFrame.displayWidth || codedWidth;
    const displayHeight = sourceFrame.displayHeight || codedHeight;
    if (codedWidth <= 0 || codedHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) return tickResult;
    if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('当前浏览器无法执行真实源画面裁切：缺少 OffscreenCanvas 或 VideoFrame。');
    const sourceVisibleRect = sourceFrame.visibleRect ?? { x: 0, y: 0, width: codedWidth, height: codedHeight };
    const cropPixels = sourceCropPixelsWithin(fixedCrop, sourceVisibleRect);
    const displayCropPixels = sourceCropPixels(fixedCrop, displayWidth, displayHeight);
    const { sx, sy, sw, sh } = cropPixels;
    const input = { codedWidth: sourceFrame.codedWidth, codedHeight: sourceFrame.codedHeight, displayWidth: sourceFrame.displayWidth, displayHeight: sourceFrame.displayHeight, visibleRect: sourceFrame.visibleRect };
    const report = (croppedFrame: VideoFrame, path: SourceCropFrameTrace['path'], startedAt: number) => onFrameProcessed?.({
      invocation: ++invocation,
      path,
      cropPixels,
      displayCropPixels,
      input,
      output: { codedWidth: croppedFrame.codedWidth, codedHeight: croppedFrame.codedHeight, displayWidth: croppedFrame.displayWidth, displayHeight: croppedFrame.displayHeight, visibleRect: croppedFrame.visibleRect },
      elapsedMs: performance.now() - startedAt,
    });
    try {
      const startedAt = performance.now();
      try {
        if (options.forceCanvas) throw new Error('Canvas crop explicitly requested');
        const croppedFrame = new VideoFrame(sourceFrame, {
          ...frameInit(sourceFrame),
          visibleRect: { x: sx, y: sy, width: sw, height: sh },
          displayWidth: displayCropPixels.sw,
          displayHeight: displayCropPixels.sh,
        });
        sourceFrame.close();
        report(croppedFrame, 'visible-rect', startedAt);
        return { ...tickResult, video: croppedFrame };
      } catch (visibleRectError) {
        // Some WebCodecs implementations cannot construct a cropped view for
        // every decoded frame format. Fall through to the established pixel
        // copy implementation instead of returning the uncropped source.
        if (!options.forceCanvas) console.warn('[SourceCrop] VideoFrame.visibleRect unavailable; using Canvas fallback', visibleRectError);
      }
      const { sx: displayX, sy: displayY, sw: displayW, sh: displayH } = displayCropPixels;
      if (!frameCanvas || frameCanvas.width !== displayW || frameCanvas.height !== displayH) {
        const canvas = new OffscreenCanvas(displayW, displayH);
        const context = canvas.getContext('2d', { alpha: true });
        if (!context) throw new Error('无法创建源画面裁切所需的 2D Canvas 上下文。');
        frameCanvas = { canvas, context, width: displayW, height: displayH };
      }
      frameCanvas.context.clearRect(0, 0, displayW, displayH);
      frameCanvas.context.drawImage(sourceFrame, displayX, displayY, displayW, displayH, 0, 0, displayW, displayH);
      const croppedFrame = new VideoFrame(frameCanvas.canvas, frameInit(sourceFrame));
      // Sprite will receive only the replacement frame, so this interceptor owns
      // the decoded input frame after drawImage has synchronously consumed it.
      sourceFrame.close();
      report(croppedFrame, 'canvas', startedAt);
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
