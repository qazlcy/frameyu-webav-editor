import { describe, expect, it } from 'vitest';
import { mapWaveformDisplayAmplitude } from '../src/timeline/waveformDisplay';
import { sampleWaveformEnvelope } from '../src/timeline/mediaPreviewCache';
describe('line waveform display', () => {
  it('preserves loud peak differences above the percentile reference at maximum gain', () => {
    const reference = {maxPeak:1,p95Peak:.3,p99Peak:.4};
    const values = [.4,.6,.8,1].map(v=>mapWaveformDisplayAmplitude(v,v/2,reference,{gain:5}).peak);
    expect(values.every((value,index)=>index===0 || value>values[index-1])).toBe(true);
    expect(values[3]).toBeLessThan(1);
    expect(mapWaveformDisplayAmplitude(0,0,reference,{gain:5})).toEqual({peak:0,rms:0});
  });
  it('aggregates cached speech-like and loud envelopes without filling silent spans', () => {
    const data={durationMs:8000,peaks:[0,.1,.3,0,0,.6,1,0],rms:[0,.04,.12,0,0,.3,.7,0]};
    const before=JSON.stringify(data);
    const columns=sampleWaveformEnvelope(data,0,8000,4);
    expect(columns.map(v=>v.peak)).toEqual([.1,.3,.6,1]);
    expect(sampleWaveformEnvelope(data,3000,2000,2).map(v=>v.peak)).toEqual([0,0]);
    expect(JSON.stringify(data)).toBe(before);
  });
});
