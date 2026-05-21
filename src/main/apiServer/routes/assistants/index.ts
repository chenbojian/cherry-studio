import { loggerService } from '@main/services/LoggerService'
import { reduxService } from '@main/services/ReduxService'
import type { Request, Response } from 'express'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import * as z from 'zod'

import { assistantChatService } from '../../services/assistant-chat'
import { rendererBridge } from '../../services/renderer-bridge'

const logger = loggerService.withContext('AssistantsRoute')

// ============ Validators ============

const AssistantIdParams = z.object({ assistantId: z.string().min(1) })
const TopicIdParams = z.object({ assistantId: z.string().min(1), topicId: z.string().min(1) })
const CreateTopicBody = z.object({ name: z.string().optional() })
const ChatFileSchema = z.object({
  type: z.enum(['image', 'file']),
  name: z.string().optional(),
  content: z.string().min(1),
  mimeType: z.string().optional()
})
const ChatBody = z.object({
  content: z.string().min(1),
  model: z.string().optional(),
  files: z.array(ChatFileSchema).optional(),
  mcpServers: z.array(z.string()).optional()
})

// ============ Helpers ============

async function getAssistants(): Promise<any[]> {
  const assistants = await reduxService.select('state.assistants.assistants')
  return Array.isArray(assistants) ? assistants : []
}

async function findAssistant(assistantId: string): Promise<any | undefined> {
  const assistants = await getAssistants()
  return assistants.find((a: any) => a.id === assistantId)
}

function sendError(res: Response, status: number, message: string, type: string, code: string) {
  res.status(status).json({ error: { message, type, code } })
}

// ============ Handlers ============

async function listAssistants(_req: Request, res: Response) {
  try {
    const assistants = await getAssistants()
    const data = assistants.map((a: any) => ({
      id: a.id,
      name: a.name,
      prompt: a.prompt,
      model: a.model,
      topics: (a.topics || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }))
    }))
    res.json({ data, total: data.length })
  } catch (error) {
    logger.error('Failed to list assistants', { error: error as Error })
    sendError(res, 500, 'Internal server error', 'internal_error', 'internal_error')
  }
}

async function getAssistant(req: Request, res: Response) {
  try {
    const { assistantId } = AssistantIdParams.parse(req.params)
    const assistant = await findAssistant(assistantId)
    if (!assistant) {
      return sendError(res, 404, `Assistant '${assistantId}' not found`, 'not_found', 'assistant_not_found')
    }
    res.json({
      id: assistant.id,
      name: assistant.name,
      prompt: assistant.prompt,
      model: assistant.model,
      settings: assistant.settings,
      mcpMode: assistant.mcpMode,
      mcpServers: assistant.mcpServers,
      topics: (assistant.topics || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        pinned: t.pinned
      }))
    })
  } catch (error) {
    logger.error('Failed to get assistant', { error: error as Error })
    sendError(res, 500, 'Internal server error', 'internal_error', 'internal_error')
  }
}

async function createTopic(req: Request, res: Response) {
  try {
    const { assistantId } = AssistantIdParams.parse(req.params)
    const body = CreateTopicBody.parse(req.body || {})

    const assistant = await findAssistant(assistantId)
    if (!assistant) {
      return sendError(res, 404, `Assistant '${assistantId}' not found`, 'not_found', 'assistant_not_found')
    }

    const now = new Date().toISOString()
    const topic = {
      id: uuidv4(),
      assistantId,
      name: body.name || 'New Topic',
      createdAt: now,
      updatedAt: now,
      messages: [],
      isNameManuallyEdited: !!body.name
    }

    // Add topic to Redux (makes it visible in UI sidebar)
    await reduxService.dispatch({
      type: 'assistants/addTopic',
      payload: { assistantId, topic }
    })

    // Ensure topic record exists in IndexedDB
    await rendererBridge.ensureTopicInDb(topic.id)

    res.status(201).json({
      id: topic.id,
      assistantId: topic.assistantId,
      name: topic.name,
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt
    })
  } catch (error) {
    logger.error('Failed to create topic', { error: error as Error })
    sendError(res, 500, 'Internal server error', 'internal_error', 'internal_error')
  }
}

async function listTopics(req: Request, res: Response) {
  try {
    const { assistantId } = AssistantIdParams.parse(req.params)
    const assistant = await findAssistant(assistantId)
    if (!assistant) {
      return sendError(res, 404, `Assistant '${assistantId}' not found`, 'not_found', 'assistant_not_found')
    }

    const topics = (assistant.topics || []).map((t: any) => ({
      id: t.id,
      assistantId: t.assistantId,
      name: t.name,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pinned: t.pinned
    }))

    res.json({ data: topics, total: topics.length })
  } catch (error) {
    logger.error('Failed to list topics', { error: error as Error })
    sendError(res, 500, 'Internal server error', 'internal_error', 'internal_error')
  }
}

async function getTopic(req: Request, res: Response) {
  try {
    const { assistantId, topicId } = TopicIdParams.parse(req.params)
    const assistant = await findAssistant(assistantId)
    if (!assistant) {
      return sendError(res, 404, `Assistant '${assistantId}' not found`, 'not_found', 'assistant_not_found')
    }

    const topic = (assistant.topics || []).find((t: any) => t.id === topicId)
    if (!topic) {
      return sendError(res, 404, `Topic '${topicId}' not found`, 'not_found', 'topic_not_found')
    }

    res.json({
      id: topic.id,
      assistantId: topic.assistantId,
      name: topic.name,
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
      pinned: topic.pinned
    })
  } catch (error) {
    logger.error('Failed to get topic', { error: error as Error })
    sendError(res, 500, 'Internal server error', 'internal_error', 'internal_error')
  }
}

async function chat(req: Request, res: Response) {
  try {
    const { assistantId, topicId } = TopicIdParams.parse(req.params)
    const body = ChatBody.parse(req.body)

    const assistant = await findAssistant(assistantId)
    if (!assistant) {
      return sendError(res, 404, `Assistant '${assistantId}' not found`, 'not_found', 'assistant_not_found')
    }

    const topic = (assistant.topics || []).find((t: any) => t.id === topicId)
    if (!topic) {
      return sendError(res, 404, `Topic '${topicId}' not found`, 'not_found', 'topic_not_found')
    }

    await assistantChatService.chat(assistant, topicId, body, res)
  } catch (error: any) {
    logger.error('Chat failed', { error })
    if (!res.headersSent) {
      sendError(res, 500, error.message || 'Internal server error', 'internal_error', 'internal_error')
    }
  }
}

async function listMessages(req: Request, res: Response) {
  try {
    const { assistantId, topicId } = TopicIdParams.parse(req.params)
    const assistant = await findAssistant(assistantId)
    if (!assistant) {
      return sendError(res, 404, `Assistant '${assistantId}' not found`, 'not_found', 'assistant_not_found')
    }

    const topic = (assistant.topics || []).find((t: any) => t.id === topicId)
    if (!topic) {
      return sendError(res, 404, `Topic '${topicId}' not found`, 'not_found', 'topic_not_found')
    }

    const { messages, blocks } = await rendererBridge.getMessages(topicId)

    const data = messages.map((msg: any) => {
      const msgBlockIds: string[] = msg.blocks || []
      const msgBlocks = blocks.filter((b: any) => msgBlockIds.includes(b.id))
      return {
        id: msg.id,
        role: msg.role,
        assistantId: msg.assistantId,
        topicId: msg.topicId,
        createdAt: msg.createdAt,
        status: msg.status,
        model: msg.model,
        blocks: msgBlocks.map((b: any) => ({
          id: b.id,
          type: b.type,
          content: b.content,
          status: b.status,
          createdAt: b.createdAt
        }))
      }
    })

    res.json({ data, total: data.length })
  } catch (error) {
    logger.error('Failed to list messages', { error: error as Error })
    sendError(res, 500, 'Internal server error', 'internal_error', 'internal_error')
  }
}

// ============ Router ============

const assistantsRouter = express.Router()

/**
 * @swagger
 * components:
 *   schemas:
 *     AssistantModel:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Model identifier
 *           example: gpt-4
 *         provider:
 *           type: string
 *           description: Provider identifier
 *           example: openai
 *         name:
 *           type: string
 *           description: Display name
 *           example: GPT-4
 *
 *     AssistantSummary:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique assistant identifier
 *         name:
 *           type: string
 *           description: Assistant name
 *         prompt:
 *           type: string
 *           description: System prompt
 *         model:
 *           $ref: '#/components/schemas/AssistantModel'
 *         topics:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TopicSummary'
 *
 *     AssistantDetail:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         prompt:
 *           type: string
 *         model:
 *           $ref: '#/components/schemas/AssistantModel'
 *         settings:
 *           type: object
 *           description: Assistant settings (contextCount, temperature, etc.)
 *         topics:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TopicSummary'
 *
 *     TopicSummary:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique topic identifier
 *         name:
 *           type: string
 *           description: Topic name
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *         pinned:
 *           type: boolean
 *
 *     TopicDetail:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         assistantId:
 *           type: string
 *         name:
 *           type: string
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *         pinned:
 *           type: boolean
 *
 *     CreateTopicRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Topic name (optional, defaults to "New Topic")
 *           example: My Conversation
 *
 *     ChatRequest:
 *       type: object
 *       required:
 *         - content
 *       properties:
 *         content:
 *           type: string
 *           minLength: 1
 *           description: User message content
 *           example: Hello, how are you?
 *         model:
 *           type: string
 *           description: Optional model override in "provider:model_id" format. If omitted, uses the assistant's configured model.
 *           example: openai:gpt-4
 *         files:
 *           type: array
 *           description: Optional file/image attachments
 *           items:
 *             type: object
 *             required:
 *               - type
 *               - content
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [image, file]
 *                 description: Attachment type
 *               name:
 *                 type: string
 *                 description: Filename (optional)
 *               content:
 *                 type: string
 *                 description: Base64-encoded image data, or text content for files
 *               mimeType:
 *                 type: string
 *                 description: MIME type (e.g., image/png, text/plain)
 *                 example: image/png
 *         mcpServers:
 *           type: array
 *           description: Optional list of MCP server IDs or names to use for tool calls. Overrides assistant's MCP config. Get available servers from GET /v1/mcps.
 *           items:
 *             type: string
 *           example: ["@cherry/fetch", "k1qkR4hEehZpiKtvyIRdu"]
 *
 *     ChatStreamEvent:
 *       type: object
 *       description: SSE event (one of text, tool_call, tool_result, error)
 *       properties:
 *         type:
 *           type: string
 *           enum: [text, tool_call, tool_result, error]
 *         content:
 *           type: string
 *           description: Text delta (for type=text) or tool result (for type=tool_result)
 *         message_id:
 *           type: string
 *           description: Assistant message ID (for type=text)
 *         tool_call_id:
 *           type: string
 *           description: Tool call ID (for tool_call/tool_result)
 *         name:
 *           type: string
 *           description: Tool name (for type=tool_call)
 *         arguments:
 *           type: object
 *           description: Tool arguments (for type=tool_call)
 *
 *     MessageBlock:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         type:
 *           type: string
 *           enum: [main_text, thinking, code, image, tool, file, error, citation]
 *         content:
 *           type: string
 *         status:
 *           type: string
 *           enum: [pending, processing, streaming, success, error, paused]
 *         createdAt:
 *           type: string
 *           format: date-time
 *
 *     MessageDetail:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         role:
 *           type: string
 *           enum: [user, assistant, system]
 *         assistantId:
 *           type: string
 *         topicId:
 *           type: string
 *         createdAt:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [success, processing, pending, error, paused]
 *         model:
 *           $ref: '#/components/schemas/AssistantModel'
 *         blocks:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/MessageBlock'
 */

/**
 * @swagger
 * /v1/assistants:
 *   get:
 *     summary: List all assistants
 *     description: Returns all configured assistants with their topics (read-only)
 *     tags: [Assistants]
 *     responses:
 *       200:
 *         description: List of assistants
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/AssistantSummary'
 *                 total:
 *                   type: integer
 */
assistantsRouter.get('/', listAssistants)

/**
 * @swagger
 * /v1/assistants/{assistantId}:
 *   get:
 *     summary: Get assistant details
 *     description: Returns a single assistant with full details including settings
 *     tags: [Assistants]
 *     parameters:
 *       - in: path
 *         name: assistantId
 *         required: true
 *         schema:
 *           type: string
 *         description: Assistant ID
 *     responses:
 *       200:
 *         description: Assistant details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AssistantDetail'
 *       404:
 *         description: Assistant not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
assistantsRouter.get('/:assistantId', getAssistant)

/**
 * @swagger
 * /v1/assistants/{assistantId}/topics:
 *   post:
 *     summary: Create a new topic
 *     description: Creates a new conversation topic under the specified assistant. The topic will appear in the UI immediately.
 *     tags: [Assistants]
 *     parameters:
 *       - in: path
 *         name: assistantId
 *         required: true
 *         schema:
 *           type: string
 *         description: Assistant ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTopicRequest'
 *     responses:
 *       201:
 *         description: Topic created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TopicDetail'
 *       404:
 *         description: Assistant not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
assistantsRouter.post('/:assistantId/topics', createTopic)

/**
 * @swagger
 * /v1/assistants/{assistantId}/topics:
 *   get:
 *     summary: List topics for an assistant
 *     description: Returns all topics belonging to the specified assistant
 *     tags: [Assistants]
 *     parameters:
 *       - in: path
 *         name: assistantId
 *         required: true
 *         schema:
 *           type: string
 *         description: Assistant ID
 *     responses:
 *       200:
 *         description: List of topics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TopicDetail'
 *                 total:
 *                   type: integer
 *       404:
 *         description: Assistant not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
assistantsRouter.get('/:assistantId/topics', listTopics)

/**
 * @swagger
 * /v1/assistants/{assistantId}/topics/{topicId}:
 *   get:
 *     summary: Get topic details
 *     description: Returns details of a specific topic
 *     tags: [Assistants]
 *     parameters:
 *       - in: path
 *         name: assistantId
 *         required: true
 *         schema:
 *           type: string
 *         description: Assistant ID
 *       - in: path
 *         name: topicId
 *         required: true
 *         schema:
 *           type: string
 *         description: Topic ID
 *     responses:
 *       200:
 *         description: Topic details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TopicDetail'
 *       404:
 *         description: Assistant or topic not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
assistantsRouter.get('/:assistantId/topics/:topicId', getTopic)

/**
 * @swagger
 * /v1/assistants/{assistantId}/topics/{topicId}/chat:
 *   post:
 *     summary: Chat in a topic (SSE streaming)
 *     description: |
 *       Sends a user message and streams the AI assistant response via Server-Sent Events.
 *       The message history is automatically built from the topic's existing messages.
 *       Both user and assistant messages are persisted and will appear in the UI immediately.
 *       MCP tools configured on the assistant are automatically included and executed.
 *
 *       **SSE event types:**
 *       ```
 *       data: {"type":"text","content":"Hello","message_id":"uuid"}\n\n
 *       data: {"type":"tool_call","tool_call_id":"tc1","name":"server__tool","arguments":{...}}\n\n
 *       data: {"type":"tool_result","tool_call_id":"tc1","content":"result..."}\n\n
 *       data: {"type":"text","content":" world","message_id":"uuid"}\n\n
 *       data: [DONE]\n\n
 *       ```
 *     tags: [Assistants]
 *     parameters:
 *       - in: path
 *         name: assistantId
 *         required: true
 *         schema:
 *           type: string
 *         description: Assistant ID
 *       - in: path
 *         name: topicId
 *         required: true
 *         schema:
 *           type: string
 *         description: Topic ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatRequest'
 *     responses:
 *       200:
 *         description: SSE stream of assistant response events
 *         content:
 *           text/event-stream:
 *             schema:
 *               $ref: '#/components/schemas/ChatStreamEvent'
 *       400:
 *         description: No model configured on assistant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Assistant or topic not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       502:
 *         description: Upstream provider error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
assistantsRouter.post('/:assistantId/topics/:topicId/chat', chat)

/**
 * @swagger
 * /v1/assistants/{assistantId}/topics/{topicId}/messages:
 *   get:
 *     summary: List messages in a topic
 *     description: Returns all messages in a topic with their content blocks
 *     tags: [Assistants]
 *     parameters:
 *       - in: path
 *         name: assistantId
 *         required: true
 *         schema:
 *           type: string
 *         description: Assistant ID
 *       - in: path
 *         name: topicId
 *         required: true
 *         schema:
 *           type: string
 *         description: Topic ID
 *     responses:
 *       200:
 *         description: List of messages with blocks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/MessageDetail'
 *                 total:
 *                   type: integer
 *       404:
 *         description: Assistant or topic not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
assistantsRouter.get('/:assistantId/topics/:topicId/messages', listMessages)

export { assistantsRouter }
