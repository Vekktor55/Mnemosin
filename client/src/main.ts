/**
 * Единая точка входа клиента (промпт 1.12, п.1).
 *
 * Роутинг без библиотек (D103): MPA — /player/ и /gm/ (две HTML-точки входа,
 * общий shell), выбор приложения по location.pathname. Третьего маршрута нет:
 * неизвестный путь трактуется как /player (корневой index.html редиректит).
 */
import { mount } from 'svelte';

import PlayerApp from './player/PlayerApp.svelte';
import GmApp from './gm/GmApp.svelte';
import './styles/theme.css';

const target = document.getElementById('app');
if (target === null) {
  throw new Error('client: контейнер #app не найден');
}

if (window.location.pathname.startsWith('/gm')) {
  void import('./styles/gm.css').then(() => {
    mount(GmApp, { target: target as HTMLElement });
  });
} else {
  void import('./styles/player.css').then(() => {
    mount(PlayerApp, { target: target as HTMLElement });
  });
}
