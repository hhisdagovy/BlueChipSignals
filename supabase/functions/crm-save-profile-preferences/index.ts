import {
  handleOptionsRequest,
  jsonResponse,
  normalizeWhitespace,
  requireAuthenticatedProfile
} from '../_shared/crm-email.ts'

function normalizeCallPreference(value: unknown) {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (!normalized || normalized === 'system_default') {
    return 'system_default'
  }

  if (normalized === 'google_voice') {
    return 'google_voice'
  }

  throw new Error('Choose a valid calling preference.')
}

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
    const callPreference = normalizeCallPreference(payload.callPreference)

    const { data, error } = await supabase
      .from('profiles')
      .update({
        call_preference: callPreference
      })
      .eq('id', profile.id)
      .select('id, call_preference')
      .single()

    if (error) {
      throw new Error(error.message || 'Unable to save your calling preference.')
    }

    return jsonResponse({
      profile: {
        id: normalizeWhitespace(data?.id) || profile.id,
        callPreference: normalizeCallPreference(data?.call_preference)
      }
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || 'Unable to save your calling preference.')
    const loweredMessage = message.toLowerCase()
    const status = loweredMessage.includes('authorization')
      || loweredMessage.includes('signed in')
      || loweredMessage.includes('active crm users')
      ? 403
      : 400

    return jsonResponse({ error: message }, status)
  }
})
