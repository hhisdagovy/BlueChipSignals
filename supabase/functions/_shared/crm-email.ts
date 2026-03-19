import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import nodemailer from 'npm:nodemailer@6.9.16'

export type CrmProfile = {
  id: string
  email: string
  fullName: string
  role: 'admin' | 'sales' | 'senior' | 'support'
  active: boolean
}

export type MailboxSenderWithSecret = {
  id: string
  kind: 'personal' | 'support'
  ownerUserId: string | null
  senderEmail: string
  senderName: string
  imapInboxFolder: string
  imapSentFolder: string
  smtpUsername: string
  smtpPassword: string
}

export type EmailParticipant = {
  email: string
  name: string
  role: 'from' | 'to'
}

type SupabaseClientType = ReturnType<typeof createClient>

type LeadAccessRow = {
  id: string | number
  assigned_rep_id?: string | null
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  lifecycle?: string | null
}

type MailboxSenderRow = {
  id: string
  kind: string
  owner_user_id?: string | null
  sender_email?: string | null
  sender_name?: string | null
  imap_inbox_folder?: string | null
  imap_sent_folder?: string | null
  is_active?: boolean | null
}

type MailboxSecretRow = {
  smtp_username?: string | null
  password_ciphertext: string
  password_iv: string
}

export function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  })
}

export function handleOptionsRequest(request: Request) {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true })
  }

  return null
}

export function normalizeWhitespace(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizeEmailAddress(value: unknown) {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return ''
  }

  return normalized
}

export function dedupeStrings(values: unknown[]) {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeWhitespace(value)

    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

export function normalizeRole(value: unknown): CrmProfile['role'] {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (normalized === 'admin') {
    return 'admin'
  }

  if (normalized === 'support') {
    return 'support'
  }

  if (normalized === 'senior' || normalized === 'senior_rep') {
    return 'senior'
  }

  return 'sales'
}

export function requireEnv(name: string) {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function getSupabaseAdminClient() {
  const url = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  })
}

export async function requireAuthenticatedProfile(request: Request, supabase = getSupabaseAdminClient()) {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.replace(/^Bearer\s+/i, '').trim()

  if (!token) {
    throw new Error('Missing authorization token.')
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token)

  if (userError) {
    throw new Error(userError.message || 'Unable to verify the signed-in CRM user.')
  }

  const userId = normalizeWhitespace(userData.user?.id)

  if (!userId) {
    throw new Error('You must be signed in to continue.')
  }

  const { data: profileRow, error: profileError } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, active')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    throw new Error(profileError.message || 'Unable to load the CRM profile.')
  }

  if (!profileRow) {
    throw new Error('No readable CRM profile was found for the signed-in user.')
  }

  const profile: CrmProfile = {
    id: normalizeWhitespace(profileRow.id),
    email: normalizeWhitespace(profileRow.email).toLowerCase(),
    fullName: normalizeWhitespace(profileRow.full_name || profileRow.email || 'CRM User'),
    role: normalizeRole(profileRow.role),
    active: profileRow.active === true
  }

  if (!profile.active) {
    throw new Error('Only active CRM users can use email actions.')
  }

  return { profile, token, supabase }
}

export async function fetchLeadForAccess(supabase: any, leadId: unknown) {
  const normalizedLeadId = normalizeWhitespace(leadId)

  if (!normalizedLeadId) {
    throw new Error('Choose a lead before sending email.')
  }

  const { data: leadRow, error } = await supabase
    .from('leads')
    .select('id, assigned_rep_id, email, first_name, last_name, full_name, lifecycle')
    .eq('id', normalizedLeadId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Unable to load the lead for email.')
  }

  const normalizedLeadRow = leadRow as LeadAccessRow | null

  if (!normalizedLeadRow) {
    throw new Error('That lead is no longer available.')
  }

  return {
    id: String(normalizedLeadRow.id),
    assignedRepId: normalizeWhitespace(normalizedLeadRow.assigned_rep_id),
    email: normalizeWhitespace(normalizedLeadRow.email).toLowerCase(),
    fullName: normalizeWhitespace(normalizedLeadRow.full_name || `${normalizedLeadRow.first_name || ''} ${normalizedLeadRow.last_name || ''}`) || 'Client',
    lifecycleType: normalizeWhitespace(normalizedLeadRow.lifecycle) || 'lead'
  }
}

export function assertLeadAccess(profile: CrmProfile, lead: { assignedRepId: string }) {
  if (profile.role === 'admin' || profile.role === 'support') {
    return
  }

  if (lead.assignedRepId !== profile.id) {
    throw new Error('You can only send email for leads assigned to your CRM session.')
  }
}

export function assertSenderModeAccess(profile: CrmProfile, senderMode: unknown) {
  const normalizedSenderMode = normalizeWhitespace(senderMode).toLowerCase() === 'support'
    ? 'support'
    : 'personal'

  if (normalizedSenderMode === 'support' && profile.role !== 'admin' && profile.role !== 'support') {
    throw new Error('Only support users and admins can send from the support mailbox.')
  }

  return normalizedSenderMode as 'personal' | 'support'
}

export async function decryptSecret(ciphertext: string, iv: string) {
  const key = await getEncryptionKey()
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64(iv)
    },
    key,
    decodeBase64(ciphertext)
  )

  return new TextDecoder().decode(decrypted)
}

export async function encryptSecret(rawSecret: string) {
  const key = await getEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    new TextEncoder().encode(rawSecret)
  )

  return {
    passwordCiphertext: encodeBase64(new Uint8Array(encrypted)),
    passwordIv: encodeBase64(iv)
  }
}

export async function loadMailboxSenderWithSecret(
  supabase: any,
  profile: CrmProfile,
  senderMode: 'personal' | 'support'
): Promise<MailboxSenderWithSecret> {
  let senderQuery = supabase
    .from('mailbox_senders')
    .select('id, kind, owner_user_id, sender_email, sender_name, imap_inbox_folder, imap_sent_folder, is_active')

  if (senderMode === 'support') {
    senderQuery = senderQuery.eq('kind', 'support').limit(1)
  } else {
    senderQuery = senderQuery.eq('kind', 'personal').eq('owner_user_id', profile.id).limit(1)
  }

  const { data: senderRow, error: senderError } = await senderQuery.maybeSingle()

  if (senderError) {
    throw new Error(senderError.message || 'Unable to load the mailbox sender.')
  }

  const normalizedSenderRow = senderRow as MailboxSenderRow | null

  if (!normalizedSenderRow || normalizedSenderRow.is_active === false) {
    throw new Error(senderMode === 'support'
      ? 'The support mailbox is not configured yet.'
      : 'Connect your mailbox in CRM settings before sending email.')
  }

  const { data: secretRow, error: secretError } = await supabase
    .from('mailbox_sender_secrets')
    .select('smtp_username, password_ciphertext, password_iv')
    .eq('sender_id', normalizedSenderRow.id)
    .maybeSingle()

  if (secretError) {
    throw new Error(secretError.message || 'Unable to load the mailbox credentials.')
  }

  const normalizedSecretRow = secretRow as MailboxSecretRow | null

  if (!normalizedSecretRow) {
    throw new Error(senderMode === 'support'
      ? 'The support mailbox credentials are missing.'
      : 'Your mailbox credentials are missing. Reconnect your mailbox in settings.')
  }

  return {
    id: normalizeWhitespace(normalizedSenderRow.id),
    kind: normalizedSenderRow.kind === 'support' ? 'support' : 'personal',
    ownerUserId: normalizeWhitespace(normalizedSenderRow.owner_user_id) || null,
    senderEmail: normalizeWhitespace(normalizedSenderRow.sender_email).toLowerCase(),
    senderName: normalizeWhitespace(normalizedSenderRow.sender_name) || profile.fullName,
    imapInboxFolder: normalizeWhitespace(normalizedSenderRow.imap_inbox_folder) || 'INBOX',
    imapSentFolder: normalizeWhitespace(normalizedSenderRow.imap_sent_folder) || 'Sent',
    smtpUsername: normalizeWhitespace(normalizedSecretRow.smtp_username),
    smtpPassword: await decryptSecret(normalizedSecretRow.password_ciphertext, normalizedSecretRow.password_iv)
  }
}

export function assertMailboxAccess(profile: CrmProfile, sender: {
  kind: string
  owner_user_id?: string | null
  ownerUserId?: string | null
  is_active?: boolean | null
  isActive?: boolean | null
}) {
  const senderKind = normalizeWhitespace(sender.kind).toLowerCase() === 'support' ? 'support' : 'personal'
  const ownerUserId = normalizeWhitespace(sender.owner_user_id ?? sender.ownerUserId)
  const isActive = sender.is_active !== false && sender.isActive !== false

  if (!isActive) {
    throw new Error(senderKind === 'support'
      ? 'The support mailbox is not configured yet.'
      : 'Connect your mailbox in CRM settings before using email.')
  }

  if (senderKind === 'support') {
    if (profile.role !== 'admin' && profile.role !== 'support') {
      throw new Error('Only support users and admins can access the support mailbox.')
    }

    return
  }

  if (ownerUserId !== profile.id) {
    throw new Error('You can only access your own connected mailbox.')
  }
}

export async function loadMailboxSenderByIdWithSecret(
  supabase: any,
  profile: CrmProfile,
  mailboxId: unknown
): Promise<MailboxSenderWithSecret> {
  const normalizedMailboxId = normalizeWhitespace(mailboxId)

  if (!normalizedMailboxId) {
    throw new Error('Choose a mailbox before continuing.')
  }

  const { data: senderRow, error: senderError } = await supabase
    .from('mailbox_senders')
    .select('id, kind, owner_user_id, sender_email, sender_name, imap_inbox_folder, imap_sent_folder, is_active')
    .eq('id', normalizedMailboxId)
    .maybeSingle()

  if (senderError) {
    throw new Error(senderError.message || 'Unable to load the mailbox sender.')
  }

  const normalizedSenderRow = senderRow as MailboxSenderRow | null

  if (!normalizedSenderRow) {
    throw new Error('That mailbox is no longer available.')
  }

  assertMailboxAccess(profile, normalizedSenderRow)

  const { data: secretRow, error: secretError } = await supabase
    .from('mailbox_sender_secrets')
    .select('smtp_username, password_ciphertext, password_iv')
    .eq('sender_id', normalizedMailboxId)
    .maybeSingle()

  if (secretError) {
    throw new Error(secretError.message || 'Unable to load the mailbox credentials.')
  }

  const normalizedSecretRow = secretRow as MailboxSecretRow | null

  if (!normalizedSecretRow) {
    throw new Error(normalizedSenderRow.kind === 'support'
      ? 'The support mailbox credentials are missing.'
      : 'Your mailbox credentials are missing. Reconnect your mailbox in settings.')
  }

  return {
    id: normalizeWhitespace(normalizedSenderRow.id),
    kind: normalizedSenderRow.kind === 'support' ? 'support' : 'personal',
    ownerUserId: normalizeWhitespace(normalizedSenderRow.owner_user_id) || null,
    senderEmail: normalizeWhitespace(normalizedSenderRow.sender_email).toLowerCase(),
    senderName: normalizeWhitespace(normalizedSenderRow.sender_name) || profile.fullName,
    imapInboxFolder: normalizeWhitespace(normalizedSenderRow.imap_inbox_folder) || 'INBOX',
    imapSentFolder: normalizeWhitespace(normalizedSenderRow.imap_sent_folder) || 'Sent',
    smtpUsername: normalizeWhitespace(normalizedSecretRow.smtp_username),
    smtpPassword: await decryptSecret(normalizedSecretRow.password_ciphertext, normalizedSecretRow.password_iv)
  }
}

export function buildTransport(mailbox: MailboxSenderWithSecret) {
  return nodemailer.createTransport({
    host: requireEnv('SMTP_HOST'),
    port: Number(Deno.env.get('SMTP_PORT') || 465),
    secure: String(Deno.env.get('SMTP_SECURE') || 'true').toLowerCase() !== 'false',
    auth: {
      user: mailbox.smtpUsername,
      pass: mailbox.smtpPassword
    }
  })
}

export async function verifyMailboxConnection(mailbox: MailboxSenderWithSecret) {
  const transport = buildTransport(mailbox)
  await transport.verify()
  await verifyImapConnection(mailbox)
}

export function buildEmailHtml({
  senderName,
  bodyText
}: {
  senderName: string
  bodyText: string
}) {
  const escapedBody = escapeHtml(bodyText).replace(/\n/g, '<br>')
  const signatureName = escapeHtml(senderName || 'Blue Chip Signals')

  return `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.65;">
      <div style="white-space: normal;">${escapedBody}</div>
      <div style="margin-top: 24px; color: #6b7280;">
        <div>Best regards,</div>
        <div style="font-weight: 700; color: #111827;">${signatureName}</div>
      </div>
    </div>
  `.trim()
}

export function parseRecipientEmails(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,\n;]/)

  return dedupeStrings(values.map((entry) => normalizeEmailAddress(entry)).filter(Boolean))
}

export function buildEmailParticipants({
  fromEmail,
  fromName = '',
  toEmails = []
}: {
  fromEmail: string
  fromName?: string
  toEmails?: string[]
}): EmailParticipant[] {
  const senderEmail = normalizeEmailAddress(fromEmail)
  const normalizedToEmails = parseRecipientEmails(toEmails)
  const participants: EmailParticipant[] = []

  if (senderEmail) {
    participants.push({
      email: senderEmail,
      name: normalizeWhitespace(fromName),
      role: 'from'
    })
  }

  normalizedToEmails.forEach((email) => {
    participants.push({
      email,
      name: '',
      role: 'to'
    })
  })

  return participants
}

export function buildEmailSnippet(value: unknown, maxLength = 220) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()

  if (!normalized) {
    return ''
  }

  return normalized.slice(0, Math.max(1, maxLength))
}

export function extractMessageIdTokens(value: unknown) {
  const raw = String(value ?? '')
  const matches = raw.match(/<[^>]+>/g) || []
  const normalizedMatches = matches.map((match) => normalizeWhitespace(match)).filter(Boolean)

  if (normalizedMatches.length) {
    return dedupeStrings(normalizedMatches)
  }

  const trimmed = normalizeWhitespace(raw)
  return trimmed ? [trimmed] : []
}

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function decodeBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

export function encodeBase64(value: Uint8Array) {
  let binary = ''

  value.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary)
}

async function verifyImapConnection(mailbox: MailboxSenderWithSecret) {
  const host = normalizeWhitespace(Deno.env.get('IMAP_HOST') || Deno.env.get('SMTP_HOST'))
  const port = Number(Deno.env.get('IMAP_PORT') || 993)
  const secure = String(Deno.env.get('IMAP_SECURE') || 'true').toLowerCase() !== 'false'

  if (!host) {
    throw new Error('Set IMAP_HOST or SMTP_HOST before saving the mailbox.')
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('IMAP_PORT must be a valid positive number.')
  }

  const connection = secure
    ? await Deno.connectTls({ hostname: host, port })
    : await Deno.connect({ hostname: host, port })
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = new Uint8Array(0)
  let tagCounter = 0

  const readLine = async (): Promise<string | null> => {
    while (true) {
      const lineEndingIndex = findCrlfIndex(buffer)

      if (lineEndingIndex >= 0) {
        const lineBytes = buffer.slice(0, lineEndingIndex)
        buffer = buffer.slice(lineEndingIndex + 2)
        return decoder.decode(lineBytes)
      }

      const chunk = new Uint8Array(4096)
      const bytesRead = await connection.read(chunk)

      if (bytesRead === null) {
        if (!buffer.length) {
          return null
        }

        const finalLine = decoder.decode(buffer)
        buffer = new Uint8Array(0)
        return finalLine
      }

      buffer = concatUint8Arrays(buffer, chunk.slice(0, bytesRead))
    }
  }

  const runCommand = async (command: string) => {
    tagCounter += 1
    const tag = `A${String(tagCounter).padStart(4, '0')}`
    await connection.write(encoder.encode(`${tag} ${command}\r\n`))

    while (true) {
      const line = await readLine()

      if (line === null) {
        throw new Error('IMAP connection closed while verifying the mailbox.')
      }

      if (line.startsWith(`${tag} `)) {
        const status = normalizeWhitespace(line.slice(tag.length)).split(/\s+/)[0]?.toUpperCase() || ''

        if (status !== 'OK') {
          throw new Error(normalizeWhitespace(line.replace(`${tag} `, '')) || `IMAP verification failed for ${mailbox.senderEmail}.`)
        }

        return
      }
    }
  }

  try {
    const greeting = await readLine()

    if (!greeting || !greeting.startsWith('*')) {
      throw new Error('Unable to open the IMAP mailbox connection.')
    }

    await runCommand(`LOGIN ${quoteImapString(mailbox.smtpUsername)} ${quoteImapString(mailbox.smtpPassword)}`)
    await runCommand('LOGOUT')
  } finally {
    try {
      connection.close()
    } catch (_error) {
      // Ignore duplicate close calls when verification finishes.
    }
  }
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

function quoteImapString(value: unknown) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function getEncryptionKey() {
  const seed = requireEnv('MAILBOX_CREDENTIALS_KEY')
  const hashedSeed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))

  return crypto.subtle.importKey(
    'raw',
    hashedSeed,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )
}
