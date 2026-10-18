import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import type { SavePicker } from '../../src/export/saveVideo';
interface TestWindow extends Window { showSaveFilePicker?: SavePicker; pickerCalls: number; pickerActive: boolean; pickerMode: string; savedBytes?: number; }
async function openVideo(page: Page) {
  await page.goto('/');
  test.skip(!await page.evaluate(() => 'VideoEncoder' in window && 'AudioEncoder' in window), 'WebCodecs unavailable');
  await page.getByLabel('导入视频', { exact: true }).setInputFiles('tests/fixtures/webav-123.mp4');
  await expect(page.locator('.video-thumbnail-cell img').first()).toBeVisible({ timeout: 30000 });
}

test('real audio dedup keeps category, one waveform analysis and repeated timeline references', async ({ page }) => {
  const registered: string[] = [];

  page.on('console', message => { if (message.text().includes('asset registered')) registered.push(message.text()); });
  await page.goto('/');
  await page.getByLabel('导入音乐', { exact: true }).setInputFiles('tests/fixtures/webav-44.1kHz-2chan.mp3');
  await expect(page.locator('.asset-card.music')).toHaveCount(1);
  await page.getByLabel('导入音效', { exact: true }).setInputFiles({ name: 'renamed.mp3', mimeType: 'audio/mpeg', buffer: await readFile('tests/fixtures/webav-44.1kHz-2chan.mp3') });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '定位已有素材' }).click();
  await expect(page.getByRole('tab', { name: '音乐', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '+ 音乐', exact: true }).click();
  await page.getByRole('button', { name: '+ 音乐', exact: true }).click();
  await expect(page.locator('.audio-waveform canvas')).toHaveCount(2);
  expect(registered).toHaveLength(1); expect((await page.locator('.waveform-diagnostics pre').textContent())?.match(/decode-ready/g)).toHaveLength(1);
  await expect(page.getByLabel('试听 webav-44.1kHz-2chan.mp3')).toHaveAttribute('src', /^blob:/);
});

test('crop handles, cancel/reset, speed and multi-track thumbnails retain source mapping', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openVideo(page);
  const clip = page.locator('.timeline-clip.video').first();
  await clip.click();
  await page.getByRole('button', { name: '裁切', exact: true }).click();
  await expect(page.locator('.source-crop-handle')).toHaveCount(8);
  await expect(page.getByRole('button', { name: '导出视频', exact: true })).toBeDisabled();
  await page.getByLabel('裁切比例').selectOption('1:1');
  const box = await page.getByRole('button', { name: '裁切右下角缩放', exact: true }).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x - 45, box!.y - 45); await page.mouse.up();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(clip.locator('img').first()).not.toHaveCSS('width', '0px');
  const croppedStyle = await clip.locator('img').first().getAttribute('style');
  expect(await clip.locator('img').first().evaluate(node => node.style.width !== '100%' || node.style.height !== '100%')).toBe(true);
  await page.getByRole('button', { name: '裁切', exact: true }).click();
  await page.getByRole('button', { name: '重置裁切' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(await clip.locator('img').first().getAttribute('style')).toBe(croppedStyle);
  for (const rate of ['0.5', '2', '1']) {
    await page.getByLabel('片段播放速度').selectOption(rate);
    await expect(clip.locator('.video-thumbnail-cell').first()).toBeVisible();
    expect(await clip.locator('img').first().getAttribute('style')).toBe(croppedStyle);
  }
  await page.getByRole('button', { name: '+ 视频轨', exact: true }).last().click();
  await page.locator('.asset-card').getByRole('button', { name: '+ 视频轨', exact: true }).click();
  await expect(page.locator('.timeline-clip.video')).toHaveCount(2);
  await page.locator('.timeline-clip.video').last().click();
  await page.getByRole('button', { name: '画中画', exact: true }).click();
  await page.getByLabel('片段播放速度').selectOption('2');
  await expect.poll(() => page.locator('.webav-preview canvas').evaluate(node => {
    const pixel = (node as HTMLCanvasElement).getContext('2d')!.getImageData(1000, 80, 1, 1).data;
    return pixel[1] > 100 && pixel[1] > pixel[0] * 2;
  })).toBe(true);
  await page.screenshot({ path: 'docs/review-evidence/crop-multitrack.png' });
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await page.getByLabel('保存方式').selectOption('download');
  await page.getByLabel('导出文件名').fill('review-crop-overlay');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '开始导出' }).click();
  await (await download).saveAs('test-results/review-crop-overlay.mp4');
  const rendered = await page.evaluate(async bytes => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
    const video = document.createElement('video'); video.src = url;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(Error('invalid MP4')); });
      await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = .2; });
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0);
      const pixel = context.getImageData(1000, 80, 1, 1).data;
      return { duration: video.duration, overlayGreen: pixel[1] > 100 && pixel[1] > pixel[0] * 2, frame: canvas.toDataURL('image/png') };
    } finally { URL.revokeObjectURL(url); }
  }, Array.from(await readFile('test-results/review-crop-overlay.mp4')));
  expect(rendered.overlayGreen).toBe(true); expect(rendered.duration).toBeGreaterThan(1);
  await writeFile('docs/review-evidence/export-crop-overlay-frame.png', Buffer.from(rendered.frame.split(',')[1], 'base64'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('picker cancellation avoids encoding; writable path exports real MP4 with an active user gesture', async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as unknown as TestWindow;
    target.pickerCalls = 0; target.pickerMode = 'cancel';
    target.showSaveFilePicker = async () => {
      target.pickerCalls++; target.pickerActive = navigator.userActivation.isActive;
      if (target.pickerMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('review-picker.mp4', { create: true });
      return { createWritable: async () => {
        const stream = await handle.createWritable();
        return { write: (blob: Blob) => stream.write(blob), abort: () => stream.abort(), close: async () => { await stream.close(); target.savedBytes = (await handle.getFile()).size; } };
      } };
    };
  });
  let encodes = 0;
  page.on('console', message => { if (message.text().includes('start combinate video')) encodes++; });
  await openVideo(page);
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(page.getByLabel('导出格式')).toHaveText('MP4（H.264 / AAC）');
  await page.getByLabel('导出文件名').fill('review-picker');
  await page.screenshot({ path: 'docs/review-evidence/export-dialog.png' });
  await page.getByRole('button', { name: '开始导出' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('未开始编码');
  expect(encodes).toBe(0);
  expect(await page.evaluate(() => (window as unknown as TestWindow).pickerActive)).toBe(true);
  await page.evaluate(() => { (window as unknown as TestWindow).pickerMode = 'save'; });
  await page.getByRole('button', { name: '开始导出' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  expect(await page.evaluate(() => (window as unknown as TestWindow).savedBytes)).toBeGreaterThan(10000);
  expect(await page.evaluate(() => (window as unknown as TestWindow).pickerCalls)).toBe(2);
  expect(encodes).toBe(1);
});

test('browser without picker offers only browser download and modal cancellation is harmless', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }); });
  await openVideo(page);
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(page.getByLabel('保存方式').locator('option')).toHaveCount(1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
