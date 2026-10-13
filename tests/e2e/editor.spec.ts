import { expect, test } from '@playwright/test';
import path from 'node:path';
import { stat } from 'node:fs/promises';

const fixture = (name: string) => path.resolve('tests/fixtures', name);

test('imports official WebAV media, overlays audio/caption, and exports an MP4', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto('/');
  await page.getByLabel('导入主视频').setInputFiles(fixture('webav-bunny_0.mp4'));
  await expect(page.getByText('已导入 webav-bunny_0.mp4')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.webav-preview canvas')).toBeVisible();
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
  expect(failures.filter((message) => !message.includes('favicon'))).toEqual([]);
});
