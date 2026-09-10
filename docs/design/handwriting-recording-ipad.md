# Gamma 手写、录音、Note Replay 与 iPad 客户端统一设计

> 本文是这组功能的统一设计总纲：解释产品定位、数据模型、状态机、跨端边界、可靠性约束和演进路线。以本次合并的实现为准，明确区分**已实现**、**验证边界**与**未来设计**。
>
> 早期讨论稿是决策历史，不是当前功能承诺。原始讨论、分阶段研究和操作说明见文末索引。本文不包含账号密码、session cookie、签名私钥或用户文档内容。

## 1. 产品定义与基本原则

Gamma 的目标不是另外做一个离线手写本，也不是要求用户把 PDF 再导入另一套知识库。iPad App **就是 Gamma 的一个客户端**：同一账号、同一文献库、同一文档身份、同一 block tree。

核心体验分为三个互相补充的部分：

1. **完整 Gamma 工作区**：文献、普通笔记、Markdown/数学公式、引用、搜索、AI、设置、导入导出等，复用现有 Web 实现。
2. **原生书写与录音工作区**：PDFKit、PencilKit 和系统音频 API 提供 Pencil 输入、原始 PDF 渲染、录音及原生 Replay。
3. **跨端阅读与回放**：原生手写进入 Gamma block 模型后，Web/Desktop 能显示、定位并按录音时间回放，不把 Apple 私有绘图格式误当作浏览器可直接编辑的数据。

必须保持的原则：

- 原始 PDF 不因批注而被改写或压平。
- 手写本身是 block，不是 block 外的孤立文件；它的文字内容就是对应 note。
- 新建一组手写由用户明确执行 **New Ink**，不是每落一笔就新建一个 block。
- 本地保存、待同步、服务器确认是不同状态，不能混称“已保存”。
- 网络重试不能制造重复笔记，也不能静默覆盖别的版本。
- 可编辑原件与显示派生物分离；派生物失败不能成为丢弃原件的理由。
- Replay 必须由音频时钟驱动，不能凭画面动画或墙上时间伪装同步。
- 没有记录过的时间信息不能事后编造。
- 完整功能对齐优先复用既有代码，而不是维护一个功能缩水、行为不同的平行客户端。

## 2. 设计如何演进

### 2.1 早期方案：独立的原生 PDF 手写本

早期探索包括独立 `.note` bundle、本地生成文档 UUID、从 Files 或 Gamma 导入 PDF、按页存一个 PKDrawing，以及以后再补上传/同步。优点是原生验证快，适合先测坐标、落盘和 Pencil 输入。

这不是当前产品模型。它会产生第二个文档身份、第二份文献库和不明确的同步关系，因此被后来的 Gamma-native 设计替代。

旧 `NoteStore` 和测试保留用于历史文件兼容；旧文件不被自动删除，也不猜测应该绑定哪个服务器文档。当前主界面不再暴露 import-only 文献库。

### 2.2 Gamma-native：把手写纳入现有 block tree

第二阶段以真实 Gamma 账号和 paper/page/block 身份为基础，实现：

- Gamma 文献库入口与账号隔离缓存；
- 多笔画组成一个 `pdf_ink` block；
- 对应文字 note 和普通子节点；
- 可编辑源、静态预览、durable outbox 和条件更新；
- Web 中的静态手写显示与原生录音。

### 2.3 录音不是 Replay

“录下来并能播放声音”只完成了录音功能。Notability-style Replay 还必须知道每笔书写和翻页相对于声音的位置。于是增加音频分段时钟、`replay_events`、逐笔显示和跨页 seek。

### 2.4 完整功能复用与浏览器回放

纯 SwiftUI 逐项重写 Web/Desktop 功能，会导致两套编辑器、两套 Markdown 行为和长期功能差距。当前改为混合架构，保留原生输入优势，同时嵌入完整 Web 工作区。

随后为浏览器增加 `.inkjson` 逐笔显示派生物，使 Replay 不再只存在于 iPad。静态 PDF 手写和 Notes 缩略图也复用这些高清图像，消除“回放清晰、静态模糊”的不一致。

## 3. 当前架构与职责

```text
                    同一 Gamma HTTPS 服务
             FastAPI / 账号隔离 SQLite / 私有资产
                       ▲             ▲
           Web 请求与 cookie       原生 REST 与 outbox
                       │             │
┌──────────────────────┴─────────────┴─────────────────┐
│ iPad App                                              │
│                                                      │
│ 原生登录 ──cookie──> 隔离、非持久化 WKWebView           │
│                         完整 Gamma Web 工作区          │
│                                  │ Pencil & Audio     │
│                   校验 origin / session / page / doc  │
│                                  ▼                    │
│                    PDFKit + PencilKit + AVFAudio       │
│                                  │ Full Gamma         │
│                  同步原生编辑后 reload Web tree        │
└──────────────────────────────────────────────────────┘

浏览器 / Electron Desktop ── 同一 Web UI ── 同一 Gamma 服务
```

### 3.1 原生端负责什么

- 原生账号登录及向 Web 工作区提供该会话的 cookie。
- 不可变 PDF 缓存与 PDFKit 页面生命周期。
- Pencil-only 书写、多 ink block 编辑隔离、选字和原生高亮。
- 录音权限、分段录制、状态持久化、恢复和原生音频播放。
- 原生 Replay 与浏览器逐笔预览的导出。
- 本地优先保存、账号隔离 outbox 和安全重试。

### 3.2 Web 工作区负责什么

直接运行既有 Gamma React 工作区：Markdown/数学公式、block tree、搜索、标签/目录、引用、AI、设置、导入导出等不另写一份原生简化版。

这不是宣称每个 WebKit 输入、拖拽、IME、剪贴板、OAuth 或文件提供者流程都已逐项验收。复用同一代码解决功能覆盖和语义一致性；平台适配仍需要测试。

### 3.3 Desktop 与 iPad 的边界

Desktop 是 Electron 加 Web 前端，并非可以直接搬入 SwiftUI 的 AppKit 程序。可复用的是界面、协议、编辑器、渲染和测试语料；不能把 Electron 的本地 Python 服务、子进程管理或桌面浏览器扩展安装能力当成 iPad 功能。

iPad 目前依赖可访问的 Gamma HTTPS 服务。原生已登录会话可以在断网期间处理缓存和队列，不代表完整 Web 工作区拥有与桌面本地服务器相同的离线能力。

## 4. 统一对象模型

### 4.1 三种容易混淆的“页”

- **Gamma page block**：文献或知识树中的根页面，有现存的 block ID。
- **PDF document**：由 `doc_id` 标识的原始 PDF。
- **PDF page number**：PDF 内部第几页，用 `pdf_page` 或 `pdf_position.pageNumber` 表示。

客户端必须保留服务器已有的 page/block/doc 身份。已有 ID 不要求是 UUID；新建原生 annotation/audio/note 的稳定 ID 使用规范小写 UUID。

PDFKit 使用零基页索引，服务端和 Web 高亮位置使用一基页码。转换应集中在边界，不在存储里混用。

### 4.2 手写 block

```text
Gamma PDF page block (existing id, properties.doc_id)
├─ pdf_ink block (stable UUID)
│  ├─ content：这组手写的文字说明
│  └─ children：普通 Gamma note blocks，可继续嵌套
├─ 另一个 pdf_ink block
├─ 普通高亮 block
└─ audio block
```

`pdf_ink` 的关键 properties：

| 字段 | 作用 |
|---|---|
| `type: "pdf_ink"` | 与普通文字、高亮、音频区分 |
| `pdf_page` | 所属 PDF 页，一基 |
| `ink_asset` | 可编辑 PKDrawing 原件的私有资产引用 |
| `preview_asset` | 整块 PNG 预览，兼容/回退用途 |
| `replay_asset` | 可选的逐笔 `.inkjson` 显示派生物 |
| `ink_revision` | 条件更新与冲突判断 |
| `bounds` | 原生规范坐标中的批注范围 |
| `crop_box` | 对应规范页尺寸 |
| `coordinate_space` | 当前为 `pdf-crop-top-left-v1` |

绘图更新不应覆盖 `content`、children 或用户的普通扩展属性。文字更新也不能改写原生源与录音清单。

### 4.3 为什么不用“一笔一个 block”

一段公式或一组批注往往包含数十笔。逐笔建 block 会破坏大纲可读性、增加排序和同步负担，并让一次擦除/移动变成大量知识节点操作。

因此用户用 **New Ink** 定义语义分组；组内 stroke 是绘图数据，不是独立知识节点。Replay 通过 stroke ID 索引组内笔画，不改变 block tree 的粒度。

### 4.4 原生文字高亮

PDFKit 选区按行取出文字和矩形；跨页选区按页拆成多个高亮 block。使用既有的 `highlight_id`、`quote`、`color`、`pdf_page`、`pdf_position`，不另造 iPad-only 高亮类型。

新建接口使用客户端稳定 UUID。丢失响应后的同 ID 重试返回当前 block，而不是覆盖后来在 Web 修改的评论或颜色。后续评论编辑仍走正常 block 更新。

### 4.5 音频 block

一个录音会话对应一个 `audio` block，`content` 仍可用作普通文字说明。音频本身由有序、已结束的 segments 表示：

```json
{
  "type": "audio",
  "audio_revision": 1,
  "audio_state": "stopped",
  "duration": 18.5,
  "segments": [
    {"id": "segment UUID", "asset": "/api/assets/<sha256>.m4a", "duration": 8.0, "start_time": 0.0},
    {"id": "next segment UUID", "asset": "/api/assets/<sha256>.m4a", "duration": 10.5, "start_time": 8.0}
  ],
  "replay_events": []
}
```

以上 UUID/hash 为示意占位符。`duration` 与累计偏移来自实际 finalized 片段，不是录音按钮按下到松开的墙上时间。active segment 属于本地恢复状态，不作为已完成音频伪装上传。

## 5. 手写坐标、显示与输入隔离

### 5.1 规范坐标

`pdf-crop-top-left-v1` 定义：

- 使用**未旋转 crop box** 的局部坐标；
- 左上为原点，x 向右，y 向下；
- 尺寸以 PDF 点表示，不随屏幕缩放、滚动、窗口大小或设备旋转改变。

原生端使用公开 PDFKit 变换，在 PDF 页坐标、屏幕坐标与规范坐标之间转换。未旋转 PDF 页坐标到规范坐标的基本关系为 `x = pdfX - crop.minX`、`y = crop.maxY - pdfY`；屏幕位置必须先通过 PDFKit 转回对应页，不能直接保存触摸点。

Web 使用 pdf.js viewport 的仿射变换。设 `view` 为 viewport.viewBox，`sx=(view[2]-view[0])/crop.width`、`sy=(view[3]-view[1])/crop.height`，则规范点映射为：

```text
P(x,y) = viewport.convertToViewportPoint(view[0] + x*sx, view[3] - y*sy)
o = P(bounds.x, bounds.y)
u = P(bounds.x + 1, bounds.y) - o
v = P(bounds.x, bounds.y + 1) - o
CSS matrix = (u.x, u.y, v.x, v.y, o.x, o.y)
```

同一变换用于预览、逐笔图像和定位框。必须考虑 crop 原点、90/180/270 度旋转和混合页面尺寸，不能只把图片缩放进一个屏幕 bounding box。

### 5.2 多层叠加，而不是改写 PDF

原生 page overlay 包含：

- 当前选中 ink block 的可编辑 canvas；
- 其他 ink block 的只读背景 canvas；
- 既有高亮显示层；
- 独立的只读 replay canvas。

这些层共用坐标变换，但只有可编辑 canvas 能成为保存来源。Replay 帧绝不能进入正常绘图保存回调。

### 5.3 页与选择切换

每个绘图快照保留创建时的 block 身份和保存回调。切换选中 annotation、内容 revision、PDF 或离开页面时，先用**旧配置** flush，再装入新配置。

失败时保留脏快照和原回调，不把旧笔迹保存到新选中的 block，也不把损坏源当成空白页。清理离屏 canvas 时区分干净快照与尚未持久化的内容。

### 5.4 Pencil、文本选择与普通导航

- 书写时 Pencil 进入选中 block，手指继续用于普通页面导航。
- 点击已有笔迹可选择其 block；选择识别应先于绘图，避免产生额外小点。
- **Select text** 开启 PDFKit 文本选择，暂时关闭书写接收；长按并调整 handles 后选色创建高亮。
- **New Ink** 明确返回书写模式。
- 原生 Replay 中不能编辑重建帧；Web Replay 不提供 PKDrawing 编辑器。

手指/Pencil 的真实仲裁、特殊机型和长时间输入仍是硬件验收项目。

## 6. 静态清晰度与笔迹定位

### 6.1 为什么旧静态 PNG 会模糊

旧整块 PNG 按最多 1× 导出，长边还受 2048 上限影响。高分屏或放大后会发糊。逐笔预览通常可到 2×，每笔单独裁切，保留更多有效像素。

现在静态 PDF 层、Notes 缩略图和 Replay 最终帧使用**同一组逐笔 PNG**。这避免仅在回放时清晰、退出后又退回低分辨率图像。

缺失、失效或超出加载预算时，才回退旧整块 PNG。它仍然是栅格图，不宣称任意放大都像矢量一样锐利。

### 6.2 手写 note 的标记与定位

高亮使用圆点；手写使用独立的圆角方框笔形标记。

点击标记、卡片或预览时：

1. 打开被隐藏的 PDF；必要时使用已有 `doc_id` 对应的缓存 PDF 路径。
2. 把 block bounds 经同一 crop/rotation 仿射变换转为显示范围。
3. 跳到目标页内的位置；放大后如目标横向不可见，调整水平滚动。
4. 短暂框出这组笔迹，约 1.8 秒后消失；重复点击可重新提示。

编辑框、CodeMirror 和链接保留原交互。几何信息缺失时退回页定位。侧栏定位本身不是录音 seek；Replay 中点击可见 timed stroke 才是跳到声音的入口。

## 7. 本地优先持久化

### 7.1 账号隔离目录

```text
Application Support/GammaCache/
└─ SHA256(normalized server URL + authenticated username)/
   ├─ library.json
   ├─ recents.json
   ├─ source-SHA256(doc_id).pdf
   ├─ page-SHA256(page_id).json
   └─ audio/<recording UUID>/<segment UUID>.m4a
```

缓存键使用实际认证返回的用户名，不使用尚未验证的输入用户名。当前缓存键明确去除 server URL 末尾斜杠并保留完整服务路径；不同别名/前缀不被猜测为同一缓存。页快照再次检查 `pageID/docID`，不允许缓存被挂到另一文档。

### 7.2 一份原子页快照

`GammaPageCache` 保存 blocks、每个 ink block 的 PKDrawing bytes、outbox、录音清单，以及不支持预览的源标记。

源数据与 pending 操作先一起原子写入，再向 UI 确认本地保存。当前使用 JSON 原子替换，并对页快照使用系统文件保护选项。它不是磁盘硬件故障或任意断电条件下的绝对保证。

只在“文件不存在”时视为空缓存；解码失败、身份不符或源损坏应显式报错，不写回空白覆盖旧数据。

### 7.3 Outbox 类型

| 类型 | 含义 |
|---|---|
| `ink` | 新建/更新可编辑手写与相关显示资产 |
| `content` | 普通 block 内容变更 |
| `child` | 原生稳定 UUID 子 note 条件 upsert |
| `audio` | finalized segments、状态和时间事件清单 |
| `highlight` | 原生选区生成的高亮 |
| `inkPreview` | 不改原件的浏览器预览补生成 |

本地操作 ID 与服务器 block ID 不同：前者标识队列项，后者是永久实体身份。服务端幂等性依赖稳定实体 ID、revision 与 payload，不应把任意本地队列 UUID 误描述为服务器去重协议。

同一 block 的重复编辑可以合并队列。父节点必须先于子节点同步，不能因为父内容后改了一次就排到尚未创建的孩子后面。可选预览任务排在核心编辑之后。

### 7.4 保存失败时的时间信息

磁盘失败后重试同一笔，不能把重试时刻当作它的录音时间。内存中的待保存时间信息保留第一次捕获的时间；重试时只恢复该 block 的笔迹事件，并与最新页快照中的其他事件合并，避免覆盖期间成功保存的翻页或其他 note 事件。

### 7.5 离线与导航

- 原件、文字和 outbox 保留在所属账号缓存中。
- 同步在定时、恢复前台或显式 Retry 时执行。
- 离开读者前先 flush；关键本地写入失败时应阻止静默离开，并明确风险。
- 退出账号不应删除待同步数据；以后只在重新认证同一账号后重试。
- 可选 `inkPreview` 失败不能卡死正常 Full Gamma 切换，也不能丢弃可编辑源。

## 8. 服务端资产与条件更新

### 8.1 内容寻址资产

当前资产类型：

| 扩展名 | 用途 | 服务端能验证什么 |
|---|---|---|
| `.pkdrawing` | Apple 可编辑原件 | 非空、大小、命名/路径；不解码 PencilKit 私有格式 |
| `.png` | 预览 | PNG 格式与完整性检查 |
| `.m4a` | AAC 音频片段 | 基本 ISO-BMFF/ftyp 合理性；不是完整音频解码保证 |
| `.inkjson` | 浏览器逐笔显示派生物 | 严格 schema、PNG/几何/时间及资源约束 |

命名为 `<sha256>.<extension>`。引用是私有同源 `/api/assets/...`，不是任意远程 URL。

上传先有界读取，单资产硬上限 32 MiB。新字节受账号 quota/per-file 政策约束；重复内容返回既有资产。临时文件写完后原子发布，数据库写锁串行化配额与发布相关操作。未引用资产受 staging grace period 保护，避免上传后 block 尚未提交就被清理。

### 8.2 API 分工

| 方法/路径 | 设计责任 |
|---|---|
| `POST /api/assets` | 上传内容寻址资产 |
| `GET /api/assets/{filename}` | 私有读取，包含音频播放需要的文件响应能力 |
| `PUT /api/blocks/{UUID}/ink` | revision 检查的手写更新 |
| `PUT /api/blocks/{UUID}/note` | 原生普通 note 的稳定 ID/条件 upsert |
| `PUT /api/blocks/{UUID}/audio` | 音频 revision、片段清单与事件 |
| `PUT /api/blocks/{UUID}/highlight` | 幂等创建已有模型的高亮 |
| `PUT /api/blocks/{UUID}/replay-preview` | 源检查后的 metadata-only 预览回填 |

精确请求字段和返回语义以 [API 文档](../dev/api.md) 及路由 schema 为准。

### 8.3 资产先于 block

```text
本地原子保存原件/清单 + outbox
          ↓
上传 PKDrawing / PNG / finalized M4A / 可用的逐笔 JSON
          ↓
稳定 block ID + expected_revision 条件更新
          ↓
重新读取最新本地快照，合并服务器确认
          ↓
只移除已确认的操作；保留同步期间新产生的编辑
```

每次 await 后都可能发生本地输入或状态变更，因此不能用网络开始前的整份旧快照覆盖当前缓存。

丢失响应后重试同一 payload 不应再次增加 revision。真正分歧进入冲突处理，不静默 last-write-wins。原生 ink 的“使用远端”会保留旧本地源的归档，不直接抹掉。

### 8.4 Web 整树保存的边界

Web 仍有 replace-children 的整树保存语义。对既有 `pdf_ink` 和 `audio`，服务端保留原生维护的源、revision、几何、录音清单、时间事件及 replay asset，防止一次文字编辑把较新的原生元数据回滚。

这**不是完整协同合并协议**。旧树若缺少另一个客户端新建的节点，整树替换仍有结构冲突风险。当前同一 iPad 的 Web/native handoff 通过 flush、冻结和回程 reload 避免这类本端切换问题；跨设备并发协作仍需更细粒度协议。

## 9. 录音状态机与恢复

### 9.1 当前录音方案

使用 `AVAudioRecorder`，初始生产参数为单声道、48 kHz、64 kbps AAC，容器 `.m4a`。这些参数不是对所有话筒、场景或蓝牙设备的质量承诺。

目标约 300 秒 rollover。若 Pencil 手势仍活跃，等待手势结束再切段，避免普通录制过程中人为把一笔切到两个片段。暂停、继续、停止和系统中断也形成片段边界。

当前选择简单、易恢复的分段 recorder，而不是为了理论上的无缝效果立即引入 AVAudioEngine/连续 PCM 管线。是否需要后者，取决于实测 gap、精度与长录音问题。

### 9.2 状态语义

| 本地状态 | 含义 |
|---|---|
| `recording` | 正在主动录制 |
| `paused` | 已结束当前片段，可显式继续 |
| `interrupted` | 因系统或生命周期中断，不能自动恢复录音 |
| `stopped` | 本次会话已结束；新录音应创建新会话 |
| `recoveryRequired` | 存在需要检查的 active/未完成文件 |

服务器不把 `recoveryRequired` 当成已完成录音，映射为 interrupted 状态；未完成片段身份留在本地恢复清单。

### 9.3 开始、结束与暂停

开始录音：

1. 用户明确操作；请求系统麦克风权限。
2. 确认 App 在前台，停止已有播放。
3. 生成 recording/segment 的稳定身份。
4. **先保存 active segment 的恢复身份，再启动麦克风。**
5. prepare/record 失败时留下明确可恢复状态，不留下无法追踪的录音。

暂停/结束：先停止并 finalize 当前文件，验证实际时长，再纳入 finalized segments 和 outbox。继续录音新建片段，不追加写入已经结束的不可变文件。

### 9.4 中断与后台政策

离开文档、进入后台、音频 interruption、相关路由变化会停止/结束当前录制路径，并要求显式恢复。没有承诺锁屏或后台持续录音，也不重启后自动开麦。

播放与录音遵循各自音频 session 类别；不是一边录一边自动混入另一段 Replay。

### 9.5 恢复与错误

检测到 active segment 时，不因文件存在就宣称它完整。恢复会实际检查音频，必要时扫描解码；扫描有界，不读过声明的 frame 范围。

用户可恢复可播放部分，或只保留已 finalized 音频。不可恢复片段不冒充完成段上传。清单落盘失败保留可重试状态和文件；关键失败不能被一个导航动作隐式忽略。

真实话筒质量、切段 gap、来电/Bluetooth、低存储、温度和长录音可靠性仍需硬件压力测试。

## 10. 时间绑定模型

### 10.1 采用音频时钟，不采用墙上时间

录制时使用 `AVAudioRecorder.currentTime` 对齐本片段内事件。暂停间隔、应用调度、设备时间调整不应被算进音轨位置。

对片段 i 和片段内位置 t：

```text
segmentStart(i) = sum(finalizedDuration(j), j < i)
globalTime(i,t) = segmentStart(i) + clamp(t, 0, finalizedDuration(i))
```

AAC priming/padding 或 finalize 后测量差异，在片段边界作有限 clamp；不能用“开始录音的 Date + 经过秒数”替代实际媒体时钟。

### 10.2 ReplayEvent

```json
{
  "id": "event UUID",
  "kind": "stroke | page | note",
  "segment_id": "segment UUID",
  "start": 1.2,
  "end": 1.8,
  "pdf_page": 3,
  "block_id": "annotation block id",
  "stroke_id": "stable stroke fingerprint"
}
```

- stroke 事件带 block/stroke 身份和开始/结束位置。
- page 事件记录页导航，不带 stroke/block 引用。
- note 事件用于记录录音期间首次产生的相关文字 note 时间，不是逐字符日志。
- 新片段开始时保留当时页面信息，以便暂停后继续也能恢复页面。
- 同步只发送引用已 finalized、已上传片段的事件。
- `block_id` 是弱引用：删除过的 annotation 不应使整个录音清单无法读取。

服务器限制一份 audio payload 最多 1000 个片段、20000 个事件；验证事件 UUID、片段引用、有限时间、`end >= start` 等。24 小时是相关单个数值的 schema 上限，不是无限长录音性能保证。

### 10.3 Stroke 身份

当前指纹的两个部分均为 SHA-256：

- lineage 输入为 creationDate 的 epoch 秒（格式化到 6 位小数）加 ink type；
- signature 输入为第一控制点 x、y、timeOffset（各格式化到 6 位小数，以逗号连接；无点时使用零值）；
- stroke ID 是 `lineage.signature`。

PencilKit `creationDate` 在这里仅参与**身份**，不承担音频对时。该算法需要跨序列化验证；若以后更改，应定义兼容/版本策略，不能让旧事件静默失配。

某些擦除后的最终碎片可以按 lineage 继承原始笔画时间。它不是完整擦除日志，也不能可靠表达所有复制/变形操作的历史。

不要用整个 PKDrawing archive bytes 作为 stroke ID。反序列化再序列化可能改变 archive 表示，即使几何不变。传输原件应比较实际保存的 bytes；绘图语义与身份应单独验证。

## 11. Phase 5A 与 Phase 5B 的严格区别

### 11.1 当前：最终有效笔迹回放

当前 Phase 5A 从**最终保留的 drawing**出发，再用时间索引决定显示什么。

例：10:00 写 A，10:05 擦除 A，10:07 写 B，最终 drawing 只有 B。回放到 10:02 时，A **不会**重新出现。这不是在重建 10:02 的完整历史状态。

规则：

- 最终保留且已到开始时间的 stroke 才参与显示。
- 当前进行中的 stroke 渐进显示；结束后完整显示。
- 有对应时间的未来笔迹隐藏。
- 未记录时间的既有笔迹作为静态上下文，不编造时间。
- 找不到对应音频片段的已计时笔迹，不应被伪装成普通 untimed 笔迹。
- 文字使用最终文本；原生 Notes 可以提示未来 note 状态，但不回放逐字符修改历史。

### 11.2 尚未实现：完整编辑历史

Phase 5B 才需要记录并重放添加、擦除/分割、撤销/重做、变形等操作，以及操作之间的因果顺序、快照和恢复规则。

仅凭最终 PKDrawing、若干时间戳或一张 PNG，无法可靠推出这些历史。不能靠补字段宣称已经支持。

## 12. 原生 Replay

原生播放器对 finalized 文件按序播放，支持暂停、继续、跨段 seek、±10 秒、结束后保留最终位置，以及点击可见 timed ink 跳到声音（当前采用约两秒 lead-in）。

音频位置决定录制页面和可见 drawing。渐进帧可以截取/插值 stroke 控制点，但输出只进入 replay canvas。

播放结束或 Done 后回到完整静态可编辑源；原件不因拖动进度条改变。媒体不存在、加载失败或恢复未完成必须显式反馈。

## 13. 浏览器逐笔显示派生物

### 13.1 为什么不是整块 PNG，也不是直接解码 PKDrawing

整块 PNG 无法独立揭示每一笔；PKDrawing 依赖 Apple 框架。另做一个通用可编辑矢量模型又会造成第二份绘图真相。

当前折中：iPad 导出**最终单笔 PNG + 数值路径样本**。最终外观交给 PencilKit，浏览器只负责显示与按时遮罩。

### 13.2 `.inkjson` 格式

```json
{
  "format": "gamma-ink-replay-v1",
  "source_sha256": "原始 PKDrawing bytes 的 SHA-256，64 个小写十六进制字符",
  "width": 612,
  "height": 792,
  "strokes": [
    {
      "id": "与 replay_events 对应的 stroke ID",
      "bounds": {"x": 20, "y": 40, "width": 100, "height": 20},
      "png": "无 data URL 前缀的 PNG base64",
      "points": [{"x": 22, "y": 50, "t": 0, "radius": 3}]
    }
  ]
}
```

这里的 `source_sha256` 必须基于调用者提供的实际保存 bytes，而不是重新序列化 drawing 后随手算一次。

导出逐笔图像时保留最终 mask、transform 和笔刷效果，裁切到规范页面；完全在页外的内容不作为页内图像导出。路径样本转换到同一规范坐标，t 单调，radius 用于保守覆盖笔刷。

### 13.3 资源预算

| 限制 | 当前值 |
|---|---:|
| 单资产字节上限 | 32 MiB |
| 单资产 stroke 数 | 2000 |
| 单资产路径点总数 | 200000 |
| 单 PNG 最大边长 | 4096 |
| 单资产解码像素总量 | 2400 万 |
| 浏览器单文档预览字节预算 | 64 MiB |
| 浏览器单文档解码像素预算 | 4800 万 |
| 并行预览加载 worker | 3 |

导出分辨率在预算内自适应，最高通常 2×。超限不丢弃原件：核心 ink 仍可同步，预览可留作 pending 或标记该源暂不支持，避免无限重复准备同一不支持源。

### 13.4 原件变化与安全回填

- 新 ink upsert 可携带 `replay_asset`。
- 字段省略且 `ink_asset` 未变时保留已有预览。
- 原件变了却没有新预览时，移除旧引用，避免显示与原件不符的笔迹。
- 老笔迹在新版 iPad hydrate 时可进入 `inkPreview` 队列。
- metadata-only endpoint 同时检查当前源引用和 JSON 内源 hash，只有匹配才更新 `replay_asset`；不改 ink revision、正文、children 或原始 bytes。

这种准备可以用 Mac 的原生导出器代做，不需要开启麦克风，也不等于物理操作 iPad UI。受授权代处理某份文档时，应限制范围，验证源/revision/正文不变，并撤销临时会话、清理私有工作副本。

**补预览不等于补时间。** 无 `replay_events` 的旧录音仍不能同步回放。

## 14. 浏览器播放器与高清静态层

### 14.1 播放入口与状态

Notes 的音频 block 保留普通音频播放入口，同时提供 **Open Note Replay**。Replay 顶栏统一管理播放、暂停、进度条、跨段 seek、±10 秒和 Done。

有计时笔迹但缺少有效逐笔预览时，默认阻止假装同步播放，并说明应在新版 iPad 打开/同步后刷新。用户可以明确选择“声音 + 静态回退”。无时间索引的录音显示 audio-only 提示。

### 14.2 媒体与绘制

一个 audio element 顺序播放真实 AAC 片段。动画读取 audio clock，最多约 30 fps，不用独立计时器冒充音频进度。seek、片段加载、暂停意图和结束位置需要共同管理，避免换 src 后错误续播旧段。

浏览器构造 SVG image/mask：

- 完成的 stroke 使用其完整 PNG；
- 当前 stroke 用数值样本形成渐进揭示遮罩；
- 未来 stroke 不显示；
- PNG 与规范坐标通过同一仿射变换放到 pdf.js 页面上。

这是近似的进行中揭示，尤其自交/重叠处不承诺与 PencilKit 动画逐像素一致。最终 PNG 外观仍来自原生渲染。

### 14.3 静态与 Replay 共用资产

文档级 loader 在普通阅读时也获取有效逐笔数据。PDF 静态层和 Notes 缩略图显示完整 strokes；进入或退出 Replay 不需要重新取一份相同数据，也不会退出后降回低清 PNG。

loader 以账号/文档和资产身份为范围，支持 abort、预算与失效校验。清晰度一致性必须比较实际图像数据，而不只是比较 CSS 尺寸。

### 14.4 页面和点击行为

录制的 page 事件驱动跨页恢复；点击可见 timed stroke 跳到对应音频附近。普通手写侧栏标记负责空间定位，是另一条明确的交互路径。

切换文档/账号或退出 Replay 应停止旧媒体与帧循环。重复打开同一 Replay 不应把画面清空却留着半活动的播放器。

## 15. Web/native handoff 协议

### 15.1 登录共享

原生认证成功后，把该 session 的 cookie 写入独立、非持久化 WK cookie store，再加载 Gamma。密码不写入 Web 脚本，不持久化到仓库或普通缓存。

Web 数据存储按原生登录 session 重建；同一 session 的普通 reload 保留 Web cookie/local state。退出时移除原生脚本 handler，停止加载；弱代理避免 handler 与 controller 相互保留。

### 15.2 Web → Pencil & Audio

```text
Web 用户点击入口
  → flush debounce + 等待在途保存
  → 确认没有新编辑或文档变化
  → 校验当前 Web session 的 user
  → 冻结旧编辑树输入/保存
  → 发出窄消息 {type:openPDF,pageID,docID,title,user}
  → 原生核对主 frame、HTTPS origin、端口、部署路径
  → 读取当前 WK cookie，用 /api/session 重新认证
  → 读取服务器目标 page，检查 doc 身份与归属
  → 打开原生 workspace
```

消息中的 `user` 只是需要一致性检查的声明，不是授权凭证。真正身份由服务器对 cookie 的验证决定。

### 15.3 Native → Full Gamma

先 flush/结束当前原生输入与必要录音状态，再同步关键 outbox。核心编辑 pending/conflict 时不能把旧 Web tree 放回可写状态。可选浏览器预览不算阻塞编辑的核心操作。

返回时 reload 既有 Web session，取最新树。隐藏期间旧 Web 的 autosave 和 unload 写入被抑制，避免把新原生节点/元数据覆盖掉。handoff 失败也应解除冻结，而不是留下不可点击的页面。

### 15.4 WebKit 平台适配

- 外部 HTTP(S) 地址交给系统浏览器，不授予 Gamma 原生 bridge 权限。
- 任意 `file:`/`javascript:` 导航不能成为 bridge 入口。
- 脚本消息限制主 frame、origin、有效端口和部署路径，并限制字段长度。
- Web 导入使用系统文件选择能力；camera/photo/microphone 有相应用途说明，不自动启动。
- 下载和 blob 导出经 WKDownload 到私有临时文件，再由系统 Share/Save to Files 交给用户。
- 脚本 dialog 限定可信主 frame，标出来源域；并发呈现不能悬挂 JavaScript 回调。

iOS 与 Chromium 对 OAuth、媒体授权、文件提供者和剪贴板的行为差异，仍需真实使用验收。

## 16. 安全、备份与迁移

### 16.1 安全边界

- 所有原生服务 URL 使用 HTTPS，不为方便测试关闭 TLS 校验。
- 非认证请求带实际用户标识做账号一致性保护；它不替代 session 认证。
- 私有资产不因可猜测 hash、uploads alias 或 share 参数绕过账号检查。
- 内容寻址文件禁止不安全路径/符号链接；UUID 用作本地音频路径前先验证。
- `.inkjson` 不允许可执行 SVG/HTML、任意图像 URL或非有限几何。浏览器仅从已验证数值构造显示层。
- 凭据、Apple 签名覆盖配置、derived data 和私有激活副本不提交。

### 16.2 备份与导出

PKDrawing、整块 PNG、M4A 和 `.inkjson` 都应进入资产引用识别、清理和备份流程。Gamma 完整/范围导出保留可再导入的资产；可读导出提供相应链接。

可读 Markdown 导出并不等于包含一个离线 Replay 应用。历史操作日志、录音转写、压平 annotated PDF 等也不是当前导出自动承诺。

### 16.3 老数据处理

| 老数据情况 | 处理 |
|---|---|
| 原生旧 `.note` bundle | 保留，不自动映射到任意 Gamma paper |
| PKDrawing + PNG，无逐笔显示资产 | 可以源检查后补 `.inkjson` |
| 录音有事件、笔迹缺逐笔资产 | 补预览后可用 Web Replay |
| 录音没有事件 | 普通声音播放，不能补造同步 |
| 新源但旧 replay asset | 拒绝/清除失配引用 |
| 不支持或超限的显示资产 | 保留原件，明确回退/错误 |
| 存在真实 revision 冲突 | 显式处理，不静默覆盖 |

## 17. 验证策略与事实边界

### 17.1 分层验证

1. **纯模型/几何测试**：stroke 身份、时间偏移、渐进截取、变换、非法输入、老数据回退。
2. **原生框架测试**：实际 PDFKit selection、PencilKit PNG 导出、真实 AAC 文件、canvas 保存隔离。
3. **本地存储/故障测试**：账号隔离、原子快照、队列重排、磁盘失败重试、source bytes 保留。
4. **真实后端联调**：原生 API/outbox 上传、条件更新、预览回填、cache reopen、录音事件 round-trip。
5. **浏览器测试**：实际 Chrome、pdf.js、播放器与真实原生 PNG/AAC fixtures；测播放时钟、跨页、旋转/crop、点击 seek、静态/Replay 图像一致性及侧栏定位。
6. **部署 smoke**：实际 HTTPS bundle/接口与健康；必要时用隔离合成 API 数据测试部署后的 UI，不触碰用户内容。
7. **实机验收**：安装/启动成功与麦克风、Pencil、长会话体验是不同层次，不混写结果。

某些 Linux Chromium 包没有 AAC 解码能力。这样的环境能移动 slider，不等于声音测试通过；需使用支持 AAC 的 Chrome 或相应 Apple WebKit 验证。

### 17.2 尚不能从自动测试推出的结论

- 每一种真实 Pencil 手势和触摸仲裁都已验证；
- 任意 Bluetooth/来电/锁屏场景都能连续录音；
- 切段无缝、任意长录音无热/存储风险；
- 所有 WebKit 导入导出、IME、OAuth、剪贴板与 AI provider 都已逐项验收；
- SVG 渐进遮罩完全等同 PencilKit 内部渲染；
- 整树保存已成为通用跨设备协同编辑协议。

具体测试次数、结果包和安装记录集中在 [VALIDATION.md](../../ipad/VALIDATION.md)，不把设计愿景写成测试证据。

## 18. 部署、版本与运维

服务端、Web bundle 和 iPad 导出器需要匹配。只有新客户端没有新服务端时，缺少接口或资产类型会导致明确错误；不能让用户以为 pending 就是同步完成。

部署顺序建议：

1. 回归测试和源/凭据审查。
2. 对现有数据作一致备份，保留可回滚镜像。
3. 构建并更新匹配的 Gamma 服务与 Web bundle。
4. 验证健康、OpenAPI 和实际发布 bundle。
5. 用 Mac/Xcode 构建原生 App，验证签名并安装到可信设备。
6. 需要回填的文档在新版原生工作区打开、同步，再刷新 Web。

原生使用 XcodeGen 管理工程，机器签名配置放 ignored `project.local.yml`。可选 GUI-session LaunchAgent 解决某些 SSH 会话签名环境问题，但不保存 Apple 密码、不扩大 keychain ACL，也不绕过锁定钥匙串。

当前完整步骤见 [iPad 部署 README](../../ipad/README.md#deployment)。推送 main 会触发现有 Docker CI；合并代码不等于创建新的 GitHub Release、Desktop 安装包或扩展版本。

## 19. 后续设计方向

### 19.1 完整历史 Replay（Phase 5B）

需要操作日志、可重现 stroke add/remove/split/transform、undo/redo 分组、检查点、压缩和迁移协议。先规定语义和验证方式，再决定事件如何跨端表达。

### 19.2 更紧密的混合工作区

当前完整 Web 与原生工作区是清晰的切换关系。进一步可研究原生 PDF 与嵌入式 Markdown/Notes 同屏协作、当前页/滚动/选区细粒度 handoff、避免完整 reload 的安全增量协议。

不能以减少一次 reload 为由恢复旧树覆盖风险。

### 19.3 更高质量/更低体积的跨平台笔迹显示

可评估压力感知矢量轮廓、数值 mesh、分辨率分级、分页加载和更精细缓存。但仍要保留 PKDrawing 原件，明确是否只是显示派生物，避免两种编辑格式互相漂移。

若引入 SVG，必须限制可执行/外部内容；不能为了缩小图片而削弱资产安全。

### 19.4 音频能力

可评估更精确的切段、AVAudioEngine、后台录音、转写、录音内搜索和语义链接。每项都需要明确权限、功耗、恢复和数据政策；目前不宣称已实现。

### 19.5 协同与冲突

逐步将整树替换演进为细粒度、版本化修改，分清正文、结构、绘图、录音清单和显示派生物的所有权。跨设备并发、删除与离线修改的合并不能靠单一“最后写入”规则蒙混。

### 19.6 导出、迁移与可访问性

后续可包括压平 PDF 导出、旧 bundle 显式迁移工具、更多键盘/屏幕阅读器优化与低性能设备预算策略。保留原始资产和可验证映射，优先可恢复性。

### 19.7 空白笔记、识别与 AI 上下文

早期讨论过空白页随笔、OCR/手写识别、转写与语义整理。这些是产品方向，不因当前客户端已能手写就自动成为已实现能力。

若加入空白手写笔记，应在 Gamma 中显式创建对应 page/document 身份，再复用 ink block；不能悄悄恢复第二套本地文献库。若允许在 PDF 中插页，应设计新源版本与旧批注坐标迁移，而不是原地改写已有不可变 PDF。

Web 中看得到手写，不代表 AI 已经看到了：原始 PDF 没有被压平叠加手写。未来送给 AI 的上下文需要明确选择笔迹图像、文字说明或组合渲染页，处理私有资产读取、用户授权、模型图像能力与成本；不能把一个资产链接当成模型必然可访问的图片。OCR/公式识别结果也应是可校验的派生内容，保留手写原件及来源关系。

## 20. 实现与文档索引

| 主题 | 主要位置 |
|---|---|
| 原生协调器、队列、handoff | `ipad/GammaIPad/App/GammaWorkspace.swift` |
| PDFKit/PencilKit overlay 与生命周期 | `ipad/GammaIPad/Reader/PDFInkView.swift`、`InkPageOverlay.swift` |
| 选区/高亮、命中 | `GammaTextSelection.swift`、`GammaHighlight.swift`、`InkSelection.swift` |
| 原生录音/播放 | `ipad/GammaIPad/App/GammaRecordingController.swift` |
| 本地模型 | `ipad/GammaIPad/Storage/GammaCache.swift`、`GammaRecordingSession.swift` |
| 原生 Replay / 显示导出 | `GammaReplay.swift`、`GammaWebInkExport.swift` |
| WebKit 与原生桥 | `ipad/GammaIPad/Web/` |
| 资产、ink/audio/upsert/backfill | `backend/gamma/routers/ink.py` |
| 原生高亮 | `backend/gamma/routers/native_highlights.py` |
| Web block 保存与保护 | `backend/gamma/routers/blocks.py` |
| Web 播放与资产 loader | `frontend/src/NoteReplayPlayer.jsx`、`noteReplay.js` |
| Web 高分辨率层与空间定位 | `ReplayInkLayer.jsx`、`inkBlock.js`、`inkNavigation.js`、`pdfViewer.jsx` |
| Notes 与 handoff 入口 | `frontend/src/blockTree.jsx`、`App.jsx`、`nativeBridge.js` |

补充文档：

- [原始完整讨论稿](../../gamma_ipad_design_discussion.md)：历史、设想和取舍；不作为当前功能清单。
- [Gamma 原生身份模型](../../ipad/GAMMA_MODEL.md)：从 import-only 迁移到同一知识库的原则。
- [录音研究](../../ipad/PHASE3_RECORDING_RESEARCH.md)：当时的实验基线与硬件问题清单。
- [录音操作/限制](../../ipad/RECORDING.md)、[原生 Note Replay](../../ipad/NOTE_REPLAY.md)。
- [浏览器 Replay 使用与实现](../dev/note-replay.md)、[完整 Web 工作区矩阵](../../ipad/WEB_PARITY.md)。
- [后续路线](../../ipad/ROADMAP.md)、[API](../dev/api.md)、[验证证据](../../ipad/VALIDATION.md)。
