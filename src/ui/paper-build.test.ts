/**
 * Instruction-sheet localization data (shared by the web app, extension, and
 * CLI paper output). Guards that every locale is complete — including the
 * `page` word used for the "Page x / N" line — and that locale selection maps
 * as expected.
 */

import { describe, it, expect } from 'vitest';
import { INSTRUCTIONS, type InstructionCopy, instructionLangs } from './paper-build';

const REQUIRED: (keyof InstructionCopy)[] = [
  'heading',
  'intro',
  'steps',
  'resilience',
  'project',
  'keyLocation',
  'passwordHint',
  'preservation',
  'warning',
  'footer',
  'page',
];

describe('instruction copy', () => {
  it('ships all nine locales, each complete', () => {
    expect(Object.keys(INSTRUCTIONS).sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'zh_CN', 'zh_TW'].sort(),
    );
    for (const [code, copy] of Object.entries(INSTRUCTIONS)) {
      for (const field of REQUIRED) {
        expect(copy[field], `${code}.${field}`).toBeTruthy();
      }
      expect(copy.steps.length).toBe(3);
      expect(typeof copy.page).toBe('string');
      expect(copy.page.length).toBeGreaterThan(0);
    }
  });

  it('localizes the page word per locale', () => {
    expect(instructionLangs('en')[0]!.page).toBe('Page');
    expect(instructionLangs('de')[0]!.page).toBe('Seite');
    expect(instructionLangs('es')[0]!.page).toBe('Página');
    expect(instructionLangs('ja')[0]!.page).toBe('ページ');
    expect(instructionLangs('zh_TW')[0]!.page).toBe('頁');
    expect(instructionLangs('zh-CN')[0]!.page).toBe('页');
  });

  it('prints the chosen locale first, English as the durable fallback', () => {
    expect(instructionLangs('en')).toEqual([INSTRUCTIONS.en]);
    const fr = instructionLangs('fr');
    expect(fr[0]).toBe(INSTRUCTIONS.fr);
    expect(fr[1]).toBe(INSTRUCTIONS.en);
    // Traditional vs Simplified Chinese routing.
    expect(instructionLangs('zh-Hant')[0]).toBe(INSTRUCTIONS.zh_TW);
    expect(instructionLangs('zh')[0]).toBe(INSTRUCTIONS.zh_CN);
    // Unknown → English only.
    expect(instructionLangs('kl')).toEqual([INSTRUCTIONS.en]);
  });
});
