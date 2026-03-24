import PostalMime from 'npm:postal-mime@2.5.0'

import {
  buildEmailSnippet,
  dedupeStrings,
  extractMessageIdTokens,
  getSupabaseAdminClient,
  handleOptionsRequest,
  jsonResponse,
  loadMailboxSenderByIdWithSecret,
  normalizeEmailAddress,
  normalizeWhitespace,
  requireAuthenticatedProfile
} from '../_shared/crm-email.ts'

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>

type SyncedMailboxMessage = {
  uid: number
  folder: string
  actualFolder: string
  direction: 'incoming' | 'outgoing'
  status: string
  subject: string
  snippet: string
  bodyText: string
  bodyHtml: string
  fromEmail: string
  fromName: string
  toEmails: string[]
  participants: Array<{ email: string; name: string; role: 'from' | 'to' }>
  messageIdHeader: string
  inReplyTo: string
  referencesHeader: string
  receivedAt: string
  isRead: boolean
  isStarred: boolean
}

type SyncedFolderResult = {
  folder: string
  actualFolder: string
  lastUid: number
  syncedCount: number
  error: string
  messages: SyncedMailboxMessage[]
}

type ImapConfig = {
  host: string
  port: number
  secure: boolean
  maxMessages: number
}

type ImapCommandResult = {
  lines: string[]
  literals: Uint8Array[]
}

type ImapFetchedMessage = {
  uid: number
  flags: string[]
  internalDate: string
  rawBytes: Uint8Array
}

type ParsedAddress = {
  email: string
  name: string
}

const DEFAULT_EMAIL_SYNC_MAX_MESSAGES = 200
const MAX_EMAIL_SYNC_OVERLAP = 200

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
    const mailboxId = normalizeWhitespace(payload.mailboxId)
    const folders = normalizeRequestedFolders(payload.folders)

    if (!mailboxId) {
      throw new Error('Choose a mailbox before syncing email.')
    }

    const mailbox = await loadMailboxSenderByIdWithSecret(supabase, profile, mailboxId)
    await pruneOrphanedEmailThreads(supabase, mailbox.id)
    let syncStateByFolder = await getMailboxSyncStateByFolder(supabase, mailbox.id, folders)
    if (payload.forceFullResync === true) {
      syncStateByFolder = new Map(folders.map((f) => [f.toUpperCase(), 0]))
    }
    const backendResult = await syncMailboxViaImap({
      mailbox,
      folders,
      syncStateByFolder
    })

    const now = new Date().toISOString()
    const allMessages = backendResult.folders.flatMap((folderResult) => folderResult.messages || [])
    const providerIds = dedupeStrings(allMessages.map((message) => `imap:${normalizeWhitespace(message.folder).toUpperCase()}:${Number(message.uid) || 0}`))
    const existingProviderIds = await fetchExistingProviderIds(supabase, mailbox.id, providerIds)
    const existingThreadIdsByMessageId = await fetchExistingThreadIdsByMessageIds(supabase, mailbox.id, dedupeStrings(
      allMessages.flatMap((message) => [
        normalizeWhitespace(message.messageIdHeader),
        ...extractMessageIdTokens(message.inReplyTo),
        ...extractMessageIdTokens(message.referencesHeader)
      ]).filter(Boolean)
    ))
    const leadIdsByEmail = await fetchLeadIdsByEmail(supabase, mailbox.senderEmail, allMessages)
    const threadAssignments = new Map<string, string>()
    const newThreadShells: Array<Record<string, unknown>> = []
    const preparedRows: Array<Record<string, unknown>> = []
    const affectedThreadIds = new Set<string>()

    const sortedMessages = [...allMessages].sort((left, right) =>
      Date.parse(String(left.receivedAt || '')) - Date.parse(String(right.receivedAt || ''))
    )

    sortedMessages.forEach((message) => {
      const messageIdHeader = normalizeWhitespace(message.messageIdHeader)
      const referenceIds = dedupeStrings([
        ...extractMessageIdTokens(message.inReplyTo),
        ...extractMessageIdTokens(message.referencesHeader)
      ])
      const threadId = resolveThreadId({
        messageIdHeader,
        referenceIds,
        existingThreadIdsByMessageId,
        threadAssignments
      })
      const providerMessageId = `imap:${normalizeWhitespace(message.folder).toUpperCase()}:${Number(message.uid) || 0}`
      const leadId = resolveLinkedLeadId(message, mailbox.senderEmail, leadIdsByEmail)
      const shouldSkipInsertBecauseMessageAlreadyExists = Boolean(
        messageIdHeader
          && existingThreadIdsByMessageId.has(messageIdHeader)
          && !existingProviderIds.has(providerMessageId)
      )

      if (shouldSkipInsertBecauseMessageAlreadyExists) {
        if (messageIdHeader) {
          threadAssignments.set(messageIdHeader, threadId)
        }

        return
      }

      affectedThreadIds.add(threadId)

      if (!newThreadShells.some((thread) => thread.id === threadId) && ![...existingThreadIdsByMessageId.values()].includes(threadId)) {
        newThreadShells.push({
          id: threadId,
          mailbox_sender_id: mailbox.id,
          lead_id: leadId ? Number(leadId) : null,
          subject: normalizeWhitespace(message.subject) || 'No subject',
          snippet: buildEmailSnippet(message.snippet || message.bodyText),
          participants: message.participants,
          folder_presence: [normalizeWhitespace(message.folder).toUpperCase() || 'INBOX'],
          latest_message_at: message.receivedAt || now,
          unread_count: message.direction === 'incoming' && !message.isRead ? 1 : 0,
          is_starred: message.isStarred === true,
          last_message_direction: message.direction,
          last_message_status: normalizeWhitespace(message.status) || 'sent'
        })
      }

      if (messageIdHeader) {
        threadAssignments.set(messageIdHeader, threadId)
      }

      preparedRows.push({
        thread_id: threadId,
        lead_id: leadId ? Number(leadId) : null,
        sender_mailbox_id: mailbox.id,
        sender_kind: mailbox.kind,
        created_by_user_id: mailbox.ownerUserId || null,
        from_email: normalizeEmailAddress(message.fromEmail),
        from_name: normalizeWhitespace(message.fromName),
        to_email: message.toEmails[0] || '',
        to_emails: message.toEmails,
        subject: normalizeWhitespace(message.subject) || 'No subject',
        body_text: String(message.bodyText ?? ''),
        body_html: String(message.bodyHtml ?? ''),
        provider: 'imap',
        provider_message_id: providerMessageId,
        status: normalizeWhitespace(message.status) || 'sent',
        error_message: null,
        direction: message.direction === 'incoming' ? 'incoming' : 'outgoing',
        folder: normalizeWhitespace(message.folder).toUpperCase() || 'INBOX',
        is_read: message.isRead !== false,
        is_starred: message.isStarred === true,
        received_at: message.receivedAt || now,
        message_id_header: messageIdHeader || null,
        in_reply_to: normalizeWhitespace(message.inReplyTo) || null,
        references_header: normalizeWhitespace(message.referencesHeader) || null,
        snippet: buildEmailSnippet(message.snippet || message.bodyText),
        participants: message.participants,
        source: 'imap',
        sent_at: message.direction === 'outgoing' ? (message.receivedAt || now) : null
      })
    })

    if (newThreadShells.length) {
      const { error } = await supabase
        .from('email_threads')
        .upsert(newThreadShells, {
          onConflict: 'id'
        })

      if (error) {
        throw new Error(error.message || 'Unable to create email conversations for the synced mailbox.')
      }
    }

    if (preparedRows.length) {
      await persistSyncedEmailMessages(supabase, preparedRows, existingProviderIds)

      for (const threadId of affectedThreadIds) {
        await refreshEmailThreadSummary(supabase, threadId)
      }
    }

    const syncStateRows = await upsertMailboxSyncState(supabase, mailbox.id, backendResult.folders, now)
    const createdCount = preparedRows.filter((row) => !existingProviderIds.has(String(row.provider_message_id))).length
    const updatedCount = preparedRows.length - createdCount

    return jsonResponse({
      mailboxId: mailbox.id,
      folders,
      syncedCount: preparedRows.length,
      createdCount,
      updatedCount,
      syncState: syncStateRows
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || 'Unable to sync the mailbox.')
    const loweredMessage = message.toLowerCase()
    const status = loweredMessage.includes('signed in')
      || loweredMessage.includes('authorization')
      || loweredMessage.includes('your own connected mailbox')
      || loweredMessage.includes('support mailbox')
      ? 403
      : 400

    return jsonResponse({ error: message }, status)
  }
})

function normalizeRequestedFolders(value: unknown) {
  const folders = Array.isArray(value) ? value : [value]
  const normalized = dedupeStrings(
    folders.map((folder) => normalizeWhitespace(folder).toUpperCase()).filter(Boolean)
  )

  return normalized.length ? normalized : ['INBOX', 'SENT']
}

async function getMailboxSyncStateByFolder(
  supabase: SupabaseAdminClient,
  mailboxId: string,
  folders: string[]
) {
  const { data, error } = await supabase
    .from('mailbox_sync_state')
    .select('folder, last_uid')
    .eq('mailbox_sender_id', mailboxId)
    .in('folder', folders)

  if (error) {
    throw new Error(error.message || 'Unable to load mailbox sync state.')
  }

  const map = new Map<string, number>()

  ;(data ?? []).forEach((row) => {
    map.set(normalizeWhitespace(row.folder).toUpperCase(), Number(row.last_uid) || 0)
  })

  return map
}

async function syncMailboxViaImap({
  mailbox,
  folders,
  syncStateByFolder
}: {
  mailbox: Awaited<ReturnType<typeof loadMailboxSenderByIdWithSecret>>
  folders: string[]
  syncStateByFolder: Map<string, number>
}) {
  const config = getImapConfig()
  const client = await SimpleImapClient.connect(config)

  try {
    await client.login(mailbox.smtpUsername, mailbox.smtpPassword)

    const folderResults: SyncedFolderResult[] = []

    for (const folder of folders) {
      const actualFolder = folder === 'SENT'
        ? (normalizeWhitespace(mailbox.imapSentFolder) || 'Sent')
        : (normalizeWhitespace(mailbox.imapInboxFolder) || 'INBOX')

      folderResults.push(await syncMailboxFolder({
        client,
        logicalFolder: folder,
        actualFolder,
        lastUid: syncStateByFolder.get(folder) || 0,
        maxMessages: config.maxMessages
      }))
    }

    return {
      folders: folderResults
    }
  } finally {
    await client.close()
  }
}

function getImapConfig(): ImapConfig {
  const host = normalizeWhitespace(Deno.env.get('IMAP_HOST') || Deno.env.get('SMTP_HOST'))
  const port = Number(Deno.env.get('IMAP_PORT') || 993)
  const secure = String(Deno.env.get('IMAP_SECURE') || 'true').toLowerCase() !== 'false'
  const maxMessages = Math.min(
    500,
    Math.max(20, Number(Deno.env.get('CRM_EMAIL_SYNC_MAX_MESSAGES') || DEFAULT_EMAIL_SYNC_MAX_MESSAGES) || DEFAULT_EMAIL_SYNC_MAX_MESSAGES)
  )

  if (!host) {
    throw new Error('Set IMAP_HOST or SMTP_HOST before syncing mailbox email.')
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('IMAP_PORT must be a valid positive number.')
  }

  return {
    host,
    port,
    secure,
    maxMessages
  }
}

async function syncMailboxFolder({
  client,
  logicalFolder,
  actualFolder,
  lastUid,
  maxMessages
}: {
  client: SimpleImapClient
  logicalFolder: string
  actualFolder: string
  lastUid: number
  maxMessages: number
}): Promise<SyncedFolderResult> {
  const normalizedFolder = normalizeWhitespace(logicalFolder).toUpperCase() || 'INBOX'
  const resolvedActualFolder = normalizeWhitespace(actualFolder) || (normalizedFolder === 'SENT' ? 'Sent' : 'INBOX')

  try {
    await client.select(resolvedActualFolder)

    const allUids = await client.searchAllUids()
    const newestUid = allUids.length ? allUids[allUids.length - 1] : Math.max(0, Number(lastUid) || 0)
    const overlapFloorUid = Math.max(0, (Number(lastUid) || 0) - MAX_EMAIL_SYNC_OVERLAP)
    let targetUids = allUids.filter((uid) => uid > overlapFloorUid)

    if (targetUids.length > maxMessages) {
      targetUids = targetUids.slice(-maxMessages)
    }

    const messages: SyncedMailboxMessage[] = []

    for (const uid of targetUids) {
      const fetchedMessage = await client.fetchMessage(uid)

      if (!fetchedMessage) {
        continue
      }

      const mappedMessage = await mapFetchedImapMessage({
        folder: normalizedFolder,
        actualFolder: resolvedActualFolder,
        fetchedMessage
      })

      if (mappedMessage) {
        messages.push(mappedMessage)
      }
    }

    return {
      folder: normalizedFolder,
      actualFolder: resolvedActualFolder,
      lastUid: newestUid,
      syncedCount: messages.length,
      error: '',
      messages
    }
  } catch (error) {
    return {
      folder: normalizedFolder,
      actualFolder: resolvedActualFolder,
      lastUid: Math.max(0, Number(lastUid) || 0),
      syncedCount: 0,
      error: String(error instanceof Error ? error.message : error || `Unable to sync the ${normalizedFolder} folder.`),
      messages: []
    }
  }
}

async function mapFetchedImapMessage({
  folder,
  actualFolder,
  fetchedMessage
}: {
  folder: string
  actualFolder: string
  fetchedMessage: ImapFetchedMessage
}): Promise<SyncedMailboxMessage | null> {
  if (!fetchedMessage.rawBytes?.length || fetchedMessage.uid <= 0) {
    return null
  }

  const parser = new PostalMime()
  const parsedEmail = await parser.parse(new Uint8Array(fetchedMessage.rawBytes))
  const direction = folder === 'SENT' ? 'outgoing' : 'incoming'
  const fromAddress = firstPostalAddress(parsedEmail?.from, parsedEmail?.sender)
  const toAddresses = dedupePostalAddresses([
    ...flattenPostalAddresses(parsedEmail?.to),
    ...flattenPostalAddresses(parsedEmail?.cc)
  ])
  const participants = buildParticipants(fromAddress, toAddresses)
  const referencesHeader = Array.isArray(parsedEmail?.references)
    ? dedupeStrings(parsedEmail.references.map((value) => normalizeWhitespace(value)).filter(Boolean)).join(' ')
    : normalizeWhitespace(parsedEmail?.references)
  const bodyText = String(parsedEmail?.text ?? '')
  const bodyHtml = String(parsedEmail?.html ?? '')

  return {
    uid: fetchedMessage.uid,
    folder,
    actualFolder,
    direction,
    status: 'sent',
    subject: normalizeWhitespace(parsedEmail?.subject) || 'No subject',
    snippet: buildEmailSnippet(bodyText || bodyHtml),
    bodyText,
    bodyHtml,
    fromEmail: fromAddress.email,
    fromName: fromAddress.name,
    toEmails: toAddresses.map((address) => address.email),
    participants,
    messageIdHeader: normalizeWhitespace(parsedEmail?.messageId),
    inReplyTo: normalizeWhitespace(parsedEmail?.inReplyTo),
    referencesHeader,
    receivedAt: normalizeEmailTimestamp(parsedEmail?.date, fetchedMessage.internalDate),
    isRead: fetchedMessage.flags.includes('\\Seen'),
    isStarred: fetchedMessage.flags.includes('\\Flagged')
  }
}

function normalizeEmailTimestamp(...values: unknown[]) {
  for (const value of values) {
    const rawValue = normalizeWhitespace(value)

    if (!rawValue) {
      continue
    }

    const timestamp = Date.parse(rawValue)

    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp).toISOString()
    }
  }

  return new Date().toISOString()
}

function normalizePostalAddress(value: unknown): ParsedAddress {
  if (typeof value === 'string') {
    return {
      email: normalizeEmailAddress(value),
      name: ''
    }
  }

  const row = typeof value === 'object' && value ? value as Record<string, unknown> : {}

  return {
    email: normalizeEmailAddress(row.address || row.email),
    name: normalizeWhitespace(row.name || row.displayName)
  }
}

function firstPostalAddress(...values: unknown[]) {
  for (const value of values) {
    const address = normalizePostalAddress(value)

    if (address.email) {
      return address
    }
  }

  return {
    email: '',
    name: ''
  }
}

function flattenPostalAddresses(value: unknown): ParsedAddress[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenPostalAddresses(entry))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const row = value as Record<string, unknown>

  if (Array.isArray(row.group)) {
    return row.group.flatMap((entry) => flattenPostalAddresses(entry))
  }

  const normalized = normalizePostalAddress(row)
  return normalized.email ? [normalized] : []
}

function dedupePostalAddresses(addresses: ParsedAddress[]) {
  const seen = new Set<string>()
  const result: ParsedAddress[] = []

  for (const address of addresses) {
    const email = normalizeEmailAddress(address.email)

    if (!email || seen.has(email)) {
      continue
    }

    seen.add(email)
    result.push({
      email,
      name: normalizeWhitespace(address.name)
    })
  }

  return result
}

function buildParticipants(fromAddress: ParsedAddress, toAddresses: ParsedAddress[]) {
  const participants: Array<{ email: string; name: string; role: 'from' | 'to' }> = []

  if (fromAddress.email) {
    participants.push({
      email: fromAddress.email,
      name: fromAddress.name,
      role: 'from'
    })
  }

  toAddresses.forEach((address) => {
    participants.push({
      email: address.email,
      name: address.name,
      role: 'to'
    })
  })

  return participants
}

function findCrlfIndex(buffer: Uint8Array) {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index
    }
  }

  return -1
}

function concatUint8Arrays(...chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0

  chunks.forEach((chunk) => {
    merged.set(chunk, offset)
    offset += chunk.length
  })

  return merged
}

function escapeImapString(value: string) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function quoteImapString(value: string) {
  return `"${escapeImapString(value)}"`
}

function quoteImapMailbox(value: string) {
  const normalized = normalizeWhitespace(value)

  if (!normalized) {
    return 'INBOX'
  }

  if (normalized.toUpperCase() === 'INBOX') {
    return 'INBOX'
  }

  return quoteImapString(normalized)
}

function parseImapLiteralLength(line: string) {
  const match = line.match(/\{(\d+)\}$/)
  return match ? Number(match[1]) || 0 : 0
}

function parseSearchUids(lines: string[]) {
  const uids = new Set<number>()

  lines.forEach((line) => {
    const trimmedLine = normalizeWhitespace(line)

    if (!trimmedLine.startsWith('* SEARCH')) {
      return
    }

    trimmedLine
      .replace(/^\* SEARCH\s*/i, '')
      .split(/\s+/)
      .forEach((token) => {
        const uid = Number(token)

        if (Number.isFinite(uid) && uid > 0) {
          uids.add(uid)
        }
      })
  })

  return [...uids].sort((left, right) => left - right)
}

function parseFetchMetadata(lines: string[]) {
  const fetchLine = lines.find((line) => /\bFETCH\b/i.test(line)) || ''
  const uidMatch = fetchLine.match(/\bUID\s+(\d+)\b/i)
  const internalDateMatch = fetchLine.match(/\bINTERNALDATE\s+"([^"]+)"/i)
  const flagsMatch = fetchLine.match(/\bFLAGS\s+\(([^)]*)\)/i)

  return {
    uid: Number(uidMatch?.[1]) || 0,
    internalDate: normalizeWhitespace(internalDateMatch?.[1]),
    flags: dedupeStrings((flagsMatch?.[1] || '').split(/\s+/).filter(Boolean))
  }
}

class SimpleImapClient {
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private buffer = new Uint8Array(0)
  private tagCounter = 0

  private constructor(private readonly connection: Deno.Conn) {}

  static async connect(config: ImapConfig) {
    const connection = config.secure
      ? await Deno.connectTls({
        hostname: config.host,
        port: config.port
      })
      : await Deno.connect({
        hostname: config.host,
        port: config.port
      })

    const client = new SimpleImapClient(connection)
    const greeting = await client.readLine()

    if (!greeting || !greeting.startsWith('*')) {
      connection.close()
      throw new Error('Unable to open the IMAP mailbox connection.')
    }

    return client
  }

  async login(username: string, password: string) {
    await this.runCommand(`LOGIN ${quoteImapString(username)} ${quoteImapString(password)}`)
  }

  async select(mailboxName: string) {
    await this.runCommand(`SELECT ${quoteImapMailbox(mailboxName)}`)
  }

  async searchAllUids() {
    const result = await this.runCommand('UID SEARCH ALL')
    return parseSearchUids(result.lines)
  }

  async fetchMessage(uid: number): Promise<ImapFetchedMessage | null> {
    const result = await this.runCommand(`UID FETCH ${Math.max(1, Number(uid) || 0)} (UID FLAGS INTERNALDATE BODY.PEEK[])`)
    const literal = result.literals[0]
    const metadata = parseFetchMetadata(result.lines)

    if (!literal?.length) {
      return null
    }

    return {
      uid: metadata.uid || Math.max(1, Number(uid) || 0),
      flags: metadata.flags,
      internalDate: metadata.internalDate,
      rawBytes: literal
    }
  }

  async close() {
    try {
      await this.runCommand('LOGOUT')
    } catch (_error) {
      // Ignore logout failures while closing the socket.
    }

    try {
      this.connection.close()
    } catch (_error) {
      // Ignore duplicate close calls.
    }
  }

  private async runCommand(command: string): Promise<ImapCommandResult> {
    const tag = `A${String(this.tagCounter + 1).padStart(4, '0')}`
    this.tagCounter += 1
    await this.write(`${tag} ${command}\r\n`)

    const lines: string[] = []
    const literals: Uint8Array[] = []

    while (true) {
      const line = await this.readLine()

      if (line === null) {
        throw new Error(`IMAP connection closed while running: ${command}`)
      }

      if (line.startsWith(`${tag} `)) {
        const status = normalizeWhitespace(line.slice(tag.length)).split(/\s+/)[0]?.toUpperCase() || ''

        if (status !== 'OK') {
          throw new Error(normalizeWhitespace(line.replace(`${tag} `, '')) || `IMAP command failed: ${command}`)
        }

        return { lines, literals }
      }

      lines.push(line)

      const literalLength = parseImapLiteralLength(line)
      if (literalLength > 0) {
        literals.push(await this.readBytes(literalLength))
      }
    }
  }

  private async write(value: string) {
    await this.connection.write(this.encoder.encode(value))
  }

  private async readLine(): Promise<string | null> {
    while (true) {
      const lineEndingIndex = findCrlfIndex(this.buffer)

      if (lineEndingIndex >= 0) {
        const lineBytes = this.buffer.slice(0, lineEndingIndex)
        this.buffer = this.buffer.slice(lineEndingIndex + 2)
        return this.decoder.decode(lineBytes)
      }

      const chunk = new Uint8Array(8192)
      const bytesRead = await this.connection.read(chunk)

      if (bytesRead === null) {
        if (!this.buffer.length) {
          return null
        }

        const finalLine = this.decoder.decode(this.buffer)
        this.buffer = new Uint8Array(0)
        return finalLine
      }

      this.buffer = concatUint8Arrays(this.buffer, chunk.slice(0, bytesRead))
    }
  }

  private async readBytes(length: number) {
    const targetLength = Math.max(0, Number(length) || 0)
    const result = new Uint8Array(targetLength)
    let offset = 0

    if (this.buffer.length) {
      const bufferedBytes = Math.min(targetLength, this.buffer.length)
      result.set(this.buffer.slice(0, bufferedBytes), offset)
      this.buffer = this.buffer.slice(bufferedBytes)
      offset += bufferedBytes
    }

    while (offset < targetLength) {
      const chunk = new Uint8Array(Math.min(8192, targetLength - offset))
      const bytesRead = await this.connection.read(chunk)

      if (bytesRead === null) {
        throw new Error('IMAP connection closed while reading mailbox content.')
      }

      result.set(chunk.slice(0, bytesRead), offset)
      offset += bytesRead
    }

    return result
  }
}

async function fetchExistingProviderIds(
  supabase: SupabaseAdminClient,
  mailboxId: string,
  providerIds: string[]
) {
  const set = new Set<string>()

  for (let index = 0; index < providerIds.length; index += 200) {
    const batch = providerIds.slice(index, index + 200)
    const { data, error } = await supabase
      .from('email_messages')
      .select('provider_message_id')
      .eq('sender_mailbox_id', mailboxId)
      .eq('provider', 'imap')
      .in('provider_message_id', batch)

    if (error) {
      throw new Error(error.message || 'Unable to load existing synced email messages.')
    }

    ;(data ?? []).forEach((row) => {
      const providerMessageId = normalizeWhitespace(row.provider_message_id)
      if (providerMessageId) {
        set.add(providerMessageId)
      }
    })
  }

  return set
}

async function persistSyncedEmailMessages(
  supabase: SupabaseAdminClient,
  rows: Array<Record<string, unknown>>,
  existingProviderIds: Set<string>
) {
  const insertRows = rows.filter((row) => !existingProviderIds.has(String(row.provider_message_id)))
  const updateRows = rows.filter((row) => existingProviderIds.has(String(row.provider_message_id)))

  if (insertRows.length) {
    const { error } = await supabase
      .from('email_messages')
      .insert(insertRows)

    if (error) {
      throw new Error(error.message || 'Unable to store synced email messages in Supabase.')
    }
  }

  for (const row of updateRows) {
    const { error } = await supabase
      .from('email_messages')
      .update({
        thread_id: row.thread_id,
        lead_id: row.lead_id,
        from_email: row.from_email,
        from_name: row.from_name,
        to_email: row.to_email,
        to_emails: row.to_emails,
        subject: row.subject,
        body_text: row.body_text,
        body_html: row.body_html,
        status: row.status,
        error_message: row.error_message,
        direction: row.direction,
        folder: row.folder,
        is_read: row.is_read,
        is_starred: row.is_starred,
        received_at: row.received_at,
        message_id_header: row.message_id_header,
        in_reply_to: row.in_reply_to,
        references_header: row.references_header,
        snippet: row.snippet,
        participants: row.participants,
        source: row.source,
        sent_at: row.sent_at
      })
      .eq('sender_mailbox_id', String(row.sender_mailbox_id))
      .eq('provider', String(row.provider))
      .eq('provider_message_id', String(row.provider_message_id))

    if (error) {
      throw new Error(error.message || 'Unable to update synced email messages in Supabase.')
    }
  }
}

async function pruneOrphanedEmailThreads(
  supabase: SupabaseAdminClient,
  mailboxId: string
) {
  const [{ data: threadRows, error: threadError }, { data: messageRows, error: messageError }] = await Promise.all([
    supabase
      .from('email_threads')
      .select('id')
      .eq('mailbox_sender_id', mailboxId),
    supabase
      .from('email_messages')
      .select('thread_id')
      .eq('sender_mailbox_id', mailboxId)
      .not('thread_id', 'is', null)
  ])

  if (threadError) {
    throw new Error(threadError.message || 'Unable to load the current email conversations.')
  }

  if (messageError) {
    throw new Error(messageError.message || 'Unable to load the existing email messages.')
  }

  const activeThreadIds = new Set(
    (messageRows ?? [])
      .map((row) => normalizeWhitespace(row.thread_id))
      .filter(Boolean)
  )
  const orphanThreadIds = (threadRows ?? [])
    .map((row) => normalizeWhitespace(row.id))
    .filter((threadId) => threadId && !activeThreadIds.has(threadId))

  for (let index = 0; index < orphanThreadIds.length; index += 100) {
    const batch = orphanThreadIds.slice(index, index + 100)
    const { error } = await supabase
      .from('email_threads')
      .delete()
      .in('id', batch)
      .eq('mailbox_sender_id', mailboxId)

    if (error) {
      throw new Error(error.message || 'Unable to clean up duplicate email conversations.')
    }
  }
}

async function fetchExistingThreadIdsByMessageIds(
  supabase: SupabaseAdminClient,
  mailboxId: string,
  messageIds: string[]
) {
  const map = new Map<string, string>()

  for (let index = 0; index < messageIds.length; index += 200) {
    const batch = messageIds.slice(index, index + 200)

    if (!batch.length) {
      continue
    }

    const { data, error } = await supabase
      .from('email_messages')
      .select('message_id_header, thread_id')
      .eq('sender_mailbox_id', mailboxId)
      .in('message_id_header', batch)

    if (error) {
      throw new Error(error.message || 'Unable to load the existing email thread references.')
    }

    ;(data ?? []).forEach((row) => {
      const messageId = normalizeWhitespace(row.message_id_header)
      const threadId = normalizeWhitespace(row.thread_id)

      if (messageId && threadId) {
        map.set(messageId, threadId)
      }
    })
  }

  return map
}

async function fetchLeadIdsByEmail(
  supabase: SupabaseAdminClient,
  mailboxEmail: string,
  messages: SyncedMailboxMessage[]
) {
  const candidateEmails = dedupeStrings(
    messages.flatMap((message) =>
      (Array.isArray(message.participants) ? message.participants : [])
        .map((participant) => normalizeEmailAddress(participant.email))
        .filter((email) => email && email !== normalizeEmailAddress(mailboxEmail))
    )
  )
  const map = new Map<string, Set<string>>()

  for (let index = 0; index < candidateEmails.length; index += 200) {
    const batch = candidateEmails.slice(index, index + 200)
    const { data, error } = await supabase
      .from('leads')
      .select('id, email')
      .in('email', batch)

    if (error) {
      throw new Error(error.message || 'Unable to match synced email participants to leads.')
    }

    ;(data ?? []).forEach((row) => {
      const email = normalizeEmailAddress(row.email)
      const leadId = normalizeWhitespace(row.id)

      if (!email || !leadId) {
        return
      }

      const current = map.get(email) || new Set<string>()
      current.add(leadId)
      map.set(email, current)
    })
  }

  return map
}

function resolveThreadId({
  messageIdHeader,
  referenceIds,
  existingThreadIdsByMessageId,
  threadAssignments
}: {
  messageIdHeader: string
  referenceIds: string[]
  existingThreadIdsByMessageId: Map<string, string>
  threadAssignments: Map<string, string>
}) {
  const existingMessageThreadId = messageIdHeader
    ? (existingThreadIdsByMessageId.get(messageIdHeader) || threadAssignments.get(messageIdHeader))
    : ''

  if (existingMessageThreadId) {
    return existingMessageThreadId
  }

  for (const referenceId of referenceIds) {
    const matchedThreadId = existingThreadIdsByMessageId.get(referenceId) || threadAssignments.get(referenceId)

    if (matchedThreadId) {
      return matchedThreadId
    }
  }

  return crypto.randomUUID()
}

function resolveLinkedLeadId(
  message: SyncedMailboxMessage,
  mailboxEmail: string,
  leadIdsByEmail: Map<string, Set<string>>
) {
  const candidateLeadIds = new Set<string>()

  ;(Array.isArray(message.participants) ? message.participants : []).forEach((participant) => {
    const email = normalizeEmailAddress(participant.email)

    if (!email || email === normalizeEmailAddress(mailboxEmail)) {
      return
    }

    ;(leadIdsByEmail.get(email) || new Set<string>()).forEach((leadId) => {
      candidateLeadIds.add(leadId)
    })
  })

  return candidateLeadIds.size === 1 ? [...candidateLeadIds][0] : ''
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
    throw new Error(error.message || 'Unable to refresh the synced email thread summary.')
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
  const folders = new Set<string>()
  const leadIds = new Set<string>()
  let unreadCount = 0
  let isStarred = false

  normalizedMessages.forEach((message) => {
    ;(Array.isArray(message.participants) ? message.participants : []).forEach((participant) => {
      const email = normalizeEmailAddress(participant?.email)

      if (!email) {
        return
      }

      const role = normalizeWhitespace(participant?.role) === 'from' ? 'from' : 'to'
      participantMap.set(`${role}:${email}`, {
        email,
        name: normalizeWhitespace(participant?.name),
        role
      })
    })

    const folder = normalizeWhitespace(message.folder).toUpperCase()
    if (folder) {
      folders.add(folder)
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
      folder_presence: [...folders],
      latest_message_id: latestMessage.id,
      latest_message_at: latestMessage.messageAt,
      unread_count: unreadCount,
      is_starred: isStarred,
      last_message_direction: normalizeWhitespace(latestMessage.direction) || 'incoming',
      last_message_status: normalizeWhitespace(latestMessage.status) || 'sent'
    })
    .eq('id', threadId)

  if (updateError) {
    throw new Error(updateError.message || 'Unable to update the synced email thread summary.')
  }
}

async function upsertMailboxSyncState(
  supabase: SupabaseAdminClient,
  mailboxId: string,
  folderResults: Array<{ folder: string; lastUid: number; syncedCount: number; error: string }>,
  syncedAt: string
) {
  if (!folderResults.length) {
    return []
  }

  const rows = folderResults.map((folderResult) => ({
    mailbox_sender_id: mailboxId,
    folder: folderResult.folder,
    last_synced_at: syncedAt,
    last_uid: folderResult.lastUid || 0,
    last_error: folderResult.error || null,
    sync_status: folderResult.error ? 'error' : 'ready',
    synced_message_count: Math.max(0, Number(folderResult.syncedCount) || 0)
  }))

  const { data, error } = await supabase
    .from('mailbox_sync_state')
    .upsert(rows, {
      onConflict: 'mailbox_sender_id,folder'
    })
    .select('mailbox_sender_id, folder, last_synced_at, last_uid, last_error, sync_status, synced_message_count, created_at, updated_at')

  if (error) {
    throw new Error(error.message || 'Unable to save mailbox sync state.')
  }

  return data ?? []
}
