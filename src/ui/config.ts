/**
 * Build-time configuration, injected by Vite from a gitignored `.env`
 * (see .env.example). Nothing sensitive is committed.
 */

export const GOOGLE_CLIENT_ID: string = import.meta.env.STEGOSHARD_GOOGLE_CLIENT_ID ?? '';

/** Whether the optional Google Photos destination is available in this build. */
export const HAS_GOOGLE_PHOTOS: boolean = GOOGLE_CLIENT_ID.length > 0;
