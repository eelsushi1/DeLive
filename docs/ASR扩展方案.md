# ASR 扩展方案（兼容 Soniox / 火山引擎）

> 目标：在不破坏现有 Soniox 与火山引擎两条链路的前提下，扩展更多 ASR（如 Qwen-ASR-Realtime、FunASR 等），并让后续新增提供商的改动成本可控、可测试、可维护。

## 1. 背景与现状

当前项目已经具备“多提供商”雏形：

- 前端有 Provider 抽象（`BaseASRProvider`）与注册表（`ProviderRegistry`），并已实现 `SonioxProvider` / `VolcProvider`。
- 但在业务流程与 UI 层仍存在**对 `volc` 的硬编码分支**（例如录音管线选择、配置字段渲染、是否已配置判断等），会导致每新增一个提供商就继续堆叠 `if/else`，长期风险较高。
- 本地代理（proxy）存在**重复实现**：Electron 主进程内置一份 + `server/` 下也有一份，后续接入更多“需要自定义 Header/签名”的云端 ASR 时，会进一步放大维护成本。

结论：如果继续按“新增一个模型就新增一套特判逻辑”推进，很容易在扩展时误伤现有 Soniox/火山链路。

## 2. 设计原则（必须满足）

1. **不破坏现有行为**：Soniox 仍走现有直连 WebSocket + MediaRecorder；火山仍可走现有本地 proxy + PCM16。
2. **新增提供商改动最小化**：新增一个提供商尽量只需要新增 Provider 文件 + 注册（以及可选的 proxy 适配器），不需要改 UI/录音主流程。
3. **能力驱动而非 vendor 特判**：`useASR` 不应知道“谁是 volc/谁是 soniox”，只根据 Provider 声明的能力选择音频管线与传输方式。
4. **协议与安全可演进**：对需要鉴权、Header、签名的提供商，优先通过本地代理承载；敏感信息避免出现在 URL query 中；可逐步迁移但保留兼容入口。

## 3. 方案对比

### 方案 A：继续堆叠 vendor 特判（不推荐）

- 做法：每新增一个 ASR，就在 `useASR`/设置页/校验逻辑里加一堆 `if (vendor===...)`。
- 优点：短期最快。
- 缺点：复杂度线性爆炸，回归风险极高；最终会“牵一发动全身”。

### 方案 B：能力声明 + 配置驱动 UI + 统一代理协议（推荐）

- 做法：Provider 通过 `info` 声明“需要的音频输入/传输方式/配置字段”，UI 与录音流程按声明执行。
- 优点：新增提供商几乎不改主流程；兼容 Soniox/火山更容易；proxy 可扩展、可复用。
- 缺点：需要一次小重构（可分阶段实施，保持兼容）。

### 方案 C：插件化动态加载（过重）

- 做法：把 Provider 做成外部插件包，运行时动态加载。
- 优点：最灵活。
- 缺点：工程复杂、调试与打包成本高；以当前规模通常不划算。

## 4. 推荐方案（B）总体架构

核心思路：把“录音/编码/传输/配置 UI”从“写死某个 vendor”改为“由 Provider 声明能力驱动”。

### 4.1 扩展 Provider 信息模型（能力声明）

在 `ASRProviderInfo` 中补充**可选**能力字段（确保不破坏现有实现，旧 Provider 不填则走默认）：

- `transport`：`direct_ws`（浏览器直连） / `local_proxy_ws`（本地代理）
- `audioInput`：音频输入规格，例如：
  - `webm_opus`：使用 `MediaRecorder` 输出 `audio/webm;codecs=opus`，按 `chunkMs` 分片
  - `pcm16`：使用 WebAudio 输出 `PCM16@sampleRate/channels`，按 callback 持续推送

兼容默认值建议：

- 未声明时默认 `transport=direct_ws`、`audioInput=webm_opus`（等价于当前 Soniox 流程）
- 火山 `VolcProvider.info` 明确声明 `transport=local_proxy_ws`、`audioInput=pcm16(16k/1ch)`

> 关键点：`useASR` 不再写 `if (vendorId === 'volc')`，而是根据 `provider.info.audioInput.kind` 选择采集管线。

### 4.2 录音管线抽象（替换 vendor 硬编码）

将 `useASR` 中的两条采集路径抽象为两种“音频管线”：

1. **MediaRecorder 管线**：适配 `webm_opus` 类提供商（Soniox、未来部分云厂商）
2. **PCM 管线**：适配 `pcm16` 类提供商（火山、Qwen-ASR-Realtime、FunASR 实时等）

`useASR` 负责：

- 获取系统音频（仍使用 `getDisplayMedia`；Electron 环境可继续复用主进程的源选择/复用能力）
- 按 Provider 声明选择音频管线，并持续调用 `provider.sendAudio(...)`
- 订阅 Provider 的 `onTokens/onPartial/onFinal/onError`，更新 store 与字幕窗口（保持现状）

Provider 负责：

- 连接/断开
- 处理上游协议
- 输出统一事件（partial/final/tokens/error）

### 4.3 设置页按 `configFields` 自动渲染（替换 `volc` 特判）

当前 `SonioxProvider` 与 `VolcProvider` 的 `info.configFields` 已定义字段，但 UI（`ApiKeyConfig`）仍硬编码了火山的 `appKey/accessKey`。

改造目标：

- 设置 UI 只依赖 `currentProvider.info.configFields` 生成表单
- “是否已配置”的判断统一为：所有 `required: true` 的字段都有值

这样新增提供商时：

- Provider 只要在 `configFields` 里声明字段（`apiKey`、`endpoint`、`serverUrl`、`model`、`language`…）
- UI 与校验逻辑无需修改

> 兼容策略：保留现有存储结构 `settings.providerConfigs[vendorId]`，只是 UI 生成方式变化；Soniox/火山配置不会丢失。

### 4.4 统一本地代理协议（承载“需要 Header/签名”的云端 ASR）

针对需要在 WebSocket 握手时带 Header/签名/鉴权信息的云端 ASR（例如 Qwen-ASR-Realtime 的某些接入方式），浏览器原生 WebSocket 无法设置自定义 Header，因此建议统一走本地代理（Node ws）。

建议定义“本地代理协议 v1”（兼容扩展、便于测试）：

- URL：`ws://localhost:3001/ws/{vendor}`
- 建连后第一帧：`{ type: 'config', vendor, config }`（敏感信息在消息体，不进 URL）
- 代理返回：`{ type: 'ready' }`
- 音频帧：二进制（PCM16 或 Provider 声明的格式）
- 结果帧：`{ type: 'partial'|'final'|'error', text, raw? }`

兼容策略（不破坏火山）：

- `/ws/volc` 保留现有 URL query 传参方式（现网兼容）
- 同时在 `/ws/volc` 新增支持 `config` 首帧方式（为后续迁移与安全优化做准备）

### 4.5 代理实现去重（长期收益）

建议将 volcProxy 与未来的 qwen/funasr proxy 适配器抽成一个可复用模块（例如 `packages/local-asr-proxy`），供：

- Electron 主进程内置 proxy 使用
- `server/` 独立服务使用

最终二选一（取决于产品策略）：

- 只保留 Electron 内置 proxy（减少部署点）
- 或只保留 `server/` proxy（更清晰的进程边界）

## 5. 新增提供商落地示例

### 5.1 Qwen-ASR-Realtime

典型特征：官方云端 WebSocket，握手阶段需要自定义 Header（`Authorization`、`OpenAI-Beta: realtime=v1` 等）；浏览器侧原生 WebSocket 无法自定义 Header，因此在 Electron 场景推荐采用“**主进程直连 + IPC 转发**”（不开放本地端口）。

#### 接入边界（主进程直连 + IPC）

- Renderer（前端/渲染进程）：只负责采集音频并按分片通过 IPC 推送给主进程；不直连云端，尽量不持有长期 `apiKey`。
- Main（Electron 主进程）：负责直连官方 Realtime `wss`、加握手 Header、按事件协议发送音频与接收识别结果，并通过 IPC 回推给 Renderer。

#### 用户配置项（不写死，建议在设置页输入）

必填：
- `apiKey`：百炼 API Key（建议仅主进程可读，避免写入日志/URL）
- `model`：例如 `qwen3-asr-flash-realtime-2026-02-10`（以官方模型列表为准）
- `region/baseURL`：北京/新加坡二选一（或高级选项直接填 Realtime 的 `wss endpoint`）

可选（提供默认值即可）：
- `language`：默认 `zh`
- `turnDetection`：`server_vad`（默认）或 Manual
- `vad.threshold`、`vad.silence_duration_ms`：按需可配

#### 云端连接参数（北京示例）

- Realtime WebSocket：`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${MODEL}`
- 握手 Header：
  - `Authorization: Bearer ${DASHSCOPE_API_KEY}`
  - `OpenAI-Beta: realtime=v1`

> 说明：`https://dashscope.aliyuncs.com/compatible-mode/v1` 是 OpenAI 兼容 **HTTP** 的 `base_url`（用于 `chat/completions` 等），并不等同于 Realtime 的 WebSocket 入口；Realtime 仍按上述 `wss://.../api-ws/v1/realtime` 连接。

#### 会话与音频事件协议（按官方示例）

连接成功后：
1. 发送 `session.update`（启动会话/更新会话配置）
   - `modalities: ['text']`
   - `input_audio_format: 'pcm'`
   - `sample_rate: 16000`
   - `input_audio_transcription: { language: 'zh' }`
   - `turn_detection: null`（Manual）或 `{ type: 'server_vad', threshold, silence_duration_ms }`
2. 循环发送 `input_audio_buffer.append`：
   - `audio` 字段为 **PCM 字节的 base64 字符串**（JSON 事件，不是二进制帧）
3. 结束：
   - Manual 模式：先发 `input_audio_buffer.commit`，再发 `session.finish`
   - VAD 模式：直接发 `session.finish`
4. 以 `session.finished` 为最终结束事件，取 `transcript` 作为最终文本。

#### 音频规格（Renderer 输出，Main 封包发送）

- 音频编码：`PCM16`（little-endian）
- 采样率/声道：`16000 Hz` / `1ch`
- 分片建议：100ms/包
  - 100ms 对应字节数：`16000 * 0.1 * 1 * 2 = 3200 bytes`

#### IPC 事件建议（最小可用集合）

- Renderer → Main：`connect(config)`、`appendAudio(chunk)`、`finish()`、`disconnect()`
- Main → Renderer：`state(connected/streaming/finished/closed)`、`partial(text, raw?)`、`final(text, raw?)`、`error(message, raw?)`

#### 可落地方案（按本项目现状，允许少量 vendor 特判）

> 说明：当前项目的 `useASR` / 设置页仍存在 `volc` 特判；本次接入 Qwen 不强制做到“前端 UI 零改、`useASR` 零改”，因此建议先用最小改动跑通链路，再视需要按第 6 章逐步收敛到“能力驱动/配置驱动”的推荐架构。

- **前端（Renderer）改动点**
  - `frontend/src/types/asr/common.ts`：在 `ASRVendor` 中新增 `Qwen = 'qwen'`
  - `frontend/src/types/asr/vendors/qwen.ts`：新增 Qwen 事件/配置类型（建议，便于约束字段）
  - `frontend/src/providers/implementations/QwenProvider.ts`：新增 Provider（IPC 版，不直连云端）
  - `frontend/src/providers/registry.ts`：注册 Qwen Provider
  - `frontend/src/hooks/useASR.ts`：把 “PCM 管线” 从仅 `volc` 扩展到 `volc + qwen`
    - 配置校验：Qwen 至少要求 `apiKey + model`（以及 `region/baseURL` 或 `endpoint`）
    - 音频处理：复用 `AudioProcessor({ sampleRate: 16000, channels: 1 })` 输出 `PCM16`
  - `frontend/src/components/ApiKeyConfig.tsx`：新增 Qwen 配置表单字段（`apiKey`/`model`/`region或baseURL`/`language`/`VAD`）
  - `frontend/src/components/ProviderSelector.tsx`、`frontend/src/components/RecordingControls.tsx`：新增 Qwen 的“已配置”判断（避免一直显示“需配置”）

- **Electron 主进程（Main）改动点**
  - `electron/preload.ts`：暴露 Qwen ASR 的 IPC API（connect/append/finish/disconnect + onEvent）
  - `electron/main.ts`：实现 Qwen Realtime 的会话管理（建议按 `webContents.id` 隔离会话，避免多窗口串话）
    - 握手 Header：`Authorization: Bearer ...`、`OpenAI-Beta: realtime=v1`
    - `connect` 后立即发 `session.update`（VAD/Manual 配置）
    - 音频：收到 IPC 的 `ArrayBuffer(PCM16)` 后 base64 封装为 `input_audio_buffer.append`
    - 结束：根据模式发送 `input_audio_buffer.commit`（Manual）与 `session.finish`，等待 `session.finished`

- **IPC 通道与消息格式（建议定稿）**
  - Renderer → Main（建议）
    - `asr:qwen:connect`（`ipcRenderer.invoke`）：`{ apiKey, model, baseURL?, endpoint?, language?, enableServerVad?, vad? }`
    - `asr:qwen:audio`（`ipcRenderer.send`）：`ArrayBuffer`（PCM16 chunk）
    - `asr:qwen:finish`（`ipcRenderer.invoke`）：`{ mode: 'vad' | 'manual' }`
    - `asr:qwen:disconnect`（`ipcRenderer.invoke`）：无参
  - Main → Renderer（建议）
    - `asr:qwen:event`（`webContents.send`）：`{ type: 'state'|'partial'|'final'|'error', state?, text?, error?, raw? }`

- **endpoint 推导规则（避免写死，但降低用户填错概率）**
  - 推荐 UI：让用户选“北京/新加坡”或填写 `baseURL`（例如 `https://dashscope.aliyuncs.com/compatible-mode/v1`）
  - 主进程推导 Realtime `wss`：
    - 取 `host = new URL(baseURL).host`
    - `wss://{host}/api-ws/v1/realtime?model={MODEL}`
  - 高级选项：允许用户直接填 `endpoint=wss://.../api-ws/v1/realtime` 覆盖推导结果

- **最小可用（MVP）与增强项**
  - MVP：仅保证 `session.finished.transcript` → `emitFinal()` + `emitFinished()`（先把链路跑通）
  - 增强：补齐 partial 映射、增加背压与队列上限、断线重连、添加“测试配置”按钮

- **安全与稳定性（必须做）**
  - 不记录/不打印 `apiKey`（日志中统一脱敏）
  - 音频发送做背压：当 `ws.bufferedAmount` 过大时暂停/丢弃，避免内存爆炸
  - 资源回收：Renderer 刷新/崩溃时主进程自动关闭 WebSocket 会话

- **回归验证清单**
  - Soniox/Volc 录制与字幕行为不变
  - Qwen：开始→说话→停止，能收到最终文本；无效 key/断网时能收到可读错误提示

参考：
- 获取 API Key：`https://help.aliyun.com/zh/model-studio/get-api-key`
- Realtime 接入文档入口：`https://help.aliyun.com/zh/model-studio/realtime`

### 5.2 FunASR

两种常见接法：

- **接法 A（直连）**：如果 FunASR WebSocket 不依赖自定义 Header，可让 `FunASRProvider` 直接连接用户配置的 `serverUrl`（`transport=direct_ws`）。
- **接法 B（推荐一致性）**：仍通过本地 proxy：`transport=local_proxy_ws`，proxy 再转发到用户 `serverUrl`。后续如需做重连、限流、日志脱敏、热词注入，会更好维护。

## 6. 分阶段实施计划（确保不破坏现有）

### 阶段 0：只加能力字段（无行为变化）

- 给 `ASRProviderInfo` 增加可选字段（不影响现有 Provider）
- Soniox/火山按需补齐声明（不改逻辑）

### 阶段 1：`useASR` 去 vendor 特判（保持两条链路一致）

- 用 `provider.info.audioInput` 驱动选择 MediaRecorder / PCM 管线
- 目标：删除 `vendorId === 'volc'` 之类硬编码，但最终行为与当前完全一致

### 阶段 2：设置页与“已配置判断”改为配置驱动

- `ApiKeyConfig` 按 `configFields` 自动渲染
- `ProviderSelector`、`RecordingControls` 等统一使用 required 字段校验
- 目标：新增提供商不需要动 UI

### 阶段 3：统一代理协议 v1 + 兼容旧 volc query

- 新增 `config` 首帧协议
- `/ws/volc` 兼容两种方式并存

### 阶段 4：接入新提供商（Qwen/FunASR）

- 新增 Provider 与（可选）proxy 适配器
- 增加最小化的协议/工具类单测（建议从 proxy 帧解析、字幕导出、配置校验开始）

## 7. 风险与回滚策略

- **风险：能力字段引入导致行为变化**  
  - 控制点：阶段 0/1 只做“等价重构”，并在上线前用手工回归验证 Soniox/火山录制与字幕窗口。
- **风险：proxy 端口冲突（Electron 内置 vs server）**  
  - 现状已有 `EADDRINUSE` 提示，但建议在文档与脚本层明确“开发/生产使用哪一种 proxy”，避免误配置。
- **回滚策略**  
  - 能力驱动实现建议以 feature flag 或最小侵入改造落地（例如先保留原分支，确认稳定后再删除）。

## 8. 待确认问题（影响细节，不影响总体方案）

1. FunASR：暂时停止开发（暂不接入）。
2. Qwen-ASR-Realtime：连接官方云端 Realtime WebSocket（北京地域）；采用“主进程直连 + IPC 转发”；`apiKey/model/region` 由用户在设置页输入；握手需要 `OpenAI-Beta: realtime=v1`。
3. 新增 Provider 不要求做到“前端 UI 零改、`useASR` 零改”（允许按需修改）。

