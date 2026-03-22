/**
 * CORS headers required for browser calls via supabase.functions.invoke().
 * Must include apikey + x-client-info (sent by supabase-js) or preflight fails.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, prefer",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export function mergeCors(headers: HeadersInit = {}): Record<string, string> {
  const base = { ...corsHeaders };
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      base[k] = v;
    }
  }
  return base;
}
