import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Asset, TimelineClip } from '../editor/types';
import { getClipSourceDurationMs } from '../editor/timelineMath';
import { getSourceCrop, sourceCropAspect } from '../editor/sourceCrop';
import { sampleThumbnailsForClip, type TimelineMediaPreviewCache } from './mediaPreviewCache';

/** Decode requests follow visible source windows, never React render or playback ticks. */
export function VideoThumbnailStrip({ clip, asset, file, cache }: { clip: TimelineClip; asset: Asset; file?: File; cache: TimelineMediaPreviewCache }) {
  const host = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ left: 0, width: 0, total: 1, height: 1 });
  const [failed, setFailed] = useState(false);
  const [, refresh] = useState(0);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const viewport = node.closest<HTMLElement>('.timeline-scroll');
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = node.getBoundingClientRect();
      const view = viewport?.getBoundingClientRect();
      const left = Math.max(0, (view?.left ?? box.left) - box.left);
      const right = Math.min(box.width, (view?.right ?? box.right) - box.left);
      const visible = !view || box.bottom > view.top && box.top < view.bottom;
      setWindow({ left, width: visible ? Math.max(0, right - left) : 0, total: Math.max(1, box.width), height: box.height });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    viewport?.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => { observer.disconnect(); viewport?.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, [clip.startMs]);
  const duration = getClipSourceDurationMs(clip);
  const sourceStart = clip.sourceStartMs + duration * window.left / window.total;
  const sourceDuration = duration * window.width / window.total;
  useEffect(() => {
    if (!file || sourceDuration <= 0) return;
    let cancelled = false;
    setFailed(false);
    void cache.ensureThumbnails(asset, file, { startMs: sourceStart, durationMs: sourceDuration }).then((data) => {
      if (!cancelled) { setFailed(!data.frames.length); refresh(value => value + 1); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [asset, file, cache, sourceStart, sourceDuration]);
  const data = cache.getThumbnails(asset.id);
  const crop = getSourceCrop(clip);
  const count = Math.min(64, Math.max(1, Math.ceil(window.width / Math.max(32, window.height * sourceCropAspect(crop, asset)))));
  const frames = data && sourceDuration > 0 ? sampleThumbnailsForClip(data, { ...clip, sourceStartMs: sourceStart, sourceDurationMs: sourceDuration }, count) : [];
  return <div ref={host} className="video-thumbnail-strip" aria-label="视频连续缩略帧">
    {frames.length ? <div className="video-thumbnail-window" style={{ left: window.left, width: window.width }}>{frames.map((frame, index) => <span key={index} className="video-thumbnail-cell" data-source-time-ms={frame.timeMs}><img alt="" draggable={false} src={frame.url} style={{ width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${-100 * crop.x / crop.w}%`, top: `${-100 * crop.y / crop.h}%` }} /></span>)}</div> : <span className="thumbnail-placeholder">{failed ? '缩略帧不可用' : '正在生成缩略帧…'}</span>}
  </div>;
}
