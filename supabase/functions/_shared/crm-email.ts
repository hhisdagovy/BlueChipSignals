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
  signatureMode: 'plain_text' | 'template' | 'html_override'
  signatureTemplate: MailboxSignatureTemplate
  signatureHtmlOverride: string
  signatureText: string
  imapInboxFolder: string
  imapSentFolder: string
  smtpUsername: string
  smtpPassword: string
}

export type MailboxSignatureTemplate = {
  displayName: string
  jobTitle: string
  phone: string
  email: string
  websiteUrl: string
  headshotPath: string
  socialLinks: Array<{
    network: string
    url: string
    label: string
  }>
  ctaImagePath: string
  ctaHeadline: string
  ctaSubtext: string
  ctaUrl: string
  disclaimerText: string
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
  signature_mode?: string | null
  signature_template?: unknown
  signature_html_override?: string | null
  signature_text?: string | null
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
    .select('id, kind, owner_user_id, sender_email, sender_name, signature_mode, signature_template, signature_html_override, signature_text, imap_inbox_folder, imap_sent_folder, is_active')

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
    signatureMode: normalizeSignatureMode(normalizedSenderRow.signature_mode),
    signatureTemplate: normalizeSignatureTemplate(normalizedSenderRow.signature_template),
    signatureHtmlOverride: sanitizeSignatureHtml(normalizedSenderRow.signature_html_override),
    signatureText: normalizeSignatureText(normalizedSenderRow.signature_text),
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
    .select('id, kind, owner_user_id, sender_email, sender_name, signature_mode, signature_template, signature_html_override, signature_text, imap_inbox_folder, imap_sent_folder, is_active')
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
    signatureMode: normalizeSignatureMode(normalizedSenderRow.signature_mode),
    signatureTemplate: normalizeSignatureTemplate(normalizedSenderRow.signature_template),
    signatureHtmlOverride: sanitizeSignatureHtml(normalizedSenderRow.signature_html_override),
    signatureText: normalizeSignatureText(normalizedSenderRow.signature_text),
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
  bodyText,
  signatureMode = 'plain_text',
  signatureTemplate = {},
  signatureHtmlOverride = '',
  signatureText = ''
}: {
  senderName: string
  bodyText: string
  signatureMode?: 'plain_text' | 'template' | 'html_override'
  signatureTemplate?: unknown
  signatureHtmlOverride?: string
  signatureText?: string
}) {
  const escapedBody = escapeHtml(bodyText).replace(/\n/g, '<br>')
  const signatureMarkup = resolveSignatureHtml({
    senderName,
    signatureMode,
    signatureTemplate,
    signatureHtmlOverride,
    signatureText
  })
  const templateHeadStyles = signatureMode === 'template'
    ? getTemplateSignatureHeadCss()
    : ''

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${templateHeadStyles}
      </head>
      <body style="margin: 0; padding: 0;">
        <div class="body bcs-email-body" style="margin: 0; padding: 0;">
          <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.65;">
            <div style="white-space: normal;">${escapedBody}</div>
            <div style="margin-top: 24px;">
              <div style="white-space: normal;">${signatureMarkup}</div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `.trim()
}

function getTemplateSignatureHeadCss() {
  return `
    <style>
      @media screen and (max-width: 480px) {
        .body .bcs-signature .bcs-signature-social-cell {
          padding-right: 4px !important;
        }

        .body .bcs-signature .bcs-signature-avatar-wrap {
          margin-left: 8px !important;
        }

        .body .bcs-signature .bcs-signature-divider-cell {
          padding-left: 4px !important;
          padding-right: 6px !important;
        }

        .body .bcs-signature .bcs-signature-contact-cell {
          width: 182px !important;
        }

        .body .bcs-signature .bcs-signature-contact-table {
          font-size: 8px !important;
          line-height: 1.24 !important;
        }

        .body .bcs-signature .bcs-signature-contact-label {
          width: 16px !important;
          padding-right: 5px !important;
        }

        .body .bcs-signature .bcs-signature-contact-value,
        .body .bcs-signature .bcs-signature-contact-value a {
          font-size: 8px !important;
          line-height: 1.24 !important;
          white-space: nowrap !important;
        }

        .body .bcs-signature .bcs-signature-name,
        .body .bcs-signature .bcs-signature-job-title,
        .body .bcs-signature .bcs-signature-contact-value,
        .body .bcs-signature .bcs-signature-contact-value a {
          color: #ffffff !important;
          -webkit-text-fill-color: #ffffff !important;
        }

        .body .bcs-signature .bcs-signature-name {
          font-size: 14px !important;
          line-height: 1.04 !important;
          white-space: nowrap !important;
        }

        .body .bcs-signature .bcs-signature-job-title {
          white-space: nowrap !important;
        }
      }

      u + .body .bcs-signature .bcs-signature-avatar-wrap {
        margin-left: 8px !important;
      }

      u + .body .bcs-signature .bcs-signature-social-cell {
        padding-right: 4px !important;
      }

      u + .body .bcs-signature .bcs-signature-contact-cell {
        width: 182px !important;
      }

      u + .body .bcs-signature .bcs-signature-contact-table,
      u + .body .bcs-signature .bcs-signature-contact-value,
      u + .body .bcs-signature .bcs-signature-contact-value a {
        font-size: 8px !important;
        line-height: 1.24 !important;
        white-space: nowrap !important;
      }

      u + .body .bcs-signature .bcs-signature-name,
      u + .body .bcs-signature .bcs-signature-job-title,
      u + .body .bcs-signature .bcs-signature-contact-value,
      u + .body .bcs-signature .bcs-signature-contact-value a {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      u + .body .bcs-signature .bcs-signature-name {
        font-size: 14px !important;
        line-height: 1.04 !important;
        white-space: nowrap !important;
      }

      u + .body .bcs-signature .bcs-signature-job-title {
        white-space: nowrap !important;
      }

      u + .body .bcs-signature .bcs-gmail-white-screen {
        display: inline-block !important;
        background: #000000 !important;
        mix-blend-mode: screen !important;
        white-space: inherit !important;
      }

      u + .body .bcs-signature .bcs-gmail-white-difference {
        display: inline-block !important;
        background: #000000 !important;
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
        mix-blend-mode: difference !important;
        white-space: inherit !important;
      }
    </style>
  `.trim()
}

function wrapTemplateGmailWhiteText(content: string) {
  return `<span class="bcs-gmail-white-screen"><span class="bcs-gmail-white-difference">${content}</span></span>`
}

export function buildEmailText({
  senderName,
  bodyText,
  signatureText = ''
}: {
  senderName: string
  bodyText: string
  signatureText?: string
}) {
  return [String(bodyText ?? '').trim(), resolveSignatureText(signatureText, senderName)]
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function normalizeSignatureMode(value: unknown): MailboxSenderWithSecret['signatureMode'] {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (normalized === 'template') {
    return 'template'
  }

  if (normalized === 'html_override') {
    return 'html_override'
  }

  return 'plain_text'
}

export function normalizeSignatureTemplate(value: unknown): MailboxSignatureTemplate {
  const template = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const socialLinks = Array.isArray(template.socialLinks)
    ? template.socialLinks
    : (Array.isArray(template.social_links) ? template.social_links : [])

  return {
    displayName: normalizeWhitespace(template.displayName ?? template.display_name),
    jobTitle: normalizeWhitespace(template.jobTitle ?? template.job_title),
    phone: normalizeWhitespace(template.phone),
    email: normalizeEmailAddress(template.email),
    websiteUrl: normalizeHttpUrl(template.websiteUrl ?? template.website_url),
    headshotPath: normalizeStorageObjectPath(template.headshotPath ?? template.headshot_path),
    socialLinks: normalizeSignatureSocialLinks(socialLinks),
    ctaImagePath: normalizeStorageObjectPath(template.ctaImagePath ?? template.cta_image_path),
    ctaHeadline: normalizeWhitespace(template.ctaHeadline ?? template.cta_headline),
    ctaSubtext: normalizeWhitespace(template.ctaSubtext ?? template.cta_subtext),
    ctaUrl: normalizeHttpUrl(template.ctaUrl ?? template.cta_url),
    disclaimerText: normalizeSignatureText(template.disclaimerText ?? template.disclaimer_text)
  }
}

function normalizeSignatureSocialLinks(value: unknown): MailboxSignatureTemplate['socialLinks'] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const item = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {}

      return {
        network: normalizeWhitespace(item.network).toLowerCase(),
        url: normalizeHttpUrl(item.url),
        label: normalizeWhitespace(item.label)
      }
    })
    .filter((entry) => entry.network && entry.url)
    .slice(0, 4)
}

export function normalizeStorageObjectPath(value: unknown) {
  return String(value ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.\.+/g, '')
}

export function normalizeHttpUrl(value: unknown) {
  const normalized = String(value ?? '').trim()

  if (!normalized) {
    return ''
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized.replace(/^\/+/, '')}`

  try {
    const url = new URL(withProtocol)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : ''
  } catch (_error) {
    return ''
  }
}

export function resolveSignatureTextForStorage({
  senderName,
  signatureMode = 'plain_text',
  signatureTemplate = {},
  signatureHtmlOverride = '',
  signatureText = ''
}: {
  senderName: string
  signatureMode?: 'plain_text' | 'template' | 'html_override'
  signatureTemplate?: unknown
  signatureHtmlOverride?: string
  signatureText?: string
}) {
  if (signatureMode === 'template') {
    const template = normalizeSignatureTemplate(signatureTemplate)
    const templateText = buildSignatureTextFromTemplate(template, senderName)

    return resolveSignatureText(templateText || signatureText, senderName)
  }

  if (signatureMode === 'html_override') {
    const strippedText = stripHtmlToText(sanitizeSignatureHtml(signatureHtmlOverride))
    return resolveSignatureText(strippedText || signatureText, senderName)
  }

  return resolveSignatureText(signatureText, senderName)
}

export function resolveSignatureHtml({
  senderName,
  signatureMode = 'plain_text',
  signatureTemplate = {},
  signatureHtmlOverride = '',
  signatureText = ''
}: {
  senderName: string
  signatureMode?: 'plain_text' | 'template' | 'html_override'
  signatureTemplate?: unknown
  signatureHtmlOverride?: string
  signatureText?: string
}) {
  if (signatureMode === 'template') {
    const template = normalizeSignatureTemplate(signatureTemplate)
    return buildTemplateSignatureHtml(template, senderName)
  }

  if (signatureMode === 'html_override') {
    const sanitizedOverride = sanitizeSignatureHtml(signatureHtmlOverride)

    if (sanitizedOverride) {
      return sanitizedOverride
    }
  }

  return `
    <div style="color: #6b7280;">
      <div style="white-space: normal;">${escapeHtml(resolveSignatureText(signatureText, senderName)).replace(/\n/g, '<br>')}</div>
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

export function normalizeSignatureText(value: unknown) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim()
}

export function resolveSignatureText(signatureText: unknown, senderName: unknown) {
  const normalizedSignature = normalizeSignatureText(signatureText)

  if (normalizedSignature) {
    return normalizedSignature
  }

  return `Best regards,\n${normalizeWhitespace(senderName || 'Blue Chip Signals') || 'Blue Chip Signals'}`
}

export function buildSignatureTextFromTemplate(template: MailboxSignatureTemplate, senderName: string) {
  const lines = [
    normalizeWhitespace(template.displayName) || normalizeWhitespace(senderName),
    normalizeWhitespace(template.jobTitle),
    template.phone ? `T: ${template.phone}` : '',
    template.email ? `E: ${template.email}` : '',
    template.websiteUrl ? `W: ${template.websiteUrl}` : '',
    template.disclaimerText ? `\n${template.disclaimerText}` : ''
  ].filter(Boolean)

  return lines.join('\n').trim()
}

function buildTemplateSignatureHtml(template: MailboxSignatureTemplate, senderName: string) {
  const resolvedName = normalizeWhitespace(template.displayName) || normalizeWhitespace(senderName) || 'Blue Chip Signals'
  const socialLinks = template.socialLinks
    .filter((entry) => normalizeWhitespace(entry.network) && normalizeWhitespace(entry.url))
    .map((entry) => ({
      ...entry,
      badge: getSignatureSocialBadge(entry.network),
      label: entry.label || entry.network
    }))
  const headshotUrl = getPublicStorageUrl(template.headshotPath)
  const ctaImageUrl = getPublicStorageUrl(template.ctaImagePath)
  const hasFooterCard = Boolean(template.ctaHeadline || template.ctaSubtext || ctaImageUrl)
  const hasContactColumn = Boolean(template.phone || template.email || template.websiteUrl)
  const disclaimerMarkup = template.disclaimerText
    ? `<div style="margin-top: 10px; font-family: Arial, sans-serif; font-size: 9px; line-height: 1.45; color: #9fa9bb; -webkit-text-fill-color: #9fa9bb;">${escapeHtml(template.disclaimerText).replace(/\n/g, '<br>')}</div>`
    : ''
  return `
    <table class="bcs-signature" role="presentation" cellpadding="0" cellspacing="0" border="0" width="440" style="margin-top: 14px; width: 100%; max-width: 440px; border-collapse: separate; border-spacing: 0;">
      <tr>
        <td style="border: 1px solid #2d3850; border-radius: 18px; padding: 12px 12px 13px; background-color: #0f1724; background-image: linear-gradient(180deg, #0f1724 0%, #0f1724 100%);">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; table-layout: fixed;">
            <tr>
              <td valign="middle" align="center" style="padding-right: 16px; vertical-align: middle;">
                <div class="bcs-signature-name" style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.08; font-weight: 700; color: #f6f7fb; -webkit-text-fill-color: #f6f7fb; text-align: center;">${wrapTemplateGmailWhiteText(escapeHtml(resolvedName))}</div>
                ${template.jobTitle ? `<div class="bcs-signature-job-title" style="margin-top: 3px; font-family: Arial, sans-serif; font-size: 11px; line-height: 1.3; color: #b9c4d8; -webkit-text-fill-color: #b9c4d8; text-align: center;">${wrapTemplateGmailWhiteText(escapeHtml(template.jobTitle))}</div>` : ''}
                ${socialLinks.length ? `
                  <table class="bcs-signature-social-row" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 9px auto 0; border-collapse: collapse;">
                    <tr>
                    ${socialLinks.map((entry) => `
                      <td class="bcs-signature-social-cell" style="padding-right: 5px;">
                        <a
                          class="bcs-signature-social-link"
                          href="${escapeHtml(entry.url)}"
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="${escapeHtml(entry.label)}"
                          style="display: block; width: 20px; height: 20px; border-radius: 999px; background-color: ${escapeHtml(entry.badge.background)}; color: ${escapeHtml(entry.badge.color)}; font-family: Arial, sans-serif; font-size: 8px; line-height: 20px; font-weight: 700; text-align: center; text-decoration: none;"
                        >${escapeHtml(entry.badge.text)}</a>
                      </td>
                    `).join('')}
                    </tr>
                  </table>
                ` : ''}
              </td>
              <td class="bcs-signature-avatar-cell" valign="middle" align="center" width="62" style="width: 62px; padding-left: 2px; padding-right: 2px; vertical-align: middle;">
                ${headshotUrl ? `
                  <table class="bcs-signature-avatar-wrap" role="presentation" cellpadding="0" cellspacing="0" border="0" width="52" style="width: 52px; border-collapse: collapse;">
                    <tr>
                      <td width="50" height="50" style="width: 50px; height: 50px; border-radius: 999px; overflow: hidden; background-color: #1b2840; background-image: linear-gradient(180deg, #1b2840 0%, #1b2840 100%); line-height: 0; font-size: 0;">
                        <img class="bcs-signature-avatar-image" src="${escapeHtml(headshotUrl)}" alt="${escapeHtml(resolvedName)}" width="50" style="display: block; width: 50px; max-width: 50px; height: auto; border: 0;">
                      </td>
                    </tr>
                  </table>
                ` : `
                  <div class="bcs-signature-avatar-wrap" style="width: 50px; height: 50px; border-radius: 999px; background-color: #1b2840; background-image: linear-gradient(180deg, #1b2840 0%, #1b2840 100%); color: #f6f1e6; -webkit-text-fill-color: #f6f1e6; font-size: 19px; font-weight: 700; line-height: 50px; text-align: center;">
                    ${escapeHtml(resolvedName.charAt(0).toUpperCase() || 'B')}
                  </div>
                `}
              </td>
              ${hasContactColumn ? `
                <td class="bcs-signature-divider-cell" valign="middle" width="14" style="width: 14px; padding: 0 8px 0 4px; vertical-align: middle;">
                  <div style="width: 1px; height: 62px; background-color: #55627c; font-size: 0; line-height: 0;">&nbsp;</div>
                </td>
                <td class="bcs-signature-contact-cell" valign="middle" width="176" style="width: 176px; vertical-align: middle;">
                  <table class="bcs-signature-contact-table" role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; font-size: 9px; line-height: 1.32; color: #ffffff; -webkit-text-fill-color: #ffffff;">
                    ${template.phone ? `
                      <tr>
                        <td class="bcs-signature-contact-label" valign="top" style="width: 18px; padding: 0 6px 4px 0; color: #f3d98b; font-weight: 700;">T:</td>
                        <td class="bcs-signature-contact-value" valign="top" style="padding: 0 0 4px; color: #ffffff; -webkit-text-fill-color: #ffffff;">${wrapTemplateGmailWhiteText(escapeHtml(template.phone))}</td>
                      </tr>
                    ` : ''}
                    ${template.email ? `
                      <tr>
                        <td class="bcs-signature-contact-label" valign="top" style="width: 18px; padding: 0 6px 4px 0; color: #f3d98b; font-weight: 700;">E:</td>
                        <td class="bcs-signature-contact-value" valign="top" style="padding: 0 0 4px;">
                          <a class="bcs-signature-contact-link" href="mailto:${escapeHtml(template.email)}" style="display: inline-block; color: #ffffff; -webkit-text-fill-color: #ffffff; font-size: 9px; text-decoration: none; white-space: nowrap;">${wrapTemplateGmailWhiteText(escapeHtml(template.email))}</a>
                        </td>
                      </tr>
                    ` : ''}
                    ${template.websiteUrl ? `
                      <tr>
                        <td class="bcs-signature-contact-label" valign="top" style="width: 18px; padding: 0 6px 0 0; color: #f3d98b; font-weight: 700;">W:</td>
                        <td class="bcs-signature-contact-value" valign="top" style="padding: 0;">
                          <a class="bcs-signature-contact-link" href="${escapeHtml(template.websiteUrl)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; color: #ffffff; -webkit-text-fill-color: #ffffff; font-size: 9px; text-decoration: none; white-space: nowrap;">${wrapTemplateGmailWhiteText(escapeHtml(stripProtocolFromUrl(template.websiteUrl)))}</a>
                        </td>
                      </tr>
                    ` : ''}
                  </table>
                </td>
              ` : ''}
            </tr>
          </table>
          ${hasFooterCard ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top: 18px; width: 100%; border-collapse: separate; border-spacing: 0;">
              <tr>
                <td style="border-radius: 14px; background-color: #162133; background-image: linear-gradient(180deg, #162133 0%, #162133 100%); border: 1px solid #2a3a56; overflow: hidden;">
                  ${ctaImageUrl ? `
                    <img src="${escapeHtml(ctaImageUrl)}" alt="${escapeHtml(template.ctaHeadline || 'Signature banner')}" width="414" style="display: block; width: 100%; max-width: 414px; height: auto;">
                  ` : ''}
                  <div style="padding: 11px 12px 12px;">
                    ${template.ctaHeadline ? `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.1; color: #ffffff; -webkit-text-fill-color: #ffffff; font-weight: 700;">${escapeHtml(template.ctaHeadline)}</div>` : ''}
                    ${template.ctaSubtext ? `<div style="margin-top: 5px; font-family: Arial, sans-serif; font-size: 10px; line-height: 1.45; color: #ffffff; -webkit-text-fill-color: #ffffff;">${escapeHtml(template.ctaSubtext)}</div>` : ''}
                    ${template.ctaUrl ? `<div style="margin-top: 7px;"><a href="${escapeHtml(template.ctaUrl)}" target="_blank" rel="noopener noreferrer" style="font-family: Arial, sans-serif; font-size: 10px; line-height: 1.2; color: #f3d98b; -webkit-text-fill-color: #f3d98b; font-weight: 700; text-decoration: none;">Open link &rsaquo;</a></div>` : ''}
                  </div>
                </td>
              </tr>
            </table>
          ` : ''}
          ${disclaimerMarkup}
        </td>
      </tr>
    </table>
  `.trim()
}

function stripProtocolFromUrl(value: string) {
  return value.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

function getSignatureSocialBadge(network: string) {
  const normalized = normalizeWhitespace(network).toLowerCase()

  if (normalized === 'linkedin') {
    return { text: 'in', background: '#0A66C2', color: '#ffffff' }
  }

  if (normalized === 'facebook') {
    return { text: 'f', background: '#1877F2', color: '#ffffff' }
  }

  if (normalized === 'telegram') {
    return { text: 'tg', background: '#24A1DE', color: '#ffffff' }
  }

  if (normalized === 'instagram') {
    return { text: 'ig', background: '#DD2A7B', color: '#ffffff' }
  }

  if (normalized === 'youtube') {
    return { text: 'yt', background: '#FF0033', color: '#ffffff' }
  }

  return { text: 'x', background: '#111111', color: '#ffffff' }
}

function getPublicStorageUrl(
  path: string,
  options: {
    width?: number
    height?: number
    resize?: 'cover' | 'contain'
  } = {}
) {
  const normalizedPath = normalizeStorageObjectPath(path)

  if (!normalizedPath) {
    return ''
  }

  const baseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '')
  const encodedPath = normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  const width = Math.max(0, Math.round(Number(options.width || 0)))
  const height = Math.max(0, Math.round(Number(options.height || 0)))

  if (width || height) {
    const params = new URLSearchParams()

    if (width) {
      params.set('width', String(width))
    }

    if (height) {
      params.set('height', String(height))
    }

    params.set('resize', options.resize === 'contain' ? 'contain' : 'cover')

    return `${baseUrl}/storage/v1/render/image/public/email-signatures/${encodedPath}?${params.toString()}`
  }

  return `${baseUrl}/storage/v1/object/public/email-signatures/${encodedPath}`
}

export function sanitizeSignatureHtml(value: unknown) {
  let html = String(value ?? '').trim()

  if (!html) {
    return ''
  }

  html = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|video|audio|svg|math|meta|link|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|video|audio|svg|math|meta|link|base)\b[^>]*\/?>/gi, '')

  const allowedTags = new Set(['table', 'tbody', 'tr', 'td', 'p', 'div', 'span', 'a', 'img', 'strong', 'b', 'em', 'i', 'br', 'ul', 'ol', 'li'])

  return html.replace(/<\/?([a-z0-9:-]+)([^>]*)>/gi, (match, rawTagName, rawAttributes) => {
    const tagName = String(rawTagName || '').toLowerCase()
    const isClosing = /^<\//.test(match)

    if (!allowedTags.has(tagName)) {
      return ''
    }

    if (isClosing) {
      return `</${tagName}>`
    }

    const sanitizedAttributes = sanitizeAllowedHtmlAttributes(tagName, String(rawAttributes || ''))
    const selfClosing = /\/\s*>$/.test(match) || tagName === 'br' || tagName === 'img'

    return `<${tagName}${sanitizedAttributes}${selfClosing ? ' />' : '>'}`
  })
}

function sanitizeAllowedHtmlAttributes(tagName: string, rawAttributes: string) {
  const attributes: string[] = []
  const attributePattern = /([a-z0-9:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  const allowedByTag = new Set(['style'])

  if (tagName === 'a') {
    allowedByTag.add('href')
    allowedByTag.add('target')
    allowedByTag.add('rel')
    allowedByTag.add('aria-label')
  }

  if (tagName === 'img') {
    allowedByTag.add('src')
    allowedByTag.add('alt')
    allowedByTag.add('width')
    allowedByTag.add('height')
  }

  if (tagName === 'td' || tagName === 'table') {
    allowedByTag.add('width')
    allowedByTag.add('height')
    allowedByTag.add('align')
    allowedByTag.add('valign')
    allowedByTag.add('cellpadding')
    allowedByTag.add('cellspacing')
    allowedByTag.add('border')
    allowedByTag.add('role')
  }

  let match: RegExpExecArray | null = null

  while ((match = attributePattern.exec(rawAttributes)) !== null) {
    const attributeName = String(match[1] || '').toLowerCase()
    const attributeValue = String(match[3] ?? match[4] ?? match[5] ?? '')

    if (!allowedByTag.has(attributeName) || attributeName.startsWith('on')) {
      continue
    }

    if (attributeName === 'style') {
      const sanitizedStyle = sanitizeInlineStyle(attributeValue)

      if (sanitizedStyle) {
        attributes.push(`style="${escapeHtml(sanitizedStyle)}"`)
      }
      continue
    }

    if (attributeName === 'href') {
      const sanitizedHref = sanitizeSignatureLink(attributeValue)

      if (sanitizedHref) {
        attributes.push(`href="${escapeHtml(sanitizedHref)}"`)
        attributes.push('target="_blank"')
        attributes.push('rel="noopener noreferrer"')
      }
      continue
    }

    if (attributeName === 'src') {
      const sanitizedSrc = sanitizeSignatureImageSource(attributeValue)

      if (sanitizedSrc) {
        attributes.push(`src="${escapeHtml(sanitizedSrc)}"`)
      }
      continue
    }

    if (attributeName === 'target' || attributeName === 'rel') {
      continue
    }

    attributes.push(`${attributeName}="${escapeHtml(attributeValue)}"`)
  }

  return attributes.length ? ` ${attributes.join(' ')}` : ''
}

function sanitizeInlineStyle(value: string) {
  if (!value) {
    return ''
  }

  const allowedProperties = new Set([
    'background', 'background-color', 'border', 'border-radius', 'border-collapse', 'border-spacing',
    'color', 'display', 'font-family', 'font-size', 'font-style', 'font-weight', 'height', 'letter-spacing',
    'line-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'max-width',
    'min-width', 'object-fit', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'text-align', 'text-decoration', 'text-transform', 'vertical-align', 'white-space', 'width'
  ])

  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [property, ...rest] = entry.split(':')
      const normalizedProperty = normalizeWhitespace(property).toLowerCase()
      const propertyValue = rest.join(':').trim()

      if (!allowedProperties.has(normalizedProperty) || !propertyValue) {
        return ''
      }

      if (/expression\s*\(|javascript:|url\s*\(/i.test(propertyValue)) {
        return ''
      }

      return `${normalizedProperty}: ${propertyValue}`
    })
    .filter(Boolean)
    .join('; ')
}

function sanitizeSignatureLink(value: string) {
  const normalized = String(value ?? '').trim()

  if (!normalized) {
    return ''
  }

  if (/^(mailto:|tel:)/i.test(normalized)) {
    return normalized
  }

  return normalizeHttpUrl(normalized)
}

function sanitizeSignatureImageSource(value: string) {
  return normalizeHttpUrl(value)
}

function stripHtmlToText(value: string) {
  return normalizeSignatureText(
    String(value ?? '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|tr|li|table|tbody)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, '\'')
      .replace(/&quot;/gi, '"')
  )
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
