import { useEffect, useRef, useState } from 'react';
import { getSavePicker, mp4FileName, type ExportSettings, type SaveMethod } from './saveVideo';
export function ExportDialog({ busy, progress, onStart, onClose }: { busy: boolean; progress: string; onStart: (settings: ExportSettings) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fileName, setFileName] = useState('frameyu-demo');
  const [method, setMethod] = useState<SaveMethod>(() => getSavePicker() ? 'picker' : 'download');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="export-dialog" aria-labelledby="export-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy) onStart({ fileName, method }); }}>
      <h2 id="export-title">导出视频</h2>
      <label>文件名<input autoFocus aria-label="导出文件名" value={fileName} disabled={busy} maxLength={140} onChange={(event) => setFileName(event.target.value)} /></label>
      <small>保存为：{mp4FileName(fileName)}</small>
      <label>格式<select aria-label="导出格式" disabled><option>MP4（H.264 / AAC）</option></select></label>
      <p>当前仅支持 MP4。1280 × 720 · 30 FPS，包含字幕、混音及画面叠加。</p>
      <label>保存方式<select aria-label="保存方式" value={method} disabled={busy} onChange={(event) => setMethod(event.target.value as SaveMethod)}><option value="download">浏览器下载</option>{getSavePicker() && <option value="picker">选择保存位置</option>}</select></label>
      <p>{method === 'picker' ? '点击开始后先选择文件位置，再开始编码。' : '下载目录由浏览器设置管理，浏览器可能询问保存位置。'}</p>
      <p role="status" aria-live="polite">{progress}</p>
      <div className="export-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? '正在导出…' : '开始导出'}</button></div>
    </form>
  </dialog>;
}
