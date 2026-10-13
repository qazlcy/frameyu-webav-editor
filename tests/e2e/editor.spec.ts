import { expect, test } from '@playwright/test';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const fixture = (name: string) => path.resolve('tests/fixtures', name);

test('sequentially composes two official WebAV videos with audio and captions into a readable MP4', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  const supported = await page.evaluate(() => 'VideoDecoder' in globalThis && 'VideoEncoder' in globalThis && 'AudioDecoder' in globalThis && 'AudioEncoder' in globalThis);
  test.skip(!supported, '当前浏览器未提供完整 WebCodecs 编解码能力；真实导出需在 Chrome/Edge 执行。');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
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
  await page.getByLabel('导入音频').setInputFiles(fixture('webav-44.1kHz-2chan.mp3'));
  await expect(page.getByText('已导入 webav-44.1kHz-2chan.mp3')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '+ 音乐' }).click();
  await page.getByRole('button', { name: '＋ 添加字幕' }).click();
  await page.locator('textarea').fill('WebAV 真实字幕');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 MP4' }).click();
  const download = await downloadPromise;
  const outputPath = await download.path();
  expect(outputPath).not.toBeNull();
  expect((await stat(outputPath!)).size).toBeGreaterThan(10_000);
  const bytes = Array.from(await readFile(outputPath!));
  const outputDuration = await page.evaluate(async (mp4Bytes) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(mp4Bytes)], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('导出的 MP4 无法重新读取元数据'));
      });
      return video.duration;
    } finally {
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, bytes);
  expect(outputDuration * 1000).toBeGreaterThanOrEqual(expectedDuration - 250);
  expect(failures.filter((message) => !message.includes('favicon'))).toEqual([]);
});
