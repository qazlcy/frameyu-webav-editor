# Windows 智能剪辑启动与演示

首次使用建议按 [Windows 完整操作说明](docs/OPERATION-GUIDE.zh-CN.md) 操作，包含两个入口区别、完整演示与故障排查。

新版在原项目 /studio 接入智能剪辑；首页、/editor 原版编辑器保留。请优先使用本说明，README 中早期 Linux 路径不适用于 Windows。

## 安装和无密钥演示

1. 将新版 ZIP 解压到一个新文件夹，保留旧版本。进入包含 package.json 的项目文件夹；本次克隆目录为 frameyu-webav-editor-main-adapt。
2. 安装 Node.js 22.10 或更新版本（建议 22 LTS / 24 LTS，含 npm）。打开 PowerShell，运行 `node --version`、`npm.cmd --version`。
3. 运行 `npm.cmd ci` 安装锁定依赖。
4. 运行 `npm.cmd run dev:ai:mock`，或者双击 `start-ai-mock.cmd`。这会同时启动前端与本机代理，Mock 启动不读取 server/.env。
5. 用本机 Chrome / Edge 打开 http://127.0.0.1:5173 ，点击首页“创作”。仅前端启动 `npm run dev` 不包含代理。
6. 导入短 H.264/AAC MP4，打开 AI 助手，勾选 1–3 个视频，输入要求。默认明确显示 Mock。
7. 点击“在本机抽帧”，核对缩略图与时间，然后点击“确认运行 Mock 测试”。Mock 按所选素材顺序截取开头，简单识别数字秒数、标题和降低原声指令；它不是 AI 视觉结果，不宣称找到了主要画面。
8. 审阅源区间、顺序、音量和文字，点击“确认替换时间线”。这会替换全部原片段（包括音乐、字幕），保留素材库与轨道。播放预览，或使用原来的“导出视频”导出 MP4。顶部“撤销”一次恢复整批计划。
9. 在终端按 Ctrl+C 停止前后端。窗口关闭后媒体会话不保留，重新打开需重新导入。

## 真实 API 联调（需用户自行执行，本轮未调用）

1. 停止 Mock 服务。在本机将 `server/.env.example` 复制为 `server/.env`。只在本机编辑此文件，填写自己的 DeepSeek 标准 API Key 和智谱标准模型 API Key；不要发到聊天中。
2. 保持 `DEEPSEEK_MODEL=deepseek-flash`、`GLM_MODEL=glm-4.6v`，或按账户当前权限及官方文档修改。GLM 端点固定为 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，不是 Coding Plan。
3. 运行 `npm.cmd run dev:ai` 或双击 `start-ai-real.cmd`。只有此启动方式读取 server/.env，密钥不返回前端、不写浏览器存储、不写日志。
4. 页面仍默认 Mock，需要主动切换到“真实 API”。选择自己允许发送的短测试素材，先抽帧，核对发送说明，再主动确认发送。调用可能产生费用。
5. GLM 接收抽取的图片、素材 ID 和时间；DeepSeek 接收要求、素材 ID/时长/分辨率及 GLM 描述。不发送完整视频、音频或文件名。素材上的文字仅作为数据，不作为系统指令。
6. 审阅方案再应用。检查是否满足目标时长、主要画面、标题文字及音量，然后预览并导出、试听。抽帧不能覆盖全部画面；没有语音识别，标题/字幕只是用户文字或明确标注的生成文案。
7. 缺少密钥会显示 MISSING_KEY，认证失败显示 AUTH，余额不足 QUOTA，限流或智谱额度不足 RATE_LIMIT，网络失败 NETWORK，超时 TIMEOUT，结构不合格 OUTPUT。不会偷偷切换 Mock。不要反复点击重试造成额外费用。

## 技术边界

- 代理仅监听 127.0.0.1:8787，前端默认仅监听 127.0.0.1:5173，严格端口；通过 Vite 同源代理访问 /api/ai。
- 模型、温度、Token 限制、超时均在服务端配置。默认每次上游 45 秒，最多 60 秒；仅 5xx 重试一次，间隔 300ms；网络/超时/认证/限流不自动重试。
- 每素材固定 3 帧（10%、50%、90%），最多 3 个素材 / 9 帧，长边最多 640px，每帧 Data URL 最多 200000 字符，请求最多 2MB。模型正文最多 24000 字符，默认输出最多 3072 tokens、上限 4096；最多 24 段、12 处文字、5 分钟成片。
- 共享严格校验器同时用于代理和前端；只接受 cut/title，所有时间为整数毫秒，检查素材 ID、范围、时长、音量、文字来源和额外字段。服务端没有执行模型代码、任意 URL 或 Shell 的路径。
- 方案过期（生成后修改工程）必须重做。构建新快照并准备 WebAV 后才一次提交；失败保留原工程并尝试恢复预览。应用期间阻止编辑，提交进入现有撤销历史。
- AI 只在首页“创作”的 /studio 内接入；/editor 保留原编辑功能。现有画幅 1280×720、30 FPS；不增加自动语音识别、转场或生成音乐。
- 没有新增运行依赖，后端使用 Node 内置 HTTP / fetch / 环境变量加载。Node 18 不支持这里的真实配置启动方式。
- 不公开部署。`dist` 是纯前端产物，本次提供的是使用 Vite 同源代理的本机启动流程。

## 检查命令

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
# 测试自动启动隔离的无密钥服务，无须手动启动
$env:PLAYWRIGHT_CHANNEL='msedge'
npm.cmd run test:e2e -- --workers=1
```

AI E2E 固定使用独立 5175 / 8789 端口，拒绝复用既有服务，显式空配置且禁止外部 API 网络，只使用仓库测试素材。源码包排除 .env、.git、node_modules、dist、日志和测试产物；只保留 server/.env.example。

## 官方文档核对（2026-10-21）

- DeepSeek 首次调用及当前模型名：https://api-docs.deepseek.com/zh-cn/
- DeepSeek JSON 输出：https://api-docs.deepseek.com/zh-cn/guides/json_mode/
- GLM-4.6V 图像请求：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v
- 智谱标准 API 和密钥类型：https://docs.bigmodel.cn/cn/api/introduction
- 智谱错误码：https://docs.bigmodel.cn/cn/api/api-code

这些文档确认了接口格式，不代表本项目已经通过真实账户付费调用验证。

### 双击提示 npm 不存在时（启动器修复）

新版 `start-ai-real.cmd` / `start-ai-mock.cmd` 已改为直接使用 Node 启动，不再要求 npm 在 PATH 中。启动器先检查 PATH 与常见 Node 安装位置，再检查本机已有的 Codex Node 运行时；不会安装程序或修改系统 PATH。当前目录已有依赖时可直接双击。

首次解压到没有 node_modules 的机器，仍需安装含 npm 的 Node.js LTS 并运行 `npm.cmd ci`。若 Codex 更新移走其附带运行时，请安装标准 Node.js LTS。

只检查启动条件（不启动服务、不读取 server/.env）：在终端运行 `start-ai-real.cmd -Check`。此检查不代表 API 已验证。

## 本次克隆目录的依赖与配置

当前电脑的新目录通过 node_modules 目录联接复用旧项目已安装依赖，未安装新依赖；源码 ZIP 不包含此联接，解压后请运行 npm.cmd ci。若以后删除旧项目，请先移除新目录的目录联接，再重新安装依赖。

本次未读取或复制旧目录的 server/.env。真实联调请自行在新目录填写；不要发送密钥给助手。默认启动端口与旧目录相同，请在旧服务窗口按 Ctrl+C 后再启动新目录。
