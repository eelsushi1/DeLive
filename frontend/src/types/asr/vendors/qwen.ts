/**
 * Qwen-ASR-Realtime 特定类型定义
 * 基于阿里云百炼 Realtime WebSocket 协议（OpenAI-Beta: realtime=v1）
 */

// Qwen 提供商配置（存储于 settings.providerConfigs['qwen']）
export interface QwenProviderConfig {
  apiKey: string
  model: string
  // 用户输入的 baseURL（compatible-mode）或直接的 wss endpoint（二选一）
  baseURL?: string
  endpoint?: string
  // 识别语言（可选，默认 zh）
  language?: string
  // VAD 必开：仅暴露参数
  vadThreshold?: number
  vadSilenceDurationMs?: number
}

// 主进程连接配置（IPC 传输）
export interface QwenIpcConnectConfig {
  apiKey: string
  model: string
  baseURL?: string
  endpoint?: string
  language?: string
  vadThreshold?: number
  vadSilenceDurationMs?: number
}

// 主进程回推给渲染进程的事件
export type QwenAsrIpcEvent =
  | { type: 'state'; state: 'connecting' | 'connected' | 'finishing' | 'closed' }
  | { type: 'partial'; text: string; raw?: unknown }
  | { type: 'final'; text: string; raw?: unknown }
  | { type: 'error'; code: string; message: string; raw?: unknown }

