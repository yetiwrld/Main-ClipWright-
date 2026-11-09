#!/usr/bin/env node
/**
 * Regenerate `assets/icons/lucide.json` from the installed `lucide-react` set.
 *
 * SPEC 11 §12 asks for the full Lucide library offline. Shipping it as a dependency of the
 * *renderer* would drag React and 1556 modules into a main process that has neither, so the
 * data is generated once into a single JSON asset and committed — the same shape as
 * `/assets/provider-presets.json` and `/assets/whisper-models.json`. That makes the icon set
 * a reviewable artefact: a diff names the icons that changed, and the licence travels with it.
 *
 * Run with `node scripts/generate-icons.mjs` after bumping `lucide-react`. The output is
 * deterministic — sorted by name, one icon per line — so a regeneration that changes nothing
 * produces an empty diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'node_modules/lucide-react/dist/esm/icons');
const targetFile = path.join(root, 'assets/icons/lucide.json');

/** Lucide writes its icon nodes as source text; this reads them without importing React. */
const TAG_PATTERN = /\[\s*"([a-z]+)"\s*,\s*\{([^}]*)\}/g;
const ATTR_PATTERN = /([a-zA-Z0-9-]+):\s*"([^"]*)"/g;

function readShapes(source, name) {
  const shapes = [];
  for (const match of source.matchAll(TAG_PATTERN)) {
    const [, tag, raw] = match;
    const attrs = {};
    for (const attr of raw.matchAll(ATTR_PATTERN)) attrs[attr[1]] = attr[2];
    const number = (key) => {
      if (attrs[key] === undefined) throw new Error(`${name}: <${tag}> has no ${key}`);
      const value = Number(attrs[key]);
      if (!Number.isFinite(value)) throw new Error(`${name}: <${tag}> ${key}="${attrs[key]}"`);
      return value;
    };
    if (tag === 'path') {
      if (!attrs.d) throw new Error(`${name}: <path> has no d`);
      shapes.push(['p', attrs.d]);
    } else if (tag === 'circle') {
      shapes.push(['c', number('cx'), number('cy'), number('r')]);
    } else if (tag === 'ellipse') {
      shapes.push(['e', number('cx'), number('cy'), number('rx'), number('ry')]);
    } else if (tag === 'rect') {
      const rect = ['r', number('x'), number('y'), number('width'), number('height')];
      if (attrs.rx !== undefined) rect.push(number('rx'));
      shapes.push(rect);
    } else if (tag === 'line') {
      shapes.push(['l', number('x1'), number('y1'), number('x2'), number('y2')]);
    } else if (tag === 'polyline' || tag === 'polygon') {
      if (!attrs.points) throw new Error(`${name}: <${tag}> has no points`);
      shapes.push([tag === 'polyline' ? 'o' : 'g', attrs.points]);
    } else {
      // Refused rather than skipped: a silently dropped child draws a broken icon that looks
      // like a design choice. Failing here means the generator gets taught the new tag.
      throw new Error(`${name}: unknown tag <${tag}>`);
    }
  }
  return shapes;
}

const names = fs
  .readdirSync(sourceDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => file.slice(0, -3))
  .sort();

const table = {};
let aliases = 0;
for (const name of names) {
  const source = fs.readFileSync(path.join(sourceDir, `${name}.js`), 'utf8');
  // An alias re-exports another icon (`calendar-days` → `calendar`), so it has no own data and
  // resolving it by name would be wrong: the name would draw the original icon. The picker
  // lists real names only.
  if (/export \{ default \} from/.test(source)) {
    aliases += 1;
    continue;
  }
  if (!source.includes('__iconNode')) continue;
  const shapes = readShapes(source, name);
  if (shapes.length > 0) table[name] = shapes;
}

const readme =
  'Lucide icon data for SPEC 11 §12, generated from lucide-react (ISC). Each entry is a list ' +
  'of children; the tag letter picks the shape: p path(d) | c circle(cx,cy,r) | ' +
  'e ellipse(cx,cy,rx,ry) | r rect(x,y,w,h[,rx]) | l line(x1,y1,x2,y2) | o polyline(points) | ' +
  'g polygon(points). Coordinates are in Lucide\'s 24-box. Regenerate with ' +
  '`node scripts/generate-icons.mjs`.';

const lines = Object.keys(table).map((name) => `  ${JSON.stringify(name)}:${JSON.stringify(table[name])}`);
const body = `{\n  "__readme": ${JSON.stringify(readme)},\n${lines.join(',\n')}\n}\n`;

fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, body);
console.log(
  `wrote ${Object.keys(table).length} icons (${aliases} aliases skipped) to ${path.relative(root, targetFile)}`,
);
