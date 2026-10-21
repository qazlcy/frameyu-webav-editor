import { expect, test } from '@playwright/test';

test('keeps the source crop confirmation toolbar inside the preview frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/editor', { waitUntil: 'domcontentloaded' });
  const frame = page.locator('.preview-frame');
  await frame.evaluate((node) => {
    node.insertAdjacentHTML('beforeend', '<div class="source-crop-editor" data-audit="editor" style="inset:0"></div><div class="source-crop-toolbar" data-audit="toolbar"><button type="button">取消裁切</button><button type="button" class="primary">确认裁切</button></div>');
  });
  const editor = page.locator('[data-audit="editor"]');
  const toolbar = page.locator('[data-audit="toolbar"]');
  const [frameBox, editorBox, toolbarBox] = await Promise.all([frame.boundingBox(), editor.boundingBox(), toolbar.boundingBox()]);
  const styles = await toolbar.evaluate((node) => {
    const value = getComputedStyle(node);
    return { display: value.display, visibility: value.visibility, zIndex: value.zIndex, pointerEvents: value.pointerEvents };
  });
  const hitTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, { x: toolbarBox!.x + toolbarBox!.width - 20, y: toolbarBox!.y + toolbarBox!.height / 2 });
  console.info('[SourceCropToolbarAudit:after]', { frameBox, editorBox, toolbarBox, styles, hitTarget });
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(frameBox!.y);
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height);
  expect(styles).toEqual({ display: 'flex', visibility: 'visible', zIndex: '14', pointerEvents: 'auto' });
  expect(hitTarget).toContain('确认裁切');
});
