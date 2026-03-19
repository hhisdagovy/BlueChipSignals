import {
  assertLeadAccess,
  assertSenderModeAccess,
  buildEmailHtml,
  buildTransport,
  fetchLeadForAccess,
  handleOptionsRequest,
  jsonResponse,
  loadMailboxSenderWithSecret,
  normalizeWhitespace,
  requireAuthenticatedProfile
} from '../_shared/crm-email.ts'

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

    const lead = await fetchLeadForAccess(supabase, payload.leadId)
    assertLeadAccess(profile, lead)

    if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
      throw new Error('This lead does not have a valid email address.')
    }

    const sender = await loadMailboxSenderWithSecret(supabase, profile, senderMode)
    const bodyHtml = buildEmailHtml({
      senderName: sender.senderName,
      bodyText
    })
    const sentAt = new Date().toISOString()
    const transport = buildTransport(sender)
    let providerMessageId = ''

    try {
      const result = await transport.sendMail({
        from: `"${sender.senderName}" <${sender.senderEmail}>`,
        to: lead.email,
        subject,
        text: bodyText,
        html: bodyHtml,
        replyTo: sender.senderEmail
      })
      providerMessageId = normalizeWhitespace(result?.messageId)
    } catch (sendError) {
      const message = String(sendError instanceof Error ? sendError.message : sendError || 'Unable to send the email.')

      await supabase.rpc('crm_record_email_send', {
        target_lead_id: Number(lead.id),
        target_sender_mailbox_id: sender.id,
        target_sender_kind: sender.kind,
        target_created_by_user_id: profile.id,
        target_from_email: sender.senderEmail,
        target_from_name: sender.senderName,
        target_to_email: lead.email,
        target_subject: subject,
        target_body_text: bodyText,
        target_body_html: bodyHtml,
        target_provider: 'smtp',
        target_provider_message_id: providerMessageId,
        target_status: 'failed',
        target_error_message: message,
        target_sent_at: sentAt
      }).catch(() => null)

      throw new Error(message)
    } finally {
      if (typeof transport.close === 'function') {
        transport.close()
      }
    }

    const { data: savedMessage, error: saveError } = await supabase
      .rpc('crm_record_email_send', {
        target_lead_id: Number(lead.id),
        target_sender_mailbox_id: sender.id,
        target_sender_kind: sender.kind,
        target_created_by_user_id: profile.id,
        target_from_email: sender.senderEmail,
        target_from_name: sender.senderName,
        target_to_email: lead.email,
        target_subject: subject,
        target_body_text: bodyText,
        target_body_html: bodyHtml,
        target_provider: 'smtp',
        target_provider_message_id: providerMessageId,
        target_status: 'sent',
        target_error_message: '',
        target_sent_at: sentAt
      })
      .single()

    if (saveError) {
      throw new Error(saveError.message || 'The email sent, but CRM logging failed.')
    }

    return jsonResponse({
      message: mapEmailMessageRow(savedMessage)
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || 'Unable to send the email.')
    const loweredMessage = message.toLowerCase()
    const status = loweredMessage.includes('signed in')
      || loweredMessage.includes('authorization')
      || loweredMessage.includes('only support')
      || loweredMessage.includes('only admin')
      || loweredMessage.includes('assigned to your crm session')
      ? 403
      : 400

    return jsonResponse({ error: message }, status)
  }
})

function mapEmailMessageRow(row: Record<string, unknown>) {
  return {
    id: normalizeWhitespace(row.id),
    leadId: String(row.lead_id ?? ''),
    senderMailboxId: normalizeWhitespace(row.sender_mailbox_id),
    senderKind: normalizeWhitespace(row.sender_kind),
    createdByUserId: normalizeWhitespace(row.created_by_user_id),
    fromEmail: normalizeWhitespace(row.from_email).toLowerCase(),
    fromName: normalizeWhitespace(row.from_name),
    toEmail: normalizeWhitespace(row.to_email).toLowerCase(),
    subject: normalizeWhitespace(row.subject),
    bodyText: String(row.body_text ?? ''),
    bodyHtml: String(row.body_html ?? ''),
    provider: normalizeWhitespace(row.provider) || 'smtp',
    providerMessageId: normalizeWhitespace(row.provider_message_id),
    status: normalizeWhitespace(row.status) || 'failed',
    errorMessage: normalizeWhitespace(row.error_message),
    sentAt: String(row.sent_at ?? ''),
    createdAt: String(row.created_at ?? '')
  }
}
