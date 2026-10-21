# 素材和依赖来源记录

本文件是迁移时对已有记录的汇总，不是新授予的使用许可。

| 内容 | 来源与状态 |
| --- | --- |
| 首页森林石桥摄影及三个 WebP 变体 | Martin Damboldt / Pexels，作品 814499；原项目的来源与许可核实记录完整保存在 `public/home/photos/SOURCES.txt` |
| 首页夕照丘陵摄影 | Christian Heitz / Pexels，作品 842711；同上 |
| `public/home/workspace.png`、`ai-panel.png` | 原项目实际页面截图，用于首页展示 |
| `public/demo/*.mp4` | 项目程序生成的图形视频；生成源码在 `src/demo/demoProject.ts`、`renderDemoShot.ts`，生成脚本在 `scripts/generate-studio-media.mjs` |
| Studio 背景音乐 | `src/demo/demoProject.ts` 自制正弦音合成，依原项目记录无第三方采样 |
| 图标 | 项目自绘 SVG，见 `src/demo/Icon.tsx` |
| `tests/fixtures/webav-*` | 原仓库已有 WebAV 测试素材，工作区没有提供各文件的完整授权链；为了测试可复现保留，不将其宣称为原创或已获得商业授权 |
| npm 依赖 | 版本与来源由 `package-lock.json` 锁定；每个已安装依赖的许可信息见 `third-party-licenses/INDEX.json`，附带许可/通知文件保存在同目录 |

原项目记录的设计参考：https://github.com/walterlow/freecut/blob/main/DESIGN.md ，据 `docs/studio/README.md` 未复制其源码、字体或图标。本次未重新开展法律许可审查。项目本体未提供许可证的情况见根目录 `LICENSE`。
