# Исходные данные мира (v1) — source of truth для контента

Получено от заказчика 2026-10-10 (D158). Формат — `schema_version: "2.0"` из проекта v1
(`data/rooms/*.json`), реестр и карта переходов — оттуда же.

| Файл | Что это | Статус |
|---|---|---|
| `_registry.json` | реестр 50 комнат (этажи 0, −1…−7), `room_id`, `title`, `floor_name`, `batch`, `floor_truth` | получен целиком |
| `_adjacency.json` | карта переходов: 63 ребра, 8 этажей, `unresolved[4]` — открытые вопросы v1 (B1, B17, B28, питание) | получен целиком |
| `rooms/floor0_airlock.json` | публичная часть комнаты «Шлюз» (этап 0): role, exits, atmosphere, lore.public_revelation, hazards, state, events[8], ai_guidance | получен |
| `rooms/floor0_airlock.gm.json` | **GM-only**: `lore.secret_truth.{truth,future_connections}`, `gm.{static_notes,secret_values,puzzle_solutions,manual_controls,noise_note}`, `meta.sensitive:true` | получен |

## Чего нет

Файлов остальных **49 комнат** нет (в v1 их было создано 13). Нужны для промптов 2.3–2.4 —
см. `docs/ARCHITECTURE.md` §4, вопрос Q8.

## Правила обращения (наследуют v1 D55/D58/D59)

1. `*.gm.json` **никогда** не уходит в контекст AI и не отдаётся игрокам. В v3-модели для этого
   нет поля — см. `docs/CONTENT_MAPPING.md`, поправка K7 (GM-only блок в LocationDefinition).
2. «Публичный» файл v1 ≠ публичный вид v3: в нём лежат `ai_guidance` и `lore.secret_truth.restrictions`,
   которые предназначены **модели**, а не игроку (v1 D59). Проекция `PublicLocationView` обязана их отсекать.
3. Никакой контент не додумывается: отсутствующие факты → вопрос заказчику, поле остаётся пустым
   с пометкой `meta.source: "todo"` (принцип v1 D11).

## Анализ

```bash
node tools/inspect-v1-rooms.mjs            # человекочитаемый отчёт
node tools/inspect-v1-rooms.mjs --json     # машинный (для CI и конвертера 2.3)
```
