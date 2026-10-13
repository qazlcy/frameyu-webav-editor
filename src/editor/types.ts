export type AssetType = 'video' | 'audio';
export type TrackType = 'caption' | 'video' | 'music' | 'sfx';
export type CaptionPosition = 'bottom' | 'center' | 'top';

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  mimeType: string;
  durationMs: number;
  width?: number;
  height?: number;
}

export interface CaptionStyle {
  fontSize: number;
  color: string;
  position: CaptionPosition;
}

export interface TimelineClip {
  id: string;
  trackId: TrackType;
  type: 'audio' | 'caption' | 'video';
  assetId?: string;
  name: string;
  startMs: number;
  sourceStartMs: number;
  durationMs: number;
  volume: number;
  text?: string;
  captionStyle?: CaptionStyle;
}

export interface Project {
  width: number;
  height: number;
  mainVideoAssetId?: string;
  assets: Asset[];
  clips: TimelineClip[];
}

export interface EditorState {
  selectedClipId?: string;
  playheadMs: number;
  zoom: number;
  playback: 'idle' | 'playing' | 'paused';
  status: 'ready' | 'loading' | 'exporting' | 'error';
  message: string;
}

export const TRACKS: ReadonlyArray<{ id: TrackType; label: string }> = [
  { id: 'caption', label: '字幕' },
  { id: 'video', label: '主视频' },
  { id: 'music', label: '背景音乐' },
  { id: 'sfx', label: '音效' },
];

export const emptyProject = (): Project => ({
  width: 1280,
  height: 720,
  assets: [],
  clips: [],
});
