import { expect, test } from '@playwright/test';
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';

const fixture = (name: string) => path.resolve('tests/fixtures', name);

test('sequentially composes two official WebAV videos with audio and captions into a readable MP4', async ({ page }) => {
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  const failures: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  const supported = await page.evaluate(() => 'VideoDecoder' in globalThis && 'VideoEncoder' in globalThis && 'AudioDecoder' in globalThis && 'AudioEncoder' in globalThis);
  test.skip(!supported, '当前浏览器未提供完整 WebCodecs 编解码能力；真实导出需在 Chrome/Edge 执行。');
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  const videoInput = '[aria-label="导入视频"]';
  await page.locator(videoInput).setInputFiles(fixture('webav-123.mp4'));
  await expect(page.getByText('已导入 webav-123.mp4')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.webav-preview canvas')).toBeVisible();
  await page.locator(videoInput).setInputFiles(fixture('webav-223.mp4'));
  await expect(page.getByText('已导入 webav-223.mp4')).toBeVisible({ timeout: 30_000 });
  await page.locator('.asset-card').filter({ hasText: 'webav-223.mp4' }).getByRole('button', { name: '+ 视频轨' }).click();
  await expect(page.locator('.timeline-clip.video')).toHaveCount(2);
  const expectedDuration = Number(await page.getByTestId('project-duration').getAttribute('data-duration-ms'));
  expect(expectedDuration).toBeGreaterThan(0);
  await page.getByLabel('导入音乐', { exact: true }).setInputFiles(fixture('webav-44.1kHz-2chan.mp3'));
  await expect(page.getByText('已导入音乐 webav-44.1kHz-2chan.mp3')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '+ 音乐', exact: true }).click();
  await page.getByRole('button', { name: '添加字幕' }).click();
  await page.locator('textarea').fill('WebAV 真实字幕');
  await page.getByRole('button', { name: '创建字幕' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await page.getByRole('radio', { name: '浏览器下载' }).check();
  await page.getByLabel('导出文件名称').fill('review-composite');
  await page.getByRole('button', { name: '开始导出' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('review-composite.mp4');
  await download.saveAs('test-results/review-composite.mp4');
  const outputPath = await download.path();
  expect(outputPath).not.toBeNull();
  expect((await stat(outputPath!)).size).toBeGreaterThan(10_000);
  const bytes = Array.from(await readFile(outputPath!));
  const output = await page.evaluate(async (mp4Bytes) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(mp4Bytes)], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('导出的 MP4 无法重新读取元数据'));
      });
      await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = Math.min(.35, video.duration / 2); });
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      const audioContext = new AudioContext();
      let peak = 0;
      try {
        const pcm = await audioContext.decodeAudioData(new Uint8Array(mp4Bytes).buffer);
        for (let channel = 0; channel < pcm.numberOfChannels; channel++) for (const value of pcm.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
      } finally { await audioContext.close(); }
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, peak, frame: canvas.toDataURL('image/png') };
    } finally {
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, bytes);
  expect(output.duration * 1000).toBeGreaterThanOrEqual(expectedDuration - 250);
  expect(output.width).toBe(1280); expect(output.height).toBe(720); expect(output.peak).toBeGreaterThan(.001);
  await writeFile('test-results/export-composite-frame.png', Buffer.from(output.frame.split(',')[1], 'base64'));
  await writeFile('test-results/export-composite.json', JSON.stringify({ duration: output.duration, width: output.width, height: output.height, peak: output.peak, bytes: bytes.length }, null, 2));
  expect(failures.filter((message) => !message.includes('favicon'))).toEqual([]);
});
