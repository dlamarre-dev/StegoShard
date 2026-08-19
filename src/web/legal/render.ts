/**
 * Renders the localized legal pages (Privacy Policy, Terms of Service). The
 * prose for every supported locale lives in the sibling JSON catalogs; this
 * module picks a locale (from `?lang=` or the browser), builds the page as real
 * DOM nodes, never innerHTML, and offers a visible language selector.
 *
 * The page URLs (privacy.html / terms.html) stay fixed, so links already
 * registered with search engines keep working; only the rendered language
 * changes.
 */

import en from './en.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';
import it from './it.json';
import pt from './pt.json';
import ja from './ja.json';
import ko from './ko.json';
import zhTW from './zh_TW.json';
// One definition, shared with the web app's i18n and the offline launcher.
import { LOCALES, LOCALE_CODES, resolveLocale } from '../../ui/locales';
// The same stored choice the app writes; these pages are a separate entry point.
import { storedLocale, storeLocale } from '../lang-store';

type Run = string | { b: string } | { code: string } | { a: string; href: string };
type Block = { p: Run[] } | { ul: Run[][] };
interface Section {
  h: string;
  blocks: Block[];
}
interface LegalDoc {
  title: string;
  heading: string;
  updatedLabel: string;
  home: string;
  intro: Block[];
  sections: Section[];
}
export type DocKey = 'privacy' | 'terms';
type Pages = Record<DocKey, LegalDoc>;

const CATALOGS: Record<string, Pages> = {
  en: en as unknown as Pages,
  fr: fr as unknown as Pages,
  de: de as unknown as Pages,
  es: es as unknown as Pages,
  it: it as unknown as Pages,
  pt: pt as unknown as Pages,
  ja: ja as unknown as Pages,
  ko: ko as unknown as Pages,
  zh_TW: zhTW as unknown as Pages,
};

/** Codes we can render, in presentation order. */
export const SUPPORTED_LOCALES = LOCALE_CODES;

export { resolveLocale };

/**
 * Which language to render, in order of precedence: an explicit `?lang=`, then
 * the choice the visitor made in the app, then the browser.
 *
 * The stored choice is what this exists for. These pages are reached by a footer
 * link from an app the visitor may well have switched out of their browser's
 * language, and following that link into a different language reads as the link
 * being broken. `?lang=` still wins, so a shared link renders as its sender meant
 * it to rather than in the recipient's saved preference.
 *
 * Pure, and separate from `pickLocale` below, because the precedence is the part
 * worth testing and `location`/`navigator` are not available to a test.
 */
export function preferredLocale(
  urlLang: string | null | undefined,
  stored: string | null | undefined,
  ambient: string,
): string {
  // Resolved innermost first: stored-or-browser gives a valid code, which then
  // serves as the fallback for the URL override. An unrecognized `?lang=` is
  // thereby ignored in favour of the stored choice rather than skipping past it.
  const chosen = stored ? resolveLocale(stored, ambient) : resolveLocale(null, ambient);
  return resolveLocale(urlLang, chosen);
}

function pickLocale(): string {
  return preferredLocale(
    new URLSearchParams(location.search).get('lang'),
    storedLocale(),
    navigator.language,
  );
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function runToNode(run: Run): Node {
  if (typeof run === 'string') return document.createTextNode(run);
  if ('b' in run) {
    const strong = document.createElement('strong');
    strong.textContent = run.b;
    return strong;
  }
  if ('code' in run) {
    const code = document.createElement('code');
    code.textContent = run.code;
    return code;
  }
  const a = document.createElement('a');
  a.href = run.href;
  a.textContent = run.a;
  return a;
}

function blockToNode(block: Block): Node {
  if ('p' in block) {
    const p = document.createElement('p');
    for (const run of block.p) p.appendChild(runToNode(run));
    return p;
  }
  const ul = document.createElement('ul');
  for (const item of block.ul) {
    const li = document.createElement('li');
    for (const run of item) li.appendChild(runToNode(run));
    ul.appendChild(li);
  }
  return ul;
}

/**
 * Render a legal document into the page shell.
 * @param docKey which document to show
 * @param date   the "last updated" date (kept in the entry point, not the prose)
 */
export function renderLegal(docKey: DocKey, date: string): void {
  const home = el<HTMLAnchorElement>('home-link');
  const body = el('legal-body');
  const select = el<HTMLSelectElement>('lang-select');

  // Build the language options once; `paint` only updates the selected value.
  select.replaceChildren();
  for (const loc of LOCALES) {
    const opt = document.createElement('option');
    opt.value = loc.code;
    opt.textContent = loc.name;
    select.appendChild(opt);
  }

  /** Render the document in `locale`, live, with no page reload. */
  function paint(locale: string): void {
    const doc = (CATALOGS[locale] ?? CATALOGS.en!)[docKey];
    const active = LOCALES.find((l) => l.code === locale) ?? LOCALES[0]!;

    document.documentElement.lang = active.htmlLang;
    document.title = doc.title;
    el('legal-heading').textContent = doc.heading;
    // A back arrow makes returning to the app one obvious click, regardless of
    // how many times the language was toggled.
    home.textContent = `← ${doc.home}`;
    el('legal-updated').textContent = `${doc.updatedLabel}: ${date}`;

    body.replaceChildren();
    for (const block of doc.intro) body.appendChild(blockToNode(block));
    for (const section of doc.sections) {
      const h = document.createElement('h2');
      h.textContent = section.h;
      body.appendChild(h);
      for (const block of section.blocks) body.appendChild(blockToNode(block));
    }
    select.value = locale;
  }

  // Switch live and keep the URL shareable, but with replaceState so toggling
  // languages never piles up history entries; one Back press returns to the
  // app the visitor came from.
  select.addEventListener('change', () => {
    const params = new URLSearchParams(location.search);
    params.set('lang', select.value);
    history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
    // Persisted so the app honours it on the way back, the same way this page
    // honours the app's. Only an explicit choice is stored: arriving on a
    // `?lang=` link must not silently rewrite the visitor's own preference.
    storeLocale(select.value);
    paint(select.value);
  });

  paint(pickLocale());
}
