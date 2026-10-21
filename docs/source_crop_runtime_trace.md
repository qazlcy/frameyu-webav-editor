# sourceCrop 运行时追踪

日期：2026-10-19  
实现提交：`7383e531b73a23e39e99ee00cc05f82fc8f178d1`

## 已执行：底层 visibleRect 像素裁切

命令：

```bash
npm run test:e2e:local-libs -- --grep "source-crop (interceptor|Canvas)"
```

输入：300×100 OffscreenCanvas，左红、中绿、右蓝，各 100px；crop `{ x:0, y:0, w:2/3, h:1 }`。

实际记录：

```text
path: visible-rect
input coded/display: 300×100
output coded: 300×100
output display: 200×100
output visibleRect: (0,0,200,100)
timestamp: 123
duration: 33333
pixels: left [255,0,0], middle [47,207,0], right [0,255,0]
```

结论：被排除的右侧蓝区没有进入 Canvas2D 输出；不是只检查 visibleRect 字段。

## 已执行：底层 OffscreenCanvas 实体像素裁切

输入：200×80 OffscreenCanvas，左红、右蓝；crop `{ x:0, y:0, w:0.5, h:1 }`，强制 `forceCanvas:true`。

实际记录：

```text
path: canvas
output coded/display: 100×80
output right pixel: [255,0,0]
```

结论：右半蓝色像素被实体删除，输出帧尺寸就是裁切尺寸。导出模式现在强制使用该路径。

## 已执行：已有 visibleRect 内的坐标换算

纯函数测试使用已有可见区域 `{ x:8, y:4, width:1280, height:720 }` 和裁切 `{ x:0.25, y:0.5, w:0.5, h:0.5 }`，结果为：

```text
cropPixels: { sx:328, sy:364, sw:640, sh:360 }
```

结论：归一化裁切相对解码帧已有可见区域计算，不会错误落到 coded frame 的左上角填充区域。

## 未执行：正式裁切交互、真实 MP4 预览与导出

远程 Playwright Chromium 不提供完整 `VideoDecoder`、`VideoEncoder`、`AudioDecoder`、`AudioEncoder`，因此以下项目未执行，不能虚构 clipId 或调用次数：

```text
一次真实 MP4 裁切操作：未执行
确认后真实 MP4 普通预览：未执行
Combinator 实际 MP4 导出：未执行
导出文件重新解码像素检查：未执行
真实视频原声/时长检查：未执行
```

## 用户本地运行时应采集的日志

确认裁切并预览后：

```text
[SourceCrop] installed source crop
  runtimeId: <clipId>:preview:<n>
  clipId: <真实片段 ID>
  sourceCrop: <确认后的归一化矩形>
  renderMode: preview

[SourceCrop] first transformed frame
  path: visible-rect（不支持时为 canvas）
  invocation: 1
  cropPixels: { sx, sy, sw, sh }
  displayCropPixels: { sx, sy, sw, sh }
  input/output: codedWidth/codedHeight/displayWidth/displayHeight/visibleRect
```

导出后：

```text
[SourceCrop] installed source crop
  runtimeId: <clipId>:export:<n>
  renderMode: export

[SourceCrop] first transformed frame
  path: canvas
  invocation: 1
  output coded/display size: displayCropPixels.sw × displayCropPixels.sh

[CropPerformance] export-crop-metrics
  exportFrameTransforms: > 0
  cropFrameTransformMs: > 0
```

如果 export runtime 没有第一帧日志或 `exportFrameTransforms` 为 0，应保留完整控制台输出并停止把导出文件标记为裁切成功。

## 自动测试汇总

```text
TypeScript: 通过
Vitest: 83/83 通过
Vite production build: 通过
Playwright local-libs: 7 通过，1 跳过
```

跳过的是远程 Chromium 无完整 WebCodecs 时的真实媒体合成；不能视为正式 MP4 裁切验收通过。
