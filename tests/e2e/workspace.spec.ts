import { expect, test } from '@playwright/test';

test('resizes the workspace and keeps a vertically scrollable dynamic track list aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const workspace = page.locator('.workspace');
  await expect(workspace).toBeVisible();
  const assetDivider = page.getByRole('separator', { name: '调整素材库宽度' });
  const dividerBox = await assetDivider.boundingBox();
  expect(dividerBox).not.toBeNull();
  await page.mouse.move(dividerBox!.x + 3, dividerBox!.y + 120);
  await page.mouse.down();
  for (const offset of [20, 40, 80]) await page.mouse.move(dividerBox!.x + 3 + offset, dividerBox!.y + 120);
  await page.mouse.up();
  expect(await workspace.evaluate((node) => getComputedStyle(node).gridTemplateColumns)).toContain('325px');
  await assetDivider.dblclick();
  expect(await workspace.evaluate((node) => getComputedStyle(node).gridTemplateColumns)).toContain('245px');

  const timelineDivider = page.getByRole('separator', { name: '调整时间轴高度' });
  const timelineDividerBox = await timelineDivider.boundingBox();
  expect(timelineDividerBox).not.toBeNull();
  await page.mouse.move(timelineDividerBox!.x + 300, timelineDividerBox!.y + 3);
  await page.mouse.down();
  await page.mouse.move(timelineDividerBox!.x + 300, timelineDividerBox!.y - 50);
  await page.mouse.up();
  expect(await page.locator('.timeline-panel').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(290);
  await timelineDivider.dblclick();
  expect(await page.locator('.timeline-panel').evaluate((node) => node.getBoundingClientRect().height)).toBe(252);

  for (let index = 0; index < 11; index += 1) await page.getByRole('button', { name: '+ 字幕轨' }).click();
  await expect(page.locator('.track')).toHaveCount(15);
  const scroll = page.locator('.timeline-scroll');
  const verticalMetrics = await scroll.evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
  expect(verticalMetrics.scrollHeight).toBeGreaterThan(verticalMetrics.clientHeight);
  await scroll.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });

  const firstTrack = page.locator('.track').first();
  const handleBox = await firstTrack.locator('.track-height-handle').boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + 80, handleBox!.y + 2);
  await page.mouse.down();
  for (const offset of [10, 25, 45]) await page.mouse.move(handleBox!.x + 80, handleBox!.y + offset);
  await page.mouse.up();
  expect(await firstTrack.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(80);

  await page.getByLabel('时间轴缩放').focus();
  await page.keyboard.press('End');
  expect(await scroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBeTruthy();
  await scroll.evaluate((node) => { node.scrollLeft = 120; node.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.timeline-ruler-scroll')).toHaveJSProperty('scrollLeft', 120);

  await scroll.evaluate((node) => { node.scrollTop = 100; node.dispatchEvent(new Event('scroll')); });
  const alignment = await page.locator('.track').nth(4).evaluate((node) => {
    const label = node.querySelector('.track-label')!.getBoundingClientRect();
    const lane = node.querySelector('.track-lane')!.getBoundingClientRect();
    return { labelTop: label.top, laneTop: lane.top };
  });
  expect(alignment.labelTop).toBe(alignment.laneTop);
});

test('keeps five material entry points and filters fixed above the independently scrolling material list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('.asset-panel');
  const actions = page.locator('.material-actions');
  const list = page.locator('.material-list');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: /导入\/生成视频/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /导入\/生成音乐/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /导入\/生成音效/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /导入\/生成字幕/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /从素材库导入/ })).toBeVisible();
  expect(await actions.evaluate((node) => getComputedStyle(node).flexShrink)).toBe('0');
  expect(await list.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');

  await page.getByRole('button', { name: /导入\/生成字幕/ }).click();
  await expect(page.getByLabel('新字幕文字')).toBeVisible();
  await page.getByRole('tab', { name: '视频' }).click();
  await expect(page.getByRole('tab', { name: '视频' })).toHaveAttribute('aria-selected', 'true');

  const divider = page.getByRole('separator', { name: '调整素材库宽度' });
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 3, box!.y + 100);
  await page.mouse.down();
  await page.mouse.move(box!.x + 63, box!.y + 100);
  await page.mouse.up();
  expect(await panel.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(290);
});
