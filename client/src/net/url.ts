/**
 * Адреса транспорта (промпт 1.12, п.1).
 *
 * Dev (vite, :5173): /health и /ws проксируются на :3000 (vite.config.ts),
 * остальные HTTP-маршруты идут напрямую на http://localhost:3000 — CORS dev
 * разрешает origin 5173 (apps/server/src/app.ts, corsOrigins).
 * Prod: клиент отдаёт сам сервер из client/dist (same-origin) — базы пустые,
 * всё относительно текущего origin.
 * VITE_API_BASE — явный override (например, e2e на нестандартном порту).
 */

export function wsUrl(): string {
  const override = import.meta.env['VITE_WS_URL'];
  if (typeof override === 'string' && override.length > 0) return override;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}

export function apiBase(): string {
  const override = import.meta.env['VITE_API_BASE'];
  if (typeof override === 'string' && override.length > 0) return override.replace(/\/+$/, '');
  return import.meta.env.DEV ? 'http://localhost:3000' : '';
}
