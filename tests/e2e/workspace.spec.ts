import { expect, test } from '@playwright/test';

test('resizes the workspace and keeps a vertically scrollable dynamic track list aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });

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

test('keeps the material drawer and direct import actions above the independently scrolling material list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('.asset-panel');
  const actions = page.locator('.material-actions');
  const list = page.locator('.material-list');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: '素材库' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上传视频' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上传音乐/音效' })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加字幕' })).toBeVisible();
  expect(await actions.evaluate((node) => getComputedStyle(node).flexShrink)).toBe('0');
  expect(await list.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');

  await page.getByRole('button', { name: '素材库' }).click();
  const drawer = page.getByRole('menu', { name: '个人素材库分类' });
  const defaultBounds = await Promise.all([panel.boundingBox(), drawer.boundingBox()]);
  expect(defaultBounds[0]).not.toBeNull();
  expect(defaultBounds[1]).not.toBeNull();
  expect(defaultBounds[1]!.x + defaultBounds[1]!.width).toBeLessThanOrEqual(defaultBounds[0]!.x + defaultBounds[0]!.width - 7);
  await expect(page.getByRole('menuitem', { name: /视频素材库/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /音乐素材库/ }).click();
  await expect(page.getByRole('dialog', { name: /音乐素材库/ })).toBeVisible();
  await expect(page.getByText('个人云端素材库尚未接入')).toBeVisible();
  const musicChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择本地音乐' }).click();
  expect(await (await musicChooser).element().getAttribute('accept')).toContain('audio/');

  await page.getByRole('button', { name: '上传音乐/音效' }).click();
  const sfxChooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '上传音效' }).click();
  expect(await (await sfxChooser).element().getAttribute('accept')).toContain('audio/');

  await page.getByRole('button', { name: '添加字幕' }).click();
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
  await page.getByRole('button', { name: '素材库' }).click();
  const resizedBounds = await Promise.all([panel.boundingBox(), drawer.boundingBox()]);
  expect(resizedBounds[0]).not.toBeNull();
  expect(resizedBounds[1]).not.toBeNull();
  expect(resizedBounds[1]!.x + resizedBounds[1]!.width).toBeLessThanOrEqual(resizedBounds[0]!.x + resizedBounds[0]!.width - 7);
});

test('manages an additional empty video track without disturbing the existing timeline', async ({ page }) => {
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.track')).toHaveCount(4);
  await page.getByRole('button', { name: '+ 视频轨' }).click();
  await expect(page.locator('.track')).toHaveCount(5);
  const extraVideoName = page.getByLabel('视频 2名称');
  await expect(extraVideoName).toBeVisible();
  await extraVideoName.fill('画中画层');
  await expect(page.getByLabel('画中画层名称')).toHaveValue('画中画层');
  await page.getByRole('button', { name: '删除画中画层' }).click();
  await expect(page.locator('.track')).toHaveCount(4);
});

test('draws the decoder-independent Canvas waveform self-test with visible pixels', async ({ page }) => {
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  await page.locator('.waveform-diagnostics summary').click();
  await page.getByRole('button', { name: '显示 Canvas 自检' }).click();
  const canvas = page.locator('.waveform-canvas-self-test canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext('2d');
    if (!context) return false;
    const { data } = context.getImageData(0, 0, (node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height);
    for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 0) > 0) return true;
    return false;
  })).toBe(true);
});

test('keeps the real source-crop prototype explicitly URL-gated', async ({ page }) => {
  await page.goto('/editor?sourceCropPrototype=1', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('裁切原型：所有视频仅保留源画面中央 50%')).toBeVisible();
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('裁切原型：所有视频仅保留源画面中央 50%')).toHaveCount(0);
});
