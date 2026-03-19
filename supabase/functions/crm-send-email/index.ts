import {
  assertLeadAccess,
  assertSenderModeAccess,
  buildEmailHtml,
  buildEmailParticipants,
  buildEmailSnippet,
  buildTransport,
  dedupeStrings,
  extractMessageIdTokens,
  fetchLeadForAccess,
  getSupabaseAdminClient,
  handleOptionsRequest,
  jsonResponse,
  loadMailboxSenderWithSecret,
  normalizeEmailAddress,
  normalizeWhitespace,
  parseRecipientEmails,
  requireAuthenticatedProfile
} from '../_shared/crm-email.ts'

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>

Deno.serve(async (request) => {
  const optionsResponse = handleOptionsRequest(request)

  if (optionsResponse) {
    return optionsResponse
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  try {
    const { profile, supabase } = await requireAuthenticatedProfile(request)
    const payload = await request.json().catch(() => ({}))
    const senderMode = assertSenderModeAccess(profile, payload.senderMode)
    const subject = normalizeWhitespace(payload.subject)
    const bodyText = String(payload.bodyText ?? '').trim()
    const explicitRecipientEmails = parseRecipientEmails(payload.recipientEmails)
    const requestedRecipientEmail = normalizeEmailAddress(payload.recipientEmail)
    const normalizedLeadId = normalizeWhitespace(payload.leadId)
    const requestedThreadId = normalizeWhitespace(payload.threadId)
    const requestedInReplyTo = normalizeWhitespace(payload.inReplyTo)
    const requestedReferences = normalizeWhitespace(payload.references)

    if (!subject) {
      throw new Error('Enter an email subject before sending.')
    }

    if (!bodyText) {
      throw new Error('Enter an email message before sending.')
    }

    if (subject.length > 160) {
      throw new Error('Keep the email subject under 160 characters.')
    }

    if (bodyText.length > 10000) {
      throw new Error('Keep the email message under 10,000 characters.')
    }

    const lead = normalizedLeadId
      ? await fetchLeadForAccess(supabase, normalizedLeadId)
      : null

    if (lead) {
      assertLeadAccess(profile, lead)
    }

    const leadEmail = normalizeEmailAddress(lead?.email)
    const recipientEmails = dedupeStrings([
      ...explicitRecipientEmails,
      requestedRecipientEmail,
      !explicitRecipientEmails.length && !requestedRecipientEmail ? leadEmail : ''
    ].filter(Boolean))

    if (!recipientEmails.length) {
      throw new Error(lead
        ? 'This lead does not have a valid email address.'
        : 'Enter at least one valid recipient email before sending.')
    }

    const sender = await loadMailboxSenderWithSecret(supabase, profile, senderMode)
    const sentAt = new Date().toISOString()
    const bodyHtml = buildEmailHtml({
      senderName: sender.senderName,
      bodyText
    })
    const loggedToLead = Boolean(lead && leadEmail && recipientEmails.length === 1 && recipientEmails[0] === leadEmail)
    const referencesTokens = dedupeStrings([
      ...extractMessageIdTokens(requestedReferences),
      ...extractMessageIdTokens(requestedInReplyTo)
    ])
    const referencesHeader = referencesTokens.join(' ')
    const inReplyTo = extractMessageIdTokens(requestedInReplyTo)[0] || ''
    const threadId = requestedThreadId || crypto.randomUUID()

    if (requestedThreadId) {
      const { data: existingThread, error: existingThreadError } = await supabase
        .from('email_threads')
        .select('id, mailbox_sender_id')
        .eq('id', requestedThreadId)
        .maybeSingle()

      if (existingThreadError) {
        throw new Error(existingThreadError.message || 'Unable to load the existing email thread.')
      }

      if (!existingThread) {
        throw new Error('That email thread is no longer available.')
      }

      if (normalizeWhitespace(existingThread.mailbox_sender_id) !== sender.id) {
        throw new Error('You can only reply inside the currently selected mailbox.')
      }
    }

    let providerMessageId = ''
    let transportErrorMessage = ''
    const transport = buildTransport(sender)

    try {
      const result = await transport.sendMail({
        from: `"${sender.senderName}" <${sender.senderEmail}>`,
        to: recipientEmails.join(', '),
        subject,
        text: bodyText,
        html: bodyHtml,
        replyTo: sender.senderEmail,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(referencesHeader ? { references: referencesHeader } : {})
      })

      providerMessageId = normalizeWhitespace(result?.messageId)
    } catch (sendError) {
      transportErrorMessage = String(sendError instanceof Error ? sendError.message : sendError || 'Unable to send the email.')
    } finally {
      if (typeof transport.close === 'function') {
        transport.close()
      }
    }

    await ensureThreadShell(supabase, {
      threadId,
      mailboxSenderId: sender.id,
      leadId: loggedToLead && lead ? lead.id : '',
      subject,
      snippet: buildEmailSnippet(bodyText),
      participants: buildEmailParticipants({
        fromEmail: sender.senderEmail,
        fromName: sender.senderName,
        toEmails: recipientEmails
      }),
      folder: 'SENT',
      direction: 'outgoing',
      status: transportErrorMessage ? 'failed' : 'sent',
      messageAt: sentAt
    })

    const savedMessage = await insertEmailMessageRecord(supabase, {
      threadId,
      leadId: loggedToLead && lead ? lead.id : '',
      mailboxSenderId: sender.id,
      senderKind: sender.kind,
      createdByUserId: profile.id,
      fromEmail: sender.senderEmail,
      fromName: sender.senderName,
      toEmails: recipientEmails,
      subject,
      bodyText,
      bodyHtml,
      provider: 'smtp',
      providerMessageId: providerMessageId || `smtp:${crypto.randomUUID()}`,
      status: transportErrorMessage ? 'failed' : 'sent',
      errorMessage: transportErrorMessage,
      direction: 'outgoing',
      folder: 'SENT',
      isRead: true,
      isStarred: false,
      receivedAt: sentAt,
      messageIdHeader: providerMessageId,
      inReplyTo,
      referencesHeader,
      snippet: buildEmailSnippet(bodyText),
      participants: buildEmailParticipants({
        fromEmail: sender.senderEmail,
        fromName: sender.senderName,
        toEmails: recipientEmails
      }),
      source: 'crm',
      sentAt
    })

    let warning = ''

    try {
      await refreshEmailThreadSummary(supabase, threadId)
    } catch (summaryError) {
      warning = String(summaryError instanceof Error ? summaryError.message : summaryError || 'Email conversation summary could not be refreshed.')
    }

    if (!transportErrorMessage && loggedToLead && lead) {
      try {
        await logLeadEmailActivity(supabase, {
          leadId: lead.id,
          sentAt,
          recipientEmail: recipientEmails[0],
          subject
        })
      } catch (logError) {
        warning = warning || String(logError instanceof Error ? logError.message : logError || 'The email sent, but the lead activity log could not be updated.')
      }
    }

    if (transportErrorMessage) {
      throw new Error(transportErrorMessage)
    }

    return jsonResponse({
      loggedToLead,
      message: mapEmailMessageRow(savedMessage),
      warning
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || 'Unable to send the email.')
    const loweredMessage = message.toLowerCase()
    const status = loweredMessage.includes('signed in')
      || loweredMessage.includes('authorization')
      || loweredMessage.includes('only support')
      || loweredMessage.includes('only admin')
      || loweredMessage.includes('access the support mailbox')
      || loweredMessage.includes('assigned to your crm session')
      || loweredMessage.includes('your own connected mailbox')
      ? 403
      : 400

    return jsonResponse({ error: message }, status)
  }
})

async function ensureThreadShell(
  supabase: SupabaseAdminClient,
  {
    threadId,
    mailboxSenderId,
    leadId,
    subject,
    snippet,
    participants,
    folder,
    direction,
    status,
    messageAt
  }: {
    threadId: string
    mailboxSenderId: string
    leadId: string
    subject: string
    snippet: string
    participants: Array<{ email: string; name: string; role: 'from' | 'to' }>
    folder: string
    direction: string
    status: string
    messageAt: string
  }
) {
  const { error } = await supabase
    .from('email_threads')
    .upsert({
      id: threadId,
      mailbox_sender_id: mailboxSenderId,
      lead_id: leadId ? Number(leadId) : null,
      subject: subject || 'No subject',
      snippet,
      participants,
      folder_presence: [folder],
      latest_message_at: messageAt,
      unread_count: 0,
      is_starred: false,
      last_message_direction: direction,
      last_message_status: status
    }, {
      onConflict: 'id'
    })

  if (error) {
    throw new Error(error.message || 'Unable to create the email conversation.')
  }
}

async function insertEmailMessageRecord(
  supabase: SupabaseAdminClient,
  payload: {
    threadId: string
    leadId: string
    mailboxSenderId: string
    senderKind: string
    createdByUserId: string
    fromEmail: string
    fromName: string
    toEmails: string[]
    subject: string
    bodyText: string
    bodyHtml: string
    provider: string
    providerMessageId: string
    status: string
    errorMessage: string
    direction: string
    folder: string
    isRead: boolean
    isStarred: boolean
    receivedAt: string
    messageIdHeader: string
    inReplyTo: string
    referencesHeader: string
    snippet: string
    participants: Array<{ email: string; name: string; role: 'from' | 'to' }>
    source: string
    sentAt: string
  }
) {
  const insertPayload = {
    thread_id: payload.threadId,
    lead_id: payload.leadId ? Number(payload.leadId) : null,
    sender_mailbox_id: payload.mailboxSenderId,
    sender_kind: normalizeWhitespace(payload.senderKind) === 'support' ? 'support' : 'personal',
    created_by_user_id: payload.createdByUserId || null,
    from_email: payload.fromEmail,
    from_name: payload.fromName,
    to_email: payload.toEmails[0] || '',
    to_emails: payload.toEmails,
    subject: payload.subject,
    body_text: payload.bodyText,
    body_html: payload.bodyHtml,
    provider: payload.provider,
    provider_message_id: payload.providerMessageId,
    status: payload.status,
    error_message: payload.errorMessage || null,
    direction: payload.direction,
    folder: payload.folder,
    is_read: payload.isRead,
    is_starred: payload.isStarred,
    received_at: payload.receivedAt,
    message_id_header: payload.messageIdHeader || null,
    in_reply_to: payload.inReplyTo || null,
    references_header: payload.referencesHeader || null,
    snippet: payload.snippet,
    participants: payload.participants,
    source: payload.source,
    sent_at: payload.sentAt
  }

  const { data, error } = await supabase
    .from('email_messages')
    .insert(insertPayload)
    .select('*')
    .single()

  if (error) {
    throw new Error(error.message || 'Unable to save the email message in CRM.')
  }

  return data
}

async function refreshEmailThreadSummary(
  supabase: SupabaseAdminClient,
  threadId: string
) {
  const { data: messages, error } = await supabase
    .from('email_messages')
    .select('id, lead_id, subject, snippet, participants, folder, is_read, is_starred, direction, status, received_at, sent_at, created_at')
    .eq('thread_id', threadId)

  if (error) {
    throw new Error(error.message || 'Unable to refresh the email conversation summary.')
  }

  const normalizedMessages = (messages ?? []).map((message) => ({
    ...message,
    messageAt: String(message.received_at ?? message.sent_at ?? message.created_at ?? '')
  }))

  if (!normalizedMessages.length) {
    return
  }

  normalizedMessages.sort((left, right) => Date.parse(String(left.messageAt || '')) - Date.parse(String(right.messageAt || '')))
  const latestMessage = normalizedMessages[normalizedMessages.length - 1]
  const participantMap = new Map<string, { email: string; name: string; role: 'from' | 'to' }>()
  const folderPresence = new Set<string>()
  const leadIds = new Set<string>()
  let unreadCount = 0
  let isStarred = false

  normalizedMessages.forEach((message) => {
    ;(Array.isArray(message.participants) ? message.participants : []).forEach((participant) => {
      const email = normalizeEmailAddress(participant?.email)

      if (!email) {
        return
      }

      const key = `${normalizeWhitespace(participant?.role) === 'from' ? 'from' : 'to'}:${email}`

      participantMap.set(key, {
        email,
        name: normalizeWhitespace(participant?.name),
        role: normalizeWhitespace(participant?.role) === 'from' ? 'from' : 'to'
      })
    })

    const folder = normalizeWhitespace(message.folder).toUpperCase()
    if (folder) {
      folderPresence.add(folder)
    }

    if (message.direction === 'incoming' && message.is_read === false) {
      unreadCount += 1
    }

    if (message.is_starred === true) {
      isStarred = true
    }

    const leadId = normalizeWhitespace(message.lead_id)
    if (leadId) {
      leadIds.add(leadId)
    }
  })

  const { error: updateError } = await supabase
    .from('email_threads')
    .update({
      lead_id: leadIds.size === 1 ? Number([...leadIds][0]) : null,
      subject: normalizeWhitespace(latestMessage.subject) || 'No subject',
      snippet: normalizeWhitespace(latestMessage.snippet) || '',
      participants: [...participantMap.values()],
      folder_presence: [...folderPresence],
      latest_message_id: latestMessage.id,
      latest_message_at: latestMessage.messageAt,
      unread_count: unreadCount,
      is_starred: isStarred,
      last_message_direction: normalizeWhitespace(latestMessage.direction) || 'outgoing',
      last_message_status: normalizeWhitespace(latestMessage.status) || 'sent'
    })
    .eq('id', threadId)

  if (updateError) {
    throw new Error(updateError.message || 'Unable to update the email conversation summary.')
  }
}

async function logLeadEmailActivity(
  supabase: SupabaseAdminClient,
  {
    leadId,
    sentAt,
    recipientEmail,
    subject
  }: {
    leadId: string
    sentAt: string
    recipientEmail: string
    subject: string
  }
) {
  const [{ error: touchError }, { error: historyError }] = await Promise.all([
    supabase
      .from('leads')
      .update({ updated_at: sentAt })
      .eq('id', Number(leadId)),
    supabase
      .from('lead_history')
      .insert({
        lead_id: Number(leadId),
        field_name: 'email',
        old_value: null,
        new_value: `Sent to ${recipientEmail} - ${subject}`
      })
  ])

  if (touchError) {
    throw new Error(touchError.message || 'The email sent, but the lead timestamp could not be updated.')
  }

  if (historyError) {
    throw new Error(historyError.message || 'The email sent, but the lead activity log could not be updated.')
  }
}

function mapEmailMessageRow(row: Record<string, unknown>) {
  return {
    id: normalizeWhitespace(row.id),
    leadId: String(row.lead_id ?? ''),
    threadId: normalizeWhitespace(row.thread_id),
    senderMailboxId: normalizeWhitespace(row.sender_mailbox_id),
    senderKind: normalizeWhitespace(row.sender_kind),
    createdByUserId: normalizeWhitespace(row.created_by_user_id),
    fromEmail: normalizeWhitespace(row.from_email).toLowerCase(),
    fromName: normalizeWhitespace(row.from_name),
    toEmail: normalizeWhitespace(row.to_email).toLowerCase(),
    toEmails: Array.isArray(row.to_emails) ? row.to_emails : [],
    subject: normalizeWhitespace(row.subject),
    bodyText: String(row.body_text ?? ''),
    bodyHtml: String(row.body_html ?? ''),
    provider: normalizeWhitespace(row.provider) || 'smtp',
    providerMessageId: normalizeWhitespace(row.provider_message_id),
    status: normalizeWhitespace(row.status) || 'failed',
    errorMessage: normalizeWhitespace(row.error_message),
    direction: normalizeWhitespace(row.direction) || 'outgoing',
    folder: normalizeWhitespace(row.folder) || 'SENT',
    isRead: row.is_read !== false,
    isStarred: row.is_starred === true,
    receivedAt: String(row.received_at ?? ''),
    sentAt: String(row.sent_at ?? ''),
    messageIdHeader: normalizeWhitespace(row.message_id_header),
    inReplyTo: normalizeWhitespace(row.in_reply_to),
    referencesHeader: normalizeWhitespace(row.references_header),
    snippet: normalizeWhitespace(row.snippet),
    source: normalizeWhitespace(row.source) || 'crm',
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  }
}
