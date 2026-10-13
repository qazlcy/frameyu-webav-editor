import { clamp } from './timelineMath';

export const DEFAULT_WORKSPACE_LAYOUT = { assetWidth: 245, propertyWidth: 270, timelineHeight: 252 };
export const MIN_ASSET_WIDTH = 200;
export const MIN_PROPERTY_WIDTH = 230;
export const MIN_PREVIEW_WIDTH = 440;
export const MIN_TIMELINE_HEIGHT = 180;
export const MIN_WORKSPACE_HEIGHT = 300;
export const WORKSPACE_DIVIDER_SIZE = 6;

export type WorkspaceLayout = typeof DEFAULT_WORKSPACE_LAYOUT;

export function normaliseWorkspaceLayout(layout: WorkspaceLayout, width: number, height: number): WorkspaceLayout {
  const assetWidth = clamp(Math.round(layout.assetWidth), MIN_ASSET_WIDTH, Math.max(MIN_ASSET_WIDTH, width - MIN_PROPERTY_WIDTH - MIN_PREVIEW_WIDTH - WORKSPACE_DIVIDER_SIZE * 2));
  const propertyWidth = clamp(Math.round(layout.propertyWidth), MIN_PROPERTY_WIDTH, Math.max(MIN_PROPERTY_WIDTH, width - assetWidth - MIN_PREVIEW_WIDTH - WORKSPACE_DIVIDER_SIZE * 2));
  const timelineHeight = clamp(Math.round(layout.timelineHeight), MIN_TIMELINE_HEIGHT, Math.max(MIN_TIMELINE_HEIGHT, height - MIN_WORKSPACE_HEIGHT - WORKSPACE_DIVIDER_SIZE));
  return { assetWidth, propertyWidth, timelineHeight };
}
