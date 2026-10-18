export type AssetType = 'video' | 'audio';
export type AudioKind = 'music' | 'sfx';
export type TrackType = 'caption' | 'video' | 'music' | 'sfx';
export type CaptionPosition = 'bottom' | 'center' | 'top';
export const DEFAULT_TRACK_HEIGHT_PX = 42;
export const MIN_TRACK_HEIGHT_PX = 38;
export const MAX_TRACK_HEIGHT_PX = 180;

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  mimeType: string;
  durationMs: number;
  width?: number;
  height?: number;
  /** SHA-256 and byte size identify video or audio content; audio kind is not part of identity. */
  fileSize?: number;
  contentHash?: string;
  /** Audio assets are deliberately classified at import time; older projects treat an unset value as music. */
  audioKind?: AudioKind;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  order: number;
  locked: boolean;
  heightPx: number;
  clipIds: string[];
}

export interface CaptionStyle {
  fontSize: number;
  color: string;
  position: CaptionPosition;
}

export type VideoLayoutMode = 'full' | 'fit' | 'fill' | 'pip' | 'custom';
export type VideoResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Coordinates use the project's fixed internal 1280×720 canvas, never CSS pixels. */
export interface VideoLayout {
  mode: VideoLayoutMode;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  keepAspectRatio: boolean;
}

/** Normalized source-image rectangle. It is independent from timeline time and videoLayout. */
export interface SourceCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimelineClip {
  id: string;
  trackId: string;
  type: 'audio' | 'caption' | 'video';
  assetId?: string;
  name: string;
  startMs: number;
  sourceStartMs: number;
  /** Source-media interval length. Undefined means legacy `durationMs × playbackRate`. */
  sourceDurationMs?: number;
  durationMs: number;
  /** Playback rate. `durationMs` is project time; source time is tracked separately. Defaults to 1 for older projects. */
  playbackRate?: number;
  volume: number;
  muted?: boolean;
  videoLayout?: VideoLayout;
  /** Undefined on legacy projects means the complete source image. */
  sourceCrop?: SourceCrop;
  text?: string;
  captionStyle?: CaptionStyle;
}

export interface CaptionDraft {
  text: string;
  startMs: number;
  endMs: number;
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
  { id: 'caption', type: 'caption', name: '字幕', order: 0, locked: false, heightPx: DEFAULT_TRACK_HEIGHT_PX, clipIds: [] },
  { id: 'video', type: 'video', name: '视频', order: 1, locked: false, heightPx: DEFAULT_TRACK_HEIGHT_PX, clipIds: [] },
  { id: 'music', type: 'music', name: '背景音乐', order: 2, locked: false, heightPx: DEFAULT_TRACK_HEIGHT_PX, clipIds: [] },
  { id: 'sfx', type: 'sfx', name: '音效', order: 3, locked: false, heightPx: DEFAULT_TRACK_HEIGHT_PX, clipIds: [] },
];

export const emptyProject = (): Project => ({
  width: 1280,
  height: 720,
  assets: [],
  tracks: INITIAL_TRACKS.map((track) => ({ ...track, clipIds: [] })),
  clips: [],
});
