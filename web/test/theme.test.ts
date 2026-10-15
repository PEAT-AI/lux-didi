import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { settingsMarkup } from '../src/settings-view.ts';
import { THEME_KEY, applyTheme, loadTheme, resolveTheme, saveTheme, type ThemeStorage, type ThemeRoot } from '../src/theme.ts';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** The first declaration block for an exact selector, or undefined. */
function block(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(escaped + '\\{([^}]*)\\}'))?.[1];
}
function token(source: string, name: string): string | undefined {
  return source.match(new RegExp('--' + name + ':([^;}]+)'))?.[1]?.trim();
}
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const channels = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
  const linear = channels.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// OUTCOME 1: :root carries the dark token set and every other colour is a token reference.
test('the dark theme is the default token set on :root', () => {
  const root = block(':root');
  assert.ok(root, ':root token block present');
  for (const name of ['bg', 'surface', 'surface-2', 'border', 'text', 'text-secondary', 'accent', 'focus', 'danger', 'banner-bg', 'green', 'muted']) {
    assert.ok(token(root, name), `--${name} defined on :root`);
  }
  assert.equal(token(root, 'green'), 'var(--accent)', '--green aliases the accent');
  assert.equal(token(root, 'muted'), 'var(--text-secondary)', '--muted aliases secondary text');
  assert.ok(luminance(token(root, 'bg')!) < 0.05, 'page background is near-black');
});

// OUTCOME 1: measurable contrast, not just a dark palette.
test('dark text contrast clears 7:1 and secondary clears 4.5:1', () => {
  const root = block(':root')!;
  const surface = token(root, 'surface')!;
  assert.ok(contrast(token(root, 'text')!, surface) >= 7, 'primary text >= 7:1 on surface');
  assert.ok(contrast(token(root, 'text-secondary')!, surface) >= 4.5, 'secondary text >= 4.5:1 on surface');
});

// OUTCOME 3: no literal colour survives outside the token blocks.
test('no hard-coded colour remains outside the token blocks', () => {
  const stripped = css
    .replace(new RegExp(':root\\{[^}]*\\}'), '')
    .replace(new RegExp('\\[data-theme="light"\\]\\{[^}]*\\}'), '');
  assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,8}|rgba?\(/, 'colour literals live only in tokens');
});

// OUTCOME 2: a light theme is defined by the same tokens.
test('a light theme overrides the same tokens under [data-theme="light"]', () => {
  const dark = block(':root')!;
  const light = block('[data-theme="light"]');
  assert.ok(light, 'light token block present');
  const names = [...dark.matchAll(/--([a-z0-9-]+):/g)].map(m => m[1]);
  for (const name of names) assert.ok(token(light, name), `light defines --${name}`);
  assert.ok(luminance(token(light, 'bg')!) > 0.5, 'light background is bright');
});

// OUTCOME 2: the Settings control names Dark and Light and reflects the active choice.
test('settings offer an Appearance Dark / Light control', () => {
  const dark = settingsMarkup({ theme: 'dark' });
  assert.match(dark, /id="appearance-theme"/);
  assert.match(dark, /<option value="dark" selected>Dark<\/option>/);
  assert.match(dark, /<option value="light">Light<\/option>/);
  const light = settingsMarkup({ theme: 'light' });
  assert.match(light, /<option value="light" selected>Light<\/option>/);
});

// OUTCOME 2: dark unless the owner picks light, and storage failures fall back to dark.
test('theme resolution defaults to dark and survives unavailable storage', () => {
  assert.equal(resolveTheme(null), 'dark');
  assert.equal(resolveTheme(undefined), 'dark');
  assert.equal(resolveTheme('light'), 'light');
  assert.equal(resolveTheme('nonsense'), 'dark');
  const throwing: ThemeStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadTheme(throwing), 'dark');
  const store = new Map<string, string>();
  const memory: ThemeStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
  assert.equal(loadTheme(memory), 'dark');
  saveTheme(memory, 'light');
  assert.equal(store.get(THEME_KEY), 'light');
  assert.equal(loadTheme(memory), 'light');
  saveTheme(throwing, 'light'); // must not throw
  const root: ThemeRoot = { dataset: {} };
  applyTheme(root, 'light');
  assert.equal(root.dataset.theme, 'light');
});

// S1-R3: every form control paints from the theme tokens, in both themes.
test('form controls use the theme tokens in both themes', () => {
  assert.match(css, /input,textarea,select\{[^}]*background:var\(--surface-2\)/);
  assert.match(css, /input,textarea,select\{[^}]*color:var\(--text\)/);
  assert.match(css, /input,textarea,select\{[^}]*border:1px solid var\(--border\)/);
  assert.match(css, /button\{[^}]*background:var\(--green\)/);
  assert.match(css, /input:focus-visible[^{]*\{[^}]*outline:3px solid var\(--focus\)/);
  assert.match(css, /:root\{[^}]*color-scheme:dark/);
  assert.match(css, /\[data-theme="light"\]\{[^}]*color-scheme:light/);
});

// S1-R1: the voice stage is compact and the page is dark around it.
test('the orb stage is compact with no tall fixed height', () => {
  assert.doesNotMatch(css, /min-height:500px/, 'no 500px stage band');
  assert.doesNotMatch(css, /min-height:410px/, 'no 410px stage band');
  const canvas = css.match(/\.orb-stage canvas\{width:min?\(?(?:(\d+)px|min\((\d+)px)/);
  assert.ok(canvas, 'a compact orb canvas rule exists');
  const width = Number(canvas[1] ?? canvas[2]);
  assert.ok(width <= 340 && width > 0, `desktop orb canvas is compact (${width}px)`);
});

test('index.html ships a dark theme colour, not the old light one', () => {
  assert.doesNotMatch(html, /content="#f6f4ef"/);
  assert.match(html, /name="theme-color" content="#[0-9a-fA-F]{6}"/);
});
