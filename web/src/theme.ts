// Owner-chosen appearance. Dark is the default; light is only ever an explicit choice.
// Pure helpers so the storage fallback is testable without a DOM.

export type Theme = 'dark' | 'light';

/** Where the owner's choice lives in local storage. */
export const THEME_KEY = 'didi-theme';

/** The minimal storage surface this module needs (satisfied by window.localStorage). */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The root element surface the theme is applied to (satisfied by document.documentElement). */
export interface ThemeRoot {
  dataset: Record<string, string | undefined>;
}

/** Only an explicit "light" picks the light theme; anything else stays dark. */
export function resolveTheme(stored: unknown): Theme {
  return stored === 'light' ? 'light' : 'dark';
}

/** Read the saved choice, falling back to dark when storage is unreadable. */
export function loadTheme(storage: ThemeStorage | undefined): Theme {
  try {
    return resolveTheme(storage?.getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

/** Persist the choice; a storage failure must not break the running page. */
export function saveTheme(storage: ThemeStorage | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the session keeps the applied theme and dark remains the default.
  }
}

/** Apply the theme to the root, where the CSS tokens switch on data-theme. */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.dataset.theme = theme;
}
