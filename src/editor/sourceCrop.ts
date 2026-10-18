import type { Asset, SourceCrop, TimelineClip, VideoLayout, VideoResizeHandle } from './types';
import { clamp } from './timelineMath';

export const FULL_SOURCE_CROP: Readonly<SourceCrop> = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const MIN_SOURCE_CROP_SIZE = 0.04;

export function getSourceCrop(clip: Pick<TimelineClip, 'sourceCrop'>): SourceCrop {
  return normaliseSourceCrop(clip.sourceCrop ?? FULL_SOURCE_CROP);
}

export function normaliseSourceCrop(crop: SourceCrop): SourceCrop {
  const x = clamp(crop.x, 0, 1 - MIN_SOURCE_CROP_SIZE);
  const y = clamp(crop.y, 0, 1 - MIN_SOURCE_CROP_SIZE);
  return { x, y, w: clamp(crop.w, MIN_SOURCE_CROP_SIZE, 1 - x), h: clamp(crop.h, MIN_SOURCE_CROP_SIZE, 1 - y) };
}

export function isFullSourceCrop(crop: SourceCrop) {
  return crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
}

export function sourceCropAspect(crop: SourceCrop, asset?: Pick<Asset, 'width' | 'height'>) {
  const sourceAspect = asset?.width && asset?.height ? asset.width / asset.height : 16 / 9;
  return sourceAspect * crop.w / crop.h;
}

/** Keeps the selected source area inside its normalized [0, 1] frame. */
export function moveSourceCrop(crop: SourceCrop, deltaX: number, deltaY: number): SourceCrop {
  const safe = normaliseSourceCrop(crop);
  return { ...safe, x: clamp(safe.x + deltaX, 0, 1 - safe.w), y: clamp(safe.y + deltaY, 0, 1 - safe.h) };
}

/** Resizes one of eight crop handles. Optional ratio is source-space width / height. */
export function resizeSourceCrop(crop: SourceCrop, handle: VideoResizeHandle, deltaX: number, deltaY: number, lockedAspect?: number): SourceCrop {
  const safe = normaliseSourceCrop(crop);
  const left = safe.x;
  const top = safe.y;
  const right = safe.x + safe.w;
  const bottom = safe.y + safe.h;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  let nextLeft = west ? clamp(left + deltaX, 0, right - MIN_SOURCE_CROP_SIZE) : left;
  let nextRight = east ? clamp(right + deltaX, left + MIN_SOURCE_CROP_SIZE, 1) : right;
  let nextTop = north ? clamp(top + deltaY, 0, bottom - MIN_SOURCE_CROP_SIZE) : top;
  let nextBottom = south ? clamp(bottom + deltaY, top + MIN_SOURCE_CROP_SIZE, 1) : bottom;

  if (lockedAspect && lockedAspect > 0) {
    const anchorX = west ? right : east ? left : (left + right) / 2;
    const anchorY = north ? bottom : south ? top : (top + bottom) / 2;
    const widthDelta = west || east ? Math.abs((west ? nextLeft : nextRight) - anchorX) : 0;
    const heightDelta = north || south ? Math.abs((north ? nextTop : nextBottom) - anchorY) : 0;
    const useWidth = widthDelta / lockedAspect >= heightDelta;
    let width = useWidth ? widthDelta : heightDelta * lockedAspect;
    let height = width / lockedAspect;
    if (!west && !east) width = height * lockedAspect;
    if (!north && !south) height = width / lockedAspect;
    const maxWidth = west ? anchorX : east ? 1 - anchorX : Math.min(anchorX, 1 - anchorX) * 2;
    const maxHeight = north ? anchorY : south ? 1 - anchorY : Math.min(anchorY, 1 - anchorY) * 2;
    const scale = Math.min(1, maxWidth / Math.max(width, MIN_SOURCE_CROP_SIZE), maxHeight / Math.max(height, MIN_SOURCE_CROP_SIZE));
    width = Math.max(MIN_SOURCE_CROP_SIZE, width * scale);
    height = Math.max(MIN_SOURCE_CROP_SIZE, height * scale);
    if (west) { nextLeft = anchorX - width; nextRight = anchorX; }
    else if (east) { nextLeft = anchorX; nextRight = anchorX + width; }
    else { nextLeft = anchorX - width / 2; nextRight = anchorX + width / 2; }
    if (north) { nextTop = anchorY - height; nextBottom = anchorY; }
    else if (south) { nextTop = anchorY; nextBottom = anchorY + height; }
    else { nextTop = anchorY - height / 2; nextBottom = anchorY + height / 2; }
  }
  return normaliseSourceCrop({ x: nextLeft, y: nextTop, w: nextRight - nextLeft, h: nextBottom - nextTop });
}

/**
 * For non-full crops, a layout with aspect lock uses videoLayout as its target
 * box and fits (or fills) the cropped frame within it. This prevents a 1:1 or
 * 9:16 crop from being silently stretched into the original source ratio.
 */
export function sourceCropDisplayLayout(layout: VideoLayout, crop: SourceCrop, asset?: Pick<Asset, 'width' | 'height'>): VideoLayout {
  if (isFullSourceCrop(crop) || !layout.keepAspectRatio) return layout;
  const aspect = sourceCropAspect(crop, asset);
  const boxAspect = layout.width / layout.height;
  const cover = layout.mode === 'fill';
  const scaleByWidth = cover ? aspect < boxAspect : aspect > boxAspect;
  const width = Math.round(scaleByWidth ? layout.width : layout.height * aspect);
  const height = Math.round(scaleByWidth ? layout.width / aspect : layout.height);
  return { ...layout, x: Math.round(layout.x + (layout.width - width) / 2), y: Math.round(layout.y + (layout.height - height) / 2), width, height };
}
