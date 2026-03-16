import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

let supabasePromise = null
const CRM_REMEMBER_KEY = 'bluechip_crm_remember_v1'
let persistSessionPreference = readRememberPreference()
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

export function getSupabaseRememberPreference() {
  return persistSessionPreference
}

export function setSupabaseRememberPreference(remember) {
  persistSessionPreference = remember === true

  try {
    localStorage.setItem(CRM_REMEMBER_KEY, persistSessionPreference ? '1' : '0')
  } catch (_error) {
    // Ignore storage write failures and fall back to in-memory preference.
  }
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
      detectSessionInUrl: true,
      storage: createSupabaseAuthStorage()
    }
  })
}

function createSupabaseAuthStorage() {
  return {
    getItem(key) {
      const primaryStorage = getPreferredStorage()
      const secondaryStorage = getFallbackStorage()

      return readStorageValue(primaryStorage, key) ?? readStorageValue(secondaryStorage, key) ?? null
    },
    setItem(key, value) {
      const primaryStorage = getPreferredStorage()
      const secondaryStorage = getFallbackStorage()

      writeStorageValue(primaryStorage, key, value)
      removeStorageValue(secondaryStorage, key)
    },
    removeItem(key) {
      removeStorageValue(localStorage, key)
      removeStorageValue(sessionStorage, key)
    }
  }
}

function getPreferredStorage() {
  return persistSessionPreference ? localStorage : sessionStorage
}

function getFallbackStorage() {
  return persistSessionPreference ? sessionStorage : localStorage
}

function readStorageValue(storage, key) {
  try {
    return storage.getItem(key)
  } catch (_error) {
    return null
  }
}

function writeStorageValue(storage, key, value) {
  try {
    storage.setItem(key, value)
  } catch (_error) {
    // Ignore storage write failures and let Supabase continue in memory.
  }
}

function removeStorageValue(storage, key) {
  try {
    storage.removeItem(key)
  } catch (_error) {
    // Ignore storage cleanup failures.
  }
}

function readRememberPreference() {
  try {
    return localStorage.getItem(CRM_REMEMBER_KEY) === '1'
  } catch (_error) {
    return false
  }
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
