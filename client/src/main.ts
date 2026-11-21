/**
 * Единая точка входа клиента (промпт 1.12, п.1).
 *
 * Роутинг без библиотек (D103): MPA — /player/ (этап 1). В v4 старая
 * GM-точка входа (/gm/) удалена вместе с GM workflow; реалтайм-клиент
 * P05 заменит SPA-каркас. Неизвестный путь трактуется как /player.
 */
import { mount } from 'svelte';

import PlayerApp from './player/PlayerApp.svelte';
import './styles/theme.css';

const target = document.getElementById('app');
if (target === null) {
  throw new Error('client: контейнер #app не найден');
}

void import('./styles/player.css').then(() => {
  mount(PlayerApp, { target: target as HTMLElement });
});
