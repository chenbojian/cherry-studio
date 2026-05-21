import type { ChatCompletionMessageParam, ChatCompletionTool } from '@cherrystudio/openai/resources'
import { loggerService } from '@main/services/LoggerService'
import mcpService from '@main/services/MCPService'
import { reduxService } from '@main/services/ReduxService'
import type { Response } from 'express'
import { v4 as uuidv4 } from 'uuid'

import { chatCompletionService } from './chat-completion'
import { rendererBridge } from './renderer-bridge'

const logger = loggerService.withContext('AssistantChatService')

const DEFAULT_CONTEXT_COUNT = 5
const MAX_TOOL_ITERATIONS = 20

interface AssistantData {
  id: string
  name: string
  prompt: string
  model?: { id: string; provider: string; name: string }
  settings?: {
    contextCount?: number
    temperature?: number
    topP?: number
    streamOutput?: boolean
    maxToolCalls?: number
  }
  mcpMode?: string
  mcpServers?: any[]
}

export interface ChatParams {
  content: string
  model?: string
  files?: Array<{
    type: 'image' | 'file'
    name?: string
    content: string
    mimeType?: string
  }>
  mcpServers?: string[]
}

interface AccumulatedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ToolBlockData {
  id: string
  messageId: string
  type: 'tool'
  toolName: string
  arguments?: any
  content?: string
  status: string
  createdAt: string
}

function writeSSE(res: Response, data: any) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export class AssistantChatService {
  async chat(assistant: AssistantData, topicId: string, params: ChatParams, res: Response): Promise<void> {
    // 1. Resolve model
    const model = this.resolveModel(assistant, params.model)
    if (!model) {
      res.status(400).json({
        error: {
          message: 'No model configured. Provide "model" in request or configure one on the assistant.',
          type: 'invalid_request_error',
          code: 'model_not_configured'
        }
      })
      return
    }

    const modelStr = `${model.provider}:${model.id}`

    // 2. Create and persist user message
    const userMsgId = uuidv4()
    const userBlocks = this.buildUserBlocks(userMsgId, params)
    const userMessage = {
      id: userMsgId,
      role: 'user',
      topicId,
      assistantId: assistant.id,
      createdAt: new Date().toISOString(),
      status: 'success',
      blocks: userBlocks.map((b) => b.id)
    }

    await rendererBridge.appendMessage(topicId, userMessage, userBlocks)
    await rendererBridge.dispatchMessageToUI(topicId, userMessage, userBlocks)

    // 3. Fetch MCP tools
    const mcpTools = await this.fetchMcpTools(assistant, params)

    // 4. Build conversation context
    const { messages: prevMessages, blocks: prevBlocks } = await rendererBridge.getMessages(topicId)
    const contextMessages = this.buildContext(prevMessages, prevBlocks, assistant)

    // 5. Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    let aborted = false
    res.on('close', () => {
      aborted = true
    })

    const assistantMsgId = uuidv4()
    const allAssistantBlocks: any[] = []

    try {
      // 6. Tool loop
      const loopMessages = [...contextMessages]
      let fullTextContent = ''
      const maxIterations = assistant.settings?.maxToolCalls ?? MAX_TOOL_ITERATIONS
      let iteration = 0

      while (iteration < maxIterations && !aborted) {
        iteration++

        const hasTools = mcpTools.length > 0
        const requestParams: any = {
          model: modelStr,
          messages: loopMessages,
          stream: true,
          ...(hasTools && { tools: mcpTools, tool_choice: 'auto' })
        }

        const { stream } = await chatCompletionService.processStreamingCompletion(requestParams)

        let chunkContent = ''
        const toolCalls: AccumulatedToolCall[] = []

        for await (const chunk of stream) {
          if (aborted) break
          const choice = chunk.choices?.[0]
          if (!choice) continue

          // Accumulate text
          const delta = choice.delta?.content || ''
          if (delta) {
            chunkContent += delta
            fullTextContent += delta
            writeSSE(res, { type: 'text', content: delta, message_id: assistantMsgId })
          }

          // Accumulate tool calls
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } }
              }
              if (tc.id) toolCalls[idx].id = tc.id
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
            }
          }
        }

        // If no tool calls, we're done
        if (toolCalls.length === 0) {
          break
        }

        // Process tool calls
        // Add assistant message with tool_calls to context
        loopMessages.push({
          role: 'assistant',
          content: chunkContent || null,
          tool_calls: toolCalls
        } as any)

        // Execute each tool and stream events
        for (const tc of toolCalls) {
          if (aborted) break
          const toolName = tc.function.name
          let toolArgs: any = {}
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}')
          } catch {
            /* use empty object */
          }

          writeSSE(res, {
            type: 'tool_call',
            tool_call_id: tc.id,
            name: toolName,
            arguments: toolArgs
          })

          let toolResult: string
          try {
            toolResult = await this.executeTool(toolName, toolArgs, assistant.mcpServers || [])
          } catch (err: any) {
            toolResult = `Error: ${err.message}`
          }

          writeSSE(res, {
            type: 'tool_result',
            tool_call_id: tc.id,
            content: toolResult
          })

          // Add tool result to context
          loopMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResult
          } as any)

          // Create tool block for persistence
          allAssistantBlocks.push({
            id: uuidv4(),
            messageId: assistantMsgId,
            type: 'tool',
            toolName,
            arguments: toolArgs,
            content: toolResult,
            status: 'success',
            createdAt: new Date().toISOString()
          } as ToolBlockData)
        }
      }

      // 7. Persist assistant message with all blocks
      const mainTextBlockId = uuidv4()
      const mainTextBlock = {
        id: mainTextBlockId,
        messageId: assistantMsgId,
        type: 'main_text',
        content: fullTextContent,
        createdAt: new Date().toISOString(),
        status: 'success'
      }
      allAssistantBlocks.unshift(mainTextBlock)

      const assistantMessage = {
        id: assistantMsgId,
        role: 'assistant',
        topicId,
        assistantId: assistant.id,
        createdAt: new Date().toISOString(),
        status: 'success',
        blocks: allAssistantBlocks.map((b) => b.id),
        modelId: model.id,
        model
      }

      await rendererBridge.appendMessage(topicId, assistantMessage, allAssistantBlocks)
      await rendererBridge.dispatchMessageToUI(topicId, assistantMessage, allAssistantBlocks)

      // 8. Update topic timestamp
      await reduxService.dispatch({
        type: 'assistants/updateTopicUpdatedAt',
        payload: { topicId }
      })

      // 9. Auto-rename
      rendererBridge.triggerAutoRename(assistant.id, topicId).catch(() => {})

      if (!aborted) {
        writeSSE(res, '[DONE]')
        res.end()
      }
    } catch (error: any) {
      logger.error('Chat streaming failed', { error, model: modelStr })

      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: error.message || 'Upstream provider error',
            type: 'upstream_error',
            code: 'upstream_error'
          }
        })
      } else {
        writeSSE(res, { type: 'error', error: { message: error.message, type: 'upstream_error' } })
        res.end()
      }
    }
  }

  private resolveModel(
    assistant: AssistantData,
    modelOverride?: string
  ): { id: string; provider: string; name: string } | undefined {
    if (modelOverride && modelOverride.includes(':')) {
      const parts = modelOverride.split(':')
      return { provider: parts[0], id: parts.slice(1).join(':'), name: parts.slice(1).join(':') }
    }
    return assistant.model
  }

  private buildUserBlocks(messageId: string, params: ChatParams): any[] {
    const blocks: any[] = []
    const now = new Date().toISOString()

    // Main text block
    blocks.push({
      id: uuidv4(),
      messageId,
      type: 'main_text',
      content: params.content,
      createdAt: now,
      status: 'success'
    })

    // File/image blocks
    if (params.files) {
      for (const file of params.files) {
        if (file.type === 'image') {
          blocks.push({
            id: uuidv4(),
            messageId,
            type: 'image',
            url: `data:${file.mimeType || 'image/png'};base64,${file.content}`,
            createdAt: now,
            status: 'success'
          })
        } else {
          blocks.push({
            id: uuidv4(),
            messageId,
            type: 'file',
            content: file.content,
            createdAt: now,
            status: 'success',
            metadata: { name: file.name, mimeType: file.mimeType }
          })
        }
      }
    }

    return blocks
  }

  private async fetchMcpTools(assistant: AssistantData, params: ChatParams): Promise<ChatCompletionTool[]> {
    const serversToUse = await this.resolveMcpServers(assistant, params)
    if (serversToUse.length === 0) return []

    const tools: ChatCompletionTool[] = []

    for (const server of serversToUse) {
      try {
        const serverTools = await mcpService.listTools(null as any, server)
        for (const tool of serverTools) {
          if (server.disabledTools?.includes(tool.name)) continue
          tools.push({
            type: 'function',
            function: {
              name: `${server.name}__${tool.name}`,
              description: tool.description || '',
              parameters: (tool.inputSchema as any) || { type: 'object', properties: {} }
            }
          })
        }
      } catch (err) {
        logger.warn(`Failed to list tools from MCP server ${server.name}`, { error: err as Error })
      }
    }

    return tools
  }

  private async resolveMcpServers(assistant: AssistantData, params: ChatParams): Promise<any[]> {
    const allServers = await reduxService.select<any[]>('state.mcp.servers')
    const activeServers = (allServers || []).filter((s: any) => s.isActive)

    // If request specifies mcpServers, use those (override assistant config)
    if (params.mcpServers && params.mcpServers.length > 0) {
      return activeServers.filter((s: any) => params.mcpServers!.includes(s.id) || params.mcpServers!.includes(s.name))
    }

    // Otherwise, replicate UI logic: getEffectiveMcpMode → getMcpServersForAssistant
    const mcpMode = assistant.mcpMode || ((assistant.mcpServers?.length ?? 0) > 0 ? 'manual' : 'disabled')

    switch (mcpMode) {
      case 'disabled':
        return []
      case 'auto':
        return [{ id: 'hub', name: '@cherry/hub', type: 'inMemory', isActive: true }]
      case 'manual': {
        const assistantMcpServers = assistant.mcpServers || []
        return activeServers.filter((s: any) => assistantMcpServers.some((as: any) => as.id === s.id))
      }
      default:
        return []
    }
  }

  private async executeTool(toolName: string, args: any, mcpServers: any[]): Promise<string> {
    const separatorIdx = toolName.indexOf('__')
    if (separatorIdx === -1) throw new Error(`Invalid tool name format: ${toolName}`)

    const serverName = toolName.substring(0, separatorIdx)
    const realToolName = toolName.substring(separatorIdx + 2)

    const server = mcpServers.find((s: any) => s.name === serverName)
    if (!server) throw new Error(`MCP server not found: ${serverName}`)

    const result = await mcpService.callTool(null as any, {
      server,
      name: realToolName,
      args,
      callId: uuidv4()
    })

    if (result.isError) {
      throw new Error(result.content?.[0]?.text || 'Tool execution failed')
    }

    return (result.content || []).map((c: any) => c.text || '').join('\n')
  }

  private buildContext(messages: any[], blocks: any[], assistant: AssistantData): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = []

    if (assistant.prompt) {
      result.push({ role: 'system', content: assistant.prompt })
    }

    const contextCount = assistant.settings?.contextCount ?? DEFAULT_CONTEXT_COUNT
    const relevantMessages = messages.slice(-contextCount * 2)

    for (const msg of relevantMessages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue
      const msgBlockIds: string[] = msg.blocks || []
      const msgBlocks = blocks.filter((b: any) => msgBlockIds.includes(b.id))

      if (msg.role === 'user') {
        const contentParts: any[] = []
        for (const block of msgBlocks) {
          if (block.type === 'main_text' && block.content) {
            contentParts.push({ type: 'text', text: block.content })
          } else if (block.type === 'image' && block.url) {
            contentParts.push({ type: 'image_url', image_url: { url: block.url } })
          }
        }
        if (contentParts.length > 0) {
          result.push({
            role: 'user',
            content: contentParts.length === 1 ? contentParts[0].text || contentParts : contentParts
          })
        }
      } else {
        const mainTextBlocks = msgBlocks.filter((b: any) => b.type === 'main_text')
        const content = mainTextBlocks.map((b: any) => b.content).join('\n\n')
        if (content) {
          result.push({ role: 'assistant', content })
        }
      }
    }

    return result
  }
}

export const assistantChatService = new AssistantChatService()
