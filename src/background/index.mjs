import ExpiryMap from 'expiry-map'
import { v4 as uuidv4 } from 'uuid'
import Browser from 'webextension-polyfill'
import { sendMessageFeedback } from './chatgpt.mjs'
import { fetchSSE } from './fetch-sse.mjs'

const KEY_ACCESS_TOKEN = 'accessToken'

const cache = new ExpiryMap(10 * 1000)

async function getAccessToken() {
  if (cache.get(KEY_ACCESS_TOKEN)) {
    return cache.get(KEY_ACCESS_TOKEN)
  }
  const resp = await fetch('https://chat.openai.com/api/auth/session')
  if (resp.status === 403) {
    throw new Error('CLOUDFLARE')
  }
  const data = await resp.json().catch(() => ({}))
  if (!data.accessToken) {
    throw new Error('UNAUTHORIZED')
  }
  cache.set(KEY_ACCESS_TOKEN, data.accessToken)
  return data.accessToken
}

async function generateAnswers(port, question) {
  const accessToken = await getAccessToken()

  const controller = new AbortController()
  port.onDisconnect.addListener(() => {
    controller.abort()
  })

  await fetchSSE('https://chat.openai.com/backend-api/conversation', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      action: 'next',
      messages: [
        {
          id: uuidv4(),
          role: 'user',
          content: {
            content_type: 'text',
            parts: [question],
          },
        },
      ],
      model: 'text-davinci-002-render',
      parent_message_id: uuidv4(),
    }),
    onMessage(message) {
      console.debug('sse message', message)
      if (message === '[DONE]') {
        return
      }
      const data = JSON.parse(message)
      const text = data.message?.content?.parts?.[0]
      if (text) {
        port.postMessage({
          text,
          messageId: data.message.id,
          conversationId: data.conversation_id,
        })
      }
    },
  })
}

Browser.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(async (msg) => {
    console.debug('received msg', msg)
    try {
      await generateAnswers(port, msg.question)
    } catch (err) {
      console.error(err)
      port.postMessage({ error: err.message })
      cache.delete(KEY_ACCESS_TOKEN)
    }
  })
})

Browser.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'FEEDBACK') {
    const token = await getAccessToken()
    await sendMessageFeedback(token, message.data)
  }
})
