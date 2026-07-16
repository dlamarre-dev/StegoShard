/**
 * Live camera capture for the restore flow (mobile-first): open the rear
 * camera, scan the printed pages continuously, and collect each page's QR
 * payload directly — no need to take photos and pick them from the gallery.
 *
 * Decoded payloads are deduplicated (pointing at the same page twice is
 * harmless) and handed to the normal import path alongside file uploads.
 */

import { CODEC_QR_GRID, getCodec, toHex } from '@core';
import { el, setStatus } from '../ui/domhelpers';
import { msg } from './i18n';

/** Longest video-frame side handed to the QR decoder (see image-io notes). */
const SCAN_MAX_SIDE = 1000;
const SCAN_INTERVAL_MS = 250;

const captured: Uint8Array[] = [];
const seen = new Set<string>();

export function capturedPayloads(): Uint8Array[] {
  return [...captured];
}

export function capturedCount(): number {
  return captured.length;
}

export function clearCaptured(): void {
  captured.length = 0;
  seen.clear();
}

export function cameraSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export interface CameraElements {
  button: string;
  modal: string;
  video: string;
  count: string;
  done: string;
  close: string;
  /** Element receiving an error message when the camera cannot start. */
  errorStatus: string;
}

/** Wire the scan button + modal. `onChange` fires whenever the count changes. */
export function wireCamera(ids: CameraElements, onChange: (count: number) => void): void {
  const button = el<HTMLButtonElement>(ids.button);
  if (!cameraSupported()) return; // button stays hidden
  button.hidden = false;

  const modal = el<HTMLDialogElement>(ids.modal);
  const video = el<HTMLVideoElement>(ids.video);
  const count = el(ids.count);
  const errorStatus = el(ids.errorStatus);
  const codec = getCodec(CODEC_QR_GRID);

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refreshCount = () => {
    count.textContent = msg('cameraCount', String(captured.length));
    onChange(captured.length);
  };

  const scanFrame = () => {
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    try {
      const payload = codec.decode(ctx.getImageData(0, 0, w, h));
      const key = toHex(payload);
      if (!seen.has(key)) {
        seen.add(key);
        captured.push(payload);
        refreshCount();
        // Brief visual confirmation that a new page was captured.
        video.classList.add('detected');
        setTimeout(() => video.classList.remove('detected'), 350);
      }
    } catch {
      // No readable QR in this frame — keep scanning.
    }
  };

  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    if (modal.open) modal.close();
  };

  button.addEventListener('click', async () => {
    setStatus(errorStatus, '');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch {
      setStatus(errorStatus, msg('errCamera'), true);
      return;
    }
    video.srcObject = stream;
    refreshCount();
    modal.showModal();
    timer = setInterval(scanFrame, SCAN_INTERVAL_MS);
  });

  el<HTMLButtonElement>(ids.done).addEventListener('click', stop);
  el<HTMLButtonElement>(ids.close).addEventListener('click', stop);
  modal.addEventListener('cancel', stop); // Esc key
  modal.addEventListener('close', stop);
}
