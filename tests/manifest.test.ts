import { describe, it, expect } from 'vitest';
import { buildManifest } from '../src/manifest.config';

describe('buildManifest', () => {
  it('produces a valid MV3 base for Chrome', () => {
    const m = buildManifest('chrome');
    expect(m.manifest_version).toBe(3);
    expect(m.default_locale).toBe('en');
    expect(m.name).toBe('__MSG_extName__');
    expect((m.background as { service_worker: string }).service_worker).toBe('background.js');
    // Minimal permissions: only 'storage' by default (no offscreen).
    expect(m.permissions).toEqual(['storage']);
  });

  it('allows WASM execution via CSP', () => {
    const csp = buildManifest('chrome').content_security_policy as {
      extension_pages: string;
    };
    expect(csp.extension_pages).toContain("'wasm-unsafe-eval'");
  });

  it('contains no identity or host permissions', () => {
    const m = buildManifest('chrome');
    expect(m.permissions).not.toContain('identity');
    expect(m).not.toHaveProperty('optional_permissions');
    expect(m).not.toHaveProperty('optional_host_permissions');
  });

  it('uses an event-page background and Gecko settings for Firefox', () => {
    const m = buildManifest('firefox');
    expect((m.background as { scripts: string[] }).scripts).toEqual(['background.js']);
    expect(m).toHaveProperty('browser_specific_settings');
    expect(m).not.toHaveProperty('optional_permissions');
    expect(m).not.toHaveProperty('optional_host_permissions');
  });
});
