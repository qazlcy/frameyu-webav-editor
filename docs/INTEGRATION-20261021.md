# GitHub main 与本地 AI 版本适配记录

日期：2026-10-21。基线：`64924704ae288aba0e95b8f229e8f19e182152b9`。
来源：`https://github.com/rong-24/frameyu-webav-editor.git`，HTTPS 克隆 main。
当前本地分支：`integrate/local-ai-windows`。按用户要求通过当前账号的 fork 分支提交 PR，由上游所有者审核合并；保留 Editor / Studio 两个入口，没有迁移 AI 到 Editor。

## 目录与功能

新目录 `frameyu-webav-editor-main-adapt` 与旧 `frameyu-webav-editor` 并列，旧源码、素材与 ZIP 保留。

- `/`：本地首页和滚动修复；“创作”进入 `/studio`。
- `/studio`：已有演示工作台、素材导入、真实时间线/预览/MP4 导出，AI 面板支持本机抽帧、Mock/真实模式、方案审阅、确认应用与整批撤销。
- `/editor`：保留 main 的素材库抽屉、直接导入入口、源画面裁剪、性能优化、底部离散柱波形及导出配置。可从首页页脚进入。

没有把远程 App 改回旧版，也没有把两个界面的所有独有控件合为同一界面。AI 目前在 `/studio` 使用；两者共享工程类型、缓存和 WebAV 引擎。

## 文件适配

- `src/main.tsx`、`src/home/`、`src/demo/`、`public/`：恢复首页和既有 Studio；远程 `src/App.tsx` 保持原样。
- `src/ai/`、`shared/`、`server/`：接入既有真实剪辑链路；只加入 `.env.example`，不读取或复制私人配置。
- `src/timeline/mediaPreviewCache.ts`：保留远程全素材最多 180 帧的缓存，同时支持 Studio 可见范围分窗缓存。远程界面使用格首采样，Studio 使用格中采样。
- `src/timeline/VideoThumbnailStrip.tsx`：Studio 的可见区缩略图与裁剪窗口映射。
- `src/timeline/waveformDisplay.ts`：保留本地对较响波形的平滑压缩，绘制组件保留远程底部离散柱实现。
- `src/webav/WebAVAdapter.ts`：保留远程预览 visibleRect / 导出 Canvas 裁剪路径和图层重建优化，合入导出错误监听及流资源释放。
- `src/editor/videoDedup.ts`：失败的文件摘要任务不永久留在缓存，允许同一 File 重试。
- `src/export/ExportDialog.tsx`、`saveVideo.ts`：Studio 保存配置；远程 App 的内联导出弹窗和 exportFile 保持。
- `src/styles.css`：仅追加 `.studio` 范围的样式，避免覆盖远程导出弹窗。
- `scripts/start-ai*`、`start-ai-real.cmd`、`start-ai-mock.cmd`、`package.json`、`vite.config.ts`：Windows 双击启动、无 npm PATH 依赖的运行方式、本机代理与独立测试进程。
- `tests/`、`playwright.config.ts`：合入 AI、安全、撤销等测试，旧编辑器测试路由调整为 `/editor`，更新过时的导入与导出选择器。
- `.gitignore`、README、Windows 说明、许可文件：私有环境排除、启动和许可说明。

没有修改依赖版本或锁文件。当前 node_modules 是指向旧项目依赖的目录联接；ZIP 中不包含，独立解压请运行 `npm.cmd ci`。

## 实测结果

- 合入前：远程基线 83 项 Vitest 测试通过，TypeScript 通过。
- 合入后：17 个测试文件、131 项 Vitest 测试全部通过。
- TypeScript `--noEmit` 和 Vite 生产构建通过。构建有单个压缩后 JS 大于 500 kB 的体积提示。
- Windows Edge：13 项 Playwright 测试全部通过，无跳过。
- 首页：1920、1366、390 宽度真实滚轮到底部；往返 Studio 和原版编辑器后仍可滚动。
- AI Mock：真实本机抽帧、确认前无计划请求、方案应用、播放、真实 MP4 编码/重新解码、整批撤销；切真实模式时无密钥明确报错。
- 原版编辑器：双视频、音频和字幕组合导出，重新解码检查分辨率、时长和非静音音频；素材抽屉、面板尺寸、轨道布局、波形 Canvas 自检通过。
- 裁剪：合成 VideoFrame 的 visibleRect 和 Canvas 路径像素测试通过；裁剪确认工具栏位置通过。
- `start-ai-real.cmd -Check` 通过，不启动服务、不加载环境配置，验证了无需 npm 在 PATH 中的启动检测。

测试服务使用 127.0.0.1:5175 / 8789，显式空配置且阻断上游 fetch；不会复用用户在 5173 / 8787 上运行的服务。测试已结束，旧服务未停止。

浏览器输出在 `test-results/`，首页截图在 `docs/home/scroll-fix/`。测试产物不作为源码 ZIP 的内容。

## 支持与未验证

AI 白名单支持：素材截取、顺序拼接、标题/文字叠加、原声音量调整。时间单位为整数毫秒。先验证方案与素材范围再应用；无任意代码执行。文字来源明确，无语音识别。

真实 DeepSeek/GLM 请求、账户权限、额度、模型输出质量均未验证。未发送用户素材。裁剪已做像素路径和布局验证，但本轮未做多种真实长视频的裁剪导出质量/性能测试；系统另存为原生对话框也未自动验证。手机仅检查首页滚动，不表示完整编辑体验适配手机。

真实联调请先停止旧目录服务，在新目录自行从 `server/.env.example` 创建 `server/.env`，填写密钥，再双击 `start-ai-real.cmd`；浏览器仍需主动切换真实模式并确认上传抽帧。不要把密钥发到聊天中。
