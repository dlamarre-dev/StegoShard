/**
 * Renders the localized legal pages (Privacy Policy, Terms of Service). The
 * prose for every supported locale lives in the sibling JSON catalogs; this
 * module picks a locale (from `?lang=` or the browser), builds the page as real
 * DOM nodes — never innerHTML — and offers a visible language selector.
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
import zhTW from './zh_TW.json';

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

// Native language names for the selector, in the order we present them.
const LOCALES: Array<{ code: string; name: string; htmlLang: string }> = [
  { code: 'en', name: 'English', htmlLang: 'en' },
  { code: 'fr', name: 'Français', htmlLang: 'fr' },
  { code: 'de', name: 'Deutsch', htmlLang: 'de' },
  { code: 'es', name: 'Español', htmlLang: 'es' },
  { code: 'it', name: 'Italiano', htmlLang: 'it' },
  { code: 'pt', name: 'Português', htmlLang: 'pt' },
  { code: 'ja', name: '日本語', htmlLang: 'ja' },
  { code: 'zh_TW', name: '繁體中文', htmlLang: 'zh-Hant' },
];

const CATALOGS: Record<string, Pages> = {
  en: en as unknown as Pages,
  fr: fr as unknown as Pages,
  de: de as unknown as Pages,
  es: es as unknown as Pages,
  it: it as unknown as Pages,
  pt: pt as unknown as Pages,
  ja: ja as unknown as Pages,
  zh_TW: zhTW as unknown as Pages,
};

/** Codes we can render, in presentation order. */
export const SUPPORTED_LOCALES = LOCALES.map((l) => l.code);

/**
 * Map an explicit `?lang=` override (if any) and the browser language to a
 * supported locale code. Pure — no globals — so it can be unit-tested. Any
 * `zh-*` tag resolves to Traditional Chinese (the only Chinese variant we
 * ship); everything unrecognized falls back to English.
 */
export function resolveLocale(requested: string | null, navLang: string): string {
  if (requested) {
    if (CATALOGS[requested]) return requested;
    const norm = requested.toLowerCase();
    if (norm.startsWith('zh')) return 'zh_TW';
    const byPrefix = SUPPORTED_LOCALES.find((c) => c === norm.split('-')[0]);
    if (byPrefix) return byPrefix;
  }
  const nav = (navLang || 'en').toLowerCase();
  if (nav.startsWith('zh')) return 'zh_TW';
  const prefix = nav.split('-')[0] ?? 'en';
  return SUPPORTED_LOCALES.find((c) => c === prefix) ?? 'en';
}

function pickLocale(): string {
  return resolveLocale(new URLSearchParams(location.search).get('lang'), navigator.language);
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

  /** Render the document in `locale`, live — no page reload. */
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
  // languages never piles up history entries — one Back press returns to the
  // app the visitor came from.
  select.addEventListener('change', () => {
    const params = new URLSearchParams(location.search);
    params.set('lang', select.value);
    history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
    paint(select.value);
  });

  paint(pickLocale());
}
