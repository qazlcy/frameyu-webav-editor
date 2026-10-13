import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_LAYOUT, MIN_ASSET_WIDTH, MIN_PROPERTY_WIDTH, MIN_TIMELINE_HEIGHT, normaliseWorkspaceLayout } from '../src/editor/layoutMath';

describe('workspace layout math', () => {
  it('retains default dimensions when there is enough room', () => {
    expect(normaliseWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, 1440, 900)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('enforces panel and timeline minimum sizes', () => {
    const layout = normaliseWorkspaceLayout({ assetWidth: 1, propertyWidth: 1, timelineHeight: 1 }, 1440, 900);
    expect(layout.assetWidth).toBe(MIN_ASSET_WIDTH);
    expect(layout.propertyWidth).toBe(MIN_PROPERTY_WIDTH);
    expect(layout.timelineHeight).toBe(MIN_TIMELINE_HEIGHT);
  });

  it('shrinks saved panel sizes to preserve the central preview at narrow widths', () => {
    const layout = normaliseWorkspaceLayout({ assetWidth: 700, propertyWidth: 700, timelineHeight: 252 }, 1100, 700);
    expect(layout.assetWidth + layout.propertyWidth).toBeLessThanOrEqual(1100 - 440 - 12);
  });

  it('caps a saved timeline height while keeping the workspace usable', () => {
    expect(normaliseWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, timelineHeight: 9999 }, 1440, 620).timelineHeight).toBe(314);
  });
});
