export type SaveMethod = 'download' | 'picker';
export interface ExportSettings { fileName: string; method: SaveMethod; }
export interface ExportWritable { write: (blob: Blob) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void>; }
export type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[]; excludeAcceptAllOption: boolean }) => Promise<{ createWritable: () => Promise<ExportWritable> }>;
export function getSavePicker(): SavePicker | undefined {
  const host = window as Window & { showSaveFilePicker?: SavePicker };
  return host.showSaveFilePicker?.bind(host);
}
export function mp4FileName(input: string): string {
  let stem = input.trim().replace(/\.(mp4|mov|webm|avi|mkv)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
  if (!stem) stem = 'frameyu-demo';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.mp4`;
}
export function downloadMp4(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url; anchor.download = fileName; document.body.append(anchor); anchor.click();
  } finally {
    anchor.remove();
    // Let the browser consume the URL before releasing it (including slow downloads).
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** One synchronous lock covers picker, encoding and writing. Picker runs before any await. */
export class ExportController {
  private running = false;
  async start(settings: ExportSettings, encode: () => Promise<Blob>, picker?: SavePicker, download = downloadMp4): Promise<'saved' | 'cancelled' | 'busy'> {
    if (this.running) return 'busy';
    this.running = true;
    let writable: ExportWritable | undefined;
    let selecting = true;
    try {
      const name = mp4FileName(settings.fileName);
      if (settings.method === 'picker') {
        if (!picker) throw new Error('当前浏览器不支持选择保存位置，请使用浏览器下载。');
        const handle = await picker({ suggestedName: name, types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }], excludeAcceptAllOption: true });
        writable = await handle.createWritable();
      }
      selecting = false;
      const blob = await encode();
      if (!blob.size || blob.type !== 'video/mp4') throw new Error('编码未生成有效的 MP4 文件。');
      if (writable) { await writable.write(blob); await writable.close(); writable = undefined; }
      else download(blob, name);
      return 'saved';
    } catch (error) {
      if (writable) { try { await writable.abort(); } catch { /* Preserve the original failure. */ } }
      if (selecting && error instanceof Error && error.name === 'AbortError') return 'cancelled';
      throw error;
    } finally { this.running = false; }
  }
}
