#!/usr/bin/env node

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true'

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

async function request(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : null

  if (!response.ok) {
    const error = new Error(`${method} ${path} failed (${response.status})`)
    error.details = data
    throw error
  }

  return data
}

async function getAuthUsersMap() {
  const map = new Map()
  let page = 1

  while (true) {
    const data = await request(`/auth/v1/admin/users?page=${page}&per_page=200`)
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

async function fetchRows(table) {
  return request(`/rest/v1/${table}?select=id,email,user_id&limit=10000`)
}

async function patchUserId(table, id, userId) {
  return request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { user_id: userId },
    prefer: 'return=minimal'
  })
}

async function runTable(table, authMap) {
  const rows = await fetchRows(table)
  let updated = 0
  let skipped = 0

  for (const row of rows) {
    if (row?.user_id) {
      skipped += 1
      continue
    }

    const email = normalizeEmail(row?.email)
    const userId = authMap.get(email)

    if (!email || !userId) {
      skipped += 1
      continue
    }

    if (!DRY_RUN) {
      await patchUserId(table, row.id, userId)
    }

    updated += 1
  }

  return { table, total: rows.length, updated, skipped }
}

async function main() {
  const authMap = await getAuthUsersMap()
  const tables = ['bcs_orders', 'bcs_entitlements', 'bcs_channel_access']
  const results = []

  for (const table of tables) {
    results.push(await runTable(table, authMap))
  }

  console.log(JSON.stringify({ dryRun: DRY_RUN, results }, null, 2))
}

main().catch((error) => {
  console.error(error.details || error)
  process.exit(1)
})
