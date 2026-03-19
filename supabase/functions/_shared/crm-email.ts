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
  smtpUsername: string
  smtpPassword: string
}

type SupabaseClientType = ReturnType<typeof createClient>

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

export async function fetchLeadForAccess(supabase: SupabaseClientType, leadId: unknown) {
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

  if (!leadRow) {
    throw new Error('That lead is no longer available.')
  }

  return {
    id: String(leadRow.id),
    assignedRepId: normalizeWhitespace(leadRow.assigned_rep_id),
    email: normalizeWhitespace(leadRow.email).toLowerCase(),
    fullName: normalizeWhitespace(leadRow.full_name || `${leadRow.first_name || ''} ${leadRow.last_name || ''}`) || 'Client',
    lifecycleType: normalizeWhitespace(leadRow.lifecycle) || 'lead'
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
  supabase: SupabaseClientType,
  profile: CrmProfile,
  senderMode: 'personal' | 'support'
): Promise<MailboxSenderWithSecret> {
  let senderQuery = supabase
    .from('mailbox_senders')
    .select('id, kind, owner_user_id, sender_email, sender_name, is_active')

  if (senderMode === 'support') {
    senderQuery = senderQuery.eq('kind', 'support').limit(1)
  } else {
    senderQuery = senderQuery.eq('kind', 'personal').eq('owner_user_id', profile.id).limit(1)
  }

  const { data: senderRow, error: senderError } = await senderQuery.maybeSingle()

  if (senderError) {
    throw new Error(senderError.message || 'Unable to load the mailbox sender.')
  }

  if (!senderRow || senderRow.is_active === false) {
    throw new Error(senderMode === 'support'
      ? 'The support mailbox is not configured yet.'
      : 'Connect your mailbox in CRM settings before sending email.')
  }

  const { data: secretRow, error: secretError } = await supabase
    .from('mailbox_sender_secrets')
    .select('smtp_username, password_ciphertext, password_iv')
    .eq('sender_id', senderRow.id)
    .maybeSingle()

  if (secretError) {
    throw new Error(secretError.message || 'Unable to load the mailbox credentials.')
  }

  if (!secretRow) {
    throw new Error(senderMode === 'support'
      ? 'The support mailbox credentials are missing.'
      : 'Your mailbox credentials are missing. Reconnect your mailbox in settings.')
  }

  return {
    id: normalizeWhitespace(senderRow.id),
    kind: senderRow.kind === 'support' ? 'support' : 'personal',
    ownerUserId: normalizeWhitespace(senderRow.owner_user_id) || null,
    senderEmail: normalizeWhitespace(senderRow.sender_email).toLowerCase(),
    senderName: normalizeWhitespace(senderRow.sender_name) || profile.fullName,
    smtpUsername: normalizeWhitespace(secretRow.smtp_username),
    smtpPassword: await decryptSecret(secretRow.password_ciphertext, secretRow.password_iv)
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
