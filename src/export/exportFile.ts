/** MP4 is the only container emitted by the current WebAV Combinator pipeline. */
export function normaliseMp4Filename(value: string) {
  const base = value.trim().replace(/\.mp4$/i, '') || 'frameyu-demo';
  return `${base}.mp4`;
}
