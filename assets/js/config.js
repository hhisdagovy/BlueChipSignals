/* ============================================================
   config.js — Blue Chip Signals
   Central configuration for API keys and external endpoints.

   NOTE: These keys are readable in the browser since this is a
   static site. Rotate them here when needed. For true key security,
   route API calls through a serverless function (Firebase Functions,
   Netlify Functions, etc.) so the key never reaches the client.
   ============================================================ */

export const POLYGON_API_KEY      = '%%POLYGON_API_KEY%%';
export const BLS_API_KEY          = '%%BLS_API_KEY%%';
export const ALPHA_VANTAGE_KEY    = '%%ALPHA_VANTAGE_KEY%%';
