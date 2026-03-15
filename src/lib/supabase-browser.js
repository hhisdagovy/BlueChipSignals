import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

let supabasePromise = null
const DEPLOY_SUPABASE_CONFIG = {
  url: '%%VITE_SUPABASE_URL%%',
  key: '%%VITE_SUPABASE_PUBLISHABLE_KEY%%'
}

export function getSupabase() {
  if (!supabasePromise) {
    supabasePromise = createSupabaseClient()
  }

  return supabasePromise
}

async function createSupabaseClient() {
  const config = await loadSupabaseConfig()

  if (!config.url || !config.key) {
    throw new Error('Missing Supabase browser configuration.')
  }

  return createClient(config.url, config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  })
}

async function loadSupabaseConfig() {
  const deployConfig = normalizeSupabaseConfig(DEPLOY_SUPABASE_CONFIG)

  if (deployConfig) {
    return deployConfig
  }

  const globalConfig = window.__CRM_SUPABASE_CONFIG__

  const runtimeConfig = normalizeSupabaseConfig(globalConfig)

  if (runtimeConfig) {
    return runtimeConfig
  }

  const envUrl = new URL('../../.env', import.meta.url)
  const response = await fetch(envUrl, { cache: 'no-store' })

  if (!response.ok) {
    throw new Error('Unable to load local Supabase env values for the CRM.')
  }

  const rawEnv = await response.text()
  const parsedEnv = parseEnv(rawEnv)

  return {
    url: parsedEnv.VITE_SUPABASE_URL || '',
    key: parsedEnv.VITE_SUPABASE_PUBLISHABLE_KEY || ''
  }
}

function normalizeSupabaseConfig(config) {
  const url = String(config?.url || '').trim()
  const key = String(config?.key || '').trim()

  if (!url || !key) {
    return null
  }

  if (url.includes('%%') || key.includes('%%')) {
    return null
  }

  return { url, key }
}

function parseEnv(rawEnv) {
  return rawEnv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .reduce((accumulator, line) => {
      const separatorIndex = line.indexOf('=')

      if (separatorIndex === -1) {
        return accumulator
      }

      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1).trim()

      accumulator[key] = value
      return accumulator
    }, {})
}
