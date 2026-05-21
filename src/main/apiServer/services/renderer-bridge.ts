import { loggerService } from '@main/services/LoggerService'
import { windowService } from '@main/services/WindowService'

const logger = loggerService.withContext('RendererBridge')

class RendererBridge {
  private async execute<T>(code: string): Promise<T> {
    const mainWindow = windowService.getMainWindow()
    if (!mainWindow) {
      throw new Error('Main window is not available')
    }
    return await mainWindow.webContents.executeJavaScript(code)
  }

  async appendMessage(topicId: string, message: object, blocks: object[]): Promise<void> {
    const msgJson = JSON.stringify(message)
    const blocksJson = JSON.stringify(blocks)
    await this.execute(`window.dbService.appendMessage(${JSON.stringify(topicId)}, ${msgJson}, ${blocksJson})`)
  }

  async getMessages(topicId: string): Promise<{ messages: any[]; blocks: any[] }> {
    return await this.execute<{ messages: any[]; blocks: any[] }>(
      `window.dbService.fetchMessages(${JSON.stringify(topicId)})`
    )
  }

  async ensureTopicInDb(topicId: string): Promise<void> {
    await this.execute(`window.dbService.ensureTopic(${JSON.stringify(topicId)})`)
  }

  async dispatchMessageToUI(topicId: string, message: object, blocks: object[]): Promise<void> {
    const blocksJson = JSON.stringify(blocks)
    const msgJson = JSON.stringify({ topicId, message })
    await this.execute(`
      (() => {
        const blocks = ${blocksJson};
        if (blocks.length > 0) {
          window.store.dispatch({ type: 'messageBlocks/upsertManyBlocks', payload: blocks });
        }
        window.store.dispatch({ type: 'newMessages/addMessage', payload: ${msgJson} });
      })()
    `)
  }

  async triggerAutoRename(assistantId: string, topicId: string): Promise<void> {
    try {
      await this.execute(`
        (async () => {
          const { autoRenameTopic } = await import('@renderer/hooks/useTopic')
          const state = window.store.getState()
          const assistant = state.assistants.assistants.find(a => a.id === ${JSON.stringify(assistantId)})
          if (assistant) {
            await autoRenameTopic(assistant, ${JSON.stringify(topicId)})
          }
        })()
      `)
    } catch (error) {
      logger.warn('Auto-rename failed (non-critical)', { error: error as Error })
    }
  }
}

export const rendererBridge = new RendererBridge()
