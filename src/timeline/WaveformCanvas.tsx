import { useEffect, useRef } from 'react';
import { sampleWaveformEnvelope, waveformVisualAmplitude, type WaveformData } from './mediaPreviewCache';

interface WaveformCanvasProps {
  data: WaveformData;
  sourceStartMs: number;
  sourceDurationMs: number;
  color: string;
  compact?: boolean;
  className?: string;
}

/** A DPR-aware, pointer-transparent, symmetric filled envelope for one visible clip window. */
export function WaveformCanvas({ data, sourceStartMs, sourceDurationMs, color, compact = false, className = '' }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let intersecting = typeof IntersectionObserver === 'undefined';
    const scrollViewport = canvas.closest<HTMLElement>('.timeline-scroll');
    const draw = () => {
      frame = 0;
      if (!intersecting) return;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(0, bounds.width);
      const height = Math.max(0, bounds.height);
      if (width < 1 || height < 1) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // Long clips can be tens of thousands of CSS pixels wide. Cap the backing store while
      // retaining device-pixel detail for normal visible clips.
      const pixelWidth = Math.min(4096, Math.max(1, Math.round(width * dpr)));
      const pixelHeight = Math.min(1024, Math.max(1, Math.round(height * dpr)));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      const scaleX = pixelWidth / width;
      const scaleY = pixelHeight / height;
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      context.clearRect(0, 0, width, height);
      const viewport = scrollViewport?.getBoundingClientRect();
      const visibleLeft = Math.max(0, viewport ? viewport.left - bounds.left : 0);
      const visibleRight = Math.min(width, viewport ? viewport.right - bounds.left : width);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      if (visibleWidth < 1) return;
      const visibleSourceStartMs = sourceStartMs + sourceDurationMs * visibleLeft / width;
      const visibleSourceDurationMs = sourceDurationMs * visibleWidth / width;
      const columns = Math.min(2400, Math.max(1, Math.round(visibleWidth * dpr)));
      const envelope = sampleWaveformEnvelope(data, visibleSourceStartMs, visibleSourceDurationMs, columns);
      if (!envelope.length) return;
      const padding = Math.max(compact ? 1 : 3, height * 0.1);
      const centerY = height / 2;
      const halfHeight = Math.max(0, (height - padding * 2) / 2);
      const xFor = (index: number) => visibleLeft + index / Math.max(1, envelope.length - 1) * visibleWidth;
      const amplitudes = envelope.map((column) => waveformVisualAmplitude(column.peak, column.rms) * halfHeight);
      context.beginPath();
      for (let index = 0; index < amplitudes.length; index += 1) {
        const x = xFor(index);
        const y = centerY - (amplitudes[index] ?? 0);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      for (let index = amplitudes.length - 1; index >= 0; index -= 1) context.lineTo(xFor(index), centerY + (amplitudes[index] ?? 0));
      context.closePath();
      context.fillStyle = color;
      context.globalAlpha = .86;
      context.fill();
      context.globalAlpha = 1;
    };
    const schedule = () => {
      if (intersecting && !frame) frame = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    const visibilityObserver = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting);
      if (intersecting) schedule();
    }, { root: scrollViewport, threshold: 0 });
    visibilityObserver?.observe(canvas);
    scrollViewport?.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      visibilityObserver?.disconnect();
      scrollViewport?.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [color, compact, data, sourceDurationMs, sourceStartMs]);

  return <canvas ref={canvasRef} className={`timeline-waveform-canvas ${className}`} aria-hidden="true" />;
}
