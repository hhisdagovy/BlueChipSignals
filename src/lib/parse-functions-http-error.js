/**
 * supabase.functions.invoke() often sets error.message to
 * "Edge Function returned a non-2xx status code". The real reason is usually
 * in the JSON body as { "error": "..." } on error.context (a Response).
 */
export async function parseFunctionsHttpError(error) {
    const fallback = error?.message || 'Edge Function request failed';
    const res = error?.context;
    if (!res || typeof res.clone !== 'function') {
        return fallback;
    }
    try {
        const text = await res.clone().text();
        if (!text || !String(text).trim()) {
            return fallback;
        }
        try {
            const body = JSON.parse(text);
            if (body && typeof body.error === 'string') {
                return body.error;
            }
            if (body && body.error != null) {
                return String(body.error);
            }
            if (body && typeof body.message === 'string') {
                return body.message;
            }
        } catch {
            return String(text).trim().slice(0, 400);
        }
    } catch {
        return fallback;
    }
    return fallback;
}
