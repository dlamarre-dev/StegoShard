/**
 * Google Photos destination (plan §6, Phase 4) — an OPTIONAL convenience, never
 * the only copy. Google Photos recompresses uploads to JPEG; the Cloud profile
 * survives it (see src/core/codec/recompression.test.ts).
 *
 * OAuth uses browser.identity.launchWebAuthFlow (cross-browser) with the implicit
 * flow — no client secret, and our per-session model does not need refresh
 * tokens. The `identity` permission and the Google host permissions are optional
 * and requested on demand. Upload uses the append-only Library API into a
 * dedicated album; restore uses the Picker API to let the user select them back.
 */

import browser from 'webextension-polyfill';
import {
  exportVault,
  importVault,
  getCodec,
  decodeHeader,
  PROFILE_CLOUD,
  toHex,
  verifyImageExport,
  type KeyMode,
  type VaultKey,
} from '@core';
import { GOOGLE_CLIENT_ID } from './config';
import { decodeImageBytes, downloadBlob, imageWithLabelToPngBlob } from './image-io';

const SCOPES = [
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
];
const HOST_PERMISSIONS = [
  'https://photoslibrary.googleapis.com/*',
  'https://photospicker.googleapis.com/*',
  'https://*.googleusercontent.com/*',
];
const TOKEN_KEY = 'stegoshard.gphotos_token';
const BATCH_CREATE_MAX = 50;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Whether a URL points at a Google-owned host (safe to send the token to). */
function isGoogleHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'googleusercontent.com' ||
      host.endsWith('.googleusercontent.com') ||
      host === 'google.com' ||
      host.endsWith('.google.com')
    );
  } catch {
    return false;
  }
}

/** Request the optional identity + host permissions (must run in a user gesture). */
async function ensurePermissions(): Promise<void> {
  // 'identity' is a valid optional permission but missing from the polyfill's
  // typed union, so cast to the request method's parameter type.
  const request = { permissions: ['identity'], origins: HOST_PERMISSIONS };
  const granted = await browser.permissions.request(
    request as unknown as Parameters<typeof browser.permissions.request>[0],
  );
  if (!granted) throw new Error('Google Photos access was not granted');
}

/** Obtain an access token (cached in the session), running the OAuth flow if needed. */
async function getToken(): Promise<string> {
  const cached = (await browser.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as
    | CachedToken
    | undefined;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const redirectUri = browser.identity.getRedirectURL();
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    '&response_type=token' +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    '&prompt=consent';

  const redirect = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!redirect) throw new Error('authorization was cancelled');
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error(`authorization failed: ${params.get('error') ?? 'no token'}`);
  const expiresIn = Number(params.get('expires_in') ?? '3600');
  await browser.storage.session.set({
    [TOKEN_KEY]: { token, expiresAt: Date.now() + expiresIn * 1000 } satisfies CachedToken,
  });
  return token;
}

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!resp.ok) {
    throw new Error(`Google Photos API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

async function createAlbum(token: string, title: string): Promise<string> {
  const album = await api<{ id: string }>(token, 'https://photoslibrary.googleapis.com/v1/albums', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ album: { title } }),
  });
  return album.id;
}

async function uploadBytes(token: string, bytes: Uint8Array, fileName: string): Promise<string> {
  const resp = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-Content-Type': 'image/png',
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': fileName,
    },
    body: bytes as BufferSource,
  });
  if (!resp.ok) throw new Error(`upload failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.text(); // the body is the upload token
}

async function batchCreate(
  token: string,
  albumId: string,
  items: { fileName: string; uploadToken: string; description: string }[],
): Promise<void> {
  await api(token, 'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      albumId,
      newMediaItems: items.map((it) => ({
        description: it.description,
        simpleMediaItem: { fileName: it.fileName, uploadToken: it.uploadToken },
      })),
    }),
  });
}

/** Encode a file into the Cloud profile and upload it to a dedicated album. */
export async function saveToPhotos(
  file: File,
  key: VaultKey,
  options: { keyMode: KeyMode; title?: string | undefined; date?: string | undefined },
): Promise<{ imageCount: number; albumTitle: string }> {
  await ensurePermissions();
  const token = await getToken();

  const content = new Uint8Array(await file.arrayBuffer());
  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(file.name, content, key, {
    profile: PROFILE_CLOUD,
    keyMode: options.keyMode,
  });
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  // Verify the local encode restores before uploading. (The cloud QR uses the
  // recompression-robust PROFILE_CLOUD; server-side JPEG recompression itself
  // isn't verifiable here without re-download — see docs.)
  await verifyImageExport(imagePayloads, key.dek, file.name, content);
  const setHex = toHex(setId);
  const albumTitle = `StegoShard ${options.title || setHex}`;
  const albumId = await createAlbum(token, albumTitle);

  const created: { fileName: string; uploadToken: string; description: string }[] = [];
  for (let i = 0; i < imagePayloads.length; i++) {
    const img = codec.encode(imagePayloads[i]!, PROFILE_CLOUD);
    const blob = await imageWithLabelToPngBlob(img, {
      title: options.title,
      date: options.date,
      index: i + 1,
      total: imagePayloads.length,
    });
    const png = new Uint8Array(await blob.arrayBuffer());
    const fileName = `stegoshard-${setHex}-${String(i + 1).padStart(2, '0')}.png`;
    const uploadToken = await uploadBytes(token, png, fileName);
    created.push({ fileName, uploadToken, description: `page ${i + 1}/${imagePayloads.length}` });
  }
  for (let i = 0; i < created.length; i += BATCH_CREATE_MAX) {
    await batchCreate(token, albumId, created.slice(i, i + BATCH_CREATE_MAX));
  }

  // Keyfile/stego key blocks still go to disk (they are not photos).
  if (keyMode !== 'embedded') {
    downloadBlob(new Blob([keyBlock as BufferSource]), `stegoshard-${setHex}.key`);
  }
  return { imageCount: imagePayloads.length, albumTitle };
}

// --- Restore via the Picker API ---------------------------------------------

interface PickerSession {
  id: string;
  pickerUri: string;
  mediaItemsSet: boolean;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
}

interface PickedItem {
  mediaFile?: { baseUrl: string; mimeType: string; filename?: string };
}

function parseDurationSeconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value.replace(/s$/, ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function pollUntilPicked(token: string, session: PickerSession): Promise<void> {
  const interval = parseDurationSeconds(session.pollingConfig?.pollInterval, 3) * 1000;
  const timeout = parseDurationSeconds(session.pollingConfig?.timeoutIn, 300) * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const s = await api<PickerSession>(
      token,
      `https://photospicker.googleapis.com/v1/sessions/${session.id}`,
    );
    if (s.mediaItemsSet) return;
  }
  throw new Error('timed out waiting for photo selection');
}

/**
 * Restore from Google Photos: the user picks the vault's images with the Picker,
 * they are downloaded and decoded, and the original file is reconstructed.
 */
export async function restoreFromPhotos(
  password: string,
  keyBlock: Uint8Array | undefined,
  onPickerOpen: (url: string) => void,
): Promise<{ filename: string }> {
  await ensurePermissions();
  const token = await getToken();

  const session = await api<PickerSession>(
    token,
    'https://photospicker.googleapis.com/v1/sessions',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  onPickerOpen(session.pickerUri);
  await pollUntilPicked(token, session);

  const items: PickedItem[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ sessionId: session.id, pageSize: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await api<{ mediaItems?: PickedItem[]; nextPageToken?: string }>(
      token,
      `https://photospicker.googleapis.com/v1/mediaItems?${query.toString()}`,
    );
    items.push(...(page.mediaItems ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const payloads: Uint8Array[] = [];
  for (const item of items) {
    if (!item.mediaFile?.baseUrl) continue;
    // Only ever send the bearer token to a Google-owned host — never trust the
    // API-supplied baseUrl blindly (defense-in-depth against token leakage).
    if (!isGoogleHost(item.mediaFile.baseUrl)) continue;
    const resp = await fetch(`${item.mediaFile.baseUrl}=d`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) continue;
    const payload = await decodeImageBytes(new Uint8Array(await resp.arrayBuffer()));
    if (payload) payloads.push(payload);
  }
  if (payloads.length === 0) throw new Error('no readable StegoShard images were selected');

  const { filename, content } = await importVault(payloads, password, { keyBlock });
  downloadBlob(new Blob([content as BufferSource]), filename);
  return { filename };
}
