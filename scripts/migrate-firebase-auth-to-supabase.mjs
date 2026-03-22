#!/usr/bin/env node

import fs from 'node:fs/promises'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const FIREBASE_AUTH_EXPORT_PATH = process.env.FIREBASE_AUTH_EXPORT_PATH || './users.json'
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true'

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

async function supabaseRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : null

  if (!response.ok) {
    const error = new Error(`Supabase API ${method} ${path} failed (${response.status})`)
    error.details = data
    throw error
  }

  return data
}

async function getAllSupabaseUsersByEmail() {
  const map = new Map()
  let page = 1

  while (true) {
    const data = await supabaseRequest(`/auth/v1/admin/users?page=${page}&per_page=200`)
    const users = Array.isArray(data?.users) ? data.users : []

    for (const user of users) {
      const email = normalizeEmail(user?.email)
      if (email && user?.id) map.set(email, user.id)
    }

    if (users.length < 200) break
    page += 1
  }

  return map
}

function randomPassword() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`
}

async function main() {
  const raw = await fs.readFile(FIREBASE_AUTH_EXPORT_PATH, 'utf8')
  const parsed = JSON.parse(raw)

  const firebaseUsers = Array.isArray(parsed?.users) ? parsed.users : []
  const supabaseByEmail = await getAllSupabaseUsersByEmail()

  let created = 0
  let skipped = 0
  let failed = 0

  for (const fbUser of firebaseUsers) {
    const email = normalizeEmail(fbUser?.email)
    if (!email) {
      skipped += 1
      continue
    }

    if (supabaseByEmail.has(email)) {
      skipped += 1
      continue
    }

    const payload = {
      email,
      email_confirm: Boolean(fbUser?.emailVerified),
      user_metadata: {
        migrated_from: 'firebase_auth',
        firebase_uid: String(fbUser?.localId || ''),
        full_name: String(fbUser?.displayName || '').trim() || null
      },
      password: randomPassword()
    }

    if (DRY_RUN) {
      created += 1
      continue
    }

    try {
      const data = await supabaseRequest('/auth/v1/admin/users', {
        method: 'POST',
        body: payload
      })

      if (data?.id) {
        created += 1
        supabaseByEmail.set(email, data.id)
      } else {
        failed += 1
        console.error('Create returned no id for', email)
      }
    } catch (error) {
      failed += 1
      console.error('Failed to create user', email, error.details || error.message)
    }
  }

  console.log(JSON.stringify({
    totalFirebaseUsers: firebaseUsers.length,
    created,
    skipped,
    failed,
    dryRun: DRY_RUN
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
