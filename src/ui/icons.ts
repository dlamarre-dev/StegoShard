/**
 * The option icons shared by the expert forms and the guided wizard.
 *
 * The expert forms carry these inline in `app.html` / `index.html`, because their
 * pickers are static markup; the wizard builds its option list at runtime and so
 * needs the same geometry in code. Keeping one definition here means a redrawn
 * icon cannot end up meaning one thing in the dense form and another in the
 * guided flow, and `icons.test.ts` holds the two copies to it.
 *
 * Built with `createElementNS` rather than an `innerHTML` string: these pages run
 * under a strict CSP and an SVG assembled as real nodes needs no exception.
 */

/** One shape of an icon: an SVG element name plus its attributes. */
type Shape = [string, Record<string, string>];

/** Every option that shows an icon, by the value it stands for. */
export type IconName =
  // save destinations
  | 'disk'
  | 'paper'
  | 'binary'
  | 'sqlite'
  | 'gallery'
  // key delivery
  | 'embedded'
  | 'keyfile'
  | 'stego'
  // image codecs
  | 'color'
  | 'qr';

const ICONS: Record<IconName, Shape[]> = {
  // A framed picture over a screen: images written to disk.
  disk: [
    ['rect', { x: '3', y: '3', width: '14', height: '14', rx: '2' }],
    ['path', { d: 'M7 21h12a2 2 0 0 0 2-2V7' }],
    ['path', { d: 'm3 13 3.5-3.5 3 3' }],
  ],
  // A printer with a sheet coming out.
  paper: [
    ['path', { d: 'M7 9V3h10v6' }],
    ['path', { d: 'M7 19H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2' }],
    ['rect', { x: '7', y: '15', width: '10', height: '6', rx: '1' }],
  ],
  // A single document with a folded corner.
  binary: [
    ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z' }],
    ['path', { d: 'M14 3v5h5' }],
  ],
  // The database cylinder every tool draws for a .db.
  sqlite: [
    ['ellipse', { cx: '12', cy: '6', rx: '8', ry: '3' }],
    ['path', { d: 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6' }],
    ['path', { d: 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' }],
  ],
  // A photo: frame, sun, horizon.
  gallery: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['circle', { cx: '8.5', cy: '9.5', r: '1.5' }],
    ['path', { d: 'm4 18 5-5 4 4 3-3 4 4' }],
  ],
  // A key inside the picture frame.
  embedded: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['circle', { cx: '9.5', cy: '14.5', r: '2.5' }],
    ['path', { d: 'm11.3 12.7 4.2-4.2M14 10l1.8 1.8' }],
  ],
  // A key on its own.
  keyfile: [
    ['circle', { cx: '7.5', cy: '15.5', r: '3.5' }],
    ['path', { d: 'M10.2 12.8 20 3M15 8l3 3' }],
  ],
  // A key hidden in a photo.
  stego: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['path', { d: 'm4 18 5-5 3 3' }],
    ['circle', { cx: '15.5', cy: '13', r: '2.5' }],
    ['path', { d: 'm17.3 11.2 3.2-3.2M19 9.5l1.5 1.5' }],
  ],
  // A grid of cells: the colour grid.
  color: [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'M9 3v18M15 3v18M3 9h18M3 15h18' }],
  ],
  // The three finder squares of a QR code.
  qr: [
    ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
    ['path', { d: 'M14 14h3v3h-3z' }],
    ['path', { d: 'M19 19h2v2h-2z' }],
  ],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The stroke setup the static markup uses, so both copies look identical. */
const FRAME: Record<string, string> = {
  class: 'seg-icon',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.7',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
};

/** Build one icon. Decorative: the visible label carries the meaning. */
export function iconSvg(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries(FRAME)) svg.setAttribute(k, v);
  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

/** The shapes of one icon, as the attribute strings a page would contain. */
export function iconShapeAttrs(name: IconName): string[] {
  return ICONS[name].flatMap(([, attrs]) => Object.values(attrs));
}

export const ICON_NAMES = Object.keys(ICONS) as IconName[];
