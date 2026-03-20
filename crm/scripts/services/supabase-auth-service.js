import {
  getSupabase,
  getSupabaseRememberPreference,
  setSupabaseRememberPreference
} from '../../../src/lib/supabase-browser.js'

const SESSION_KEY = 'bluechip_crm_session_v1'
const USERS_KEY = 'bluechip_crm_users_v1'
const PROFILE_SELECT = 'id, email, full_name, role, active, call_preference'
const PROFILE_SELECT_FALLBACK = 'id, email, full_name, role, active'
const PROFILE_ACCESS_SELECT = 'id, role, active'

export class SupabaseAuthService {
  constructor() {
    this.usersCache = this.readUsersCache()
    this.authSubscription = null
    this.currentAuthUser = null
    this.currentProfile = null
  }

  getSession() {
    return readStoredSession()
  }

  getTestUsers() {
    return []
  }

  getRememberPreference() {
    return getSupabaseRememberPreference()
  }

  getAuthUser() {
    return this.currentAuthUser
  }

  getProfile() {
    return this.currentProfile
  }

  getUserById(userId) {
    return this.readUsersCache().find((user) => user.id === userId) || null
  }

  async initialize() {
    const supabase = await getSupabase()
    const { data, error } = await supabase.auth.getSession()

    if (error) {
      throw new Error(error.message || 'Unable to restore the Supabase session.')
    }

    return this.resolveSession(data.session)
  }

  async updateSessionFromUser(userId) {
    const currentSession = this.getSession()

    if (!currentSession || currentSession.id !== userId) {
      return currentSession
    }

    return this.initialize()
  }

  async listUsers() {
    const supabase = await getSupabase()
    const { data, error } = await selectProfilesWithFallback(supabase)

    if (error) {
      if (this.usersCache.length) {
        return this.usersCache
      }

      throw new Error(error.message || 'Unable to load CRM profiles from Supabase.')
    }

    const mappedUsers = (data ?? []).map(mapProfileRow).sort((left, right) => left.name.localeCompare(right.name))
    this.usersCache = mappedUsers
    localStorage.setItem(USERS_KEY, JSON.stringify(mappedUsers))
    return mappedUsers
  }

  async login({ email, password, remember = false }) {
    setSupabaseRememberPreference(remember)
    const supabase = await getSupabase()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(email ?? '').trim(),
      password: String(password ?? '')
    })

    if (error) {
      if (error.code === 'invalid_credentials') {
        throw new Error('Invalid email or password.')
      }

      throw new Error(error.message || 'Unable to sign in with Supabase.')
    }

    return this.resolveSession(data.session)
  }

  async quickLogin() {
    throw new Error('Quick login is not available once Supabase auth is enabled.')
  }

  async logout() {
    const supabase = await getSupabase()
    const { error } = await supabase.auth.signOut()

    if (error) {
      throw new Error(error.message || 'Unable to sign out of Supabase.')
    }

    this.clearResolvedSession()
  }

  async saveUser(payload) {
    await this.assertActiveAdminProfileAccess()

    const normalizedUserId = String(payload?.id ?? '').trim()

    if (!normalizedUserId) {
      throw new Error('Create the user in Supabase Auth first, then edit the CRM profile here.')
    }

    const fullName = String(payload?.name ?? '').trim()
    const email = String(payload?.email ?? '').trim().toLowerCase()
    const role = serializeProfileRole(payload?.role)
    const active = payload?.isActive !== false

    if (!fullName || !email) {
      throw new Error('Name and email are required for CRM profiles.')
    }

    const supabase = await getSupabase()
    const { data, error } = await supabase
      .from('profiles')
      .update({
        email,
        full_name: fullName,
        role,
        active
      })
      .eq('id', normalizedUserId)
      .select(PROFILE_SELECT)
      .single()

    if (error) {
      throw new Error(describeProfileWriteError(error))
    }

    const savedUser = mapProfileRow(data)
    const nextUsers = mergeCachedUsers(this.readUsersCache(), [savedUser]).sort((left, right) => left.name.localeCompare(right.name))
    this.usersCache = nextUsers
    localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers))
    return savedUser
  }

  async deleteUser(userId) {
    await this.assertActiveAdminProfileAccess()

    const normalizedUserId = String(userId ?? '').trim()

    if (!normalizedUserId) {
      throw new Error('Choose a CRM profile before deleting it.')
    }

    if (normalizedUserId === this.currentProfile?.id) {
      throw new Error('You cannot delete the currently signed-in admin account.')
    }

    const supabase = await getSupabase()
    const { error: rpcError } = await supabase
      .rpc('admin_delete_user', { target_user_id: normalizedUserId })

    if (rpcError && !isMissingRpcFunctionError(rpcError)) {
      throw new Error(describeProfileWriteError(rpcError))
    }

    if (rpcError && isMissingRpcFunctionError(rpcError)) {
      const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('id', normalizedUserId)

      if (error) {
        throw new Error(describeProfileWriteError(error))
      }
    }

    const nextUsers = this.readUsersCache().filter((user) => user.id !== normalizedUserId)
    this.usersCache = nextUsers
    localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers))
  }

  async bindAuthListener(onSessionChange) {
    const supabase = await getSupabase()

    if (this.authSubscription) {
      this.authSubscription.unsubscribe()
      this.authSubscription = null
    }

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Defer async profile loading out of the auth callback so sign-in does not deadlock.
      window.setTimeout(async () => {
        try {
          const nextSession = await this.resolveSession(session, { refreshUsers: false })
          onSessionChange({
            event,
            session: nextSession,
            authUser: this.getAuthUser(),
            profile: this.getProfile(),
            error: null
          })
        } catch (error) {
          this.clearResolvedSession()
          onSessionChange({
            event,
            session: null,
            authUser: null,
            profile: null,
            error
          })
        }
      }, 0)
    })

    this.authSubscription = data.subscription
    return data.subscription
  }

  readUsersCache() {
    try {
      const raw = localStorage.getItem(USERS_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch (_error) {
      return []
    }
  }

  async resolveSession(authSession, { refreshUsers = true } = {}) {
    if (!authSession?.user) {
      this.clearResolvedSession()
      return null
    }

    const profile = await this.fetchProfile(authSession.user.id)

    if (profile.isActive === false) {
      this.clearResolvedSession()
      throw new Error('Your CRM profile is inactive.')
    }

    this.currentAuthUser = mapAuthUser(authSession.user)
    this.currentProfile = profile
    const nextSession = {
      id: profile.id,
      email: profile.email || authSession.user.email || '',
      name: profile.fullName || authSession.user.user_metadata?.full_name || authSession.user.email || 'CRM User',
      role: profile.role,
      title: profile.title,
      callPreference: profile.callPreference,
      loggedInAt: new Date().toISOString()
    }

    writeStoredSession(nextSession, getSupabaseRememberPreference())

    if (refreshUsers) {
      try {
        await this.listUsers()
      } catch (_error) {
        const fallbackUsers = mergeCachedUsers(this.readUsersCache(), [mapProfileRow(profile)])
        this.usersCache = fallbackUsers
        localStorage.setItem(USERS_KEY, JSON.stringify(fallbackUsers))
      }
    }

    return nextSession
  }

  clearResolvedSession() {
    this.currentAuthUser = null
    this.currentProfile = null
    clearStoredSession()
  }

  async fetchProfile(userId) {
    const supabase = await getSupabase()
    const normalizedUserId = String(userId ?? '').trim()
    const { data, error } = await selectProfileByIdWithFallback(supabase, normalizedUserId)

    if (error) {
      throw new Error(describeProfileLookupError(error))
    }

    if (!data) {
      throw new Error(`Signed in successfully, but no readable CRM profile row matched auth user id ${normalizedUserId}.`)
    }

    return mapProfileRow(data)
  }

  async assertActiveAdminProfileAccess() {
    const supabase = await getSupabase()
    const { data: authData, error: authError } = await supabase.auth.getUser()

    if (authError) {
      throw new Error(authError.message || 'Unable to verify the signed-in CRM admin.')
    }

    const currentUserId = String(authData?.user?.id ?? '').trim()

    if (!currentUserId) {
      throw new Error('You must be signed in to manage CRM users.')
    }

    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_ACCESS_SELECT)
      .eq('id', currentUserId)
      .maybeSingle()

    if (error) {
      throw new Error(describeProfileLookupError(error))
    }

    if (!data || normalizeProfileRole(data.role) !== 'admin' || data.active !== true) {
      throw new Error('Only active admin users can manage CRM profiles.')
    }
  }
}

function readStoredSession() {
  const preferredStorage = getSupabaseRememberPreference() ? localStorage : sessionStorage
  const fallbackStorage = getSupabaseRememberPreference() ? sessionStorage : localStorage

  return parseStoredSession(preferredStorage) || parseStoredSession(fallbackStorage)
}

function parseStoredSession(storage) {
  try {
    const raw = storage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (_error) {
    return null
  }
}

function writeStoredSession(session, remember) {
  const primaryStorage = remember ? localStorage : sessionStorage
  const secondaryStorage = remember ? sessionStorage : localStorage

  try {
    primaryStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch (_error) {
    // Ignore storage write failures and fall back to the in-memory session.
  }

  try {
    secondaryStorage.removeItem(SESSION_KEY)
  } catch (_error) {
    // Ignore storage cleanup failures.
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch (_error) {
    // Ignore storage cleanup failures.
  }

  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch (_error) {
    // Ignore storage cleanup failures.
  }
}

function mergeCachedUsers(existingUsers, incomingUsers) {
  const nextUsers = [...existingUsers]

  incomingUsers.forEach((incomingUser) => {
    const index = nextUsers.findIndex((user) => user.id === incomingUser.id)

    if (index === -1) {
      nextUsers.push(incomingUser)
      return
    }

    nextUsers[index] = {
      ...nextUsers[index],
      ...incomingUser
    }
  })

  return nextUsers
}

function mapProfileRow(profile) {
  const role = normalizeProfileRole(profile.role)
  return {
    id: String(profile.id ?? '').trim(),
    fullName: String(profile.full_name ?? profile.email ?? 'CRM User').trim(),
    name: String(profile.full_name ?? profile.email ?? 'CRM User').trim(),
    email: String(profile.email ?? '').trim().toLowerCase(),
    role,
    title: deriveRoleTitle(role),
    isSeniorRep: role === 'senior',
    isActive: profile.active !== false,
    callPreference: normalizeCallPreference(profile.call_preference ?? profile.callPreference)
  }
}

async function selectProfilesWithFallback(supabase) {
  let response = await supabase
    .from('profiles')
    .select(PROFILE_SELECT)

  if (!isMissingCallPreferenceColumnError(response.error)) {
    return response
  }

  response = await supabase
    .from('profiles')
    .select(PROFILE_SELECT_FALLBACK)

  return response
}

async function selectProfileByIdWithFallback(supabase, userId) {
  let response = await supabase
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', userId)
    .maybeSingle()

  if (!isMissingCallPreferenceColumnError(response.error)) {
    return response
  }

  response = await supabase
    .from('profiles')
    .select(PROFILE_SELECT_FALLBACK)
    .eq('id', userId)
    .maybeSingle()

  return response
}

function isMissingCallPreferenceColumnError(error) {
  const message = String(error?.message ?? '').toLowerCase()
  return message.includes('call_preference') && message.includes('does not exist')
}

function normalizeCallPreference(value) {
  return String(value ?? '').trim().toLowerCase() === 'google_voice'
    ? 'google_voice'
    : 'system_default'
}

function describeProfileLookupError(error) {
  const message = String(error?.message ?? '').toLowerCase()

  if (message.includes('permission denied') || message.includes('row-level security')) {
    return 'Signed in successfully, but the CRM could not read your profile. Check the public.profiles RLS policy for this authenticated user.'
  }

  return error?.message || 'Unable to load the signed-in CRM profile.'
}

function describeProfileWriteError(error) {
  const message = String(error?.message ?? '').toLowerCase()

  if (error?.code === '23505' || message.includes('duplicate key')) {
    return 'A CRM profile with that email already exists.'
  }

  if (message.includes('permission denied') || message.includes('row-level security')) {
    return 'Supabase rejected the CRM profile change. Check the public.profiles RLS policy for active admins.'
  }

  return error?.message || 'Unable to save the CRM profile.'
}

function isMissingRpcFunctionError(error) {
  const message = String(error?.message ?? '').toLowerCase()
  return message.includes('could not find the function')
    || message.includes('function public.admin_delete_user')
    || error?.code === 'PGRST202'
}

function deriveRoleTitle(role) {
  if (role === 'admin') {
    return 'Administrator'
  }

  if (role === 'support') {
    return 'Support Team'
  }

  if (role === 'senior') {
    return 'Senior Rep'
  }

  return 'Sales Rep'
}

function mapAuthUser(user) {
  return {
    id: String(user?.id ?? '').trim(),
    email: String(user?.email ?? '').trim().toLowerCase(),
    lastSignInAt: user?.last_sign_in_at ?? '',
    appMetadata: user?.app_metadata ?? {},
    userMetadata: user?.user_metadata ?? {}
  }
}

function normalizeProfileRole(role) {
  if (role === 'admin') {
    return 'admin'
  }

  if (role === 'support') {
    return 'support'
  }

  if (role === 'senior_rep') {
    return 'senior'
  }

  return 'sales'
}

function serializeProfileRole(role) {
  if (role === 'admin') {
    return 'admin'
  }

  if (role === 'support') {
    return 'support'
  }

  if (role === 'senior' || role === 'senior_rep') {
    return 'senior_rep'
  }

  return 'sales'
}
