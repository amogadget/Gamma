# Gamma iPad 客户端设计讨论记录

## 1. 最初目标：一个极简的 iPad Notability alternative

最开始的设想是做一个 iPad 上非常克制的 Notability 替代品，不追求复杂功能，只保留最核心的几件事：

- PDF 阅读与手写批注
- 空白页随笔记录
- 录音
- 分享

第一版不考虑 OCR、AI、复杂模板、协作、Web、Android、账号体系、实时同步等功能。

### 1.1 最小产品界面

首页只需要两个主要入口：

1. New Note
   - 创建空白笔记
   - Apple Pencil 手写
   - 多页
   - 笔 / 荧光笔 / 橡皮
   - Undo / Redo

2. Import PDF
   - 从 Files 导入 PDF
   - 在 PDF 上直接书写
   - 翻页 / 连续滚动
   - 自动保存批注

笔记页可以保持极简：

```text
┌──────────────────────────────────────┐
│ ←   Lecture 9                 Share │
├──────────────────────────────────────┤
│                                      │
│                                      │
│               PDF / Paper            │
│                                      │
│                                      │
├──────────────────────────────────────┤
│ ✏️   🖍   ⌫   ↶   ↷       🎙 00:32 │
└──────────────────────────────────────┘
```

录音操作也尽量简单：

```text
tap -> record
tap -> pause
tap -> continue
stop -> finish
```

### 1.2 原生技术栈

如果目标就是 iPad，优先采用原生实现：

```text
SwiftUI
+ UIKit bridge
+ PDFKit
+ PencilKit
+ AVFAudio
```

其中：

- PDFKit 负责 PDF 显示和页面管理
- PencilKit 负责 Apple Pencil 输入、压感、橡皮、低延迟绘制
- AVFAudio 负责录音和播放
- 系统 Share Sheet / ShareLink 负责分享

PDF 页面与手写层的基本关系：

```text
PDFPage
   ↓
PDF render
   +
PKCanvasView
   ↓
handwriting
```

### 1.3 最初的数据结构设想

每个 note 可以先作为一个简单的文件包：

```text
My Lecture.note/
    metadata.json
    source.pdf

    drawings/
        page-0001.data
        page-0002.data
        page-0003.data

    audio/
        recording.m4a
```

`metadata.json` 示例：

```json
{
  "title": "My Lecture",
  "createdAt": "...",
  "modifiedAt": "...",
  "type": "pdf",
  "pageCount": 12
}
```

每页保存一个 `PKDrawing`，这样：

- PDF 原件保持不变
- 手写是独立 overlay
- 可以随时继续编辑或擦除
- 自动保存简单
- 哪一页修改就只保存哪一页

分享时再将 PDF 和手写 flatten 成普通 PDF：

```text
Original PDF
     +
PKDrawing overlay
     ↓
Flattened PDF
```

空白笔记同样可以导出成 PDF。

---

# 2. 更大的方向：做成 Gamma 的 iPad 客户端

后来目标被重新定义为：

> 做一个 Gamma 的原生 iPad 客户端，并给 Gamma 的笔记系统加入 Apple Pencil 手写能力。

Gamma 仓库：

https://github.com/amogadget/Gamma

因此产品不再只是一个独立的 Notability clone，而是：

> Gamma iPad = 原生 iPad 阅读 / 笔记客户端 + Apple Pencil handwriting layer

这个方向的核心价值是：

- Gamma server 继续承担知识模型和数据存储
- iPad 客户端专注阅读、触控和 Pencil 体验
- 手写进入 Gamma 的知识结构，而不是成为孤立的 annotation 系统

### 2.1 整体架构

```text
                 Gamma Server
               FastAPI + SQLite
                      │
                Gamma REST API
                      │
            ┌─────────┴─────────┐
            │                   │
      Web / Desktop          iPad App
        React               SwiftUI
       pdf.js               PDFKit
                            PencilKit
                            AVFAudio
```

iPad 端建议直接做原生 client，而不是用 WKWebView 套现有 Web UI。

原因：

- Apple Pencil 低延迟体验更好
- PDF 缩放、滚动和 Pencil overlay 更容易保持坐标一致
- 不需要不断同步 Web 页面坐标和 native canvas 坐标
- 可以设计更适合 iPad 横竖屏的交互

---

# 3. Handwriting 应该成为 Gamma 的原生内容类型

Gamma 已经有统一 block 模型，因此手写应该顺着 Gamma 的内容哲学进入 block 系统。

现有概念可以扩展成：

```text
Block
├─ text
├─ highlight
├─ pdf figure/link
├─ page
├─ ink
├─ pdf_ink
└─ audio
```

手写不需要在一开始修改数据库 schema，只要 `properties` 能承载 JSON，就可以先把 ink 信息放进去。

例如普通 handwriting block：

```json
{
  "id": "abc123",
  "parent_id": "paper123",
  "content": "",
  "properties": {
    "type": "ink",
    "ink_asset": "/api/assets/73af....ink",
    "preview": "/api/uploads/83ab....png",
    "width": 1024,
    "height": 768
  }
}
```

Gamma outliner 里可以表现成：

```text
• Important result
    • [handwritten note]
    • Check supplementary figure
```

Web 端不一定要支持编辑 PencilKit 数据，只需要展示预览图。

---

# 4. 区分两类手写

## 4.1 PDF Ink

直接写在论文 PDF 页面上的手写。

```text
PDF page 7
      +
PencilKit drawing
```

数据应该绑定 PDF page coordinate：

```json
{
  "type": "pdf_ink",
  "doc_id": "...",
  "page": 6,
  "ink_asset": "...",
  "preview": "...",
  "bounds": [0, 0, 612, 792]
}
```

关键要求：

无论用户在 50%、100% 还是 300% zoom 下，笔迹都必须严格锁在 PDF 页面坐标上。

## 4.2 Ink Block

另一种是普通 Gamma note 中的手写 block。

例如：

```text
Paper: Quantum error correction

• Surface code
    some markdown notes...

    ┌─────────────────────┐
    │  handwritten        │
    │  derivation...      │
    └─────────────────────┘

    • Threshold ~1%
```

这类手写不绑定 PDF page coordinate，而是作为 Gamma 内容树中的一个普通 block。

这意味着手写笔记可以：

- 被移动
- 被引用
- 被嵌套
- 被链接
- 与 Gamma 其他知识 block 一起组织

---

# 5. PencilKit 数据存储

不建议只保存 PNG。

至少保留两份：

```text
source:  PKDrawing
preview: PNG
```

例如：

```text
73af21.pkdrawing   ← PKDrawing.dataRepresentation()
73af21.png         ← preview
```

iPad 端：

```text
GET ink
↓
PKDrawing(data:)
↓
继续编辑
```

Web 端：

```text
GET png
↓
<img>
```

第一版没有必要马上设计跨平台 vector stroke format。

---

# 6. Gamma backend 需要的资产接口

现有 backend 主要处理 PDF 和 image，因此手写和录音最终更适合进入通用 assets 系统。

建议增加：

```text
POST /api/assets
GET  /api/assets/{hash}
```

资产目录可以类似：

```text
uploads/
  xxx.pdf
  yyy.png

assets/
  aaa.pkdrawing
  bbb.m4a
```

继续使用 content-addressed storage / SHA256 去重会很合适：

```text
SHA256(data)
      ↓
73af29c...
```

这对 handwriting autosave、audio upload 和 sync 都有帮助。

---

# 7. 录音的产品哲学

最开始讨论的录音原则是：

> 录音保存时间，笔记组织时间。

英文表达：

> Recording preserves time; notes give time structure.

录音不是独立的媒体管理器，而是笔记产生时的上下文。

理想的数据关系：

```text
Paper / Page
│
├── Recording
│    └── audio.m4a
│
├── Block
│    └── recording_time: 12:31
│
├── Highlight
│    └── recording_time: 18:42
│
└── Ink
     ├── stroke ...
     └── recording_time: 23:07
```

点击一个笔记对象，可以跳回它产生时对应的音频位置。

---

# 8. 真正达到 Notability 效果：Audio-Synchronized Note Replay

如果目标是 Notability 那种体验，核心不是“能录音”，而是：

> 音频时间轴和所有笔记事件严格同步。

整个系统建议拆成四层：

1. 录音采集
2. 笔迹 / 编辑事件打时间戳
3. playback 调度
4. replay 的视觉呈现

---

# 9. 每一笔都必须有时间

不能只保存：

```swift
PKDrawing
```

还要能知道每个 stroke 对应的 audio timeline。

概念上：

```text
Stroke
├── PencilKit stroke data
├── audioStartTime
└── audioEndTime
```

例如：

```text
stroke A:  123.42s -> 123.91s
stroke B:  124.18s -> 125.02s
stroke C:  127.33s -> 128.10s
```

PencilKit 自己的 stroke 也包含内部时间信息，例如一笔的 creation time 和 stroke point 的 time offset。

因此理论上可以做到逐笔、甚至逐点的真实 handwriting replay。

回放时，不是整笔突然出现，而是按时间逐渐绘制：

```text
12:31.000   ─
12:31.050   ──
12:31.100   ───
12:31.150   ───╮
12:31.200   ───╯
```

---

# 10. Audio timeline 必须是唯一时钟

所有 annotation 时间戳都应该保存成相对于录音的秒数：

```json
{
  "recording_id": "rec_123",
  "start_time": 183.421,
  "end_time": 183.917
}
```

不要依赖系统 wall clock：

```text
Date.now - recordingStartedAt
```

而要依赖 audio timeline，例如 recorder/player 的 current time。

原因：

- 用户可能 pause 录音
- 系统时间可能改变
- server 和 iPad 时钟可能不同
- app 运行很久也不应影响同步

例如：

```text
00:00 record
20:00 pause
       休息 15 分钟
20:00 resume
40:00 stop
```

最终音频只有 40 分钟，所以手写 timestamp 也必须使用录音时间，而不是现实世界经过的 55 分钟。

---

# 11. Playback engine

假设播放到：

```text
player.currentTime = 183.62
```

所有：

```text
startTime < 183.62
```

的 stroke 应该已经可见。

对于当前正在形成的 stroke：

```text
start = 183.42
end   = 183.92
current = 183.62
```

进度：

```text
progress =
(current - start)
/
(end - start)

= 0.40
```

于是只画出这一笔前 40%。

视觉效果类似：

```text
audio  3:03.42

Apple Pencil:
╭────
```

继续播放：

```text
audio  3:03.62

╭─────────
```

再继续：

```text
audio  3:03.92

╭─────────────╮
```

这就是 Notability Note Replay 类体验的核心。

---

# 12. Future Ink Preview

回放时，尚未在时间轴中发生的笔迹不一定要完全隐藏。

推荐视觉规则：

```text
past       opacity 1.0
current    animated
future     opacity 0.15
```

例如完整页面最终是：

```text
The mitochondria
is the powerhouse
of the cell

ATP -> ADP
```

当前音频只播放到第一行时：

```text
The mitochondria       ← 黑
is the powerhouse      ← 淡灰
of the cell            ← 淡灰

ATP -> ADP             ← 淡灰
```

这样用户仍然保留页面空间感。

设置中可以提供：

```text
Preview future ink
● On
○ Off
```

---

# 13. 点击笔迹跳回音频

每个 stroke 已经有 audioStartTime，所以用户点击某一笔：

```text
          ↓
E = mc²
```

可以直接：

```text
player.seek(stroke.audioStartTime)
player.play()
```

产品上更好的体验可能是自动提前几秒：

```text
seek(max(0, stroke.audioStartTime - 3s))
```

因为实际课堂中通常是：

```text
教授先说话
↓
用户理解
↓
开始落笔
```

所以落笔时间通常稍晚于关键语句的起点。

---

# 14. Eraser 和 Edit History

这是 replay 系统容易忽略的问题。

例如：

```text
10:00 写 A
10:05 擦 A
10:07 写 B
```

最终 `PKDrawing` 只有 B。

如果只保存最终 drawing，回放到 10:00 时 A 已经不存在，历史会丢失。

因此完整系统应该保存：

```text
ReplayEvent[]
```

例如：

```json
[
  {
    "time": 600.12,
    "type": "strokeAdded",
    "stroke": "..."
  },
  {
    "time": 605.74,
    "type": "strokeRemoved",
    "strokeID": "..."
  },
  {
    "time": 607.18,
    "type": "strokeAdded",
    "stroke": "..."
  }
]
```

最终保存三类东西：

```text
drawing.pkdrawing     最终状态
replay.events         历史
recording.m4a         音频
```

普通打开 note：

```text
直接 load drawing.pkdrawing
```

进入 Replay：

```text
replay.events + audio
```

### Phase 5A：Replay MVP 的简化规则

Replay MVP 采用以下规则（这里不指 Phase 1）：

> Replay 只展示最终仍然存在的笔迹，并保留它最初写下的时间。

被永久擦掉的 stroke 不参与 replay。

这样已经能覆盖主要用户体验，同时显著降低工程复杂度。

---

# 15. Undo / Redo

完整 replay 理论上可以记录：

```text
12:00 write A
12:03 undo
12:05 redo
```

对应：

```text
strokeAdd A
strokeHide A
strokeShow A
```

但 Phase 5A 同样忽略完整 edit history，只保证最终存在的笔迹拥有正确的首次创建时间；完整 undo / redo 历史属于 Phase 5B。

---

# 16. 录音文件本身

录音技术不需要过度复杂。

第一版可以：

```text
AVAudioRecorder
AAC
.m4a
mono
44.1 / 48 kHz
```

长录音建议分 segment 保存。

例如：

```text
RecordingSession
│
├── segment-000.m4a   0:00 - 59:59
├── segment-001.m4a  60:00 - 119:59
└── segment-002.m4a 120:00 - ...
```

对用户仍显示成一条连续时间轴：

```text
02:17:43
```

segment 的好处：

- crash 损失更小
- 上传方便
- sync 方便
- seek 更容易
- 后续转写更容易

---

# 17. Playback UI

可以保持非常简单：

```text
┌─────────────────────────────────────────┐
│                                         │
│               PDF                       │
│                                         │
│        handwritten notes                │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ ↶10   ▶︎   ↷10      ━━━●━━━━   1×      │
│                      32:18 / 1:21:04     │
└─────────────────────────────────────────┘
```

进入 playback mode 后：

```text
tap ink
   ↓
jump to audio
```

如果用户想继续编辑，再切回 Pencil 模式。

如果用户在 playback 时继续写，新笔迹应该绑定：

```text
player.currentTime
```

这样复习时补充的内容，也可以和当前播放位置建立关联。

---

# 18. Gamma 中最终建议的数据关系

```text
Gamma Page
│
├── PDF
│
├── InkDocument
│    ├── drawing.pkdrawing
│    └── ReplayTimeline
│
└── RecordingSession
     ├── segment 0
     ├── segment 1
     └── segment 2
```

ReplayTimeline：

```text
0s
│
├── 03:12.420 stroke 001
├── 03:13.050 stroke 002
├── 03:16.221 stroke 003
│
├── 08:42.170 highlight 01
│
├── 13:01.220 stroke 004
│
└── 72:18.420 stroke 295
```

核心原则：

> Audio timeline 是全局时钟。

未来所有事件都可以挂在这条时间轴上：

- PDF handwriting
- Ink block
- Highlight
- Text block
- Page navigation
- Transcript
- AI summary marker

---

# 19. 进一步超过 Notability 的方向

一旦 Gamma 的知识模型与 audio timeline 结合，可以自然得到：

```text
点击手写
→ audio

点击 highlight
→ audio

点击 Gamma block
→ audio

点击 transcript
→ PDF + handwriting

拖 audio timeline
→ 自动回到当时正在看的页面
```

其中最重要的高级能力是：

> Phase 5B 的高级目标：用户拖到任意时间点，App 自动恢复当时的 PDF 页面、滚动位置、历史笔迹状态和声音。

Phase 5A 则必须支持跨页 seek / restore，但只恢复对应时间点的最终有效笔迹，不承诺完整历史态重建；精确滚动位置恢复不作为其核心验收要求。

例如拖到：

```text
43:21
```

系统自动：

```text
PDF -> 第 17 页
scroll -> 当时阅读位置
ink -> 恢复到 43:21 时的状态
audio -> 43:21
```

这才是一个完整的“时间同步笔记系统”。

---

# 20. 推荐的开发顺序

依赖顺序：Phase 1 PDF Ink Persistence → Phase 2 Gamma Block / Client 基础 → Phase 3 Recording → Phase 4 Timestamped Interaction → Phase 5A Replay MVP → Phase 5B Historical Replay。

## Phase 1: PDF Ink Persistence

目标：

1. 连接 Gamma server
2. 拉取 library
3. 打开 paper
4. 下载 PDF
5. PDFKit 显示
6. PencilKit 手写
7. 自动保存
8. 关闭后重新打开，笔迹仍存在

这一阶段仅验收 PDF 手写可靠持久化与页面坐标对齐；不包含录音、时间戳、replay 或跨页时间恢复。

## Phase 2: Gamma Block / Client 基础

原生实现：

```text
• block
    • block
        • block
```

支持：

- 浏览
- 文本编辑
- indent / outdent
- handwriting block

## Phase 3: Recording

先实现：

- record
- pause / resume
- stop
- segmented audio
- recording session 数据模型
- audio / session persistence，退出重开后可恢复已保存录音

## Phase 4: Timestamped Interaction

实现：

- 每个 stroke 记录 audioStartTime / audioEndTime
- highlight 绑定时间
- page navigation 绑定时间

## Phase 5A: Replay MVP

实现：

- audio playback
- past/current/future ink state（future preview 只是视觉辅助，不属于时间 t 的有效笔迹状态）
- progressive stroke animation
- tap ink -> seek audio
- cross-page seek / restore：拖动时间轴恢复当时所在 PDF 页面与最终有效笔迹

时间 t 的页面状态定义为：最终文档中仍然存在，并且创建时间 <= t 的笔迹。进行中的笔迹按时间逐步呈现。

例如：10:00 写 A，10:05 擦 A，10:07 写 B，最终文档只有 B。

- Replay 到 10:02：A、B 都不出现。
- Replay 到 10:08：B 出现。
- A 最终已被删除，因此整个 replay 都忽略它。

此阶段只需要：

```text
Final PKDrawing
+ surviving stroke timestamps
+ page/navigation timestamps
+ audio
```

不需要保存完整 edit history。此等级的承诺是：**恢复该时间点对应的最终有效笔迹。**

## Phase 5B: Historical Replay

实现完整 ReplayEvent / edit history，包括：

- strokeAdded / strokeRemoved
- undo / redo
- transform
- exact historical state reconstruction

同样的例子应该得到：

- 10:02 -> A
- 10:06 -> 空白
- 10:08 -> B

此等级的承诺是：**恢复该时间点历史上真实存在的文档状态。** 只有此等级可以使用“完整恢复当时状态”的表述。

## Phase 6: Gamma-native 时间知识结构

继续扩展：

- text block timestamp
- highlight timestamp
- transcript
- block/audio 双向跳转
- page navigation replay
- cross-page timeline

---

# 21. 核心 Milestone 与验收标准

## Phase 1 Done：PDF Ink Persistence

范围：PDF 打开与阅读、PencilKit 手写、自动保存，以及关闭 App 后重新打开仍保留手写。不包含录音、时间戳、replay，也不要求跨页时间恢复。

唯一核心验收：

> 在 PDF 任意页面手写，退出并重新进入文档后，所有笔迹能够准确恢复，并始终与对应 PDF 页面坐标对齐。

## Phase 5A Done：Notability-style Replay MVP 验收标准

> 录音 10 分钟，一边跨页阅读一边写；退出重开后，拖到任意时间点，声音、当时所在 PDF 页面，以及截至该时间点的最终有效笔迹能够同步恢复。

这是跨越 Recording、Timestamped Interaction 和 Replay 的端到端目标，不是 Phase 1 的验收标准。跨页 seek / restore 是 Phase 5A 的必要验收项。

这里的“最终有效笔迹”指最终文档中仍然存在、且创建时间不晚于当前回放时间的笔迹；进行中的笔迹按时间逐步呈现。最终被删除的笔迹在整个 MVP replay 中均不出现。

完整历史态重建明确不属于此验收，留给 Phase 5B。只有 Phase 5B 才承诺“完整恢复当时状态”。

---

# 22. 当前产品原则总结

整个项目目前可以归纳成几个长期原则：

### 产品层

- 极简优先
- PDF 阅读和 Pencil 体验优先
- Gamma 是知识模型，不重做第二套知识库
- 录音作为笔记上下文
- 时间轴是一等公民

### 数据层

- PDF 原件不破坏
- PencilKit source 与 preview 分离
- editable source 永远保留
- audio timeline 使用相对时间
- ReplayEvent 与最终 Drawing 分开
- 通用 asset storage 支持 ink/audio

### 交互层

- 一键开始录音
- 写字自动绑定时间
- 点击笔迹跳到录音
- 拖录音时间轴恢复当时页面和笔迹
- future ink 可以低透明度预览
- 横屏适合 PDF + Notes 双栏
- 竖屏以 PDF 为主，notes 用 sheet / panel

### 架构层

```text
Gamma Server
    ↓
REST API
    ↓
Native iPad Client
    ├── SwiftUI
    ├── PDFKit
    ├── PencilKit
    └── AVFAudio
```

Gamma server 负责：

- library
- blocks
- knowledge model
- assets
- sync

Gamma iPad 负责：

- PDF 阅读
- Apple Pencil
- handwriting
- recording
- replay
- touch interaction

---

# 23. 一句话定义这个产品

可以暂时把项目定义为：

> 一个以 Gamma 为知识后端、以 Apple Pencil 和时间同步录音为核心交互的原生 iPad 学术阅读与笔记客户端。

或者更短：

> Gamma for iPad, with handwriting and time-synchronized audio notes.
