/**
 * The ONLY place the brand lives in server code; durable identifiers use the
 * permanent codename "context" — see docs/BRANDING.md. Self-hosters can set
 * the BRAND_NAME env var to show their own name in emails and server pages.
 */
export const BRAND_NAME: string = process.env.BRAND_NAME?.trim() || "2ndBrain";
