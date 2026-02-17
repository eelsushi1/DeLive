/**
 * Qwen-ASR-Realtime Provider（主进程直连 + IPC）
 * 场景：实时字幕（支持 manual 定时 commit 或 server_vad）
 */

import { BaseASRProvider } from '../base'
import type { ASRProviderInfo, ASRVendor, ProviderConfig } from '../../types/asr'
import type { QwenAsrIpcEvent, QwenIpcConnectConfig } from '../../types/asr/vendors/qwen'

export class QwenProvider extends BaseASRProvider {
  readonly id: ASRVendor = 'qwen' as ASRVendor

  readonly info: ASRProviderInfo = {
    id: 'qwen' as ASRVendor,
    name: 'Qwen ASR Realtime',
    description: '阿里云百炼实时语音识别（主进程直连，支持实时字幕）',
    type: 'cloud',
    supportsStreaming: true,
    supportedLanguages: ['zh', 'en'],
    website: 'https://help.aliyun.com/zh/model-studio/realtime',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/realtime',
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: '输入你的百炼 API Key（sk-...）',
        description: '从阿里云百炼控制台获取',
      },
      {
        key: 'model',
        label: 'Model',
        type: 'text',
        required: true,
        placeholder: '例如：qwen3-asr-flash-realtime-xxxx',
        description: '填写要使用的 ASR Realtime 模型名称',
      },
      {
        key: 'baseURL',
        label: 'Base URL（可选）',
        type: 'text',
        required: false,
        placeholder: '例如：https://dashscope.aliyuncs.com/compatible-mode/v1',
        description: '用于推导 Realtime 的 wss host；也可改为直接填写 endpoint',
      },
      {
        key: 'endpoint',
        label: 'Realtime WSS Endpoint（可选）',
        type: 'text',
        required: false,
        placeholder: '例如：wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
        description: '直接指定 Realtime WebSocket 地址（优先级高于 baseURL）',
      },
      {
        key: 'language',
        label: 'Language',
        type: 'text',
        required: false,
        placeholder: 'zh',
        description: '识别语言（默认 zh）',
      },
      {
        key: 'turnDetectionMode',
        label: '断句模式',
        type: 'select',
        required: false,
        description: 'manual 更实时（更碎），server_vad 更自然（可能更慢）',
        options: [
          { value: 'manual', label: '实时字幕（Manual + 定时 commit）' },
          { value: 'server_vad', label: '自然断句（服务端 VAD）' },
        ],
        defaultValue: 'server_vad',
      },
      {
        key: 'commitIntervalMs',
        label: 'Manual commit 间隔（ms）',
        type: 'number',
        required: false,
        placeholder: '250',
        description: '仅 manual 生效，建议 200~400',
        defaultValue: 250,
      },
      {
        key: 'vadThreshold',
        label: 'VAD Threshold',
        type: 'number',
        required: false,
        placeholder: '0.0',
        description: '服务端 VAD 阈值（仅 server_vad 模式，默认 0.0）',
      },
      {
        key: 'vadSilenceDurationMs',
        label: 'VAD Silence (ms)',
        type: 'number',
        required: false,
        placeholder: '400',
        description: '服务端 VAD 静音判停时长（仅 server_vad 模式，默认 400ms）',
      },
    ],
  }

  private cleanupListener: (() => void) | null = null

  async connect(config: ProviderConfig): Promise<void> {
    const apiKey = (config.apiKey as string) || ''
    const model = (config.model as string) || ''

    if (!apiKey.trim()) {
      this.emitError(this.createError('MISSING_API_KEY', '请提供 Qwen API Key'))
      return
    }
    if (!model.trim()) {
      this.emitError(this.createError('MISSING_MODEL', '请提供 Qwen ASR 的 model'))
      return
    }

    if (!window.electronAPI?.qwenAsrConnect || !window.electronAPI?.onQwenAsrEvent) {
      this.emitError(this.createError('NOT_SUPPORTED', '当前环境不支持 Qwen ASR（需要 Electron 主进程）'))
      return
    }

    this._config = config
    this.setState('connecting')

    // 重新绑定事件监听（避免重复订阅）
    if (this.cleanupListener) {
      this.cleanupListener()
      this.cleanupListener = null
    }

    this.cleanupListener = window.electronAPI.onQwenAsrEvent((evt: QwenAsrIpcEvent) => {
      this.handleIpcEvent(evt)
    })

    const connectConfig: QwenIpcConnectConfig = {
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseURL: (config.baseURL as string) || undefined,
      endpoint: (config.endpoint as string) || undefined,
      language: (config.language as string) || 'zh',
      turnDetectionMode: (config.turnDetectionMode as 'server_vad' | 'manual') || undefined,
      commitIntervalMs: typeof config.commitIntervalMs === 'number' ? (config.commitIntervalMs as number) : undefined,
      vadThreshold: typeof config.vadThreshold === 'number' ? (config.vadThreshold as number) : undefined,
      vadSilenceDurationMs: typeof config.vadSilenceDurationMs === 'number' ? (config.vadSilenceDurationMs as number) : undefined,
    }

    const result = await window.electronAPI.qwenAsrConnect(connectConfig)
    if (result?.error) {
      this.emitError(this.createError('CONNECTION_ERROR', result.error))
      return
    }

    this.setState('connected')
  }

  async disconnect(): Promise<void> {
    try {
      // 尝试结束会话，触发服务端输出最后的 transcript
      await window.electronAPI?.qwenAsrFinish?.()
    } catch {
      // ignore
    }

    try {
      await window.electronAPI?.qwenAsrDisconnect?.()
    } catch {
      // ignore
    }

    if (this.cleanupListener) {
      this.cleanupListener()
      this.cleanupListener = null
    }

    this.setState('idle')
  }

  sendAudio(data: Blob | ArrayBuffer): void {
    if (!window.electronAPI?.qwenAsrSendAudio) return

    this.setState('recording')

    if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => {
        window.electronAPI?.qwenAsrSendAudio(buf)
      })
      return
    }

    window.electronAPI.qwenAsrSendAudio(data)
  }

  private handleIpcEvent(evt: QwenAsrIpcEvent): void {
    switch (evt.type) {
      case 'state':
        if (evt.state === 'connected') this.setState('connected')
        if (evt.state === 'finishing') this.setState('processing')
        if (evt.state === 'closed') this.setState('idle')
        break
      case 'partial':
        if (evt.text) {
          this.emitPartial(evt.text)
        }
        break
      case 'final':
        // 字幕场景仅展示实时文本：final 也按 partial 更新，避免 useASR 追加导致重复
        if (evt.text) {
          this.emitPartial(evt.text)
        }
        this.emitFinished()
        break
      case 'error':
        this.emitError(
          this.createError(evt.code || 'QWEN_ERROR', evt.message || 'Qwen ASR 错误', {
            raw: evt.raw,
          })
        )
        break
    }
  }
}
