/**
 * Короткие подписи выходов (D177 + D183).
 *
 * Формат: «Дверь в Регистратуру» = VIA_LABEL[via] + ' ' + toAccusative(title цели).
 * Текст не сочиняется: если имени цели нет в реестре (описательный выход),
 * берётся усечённый `direction` и ставится пометка needsReview.
 *
 * Модуль намеренно без зависимостей и без побочных эффектов: его импортируют и анализатор
 * (tools/inspect-v1-rooms.mjs), и contract-тест (tests/contract/real-content.test.ts).
 */

export const EXIT_LABEL_MAX = 60;

export const VIA_LABEL = {
  door: 'Дверь в',
  stairs: 'Лестница в',
  elevator: 'Лифт в',
  shaft: 'Шахта в',
  hatch: 'Люк в',
  vent: 'Вентиляционный ход в',
};

/** Винительный падеж для неодушевлённых существительных и согласованных прилагательных. */
export function toAccusative(title) {
  const m = title.match(/^(.*?)(\s*[(«[].*)?$/s);
  const head = (m?.[1] ?? title).trim();
  const tail = m?.[2] ?? '';
  const words = head.split(/\s+/);
  let needsReview = words.length === 0;

  const declined = words.map((word, idx) => {
    const lower = word.toLowerCase();
    // Одно-двухбуквенные слова и аббревиатуры не склоняются: «Смотровая А» → «Смотровую А».
    if (word.length <= 2 || word === word.toUpperCase()) return word;
    if (lower.endsWith('ая')) return word.slice(0, -2) + 'ую';
    if (lower.endsWith('яя')) return word.slice(0, -2) + 'юю';
    if (lower.endsWith('ия')) return word.slice(0, -2) + 'ию';
    if (lower.endsWith('а') && !lower.endsWith('иа')) return word.slice(0, -1) + 'у';
    if (lower.endsWith('я')) return word.slice(0, -1) + 'ю';
    if (/[оеёуыйи]$/.test(lower)) return word;
    if (lower.endsWith('ь') || lower.endsWith('й')) {
      needsReview = true; // форма совпадает с именительной — проверяем глазами
      return word;
    }
    if (idx === 0) needsReview = true;
    return word;
  });

  return { text: (declined.join(' ') + tail).trim(), needsReview };
}

export function truncateWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '')}…`;
}

/**
 * @param {{via?: string|null, direction?: string|null}} exit
 * @param {string|null} targetTitle — имя цели из _registry.json (null для описательных выходов)
 * @returns {{label: string, source: string, needsReview: boolean}}
 */
export function deriveExitLabel(exit, targetTitle) {
  const via = VIA_LABEL[exit.via] ?? 'Выход в';
  if (typeof targetTitle === 'string' && targetTitle.length > 0) {
    const { text, needsReview } = toAccusative(targetTitle);
    const candidate = `${via} ${text}`;
    if (candidate.length <= EXIT_LABEL_MAX) return { label: candidate, source: 'via+title-accusative', needsReview };
    if (text.length <= EXIT_LABEL_MAX) return { label: text, source: 'title-accusative', needsReview };
  }
  return {
    label: truncateWords(String(exit.direction ?? ''), EXIT_LABEL_MAX),
    source: 'direction-truncated',
    needsReview: true,
  };
}
