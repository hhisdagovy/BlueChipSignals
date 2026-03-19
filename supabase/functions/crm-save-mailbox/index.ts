import {
  decryptSecret,
  encryptSecret,
  handleOptionsRequest,
  jsonResponse,
  normalizeWhitespace,
  requireAuthenticatedProfile,
  verifyMailboxConnection
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
    const kind = normalizeWhitespace(payload.kind).toLowerCase() === 'support' ? 'support' : 'personal'

    if (kind === 'support' && profile.role !== 'admin') {
      throw new Error('Only admin users can manage the support mailbox.')
    }

    const senderEmail = kind === 'support'
      ? normalizeWhitespace(payload.senderEmail).toLowerCase()
      : profile.email
    const senderName = normalizeWhitespace(payload.senderName) || profile.fullName
    const smtpUsername = normalizeWhitespace(payload.smtpUsername || senderEmail).toLowerCase()
    const imapInboxFolder = normalizeWhitespace(payload.imapInboxFolder) || 'INBOX'
    const imapSentFolder = normalizeWhitespace(payload.imapSentFolder) || 'Sent'

    if (!senderEmail) {
      throw new Error('A sender email is required before saving the mailbox.')
    }

    if (!senderName) {
      throw new Error('A sender name is required before saving the mailbox.')
    }

    if (!smtpUsername) {
      throw new Error('An SMTP username is required before saving the mailbox.')
    }

    let senderQuery = supabase
      .from('mailbox_senders')
      .select('id, kind, owner_user_id, sender_email, sender_name, imap_inbox_folder, imap_sent_folder')

    if (kind === 'support') {
      senderQuery = senderQuery.eq('kind', 'support').limit(1)
    } else {
      senderQuery = senderQuery.eq('kind', 'personal').eq('owner_user_id', profile.id).limit(1)
    }

    const { data: existingSender, error: existingSenderError } = await senderQuery.maybeSingle()

    if (existingSenderError) {
      throw new Error(existingSenderError.message || 'Unable to load the mailbox sender.')
    }

    let existingPassword = ''

    if (existingSender?.id) {
      const { data: existingSecret, error: existingSecretError } = await supabase
        .from('mailbox_sender_secrets')
        .select('password_ciphertext, password_iv')
        .eq('sender_id', existingSender.id)
        .maybeSingle()

      if (existingSecretError) {
        throw new Error(existingSecretError.message || 'Unable to load the current mailbox credentials.')
      }

      if (existingSecret) {
        existingPassword = await decryptSecret(existingSecret.password_ciphertext, existingSecret.password_iv)
      }
    }

    const smtpPassword = String(payload.smtpPassword ?? '').trim() || existingPassword

    if (!smtpPassword) {
      throw new Error('Enter the mailbox password before saving.')
    }

    await verifyMailboxConnection({
      id: normalizeWhitespace(existingSender?.id) || 'pending',
      kind,
      ownerUserId: kind === 'personal' ? profile.id : null,
      senderEmail,
      senderName,
      imapInboxFolder: normalizeWhitespace(existingSender?.imap_inbox_folder) || imapInboxFolder,
      imapSentFolder: normalizeWhitespace(existingSender?.imap_sent_folder) || imapSentFolder,
      smtpUsername,
      smtpPassword
    })

    const encryptedSecret = await encryptSecret(smtpPassword)
    const now = new Date().toISOString()
    let savedSenderId = normalizeWhitespace(existingSender?.id)

    if (savedSenderId) {
      const { error: updateSenderError } = await supabase
        .from('mailbox_senders')
        .update({
          sender_email: senderEmail,
          sender_name: senderName,
          imap_inbox_folder: imapInboxFolder,
          imap_sent_folder: imapSentFolder,
          is_active: true,
          last_verified_at: now,
          updated_by_user_id: profile.id,
          updated_at: now
        })
        .eq('id', savedSenderId)

      if (updateSenderError) {
        throw new Error(updateSenderError.message || 'Unable to update the mailbox sender.')
      }
    } else {
      const { data: insertedSender, error: insertSenderError } = await supabase
        .from('mailbox_senders')
        .insert({
          kind,
          owner_user_id: kind === 'personal' ? profile.id : null,
          sender_email: senderEmail,
          sender_name: senderName,
          imap_inbox_folder: imapInboxFolder,
          imap_sent_folder: imapSentFolder,
          is_active: true,
          last_verified_at: now,
          created_by_user_id: profile.id,
          updated_by_user_id: profile.id,
          created_at: now,
          updated_at: now
        })
        .select('id')
        .single()

      if (insertSenderError) {
        throw new Error(insertSenderError.message || 'Unable to create the mailbox sender.')
      }

      savedSenderId = normalizeWhitespace(insertedSender?.id)
    }

    if (!savedSenderId) {
      throw new Error('The mailbox sender could not be resolved after saving.')
    }

    const { error: secretUpsertError } = await supabase
      .from('mailbox_sender_secrets')
      .upsert({
        sender_id: savedSenderId,
        smtp_username: smtpUsername,
        password_ciphertext: encryptedSecret.passwordCiphertext,
        password_iv: encryptedSecret.passwordIv,
        updated_at: now
      })

    if (secretUpsertError) {
      throw new Error(secretUpsertError.message || 'Unable to save the mailbox credentials.')
    }

    return jsonResponse({
      sender: {
        id: savedSenderId,
        kind,
        ownerUserId: kind === 'personal' ? profile.id : null,
        senderEmail,
        senderName,
        isActive: true,
        lastVerifiedAt: now
      }
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || 'Unable to save the mailbox.')
    const loweredMessage = message.toLowerCase()
    const status = loweredMessage.includes('authorization')
      || loweredMessage.includes('signed in')
      || loweredMessage.includes('only admin')
      ? 403
      : 400

    return jsonResponse({ error: message }, status)
  }
})
