import { useLayoutEffect, useRef } from 'react';
import { sampleWaveformEnvelope, summariseWaveform, type WaveformData, type WaveformSummary } from './mediaPreviewCache';
import { DEFAULT_WAVEFORM_DISPLAY_SETTINGS, mapWaveformDisplayAmplitude, normaliseWaveformDisplaySettings, type WaveformDisplaySettings } from './waveformDisplay';

interface WaveformCanvasProps {
  data: WaveformData;
  sourceStartMs: number;
  sourceDurationMs: number;
  color: string;
  summary?: WaveformSummary;
  displaySettings?: WaveformDisplaySettings;
  compact?: boolean;
  className?: string;
}

/** Browser-independent diagnostic data for checking Canvas layout without any decoder. */
export const WAVEFORM_CANVAS_SELF_TEST_DATA: WaveformData = {
  durationMs: 8000,
  peaks: Array.from({ length: 256 }, (_, index) => {
    const envelope = .14 + .86 * Math.abs(Math.sin(index / 19));
    return index > 72 && index < 94 ? 0 : envelope * (.55 + .45 * Math.abs(Math.sin(index / 7)));
  }),
  rms: Array.from({ length: 256 }, (_, index) => index > 72 && index < 94 ? 0 : (.08 + .64 * Math.abs(Math.sin(index / 19))) * (.55 + .45 * Math.abs(Math.sin(index / 7)))),
  sampleCounts: Array.from({ length: 256 }, () => 1),
};

/** A DPR-aware, pointer-transparent, symmetric filled envelope for one visible clip window. */
export function WaveformCanvas({ data, sourceStartMs, sourceDurationMs, color, summary, displaySettings = DEFAULT_WAVEFORM_DISPLAY_SETTINGS, compact = false, className = '' }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasReportedPaintRef = useRef(false);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    hasReportedPaintRef.current = false;
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
      const reference = summary ?? summariseWaveform(data);
      const settings = normaliseWaveformDisplaySettings(displaySettings);
      const padding = Math.max(compact ? 1 : 3, height * 0.1);
      const centerY = height / 2;
      const halfHeight = Math.max(0, (height - padding * 2) / 2);
      const xFor = (index: number) => visibleLeft + index / Math.max(1, envelope.length - 1) * visibleWidth;
      const amplitudes = envelope.map((column) => mapWaveformDisplayAmplitude(column.peak, column.rms, reference, settings));
      const peakAmplitudes = amplitudes.map((value) => value.peak * halfHeight);
      const rmsAmplitudes = amplitudes.map((value) => value.rms * halfHeight);
      if (!hasReportedPaintRef.current) {
        hasReportedPaintRef.current = true;
        console.info('[WaveformCanvas] painted', {
          sourceStartMs: Math.round(sourceStartMs), sourceDurationMs: Math.round(sourceDurationMs), buckets: data.peaks.length,
          cssWidth: Math.round(width), cssHeight: Math.round(height), pixelWidth, pixelHeight, dpr,
          visibleLeft: Math.round(visibleLeft), visibleWidth: Math.round(visibleWidth), columns: envelope.length,
          rawMaxPeak: reference.maxPeak, p10Peak: reference.p10Peak, p50Peak: reference.p50Peak,
          p90Peak: reference.p90Peak, p95Peak: reference.p95Peak, p99Peak: reference.p99Peak,
          maxRms: reference.maxRms, averageRms: reference.averageRms, nonZeroPeakRatio: reference.nonZeroPeakRatio,
          mode: settings.mode, gain: settings.gain, contrast: settings.contrast,
          effectiveHeight: Math.round(halfHeight * 2), maxPeakHeight: Math.max(0, ...peakAmplitudes) * 2,
          maxRmsHeight: Math.max(0, ...rmsAmplitudes) * 2,
        });
      }
      const paintEnvelope = (values: number[], alpha: number) => {
        context.beginPath();
        for (let index = 0; index < values.length; index += 1) {
          const x = xFor(index);
          const y = centerY - (values[index] ?? 0);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        for (let index = values.length - 1; index >= 0; index -= 1) context.lineTo(xFor(index), centerY + (values[index] ?? 0));
        context.closePath();
        context.fillStyle = color;
        context.globalAlpha = alpha;
        context.fill();
      };
      // The outer envelope preserves transients; the inner layer shows sustained energy.
      paintEnvelope(peakAmplitudes, compact ? .43 : .38);
      paintEnvelope(rmsAmplitudes, compact ? .82 : .88);
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
  }, [color, compact, data, displaySettings, sourceDurationMs, sourceStartMs, summary]);

  return <canvas ref={canvasRef} className={`timeline-waveform-canvas ${className}`} data-waveform-buckets={data.peaks.length} data-waveform-source-start-ms={sourceStartMs} data-waveform-source-duration-ms={sourceDurationMs} aria-hidden="true" />;
}
