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

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  order: number;
  locked: boolean;
  clipIds: string[];
}

export interface CaptionStyle {
  fontSize: number;
  color: string;
  position: CaptionPosition;
}

export interface TimelineClip {
  id: string;
  trackId: string;
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
  assets: Asset[];
  tracks: Track[];
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

export const INITIAL_TRACKS: ReadonlyArray<Track> = [
  { id: 'caption', type: 'caption', name: '字幕', order: 0, locked: false, clipIds: [] },
  { id: 'video', type: 'video', name: '视频', order: 1, locked: false, clipIds: [] },
  { id: 'music', type: 'music', name: '背景音乐', order: 2, locked: false, clipIds: [] },
  { id: 'sfx', type: 'sfx', name: '音效', order: 3, locked: false, clipIds: [] },
];

export const emptyProject = (): Project => ({
  width: 1280,
  height: 720,
  assets: [],
  tracks: INITIAL_TRACKS.map((track) => ({ ...track, clipIds: [] })),
  clips: [],
});
