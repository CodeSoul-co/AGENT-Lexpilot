function createConversationMessage({ id, sessionId, role, messageType, createdAt, content, metadata }) {
  if (!id || !sessionId || !['user', 'assistant'].includes(role) || !messageType || !createdAt) {
    throw new TypeError('Conversation message requires id, sessionId, role, messageType and createdAt.');
  }
  const safeContent = typeof content === 'string' ? content : '';
  return {
    id,
    sessionId,
    role,
    messageType,
    createdAt,
    content: safeContent,
    redactedText: safeContent,
    receivedAt: createdAt,
    ...(metadata && typeof metadata === 'object' ? { metadata } : {})
  };
}

function normalizeConversationMessage(message, sessionId, idFactory) {
  if (message?.id && message?.sessionId && message?.messageType && message?.createdAt) {
    return { ...message };
  }
  return createConversationMessage({
    id: idFactory(),
    sessionId,
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    messageType: message?.role === 'assistant' ? 'clarification' : 'user_input',
    createdAt: message?.createdAt ?? message?.receivedAt ?? new Date(0).toISOString(),
    content: message?.content ?? message?.redactedText ?? ''
  });
}

module.exports = { createConversationMessage, normalizeConversationMessage };
