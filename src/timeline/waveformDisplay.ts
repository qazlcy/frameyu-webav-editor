/**
 * Display-only waveform mapping. These values never feed WebAV, decoded PCM,
 * clip gain, or export; they only decide how cached envelope data is painted.
 */
export type WaveformDisplayMode = 'linear' | 'enhanced';

export interface WaveformDisplaySettings {
  style: 'outline' | 'bars';
  mode: WaveformDisplayMode;
  /** A bounded visual gain, deliberately separate from clip.volume. */
  gain: number;
  /** 1 is neutral; larger values reveal lower-level detail without inventing it. */
  contrast: number;
}

export interface WaveformDisplayReference {
  maxPeak: number;
  p95Peak: number;
  p99Peak: number;
}

export interface WaveformDisplayAmplitude {
  peak: number;
  rms: number;
}

export const DEFAULT_WAVEFORM_DISPLAY_SETTINGS: WaveformDisplaySettings = {
  style: 'outline',
  mode: 'enhanced',
  gain: 1.35,
  contrast: 1.14,
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function normaliseWaveformDisplaySettings(settings: Partial<WaveformDisplaySettings> | undefined): WaveformDisplaySettings {
  return {
    style: settings?.style === 'bars' ? 'bars' : 'outline',
    mode: settings?.mode === 'linear' ? 'linear' : 'enhanced',
    gain: clamp(settings?.gain ?? DEFAULT_WAVEFORM_DISPLAY_SETTINGS.gain, 1, 5),
    contrast: clamp(settings?.contrast ?? DEFAULT_WAVEFORM_DISPLAY_SETTINGS.contrast, .7, 1.6),
  };
}

/** P95 is robust to a single click while P99 keeps brief, legitimate transients visible. */
export function waveformReferencePeak(reference: WaveformDisplayReference) {
  return Math.max(0, Math.min(1, Math.max(reference.p95Peak, reference.p99Peak * .72)));
}

function mapAmplitude(value: number, reference: WaveformDisplayReference, settings: WaveformDisplaySettings) {
  if (!(value > 0)) return 0;
  const normalised = settings.mode === 'linear'
    ? value
    : value / Math.max(.000_001, waveformReferencePeak(reference));
  // Smooth compression preserves differences above P95/P99 instead of clipping
  // many adjacent loud buckets to the same flat ceiling. Silence stays exact zero.
  const gained = Math.max(0, normalised * settings.gain);
  return Math.pow(gained / (.2 + gained), 1 / settings.contrast);
}

/** Keeps Peak and RMS distinct, with RMS constrained inside the Peak envelope. */
export function mapWaveformDisplayAmplitude(peak: number, rms: number, reference: WaveformDisplayReference, settingsInput?: Partial<WaveformDisplaySettings>): WaveformDisplayAmplitude {
  const settings = normaliseWaveformDisplaySettings(settingsInput);
  const mappedPeak = mapAmplitude(peak, reference, settings);
  const mappedRms = Math.min(mappedPeak, mapAmplitude(rms, reference, settings));
  return { peak: mappedPeak, rms: mappedRms };
}
