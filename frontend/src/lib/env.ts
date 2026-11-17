/** Public, browser-visible configuration. Backend secrets must never be read here. */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
