import { expect, test } from '@playwright/test';

test('source-crop interceptor removes excluded pixels from a synthetic VideoFrame', async ({ page }) => {
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({
    type: 'module',
    content: `
      import { installSourceCropFrameTransform } from '/src/webav/sourceCropPrototype.ts';
      window.__installSourceCropFrameTransform = installSourceCropFrameTransform;
    `,
  });

  const result = await page.evaluate(async () => {
    if (!('VideoFrame' in window) || !('OffscreenCanvas' in window)) return { supported: false as const };
    type TickResult = { video?: VideoFrame; audio: never[]; state: 'success' };
    type TestClip = { tickInterceptor: (timeUs: number, result: TickResult) => Promise<TickResult> };
    type CropTrace = { path: string };
    type CropInstaller = (clip: TestClip, crop: { x: number; y: number; w: number; h: number }, onFrame: (trace: CropTrace) => void, options?: { forceCanvas?: boolean }) => void;
    const install = (window as unknown as { __installSourceCropFrameTransform: CropInstaller }).__installSourceCropFrameTransform;
    const sourceCanvas = new OffscreenCanvas(300, 100);
    const sourceContext = sourceCanvas.getContext('2d', { alpha: false });
    if (!sourceContext) throw new Error('2D source context unavailable');
    sourceContext.fillStyle = '#ff0000';
    sourceContext.fillRect(0, 0, 100, 100);
    sourceContext.fillStyle = '#00ff00';
    sourceContext.fillRect(100, 0, 100, 100);
    sourceContext.fillStyle = '#0000ff';
    sourceContext.fillRect(200, 0, 100, 100);

    const paths: string[] = [];
    const clip: TestClip = { tickInterceptor: async (_timeUs, tickResult) => tickResult };
    install(clip, { x: 0, y: 0, w: 2 / 3, h: 1 }, (trace) => paths.push(trace.path));
    const transformed = await clip.tickInterceptor(0, {
      video: new VideoFrame(sourceCanvas, { timestamp: 123, duration: 33_333 }),
      audio: [],
      state: 'success',
    });
    if (!transformed.video) throw new Error('Crop interceptor returned no VideoFrame');

    const outputCanvas = new OffscreenCanvas(300, 100);
    const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
    if (!outputContext) throw new Error('2D output context unavailable');
    outputContext.drawImage(transformed.video, 0, 0, 300, 100);
    const sample = (x: number) => Array.from(outputContext.getImageData(x, 50, 1, 1).data.slice(0, 3));
    const metadata = {
      codedWidth: transformed.video.codedWidth,
      codedHeight: transformed.video.codedHeight,
      displayWidth: transformed.video.displayWidth,
      displayHeight: transformed.video.displayHeight,
      visibleRect: transformed.video.visibleRect ? {
        x: transformed.video.visibleRect.x,
        y: transformed.video.visibleRect.y,
        width: transformed.video.visibleRect.width,
        height: transformed.video.visibleRect.height,
      } : null,
      timestamp: transformed.video.timestamp,
      duration: transformed.video.duration,
    };
    const samples = { left: sample(50), middle: sample(150), right: sample(250) };
    transformed.video.close();
    return { supported: true as const, paths, metadata, samples };
  });

  test.skip(!result.supported, 'Remote Chromium does not expose VideoFrame/OffscreenCanvas');
  if (!result.supported) return;
  console.info('[SourceCropPixelTest] visible-rect', result);
  expect(result.paths).toEqual(['visible-rect']);
  expect(result.metadata).toMatchObject({
    codedWidth: 300,
    codedHeight: 100,
    displayWidth: 200,
    displayHeight: 100,
    visibleRect: { x: 0, y: 0, width: 200, height: 100 },
    timestamp: 123,
    duration: 33_333,
  });
  expect(result.samples.left[0]).toBeGreaterThan(240);
  // VideoFrame conversion may pass through a browser colour space; compare
  // dominant channels rather than requiring byte-perfect CSS colours.
  expect(result.samples.middle[1]).toBeGreaterThan(180);
  expect(result.samples.middle[1]).toBeGreaterThan(result.samples.middle[2] + 150);
  expect(result.samples.right[1]).toBeGreaterThan(180);
  expect(result.samples.right[1]).toBeGreaterThan(result.samples.right[2] + 150);
  expect(result.samples.right[2]).toBeLessThan(15);
});

test('source-crop Canvas fallback copies only retained pixels', async ({ page }) => {
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({
    type: 'module',
    content: `
      import { installSourceCropFrameTransform } from '/src/webav/sourceCropPrototype.ts';
      window.__installSourceCropFrameTransform = installSourceCropFrameTransform;
    `,
  });
  const result = await page.evaluate(async () => {
    if (!('VideoFrame' in window) || !('OffscreenCanvas' in window)) return { supported: false as const };
    type TickResult = { video?: VideoFrame; audio: never[]; state: 'success' };
    type TestClip = { tickInterceptor: (timeUs: number, result: TickResult) => Promise<TickResult> };
    type CropInstaller = (clip: TestClip, crop: { x: number; y: number; w: number; h: number }, onFrame: (trace: { path: string }) => void, options: { forceCanvas: boolean }) => void;
    const install = (window as unknown as { __installSourceCropFrameTransform: CropInstaller }).__installSourceCropFrameTransform;
    const sourceCanvas = new OffscreenCanvas(200, 80);
    const sourceContext = sourceCanvas.getContext('2d', { alpha: false });
    if (!sourceContext) throw new Error('2D source context unavailable');
    sourceContext.fillStyle = '#ff0000';
    sourceContext.fillRect(0, 0, 100, 80);
    sourceContext.fillStyle = '#0000ff';
    sourceContext.fillRect(100, 0, 100, 80);
    const paths: string[] = [];
    const clip: TestClip = { tickInterceptor: async (_timeUs, tickResult) => tickResult };
    install(clip, { x: 0, y: 0, w: 0.5, h: 1 }, (trace) => paths.push(trace.path), { forceCanvas: true });
    const transformed = await clip.tickInterceptor(0, { video: new VideoFrame(sourceCanvas, { timestamp: 0 }), audio: [], state: 'success' });
    if (!transformed.video) throw new Error('Crop interceptor returned no VideoFrame');
    const outputCanvas = new OffscreenCanvas(200, 80);
    const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
    if (!outputContext) throw new Error('2D output context unavailable');
    outputContext.drawImage(transformed.video, 0, 0, 200, 80);
    const right = Array.from(outputContext.getImageData(175, 40, 1, 1).data.slice(0, 3));
    const dimensions = { codedWidth: transformed.video.codedWidth, displayWidth: transformed.video.displayWidth };
    transformed.video.close();
    return { supported: true as const, paths, right, dimensions };
  });
  test.skip(!result.supported, 'Remote Chromium does not expose VideoFrame/OffscreenCanvas');
  if (!result.supported) return;
  console.info('[SourceCropPixelTest] canvas', result);
  expect(result.paths).toEqual(['canvas']);
  expect(result.dimensions).toEqual({ codedWidth: 100, displayWidth: 100 });
  expect(result.right[0]).toBeGreaterThan(240);
  expect(result.right[2]).toBeLessThan(15);
});
