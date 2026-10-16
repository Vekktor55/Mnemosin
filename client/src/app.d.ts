/// <reference types="vite/client" />

/**
 * Ambient-объявления для tsc -b (промпт 1.12).
 *
 * tsc не понимает .svelte-файлы — их проверяет svelte-check (npm run check -w
 * client), для которого компонентные типы реальны. Для компиляции .ts-модулей,
 * импортирующих компоненты, достаточно общей сигнатуры Svelte 5 Component.
 */
declare module '*.svelte' {
  import type { Component } from 'svelte';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: Component<any, any, any>;
  export default component;
}
