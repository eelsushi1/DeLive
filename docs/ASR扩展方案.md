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

典型特征：云端实时、可能需要鉴权/签名/自定义 Header，建议走 `local_proxy_ws`。

落地清单：

1. 新增 `frontend/src/providers/implementations/QwenRealtimeProvider.ts`
   - `transport=local_proxy_ws`
   - `audioInput=pcm16(16000/1)`
   - `configFields`：如 `apiKey`/`endpoint`/`model`/`language` 等
2. 在本地 proxy 增加 `qwen` 适配器：
   - 将 `config` 转换为上游需要的鉴权信息
   - 负责上游消息解析与 partial/final 归一化

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

1. FunASR 希望以“用户自建服务连接”还是“应用内置启动/管理模型进程”的形态接入？
2. Qwen-ASR-Realtime 连接目标是“官方云端”还是“自建网关/私有化部署”？（决定 proxy 的鉴权/签名实现方式）
3. 是否要求新增 Provider 时做到“前端 UI 零改、`useASR` 零改”？（若是，需尽快完成配置驱动 UI + 能力驱动管线）

