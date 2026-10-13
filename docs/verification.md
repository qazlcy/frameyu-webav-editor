# WebAV 验证记录

日期：2026-10-13。所有时间均以浏览器客户端的本地 WebCodecs 能力为准。

## 阶段 A：环境与 API

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| Node.js | 通过 | 用户级 Node `v22.14.0`，npm 使用该运行时。 |
| 依赖锁定 | 通过 | `package-lock.json` 固定 React 18、Vite 6、WebAV 1.2.8、Vitest、Playwright。 |
| TypeScript | 通过 | `npm run typecheck`。 |
| WebAV 画布 API | 已验证 | `AVCanvas(container, { width, height, bgColor })`、`play`、`pause`、`previewFrame`、`createCombinator`。 |
| WebAV 媒体 API | 已验证 | `MP4Clip(stream)`、`AudioClip(stream, { volume })`、`AudioClip.split(us)`、`VisibleSprite`、`ImgClip`、`renderTxt2ImgBitmap`。 |
| MP4 输出 API | 已验证 | `await canvas.createCombinator()` 后读取 `combinator.output({ maxTime })` 的 `ReadableStream`。 |

SDK 类型来源：`node_modules/@webav/av-canvas/dist/av-canvas.d.ts` 与 `node_modules/@webav/av-cliper/dist/av-cliper.d.ts`。未使用 `any` 或 `@ts-ignore` 绕过接口差异。

## 阶段 B：真实媒体链路

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 官方公开 MP4 夹具 | 已准备 | `tests/fixtures/webav-bunny_0.mp4`，来源 WebAV GitHub Pages。 |
| 官方公开 MP3 夹具 | 已准备 | `tests/fixtures/webav-44.1kHz-2chan.mp3`，来源 WebAV GitHub Pages。 |
| 导入、预览、混音、字幕、导出实现 | 已实现 / 待浏览器验证 | 适配器使用 WebAV 实际 Clip、Sprite 和 Combinator，不提供模拟结果。 |
| Playwright Chromium 下载 | 通过 | 下载到项目 `node_modules/playwright-core/.local-browsers`。 |
| Playwright 真实导出 | 未通过（环境阻断） | 启动 Chromium 前失败：宿主缺少 `libgbm1` 与 `libasound2`；当前账户无 sudo。未将此标记为导出成功。 |

## 阶段 C/D：编辑工程和裁剪

| 项目 | 结果 | 记录 |
| --- | --- | --- |
| 工程/运行时分离 | 已实现 | `Project` 只保存可序列化数据；`WebAVAdapter` 私有保存 File 和 WebAV 实例。 |
| 时间换算和边界 | 通过 | Vitest 覆盖毫秒/微秒、100ms 吸附、移动边界和左右裁剪。 |
| 音频源裁剪 | 已实现 / 待浏览器听感验证 | 对每一片段使用 `AudioClip.split` 丢弃前置/尾部音频，预览与导出共享路径。 |
| 工作台 | 已实现 | 素材库、预览、属性、四轨时间轴、选中/拖动/裁剪。 |

## 阶段 E：交付检查

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test` | 通过：5/5 |
| `npm run build` | 通过：Vite 生产构建完成 |
| `PLAYWRIGHT_BROWSERS_PATH=0 npm run test:e2e` | 环境阻断，见阶段 B |

## 已知限制

1. 远程容器缺浏览器运行库，尚不能在该容器中声明真实 MP4 导出已验证；请按 README 清单在 Chrome/Edge 复核。
2. 为优先保证状态正确，编辑同步会在 120ms 节流后重建当前 WebAV Sprite 集合，但不会重建 AVCanvas 实例；长视频或高频编辑的性能不属于首版承诺。
3. 支持范围受浏览器 WebCodecs 编解码器限制；遇到不支持输入会给出错误，不会回退到 FFmpeg。
