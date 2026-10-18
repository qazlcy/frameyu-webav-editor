# 帧语编辑器教师评审交接（2026-10-18）

## 目录、基线与范围

工作目录：`C:\Users\62519\Desktop\课题5搭建\frameyu-webav-editor`。
来源：`https://github.com/rong-24/frameyu-webav-editor.git`。
功能分支：`feat/timeline-media-export-review`，基线 `f1fe014d918e482124c45ead8b94ad45e3c82374`。
`200a9ab`、`33b02e2`、`241ddb1` 均是基线祖先；未重新合并这些历史提交，未重做空间裁切或视频去重。启动时工作区干净，未找到仓库 AGENTS.md。

本轮完成波形细线、视频连续缩略帧、音频内容去重和导出设置四项。未做素材抽屉、依赖升级、架构重写、服务器操作或合并 main。

## 环境与基线验证

锁文件未修改。检查 package.json 和锁文件后使用 `npm ci --ignore-scripts --no-audit --no-fund`；锁中安装脚本涉及 esbuild 与 macOS 专用 fsevents。Windows 的可选 esbuild 二进制已正常工作，不需要运行安装脚本。

系统终端默认 Node 18.19.0，初次测试 35/77 失败，原因是测试环境缺少 crypto/File 全局对象。随后从 nodejs.org 下载 Node 22.14.0 到临时目录，没有改变系统 Node 安装或项目依赖。为确认不是代码修改掩盖基线问题，又将原始 f1fe014 用 git archive 解到独立临时目录，复用相同锁文件依赖，运行原始脚本：

| 原始基线检查（Node 22.14.0） | 结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm test | 77/77 通过 |
| npm run build | 通过 |

临时 Node：`C:\Users\62519\AppData\Local\Temp\frameyu-node-22.14.0\node-v22.14.0-win-x64`。
本机 Chrome 提供 VideoDecoder、VideoEncoder、AudioDecoder、AudioEncoder。本轮使用的是本机 Chrome 无头运行，不是旧远程 Linux 缺 WebCodecs 的环境。

## 实现与独立提交

1. `ac036f9`：音频波形细线。`WaveformCanvas.tsx` 从现有 Peak/RMS 缓存按可见像素聚合，默认画两层细线和稳定中线，可选间隔竖线。可见区域独立分配 DPR 画布，避免长片段整幅压缩造成模糊。`waveformDisplay.ts` 用平滑压缩代替增强增益的硬钳制，零值保持零，强峰仍有区别。未改 PCM 分析、片段音量或导出音量。
2. `6440e4d`：视频连续缩略帧。`VideoThumbnailStrip.tsx` 根据可见窗口、轨高和 sourceCrop 展示源帧；源时间来自 sourceStartMs/sourceDurationMs，时间轴长度负责倍率映射。`TimelineMediaPreviewCache.ensureThumbnails` 继续调用 MP4Clip.thumbnails，按稳定时间窗口请求、合并并发任务、串行取帧，每次至多约 33 帧，每素材保留 8 个窗口。淘汰、forgetAsset、dispose 回收 URL；失败窗口不会因渲染反复重试，显示占位。裁切显示复用原帧 URL，原声分析、播放与导出保留。
3. `754f3a8`：音乐/音效去重。`videoDedup.ts` 泛化为 MediaContentDeduplicator，保留旧视频入口和 Worker。音频共用 audio 范围，不把 music/sfx 作为内容身份。先 SHA-256 预留，后解析/注册/分析；失败释放预留，哈希失败可对同一 File 重试。导入成功同步发布 projectRef 再提交预留，避免并发等待者读到未发布素材。重复提示定位实际分类，不改已有 audioKind。同素材仍可多次加入音乐或音效轨。
4. `cd9aac7`：导出设置：`src/export/ExportDialog.tsx`、`saveVideo.ts` 和 App 接入。顶部“导出视频”打开原生模态 dialog，支持文件名及两种保存方式。WebAV 1.2.8 安装源码的 Combinator 使用 MP4 box 输出，未提供其他容器选择，因此只展示 MP4（H.264/AAC）。保持工程的 1280×720、30 FPS；未增加未经验证的高级参数或 FFmpeg 管线。文件名移除路径字符并统一 .mp4，避免伪装格式。picker 在开始按钮调用栈中、任何编码之前调用；同步锁覆盖选择、编码、写入，取消选择不编码。选择文件后创建 writable，编码成功后 write/close，失败 abort；下载回退使用 Blob URL 并延迟释放。WebAVAdapter 回收 reader、监听错误并销毁 Combinator。裁切编辑会话期间禁用导出，避免导出临时完整画面。

## 验证与证据

| 当前检查 | 结果及边界 |
| --- | --- |
| npm run typecheck | 通过 |
| npm test | 95/95 通过，原有测试保留 |
| npm run build | 通过 |
| npm run test:e2e -- --workers=1 | 本机 Chrome 10/10 通过，0 skipped（最终运行 28.1 秒，包含预览/成片画中画区域像素校验） |
| 内容去重 | 实际 MP3 异名跨音乐/音效导入只有 1 次注册、1 次音频分析；两条时间轴引用共用波形。单测另覆盖同名异内容、并发、失败重试、视频范围隔离 |
| 波形 | 静音、类似语音起伏、响亮包络的确定性数据与缓存采样单测；实际 MP3 双引用截图。没有把合成包络称为真实人声录音 |
| 缩略帧 | Chrome 实际 MP4 取帧；单测验证有界请求、同窗口复用、失败抑制、URL 回收、遗忘中的结果丢弃、0.5×/2×源时间映射 |
| 裁切/多轨 | UI 验证 8 个手柄存在、角点拖动、比例、确认、重置后取消；0.5×/2×/1×切换保留裁切；另导出裁切加画中画 2×成片 |
| MP4 下载 | 两视频顺序合成 + MP3 + 烧录字幕，下载后重新解码、检查分辨率/时长与非零音频；见 JSON 和帧截图 |
| picker 分支 | 用户激活为 true 时调用；取消不触发编码；注入 picker 选择器，后端使用真实 Chrome OPFS writable 写入实际编码 MP4。未自动操作系统原生选择窗口 |
| 异常路径 | 单测覆盖不支持 API、权限拒绝、编码/写入/close 失败、重复启动、无效输出、取消后重试 |

截图与成片指标均在 [review-evidence](review-evidence/)：

- [旧填充](review-evidence/waveform-old-fill.png)、[默认轮廓细线](review-evidence/waveform-outline.png)、[间隔细线](review-evidence/waveform-bars.png)：同一确定性 Canvas 自检包络。默认轮廓更连续，竖线保留间距；旧填充在响亮处形成大片实色。
- [视频连续缩略帧](review-evidence/video-thumbnails.png)、[音频重复提示](review-evidence/audio-duplicate.png)、[同源波形复用](review-evidence/audio-waveform-reuse.png)。
- [导出弹窗](review-evidence/export-dialog.png)、[裁切与多轨工作台](review-evidence/crop-multitrack.png)。
- [实际烧录字幕成片帧](review-evidence/export-composite-frame.png)、[成片参数](review-evidence/export-composite.json)。

早期 E2E 暴露旧选择器与当前 UI 不一致（导入音频、添加字幕、导出按钮名称），以及 favicon 404 干扰；已修正测试，并真实创建字幕后导出，没有删除原测试或绕过 WebCodecs。一次运行受开发热更新打断，废弃该轮结果，稳定源码后重跑。

## 限制与接手验收

- 系统原生“选择保存位置”窗口、用户实际磁盘目录和取消/覆盖提示需人工点验；自动测试使用了替代选择器，因此不能宣称原生窗口已通过。
- 固定测试素材较短。小时级视频真实解码性能、超大文件 SHA-256 内存占用、长时间拖动与跨多个不同素材的总内存尚未压力测试。缩略帧缓存按素材有界，素材数量本身未设全局上限。
- 取帧失败后同一窗口保留失败状态，避免反复解码；重新导入/新会话可重试。长时间轴只为可见区域请求细化帧，加载期间可能暂用现有近邻帧。
- 没有进行真人主观听感验收；已检查真实导出 PCM 非零，音调随倍率变化仍是 WebAV 1.2.8 的既有行为。
- 本轮不修改已有 sourceCrop 帧处理算法。旧工程缺失 sourceCrop 的兼容性、分割/裁剪/倍率与层级均保留原单测覆盖。
- 导出仍使用 Blob 聚合，超长成片会占用内存；未借本任务改写输出架构。文件流失败调用 abort 保留原文件，系统选择器可能留下新建的零字节文件，未自动删除用户选中的文件。

## 后续本地启动与复核

PowerShell 在仓库目录中，确保 Node 22 在 PATH 前部（可用上述临时路径，或用户自行安装的 Node 22）：

```powershell
node --version
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm.cmd run test:e2e -- --workers=1
npm.cmd run dev -- --host 127.0.0.1
```

使用 `npm.cmd` 避免当前 Windows 的 npm.ps1 参数转发差异。`test:e2e:local-libs` 是 Linux 的 LD_LIBRARY_PATH 脚本，本机不用。开发服务只绑定 127.0.0.1。依赖安装与测试会生成 node_modules/dist/test-results，均被现有 .gitignore 排除。

人工验收建议：导入一段安静人声、一段响亮音乐及长视频，检查两种细线、静音区、轨高和缩放；重复改名导入音乐/音效；对裁切视频分割、变速、多轨叠加；用原生文件选择保存到专用测试路径，取消一次再成功保存，重新播放输出核对画面和听感。

## 发布状态

此前直接推送上游被 GitHub 以 HTTP 403 拒绝（账号 qazlcy 无上游写权限）。用户随后明确批准通过个人 fork 提交 PR；已使用现有认证完成发布，没有扩大账号权限或创建新凭据。

- 个人 fork：https://github.com/qazlcy/frameyu-webav-editor ，GitHub parent/source 均确认是 rong-24/frameyu-webav-editor。
- PR：https://github.com/rong-24/frameyu-webav-editor/pull/1 。目标 rong-24/frameyu-webav-editor:main，来源 qazlcy/frameyu-webav-editor:feat/timeline-media-export-review。
- 本地 origin 保留原上游，新增 fork remote。没有修改任一 main、覆盖已有分支或改写历史。
- 创建时 head 为 72a70649fe1a0ce33e5d6bea655b3f2fc524d67d，包含四项功能提交与两项交接记录；本次仅追加发布说明文档提交，不新增功能。
- PR 为 open、非草稿，merged=false，auto_merge=null；创建后核验 mergeable=true、mergeable_state=clean。
- 创建后 GitHub 报告 no checks reported，不能把它表述为远程 CI 通过。代码验证依据仍是本轮已记录的本机 typecheck/build、95/95 单测、10/10 Chrome E2E 和真实 MP4 验证。
- 发布前检查工作区/staged/tracked 内容：没有待提交源码改动、node_modules、dist、缓存、凭据文件或凭据文本模式；媒体证据均来自已授权的非敏感仓库夹具。原生文件选择窗口仍需人工验收。

最终成片证据：

- [两视频、音乐及字幕 MP4](review-evidence/review-composite.mp4)：373580 字节，2.033313 秒，1280×720，重新解码音频峰值 0.7324561476707458。SHA-256：`0AB092D835255F43BDA50B83A8B53A3FC9DC277280FBCFF598E52F5D844BE155`。
- [裁切、画中画及 2× MP4](review-evidence/review-crop-overlay.mp4)，[重新解码帧](review-evidence/export-crop-overlay-frame.png)。预览与成片在画中画区域的对应绿色像素检测均通过。SHA-256：`23E6F7D3409681F979A18CA598530964755FB2BA5A3A19E1AF2BCF8071A0E7CE`。

以上文件来自仓库现有非敏感夹具，本轮没有使用用户私人媒体。每次编码产物字节可能不同，重新运行测试会生成新的 JSON 和帧图，归档 MP4 应与新 JSON 一并更新。