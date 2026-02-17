# Qwen 实时字幕方案B（Manual + 定时 commit）落地与排错

时间：2026-02-17 21:06

## 1. 背景与现象

- **火山引擎**：能“边说边出字”，字幕几乎跟音频同步。
- **Qwen Realtime**：在 `server_vad`（服务端断句）模式下，常见现象是**一小段话说完/出现停顿后**才输出较长的文本，看起来“不够实时”。

结论（核心差异）：两者的“实时性”并不只取决于音频上行，而是取决于**服务端什么时候把音频缓冲区“提交/切段”并开始产出转写结果**。

## 2. 原因（官方协议层面）

依据官方 Realtime 协议：

- `input_audio_buffer.append`：向服务端输入音频缓冲区持续写入音频字节。
- `input_audio_buffer.commit`：提交音频缓冲区，**创建新的用户输入项并清空缓冲区**；如果开启转写，**转写通常在 commit 后触发**。
- **Server VAD 开启时**：服务端根据静音检测自动决定何时 commit；**Server VAD 关闭时**：需要客户端自行 commit。
- `input_audio_buffer.commit` 在**音频缓冲为空**时会报错。
- 阿里云百炼 Realtime 示例明确要求：`input_audio_format: "pcm16"`，并说明仅支持 **16-bit / 16kHz / 单声道 PCM**。

因此在 Qwen 的 `server_vad` 模式下，“等待一句话说完才出字”往往是**服务端等到判停（silence_duration_ms）才 commit** 的必然结果；而要做到“边说边出字”，就需要更高频、更主动的 commit（方案B）。

## 3. 方案B（Manual + 定时 commit）设计目标

目标：在不依赖服务端判停的情况下，让字幕以更小粒度持续刷新。

关键点：

1. 将 `turn_detection` 置空（manual）。
2. 继续按小 chunk `append` 音频。
3. 以固定周期（例如 200~400ms）触发 `input_audio_buffer.commit`，让服务端更快地产出转写。

风险与权衡：

- commit 更频繁 ⇒ 文本更实时，但会更“碎”，且可能增加服务端处理负载/费用（取决于计费与实现）。
- commit 更稀疏 ⇒ 文本更自然，但延迟更明显。

## 4. 本次落地的关键实现点（简述）

- 前端配置增加：
  - `turnDetectionMode: 'server_vad' | 'manual'`
  - `commitIntervalMs`（manual 模式下生效）
- 主进程 Qwen 会话增加：
  - `startQwenCommitTimer()`：按 `commitIntervalMs` 定时 commit
  - `audioSinceLastCommit`：有新音频写入才 commit，避免空提交

## 5. 本次遇到的报错与原因定位

### 5.1 Qwen 服务端报错：commit 失败

现象（raw）：

- `type: "error"`
- `message: "Error committing input audio buffer, maybe no valid audio stream."`

结合官方协议，“commit 失败”最常见原因是：**服务端认为缓冲区为空/音频流无效**，例如：

- `input_audio_format` 配置不匹配，导致服务端丢弃/无法解析 `append` 的音频（commit 时就会像“空缓冲”一样失败）。
- 某次 `append` 实际发送了空 chunk（byteLength=0），commit 认为没有有效音频。

### 5.2 Windows 捕获报错：Source is not capturable

现象：

- `CreateForWindow failed ...`
- `Source is not capturable`
- 并伴随日志：`[DisplayMedia] 自动复用上次选择的源: window:...`

根因：自动复用上一次的 **window 源** 在 Windows 上更容易遇到：

- 窗口已关闭/句柄变化
- 受保护内容/不可捕获窗口
- 最小化/系统窗口等导致 WGC 捕获失败

这会影响 `getDisplayMedia` 捕获的稳定性，进而影响音频上行与字幕链路。

## 6. 针对报错的修复点（已落地）

1. **Qwen `session.update` 修正音频格式**
   - `input_audio_format` 从 `'pcm'` 改为 `'pcm16'`（与百炼 Realtime 官方示例一致）
2. **避免空音频 append**
   - 收到 `chunk.byteLength === 0` 时直接丢弃，不发送 `append`
3. **显示更完整的服务端错误信息**
   - 兼容解析 `msg.error.message`，避免只看到“服务端错误”
4. **DisplayMedia 自动复用更稳健**
   - 自动复用仅对 `screen:` 源生效；如果缓存的是 `window:` 源则清空并强制弹出选择器

## 7. 参数说明与当前系统取值

### 7.1 Qwen `server_vad` 相关

- `vadThreshold`：VAD 激活阈值（0~1），越大越“需要更响的声音才认为在说话”（更抗噪，但可能漏掉轻声）。
- `vadSilenceDurationMs`：判停的静音时长（ms），越小越容易更快断句（但更容易过早切段）。

当前系统（未填写时）默认值：

- `vadThreshold = 0.0`
- `vadSilenceDurationMs = 400`

### 7.2 火山引擎 VAD/断句相关（本项目当前写死值）

代码里开启 VAD 时设置：

- `end_window_size = 800`（ms）
- `force_to_speech_time = 1000`（ms）

官方含义（Doubao Voice / 火山语音 WebSocket 参数）：

- `end_window_size`：**强制句末检测时间**（ms），默认 800，最小 200。
- `force_to_speech_time`：**强制语音时间**（ms），默认 10000，最小 1；与 `end_window_size` 配合使用。

## 8. 如果仍觉得 Qwen 字幕慢：下一步优化建议（可选）

1. **降低前端音频 chunk 粒度**：将 `AudioProcessor` 的 `bufferSize` 从 4096 调小（例如 2048/1024），降低单包时间长度（代价是更高的 IPC/WS 频率）。
2. **从“固定周期 commit”改为“本地 VAD + commit”**：用短静音/能量阈值触发 commit，既更实时又更自然。
3. **加 commit ACK 节流**：收到 `input_audio_buffer.committed` 后再允许下一次 commit，避免在服务端忙时触发空提交。

