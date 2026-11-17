# MNEMOSIN v4 — DECISION REGISTER (P01)

**Deliverable:** P01 — Decision Register & ADR pass.  
**Branch:** `arch-v2`  
**Current HEAD at creation:** `d292715ea96e80743075fc969915646520724565`  
**Audited source-tree snapshot:** `55ddad6f6c53ae7baabc9c1f753f4c682aec51ea`  
**Date:** 2026-11-17  
**Status:** Prepared for project-owner review. P01 does not implement, approve or enact any decision.

**Sources (seven specifications + two supporting documents):**

1. `docs/SYSTEM_ARCHITECTURE.md`
2. `docs/HOT_COLD_DESIGN.md`
3. `docs/WORLD_SIMULATION.md`
4. `docs/DOLL_AI.md`
5. `docs/ANDREY_AI.md`
6. `docs/NETWORK_PROTOCOL.md`
7. `docs/MATCH_LIFECYCLE.md`
8. `docs/IMPLEMENTATION_ROADMAP.md` — phase order and dependencies
9. `docs/implementation/REPOSITORY_AUDIT.md` — verified repository state (P00)

---

## §1. Purpose and Rules

### §1.1. Purpose

This register is the single inventory of open architectural and game-design decisions in the v4 specifications. Its job is to:

- make every open question visible in one place;
- preserve the original document IDs while removing register-level duplication;
- classify each question by what it blocks (`BLOCKER` / `PROTOTYPE` / `CONTENT` / `DEFERRED`);
- separate decisions required for the **first vertical slice (P03–P05)** from later production blockers;
- give the project owner an ordered decision queue.

**P01 does not implement decisions.** A question being listed here grants no permission to implement a behaviour, and a suggested option being quoted here does not make it approved.

### §1.2. Source priority

When sources conflict, apply the project-wide priority order from the master plan:

1. The latest explicit decision of the project owner.
2. Positions marked **СОГЛАСОВАНО** in the target specifications.
3. Approved architectural decisions and ADRs.
4. The original game canon «Цикл 48».
5. Positions marked **ПРЕДЛАГАЕТСЯ** — as implementation options only.
6. Current code — evidence of actual implementation, never a reason to preserve old game rules.

### §1.3. Meaning of source statuses

| Status | Meaning |
|---|---|
| **СОГЛАСОВАНО** | Explicitly fixed by the original canon or confirmed by the project owner. |
| **ПРЕДЛАГАЕТСЯ** | A proposed option/engineering recommendation. Can change after prototyping. Not a decision. |
| **ОТКРЫТО** | Requires an owner decision, a test/measurement, or game-balance work. |

### §1.4. Rules binding on the coding agent

1. The coding agent **does not decide game rules** and does not convert a proposal into canon.
2. A question present in this register is **not resolved** by being listed, classified or prototyped.
3. Prototypes may use values explicitly labelled `PROTOTYPE-ONLY`; such values must never silently become production rules or production configuration.
4. Original document IDs are immutable. Local register keys (`UNASSIGNED-*-L<line>`, `GROUP-*`) are register-local identifiers, **not** specification IDs.
5. Where a source lists options, the register quotes them; it never adds options of its own.
6. Absence of data is recorded as `NOT SPECIFIED` or `OWNER INPUT REQUIRED` — never filled by guesswork.
7. Spec text is not edited in P01. Contradictions are preserved and reported (§5).

---

## §2. Executive Summary

| Metric | Value |
|---|---|
| Numbered questions verified in the seven specifications | **136** (WS 22, HC 14, DOLL-OPEN 19, NET 20, ML 38, AND-OPEN 23) |
| Additional inline `ОТКРЫТО` items found | **78** |
| Of those, distinct decisions not already covered by a numbered ID | **21** |
| Of those, duplicate/facet anchors folded into numbered rows | **57** |
| Total inventory entries in this register | **157** (136 numbered + 21 unnumbered) |
| Register-level duplicate groups linking several IDs to one decision | **53 groups (38 multi-ID, 141 linked IDs)** |
| BLOCKER | **71** |
| PROTOTYPE | **46** |
| CONTENT | **22** |
| DEFERRED | **18** |
| Decisions that touch the first vertical slice (P03–P05) | **5 groups (8 IDs) MUST** + **20 provisional** + rest NOT REQUIRED |
| Questions that can be postponed without architectural damage | **18 (DEFERRED)** |

**Reading note.** Numbers were produced by a full ID-by-ID check, not by trusting the ID ranges: all 136 numbered IDs exist and are filled; no ID is missing. Duplication is recorded as cross-reference, never by deleting an original ID.

---

## §3. Canonical Decision Register

### §3.0. Column legend and standing defaults

Each subsection below names its source document. Column meanings:

- **Anchor** — line(s) in the source document at the current audited snapshot; `§` denotes the enclosing section.
- **Question** — faithful short form; full text remains in the source.
- **Status** — source status. Default for every row: `ОТКРЫТО`.
- **Class** — `BLOCKER` / `PROTOTYPE` / `CONTENT` / `DEFERRED` (rules: §4).
- **Blocks** — exact scope: `slice` (P03–P05), `production <subsystem>`, `full lifecycle`. `—` for CONTENT/DEFERRED rows that block no implementation.
- **Impact** — consequence if the decision stays open.
- **Options** — only options literally present in the source; `нет` means the source lists none.
- **Proto?** — can a prototype or interface be built without the canonical decision: `YES` / `PARTIAL` / `NO`.
- **Cross-ref** — register group keys (`G*`) and original IDs describing the same decision.
- **Next action** — the concrete next step for the owner/team.

**Standing defaults** (stated once instead of repeating in every row): *Decision owner* = project owner for all rows; *Required approval* = owner-approved update of the source specification (plus ADR if the owner chooses to create an ADR structure); *Source status* = `ОТКРЫТО` unless the row says otherwise.

Row-level IDs are immutable document IDs. `UNASSIGNED-*` keys are register-local and must not be cited as specification IDs.

### §3.1. WORLD_SIMULATION.md — WS-01…WS-22

Table source: `docs/WORLD_SIMULATION.md` §19 (lines 1438–1459). Inline anchors verified at lines 235, 557, 582, 594, 637, 655, 722, 764, 797, 844, 896, 953, 1090.

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| WS-01 | L1438 | Вся карта этажа — единый WorldSpace или отдельные пространства/сегменты? | ОТКРЫТО | PROTOTYPE | — (P03 schema shape; P10 floors) | World identity and scene loading model undefined | единый WorldSpace / отдельные пространства | YES | G5 | Prototype one-space test room; owner confirms multi-floor model before P10 |
| WS-02 | L1439, L235 | Мировые координаты в tile units и центр клетки `(gx+0.5, gy+0.5)` — подтверждаем? | ОТКРЫТО | **BLOCKER** | **slice** (P03/P04 contracts) | No server/client coordinate contract; all projections blocked | tile units + cell centre (предложение на подтверждение) | PARTIAL | G2 | Owner ratifies coordinate convention before P04 |
| WS-03 | L1440 | Движение: свободное направленное, click-to-move или оба? | ОТКРЫТО | **BLOCKER** | **slice** (P04/P05 input) | Input schema, prediction model and client UX undefined | свободное направленное / click-to-move / оба | PARTIAL | G1 (HC-02, NET-02) | Decide input mode with HC-02/NET-02 in one decision |
| WS-04 | L1441, L637 | Должны ли игроки физически блокировать друг друга? | ОТКРЫТО | PROTOTYPE | — (P07 social) | Player collision rule unknown; blocking must not be implemented blind | блокировать / проходить сквозь с визуальным/социальным ограничением | YES | G4 | Prototype pass-through; owner decides final rule |
| WS-05 | L1442, L582 | Collider персонажа — круг, AABB или другое? | ОТКРЫТО | PROTOTYPE | — (production P04) | Final collider shape unknown | круг / AABB / другое; §5.6 предлагает круг (ПРЕДЛАГАЕТСЯ) | YES | G3 (HC-03) | Prototype with proposed circle; owner confirms final shape |
| WS-06 | L1443, L594 | Навигация 4- или 8-соседняя? | ОТКРЫТО | PROTOTYPE | — (P08A navigation) | Doll pathfinding convention undefined | 4 / 8 соседей | YES | G3, DOLL-OPEN-11 | Measure both on test room; owner ratifies |
| WS-07 | L1444 | Какие типы поверхностей влияют на шум движения? | ОТКРЫТО | CONTENT | — | Stimulus generation lacks authored surface taxonomy | нет | PARTIAL | G8 | Author surface list together with World Pack content |
| WS-08 | L1445, L764, L797 | Точная модель концентрации газа и единицы сканера (ppm vs нормализованная шкала)? | ОТКРЫТО | PROTOTYPE | — (production P07 gas) | Gas field and filter mechanics undefined | ppm / нормализованная шкала | YES | G6 (ARCH-L429) | Prototype normalized scale; owner fixes canonical unit |
| WS-09 | L1446 | Есть ли динамические утечки/вентиляционные изменения газа? | ОТКРЫТО | DEFERRED | — (P07 advanced) | Event-driven gas overlays unspecified | статическая/сценарная карта / дискретное событие | YES | G6 | Defer until P07 spatial mechanics |
| WS-10 | L1447, L844 | Как суммируются несколько источников света и влияют препятствия? | ОТКРЫТО | PROTOTYPE | — (production P07 light) | Gameplay illumination model absent | §9.3: contribution в радиусе, падение, блокировка, нормализация (ПРЕДЛАГАЕТСЯ) | YES | G7 | Prototype per §9.3; owner ratifies |
| WS-11 | L1448 | FOV для игроков или только для кукол? | ОТКРЫТО | **BLOCKER** | production P08A (detection) | Player visibility/privacy rules undefined | для игроков / только для кукол | PARTIAL | G7, DOLL-OPEN-01 | Decide together with sensor model |
| WS-12 | L1449 | Какие свойства стен/дверей блокируют зрение и звук? | ОТКРЫТО | **BLOCKER** | production P08A; P03 schema fields | Occlusion data model missing from World Pack | нет | PARTIAL | G7 | Define occlusion flags in Pack schema provisionally; owner ratifies semantics |
| WS-13 | L1450, L953 | Акустика: простая дистанция или bounded propagation по grid? | ОТКРЫТО | PROTOTYPE | — (production P08A) | Stimulus range model undefined | простая дистанция / bounded propagation (ПРЕДЛАГАЕТСЯ) | YES | G8 (ARCH-L445) | Measure cost on test room |
| WS-14 | L1451 | Proximity thresholds для шёпота и приватного канала? | ОТКРЫТО | **BLOCKER** | production P09 (privacy) | Private channel semantics undefined | нет | PARTIAL | G30 (NET-06, ARCH-L801) | Owner defines privacy matrix before P09 |
| WS-15 | L1452, L1090 | Кто видит факт входа игрока в укрытие? | ОТКРЫТО | **BLOCKER** | production P07/P08A | Hideout privacy and detection rules undefined | нет | PARTIAL | G9 | Owner defines; no invented rule |
| WS-16 | L1453, L1090 | Вместимость укрытий и правила обыска куклой? | ОТКРЫТО | **BLOCKER** | production P07/P08A | Hideout mechanics undefined | нет | PARTIAL | G9 (ARCH-L487) | Owner defines capacity/search rules |
| WS-17 | L1454, L655 | Можно ли закрыть дверь, если в проёме игрок/кукла? | ОТКРЫТО | PROTOTYPE | — (production P07) | Collision-safety rule for doors undefined | запрет закрытия / отдельная безопасная процедура | YES | G10 | Prototype safe refusal; owner ratifies |
| WS-18 | L1455, L896 | Какие объекты требуют динамического dark-state в Baked Room? | ОТКРЫТО | CONTENT | — (P14 art) | Art pipeline scope undefined | подготовленный dark-state / динамический overlay | YES | G11 | Decide per room during P14 |
| WS-19 | L1456 | Точная проекция Blender camera и tile aspect? | ОТКРЫТО | PROTOTYPE | — (P14) | Art alignment risk | нет | YES | G11 | Calibrate on one room (P14) |
| WS-20 | L1457 | Формат authoring World Pack: JSON вручную, Tiled export, свой редактор? | ОТКРЫТО | PROTOTYPE | — (production P14; P03 schema) | Authoring pipeline undefined | JSON вручную / Tiled export / свой редактор | YES | G11 | Use hand-authored JSON for test room; owner picks production format |
| WS-21 | L1458 | Какие действия разрешены в фазах исследования, инцидента и разбора? | ОТКРЫТО | **BLOCKER** | production P10 (interaction gating) | Phase-scoped action matrix missing | нет | PARTIAL | G12 | Owner defines with ML phase rules |
| WS-22 | L1459 | Приоритет между входом в укрытие, захватом и другими одновременными событиями? | ОТКРЫТО | **BLOCKER** | production P07/P08B | Concurrent state transitions nondeterministic | нет | PARTIAL | G12 | Owner defines priority table |

**Unnumbered unique items (WORLD_SIMULATION):**

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| UNASSIGNED-WSIM-L557 | L557 (§5.3) | Точный перечень режимов движения и скорость каждого? | ОТКРЫТО | CONTENT | — (balance) | Speeds are game balance, must not be invented in code | обычное движение / бег / ограниченное движение / перенос / стазис | YES | G1 | Owner sets numbers via balance config |
| UNASSIGNED-WSIM-L722 | L722 (§7.4) | Какие факторы участвуют в path cost? | ОТКРЫТО | PROTOTYPE | — (P08A) | Path cost model undefined | длина / газ / освещённость / узкие проходы / охраняемые зоны | YES | G3 | First prototype uses length + reachability only |
| UNASSIGNED-WSIM-L235 | L235 | Нужна ли квантизация координат? | ОТКРЫТО | PROTOTYPE | — | Serialization/reproducibility policy | нет | YES | G2 (facet of WS-02) | Test determinism need before adding quantization |
| UNASSIGNED-WSIM-L797 | L797 | Формула расхода фильтра и пороги? | ОТКРЫТО | CONTENT | — (balance) | Filter economy undefined | нет | YES | G6 | Owner sets via balance config |

*Folded duplicate anchors (already covered by numbered rows): L582→WS-05, L594→WS-06, L637→WS-04, L655→WS-17, L764→WS-08, L844→WS-10, L896→WS-18, L953→WS-13, L1090→WS-15/WS-16.*

### §3.2. HOT_COLD_DESIGN.md — HC-01…HC-14

Table source: `docs/HOT_COLD_DESIGN.md` §19 (lines 1184–1197). No inline `ОТКРЫТО` items exist outside the table (verified: only the §1 legend and unrelated prose). Confirmed invariant: `SIMULATION_HZ = 20`, `FIXED_DT = 0.05` (L272, `СОГЛАСОВАНО`).

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| HC-01 | L1184 | Оставляем 20 Гц после прототипа или повышаем до 30 Гц? | ОТКРЫТО | PROTOTYPE | — (tuning) | Tick rate is a measured trade-off | 20 Гц / 30 Гц | YES | G13 | Measure overrun at 20 Hz; owner decides escalation |
| HC-02 | L1185 | Тип ввода движения: held direction, velocity intent, click-to-move, комбинация? | ОТКРЫТО | **BLOCKER** | **slice** (P04/P05) | Input contract and prediction undefined | held / velocity intent / click-to-move / комбинация | PARTIAL | G1 (WS-03, NET-02) | One decision covering WS-03/HC-02/NET-02 |
| HC-03 | L1186 | Алгоритм столкновений и точность grid movement? | ОТКРЫТО | **BLOCKER** | **slice** (P04) | Server-authoritative movement cannot be specified | нет | PARTIAL | G3 (WS-05) | Prototype swept-circle; owner ratifies tolerance |
| HC-04 | L1187 | Размер interpolation buffer при реальных RTT/jitter? | ОТКРЫТО | PROTOTYPE | — (P05 tuning) | Remote motion smoothness undefined | нет | YES | G14 (NET-13) | Measure with artificial RTT/jitter |
| HC-05 | L1188 | Что можно кратко экстраполировать, а что удерживать? | ОТКРЫТО | PROTOTYPE | — (P05 visual correctness) | Extrapolation policy undefined | нет | YES | G14 | Test visible artifacts; owner ratifies policy |
| HC-06 | L1189 | Как надёжно фиксировать HOT events до потери процесса? | ОТКРЫТО | PROTOTYPE | — (production P06) | Durability guarantee undefined | нет | YES | G15 (ARCH-L385) | Crash harness experiment; owner approves guarantee |
| HC-07 | L1190 | Допустимый snapshot interval для текущего adapter? | ОТКРЫТО | PROTOTYPE | — (P06) | Recovery point/load trade-off unknown | нет | YES | G15 (ARCH-L850) | Measure SQLite serialization/write time |
| HC-08 | L1191 | Допустим ли rollback transient state до последнего snapshot? | ОТКРЫТО | **BLOCKER** | production P06 (recovery semantics) | Recovery UX/guarantee cannot be promised | нет | PARTIAL | G15 | Owner accepts allowed loss; test in harness |
| HC-09 | L1192 | При каком queue depth/ошибках ставить матч на паузу? | ОТКРЫТО | **BLOCKER** | production P06/P10 | Failure policy undefined | нет | PARTIAL | G15 | Owner defines fail-safe policy |
| HC-10 | L1193 | Сериализация COLD mutations: одна очередь на матч или на агрегаты? | ОТКРЫТО | PROTOTYPE | — (P02/P06 design) | Contention/throughput model unknown | одна очередь / очереди на агрегаты | YES | G16 | Load experiment on test aggregates |
| HC-11 | L1194 | Срок действия spatial validation для interaction command? | ОТКРЫТО | PROTOTYPE | — (P07 tuning) | Race between move and interact | нет | YES | G17 | Tune with jitter tests |
| HC-12 | L1195 | Семантика disconnect/AFK для персонажа? | ОТКРЫТО | **BLOCKER** | production P10 (lifecycle) | Player state on disconnect undefined | нет | PARTIAL | G18 (NET-12, ML-06, ARCH-L903) | One decision; transport resync can prototype first |
| HC-13 | L1196 | Как часто обновлять неподвижные/удалённые scene entities? | ОТКРЫТО | PROTOTYPE | — (P05 traffic) | Bandwidth policy undefined | нет | YES | G34 (NET-15) | Measure traffic; set throttle |
| HC-14 | L1197 | Отдельный event stream для observer или отдельная projection/connection? | ОТКРЫТО | DEFERRED | — (P11) | Observer transport design | отдельный event stream / отдельная projection/connection | YES | G20 (NET-08/09) | Defer to P11 |

### §3.3. DOLL_AI.md — DOLL-OPEN-01…19

Table source: `docs/DOLL_AI.md` §23 (lines 1474–1568). Inline anchors verified at 184, 323, 408, 428, 484, 520, 641, 657, 1215.

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| DOLL-OPEN-01 | L1474–1483 | Что означает «слепые, слышат» при наличии светового триггера и конуса обнаружения? | ОТКРЫТО | **BLOCKER** | production P08A (sensor model) | Detection rules cannot be finalized; source calls it a blocker | 4 варианта: без зрения / восприятие света без распознавания / конус как иная зона / уточнить формулировку | PARTIAL | G21; LL408 | Owner picks interpretation; then detection rules |
| DOLL-OPEN-02 | L1485–1487, L428 | К чему применяется множитель Мнемосина ×1.5? | ОТКРЫТО | **BLOCKER** | production P08A | Infected detection advantage undefined | радиус присутствия / любой стимул / зона обнаружения / иной параметр | PARTIAL | G21 | Decide with DOLL-OPEN-01 |
| DOLL-OPEN-03 | L1489–1491 | Как кукла определяет источник звука/стимула и с какой точностью? | ОТКРЫТО | **BLOCKER** | production P08A | Localization model undefined | зона / направление / клетка / точная позиция; раскрывает ли звук сущность | PARTIAL | G21 (ARCH-L435) | Owner defines localization granularity |
| DOLL-OPEN-04 | L1495–1497, L184 | Какие состояния/поведения доступны на каждом этаже Э1–Э6? | ОТКРЫТО | CONTENT | — (production content) | Floor ability tables undefined | нет | YES | G24 (DOLL-OPEN-08, L520) | Author tables per floor in P08A content pass |
| DOLL-OPEN-05 | L1499–1508, L657 | Как куклы координируются? | ОТКРЫТО | **BLOCKER** | production P08A (full tactics) | Coordination model undefined | без координации / локальный обмен / общекомандный обмен / иерархия крупных кукол | PARTIAL | G23 (DOLL-OPEN-11) | Owner chooses per-floor model |
| DOLL-OPEN-06 | L1510–1512 | Полный каталог условий обнаружения и захвата? | ОТКРЫТО | **BLOCKER** | production P08A/P08B | Detect/capture rules undefined | нет | PARTIAL | G22 | Owner authors catalog after sensor model |
| DOLL-OPEN-07 | L1514–1516 | Кто и как переносит захваченного в Детскую? | ОТКРЫТО | **BLOCKER** | production P08B/P10 | Capture handoff undefined | нет | PARTIAL | G25 (ML-16…ML-20) | Decide with P10 participant states |
| DOLL-OPEN-08 | L1520–1522 | Точная конфигурация профилей Э1–Э7? | ОТКРЫТО | CONTENT | — | Tactical profiles undefined | нет | YES | G24 (ARCH-L525) | Author with DOLL-OPEN-04 |
| DOLL-OPEN-09 | L1524–1526 | Какие типы кукол — полноценные агенты (пустышки, швы)? | ОТКРЫТО | **BLOCKER** | production P08A | Agent roster undefined | нет | YES | G24 | Prototype one patrol type; owner ratifies roster |
| DOLL-OPEN-10 | L1528–1530, L484 | Какие параметры сложности могут изменяться? | ОТКРЫТО | CONTENT | — (balance) | Difficulty parameter list undefined | perception / memory TTL / capabilities / coordination / decision rate / movement | YES | G24 (DOLL-OPEN-17) | Owner approves parameter list |
| DOLL-OPEN-11 | L1532–1534, L641 | Как обрабатывать несколько кукол в узком проходе? | ОТКРЫТО | PROTOTYPE | — (production P08A) | Crowd conflicts need deterministic tie-breaker | reservation / avoidance / приоритет по типу / иной tie-breaker | YES | G23 | Prototype deterministic tie-breaker; owner ratifies |
| DOLL-OPEN-12 | L1536–1538 | Может ли кукла открывать/закрывать дверь? | ОТКРЫТО | PROTOTYPE | — (production P08A) | Door capability undefined | нет | YES | G10 (WS-17) | Capability toggle in prototype |
| DOLL-OPEN-13 | L1540–1542 | Правила проверки укрытий куклой? | ОТКРЫТО | **BLOCKER** | production P08A/P07 | Hideout search rules undefined | нет | PARTIAL | G9 (WS-15/16) | Owner defines with WS-15/16 |
| DOLL-OPEN-14 | L1544–1546 | Как работает «взять за руку и задать вопрос»? | ОТКРЫТО | DEFERRED | — (late interaction) | Special interaction undefined | нет | NO | G24 | Defer past P08A baseline |
| DOLL-OPEN-15 | L1548–1550 | Как Doll AI ведёт себя на Э7? | ОТКРЫТО | DEFERRED | — (P13/P14 late) | Finale doll behaviour undefined | обычная симуляция / только сценарные условия | PARTIAL | G44 | Defer to P13 |
| DOLL-OPEN-16 | L1554–1556 | Точные частоты Perception/Decision? | ОТКРЫТО | PROTOTYPE | — (P08A tuning) | Tick budget unknown | нет | YES | G26 | Measure on prototype |
| DOLL-OPEN-17 | L1558–1560, L1215 | Какие состояния/память сохраняются в HOT snapshots? | ОТКРЫТО | PROTOTYPE | — (P06/P08A) | Recovery fidelity unknown | точное восстановление / допустимый сброс transient | YES | G26 (HC-08) | Experiment with crash harness |
| DOLL-OPEN-18 | L1562–1564 | Предел активных кукол и стимулов? | ОТКРЫТО | PROTOTYPE | — (P15 load) | Capacity unknown | нет | YES | G49 | Load test, not guess |
| DOLL-OPEN-19 | L1566–1568 | Нужен ли bit-for-bit replay Doll AI? | ОТКРЫТО | PROTOTYPE | — (P06/P15) | Replay guarantee scope undefined | нет | YES | G26 | Define reproducibility requirement |
| UNASSIGNED-DOLL-L323 | L323 (§4.2) | Хранить `facing`/`velocity` в authoritative runtime или вычислять? | ОТКРЫТО | PROTOTYPE | — (technical) | Runtime state shape | хранить / вычислять из последнего движения | YES | G26 | Decide during P08A runtime skeleton |
| UNASSIGNED-DOLL-L520 | L520 (§7.2) | Нужна ли способность `AMBUSH`? | ОТКРЫТО | CONTENT | — | Ability catalog incomplete | нет | YES | G24 (DOLL-OPEN-04) | Include in floor ability tables |

*Folded duplicate anchors: L184→DOLL-OPEN-04/08, L408→DOLL-OPEN-01, L428→DOLL-OPEN-02, L484→DOLL-OPEN-10, L641→DOLL-OPEN-11, L657→DOLL-OPEN-05, L1215→DOLL-OPEN-17.*

### §3.4. NETWORK_PROTOCOL.md — NET-01…NET-20

Table source: `docs/NETWORK_PROTOCOL.md` §24 (lines 1673–1692). Inline anchors verified at 190, 280, 479, 1115, 1185.

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| NET-01 | L1673, L190 | Сохраняем `mnemosin.v1.<jwt>` subprotocol или вводим ticket/cookie flow? | ОТКРЫТО | **BLOCKER** | production P05 (security) | Browser handshake security undefined | JWT subprotocol / одноразовый ticket / same-origin cookie | YES | G27 | Keep existing for prototype; owner decides security model |
| NET-02 | L1674 | Финальный movement input mode (held direction, velocity intent, click-to-move, комбинация)? | ОТКРЫТО | **BLOCKER** | **slice** (P05) | Input message schema blocked | те же 4 варианта | PARTIAL | G1 (WS-03, HC-02) | One joint decision |
| NET-03 | L1675, L280 | Разрешены ли несколько controlling connections на одного actor? | ОТКРЫТО | PROTOTYPE | — (P05) | Multi-tab conflict handling | нет | YES | G28 | Prototype single-connection policy |
| NET-04 | L1676 | Heartbeat interval и connection timeout? | ОТКРЫТО | PROTOTYPE | — (P05) | False disconnects vs liveness | нет | YES | G29 | Tune with jitter tests |
| NET-05 | L1677, L479 | Значение input lease timeout? | ОТКРЫТО | PROTOTYPE | — (P04/P05) | Stuck movement after lost release | нет | YES | G29 | Measure with prototype and jitter |
| NET-06 | L1678 | Точная audience policy для whisper/private communication? | ОТКРЫТО | **BLOCKER** | production P09 (privacy) | Private chat semantics undefined | нет | PARTIAL | G30 (WS-14, ARCH-L801) | Owner defines privacy matrix |
| NET-07 | L1679 | Spatial visibility rules для позиции других игроков? | ОТКРЫТО | PROTOTYPE | — (P05 projection) | Scene projection scope undefined | нет | YES | G31 | Prototype same-room visibility |
| NET-08 | L1680 | Какую часть Observer data слать realtime, какую по запросу? | ОТКРЫТО | DEFERRED | — (P11) | Observer traffic design | нет | YES | G20 (HC-14) | Defer to P11 |
| NET-09 | L1681 | Отдельный физический WS для Observer или logical stream? | ОТКРЫТО | DEFERRED | — (P11) | Observer isolation/backpressure | отдельный WS / logical stream | YES | G20 | Defer to P11 |
| NET-10 | L1682, L1115 | Сколько Observer connections в партии? | ОТКРЫТО | DEFERRED | — (P11) | Capacity/permissions | нет | YES | G32 (ML-34) | Defer with Observer policy |
| NET-11 | L1683, L1185 | Какие commands безопасно повторять после reconnect и их TTL? | ОТКРЫТО | PROTOTYPE | — (P05/P06 reconnect) | Offline queue correctness | нет; начальный безопасный режим — не replay time-sensitive commands | YES | G33 | Test command classes on prototype |
| NET-12 | L1684 | Disconnect/AFK policy для персонажа? | ОТКРЫТО | **BLOCKER** | production P10 | Same decision as HC-12 | нет | PARTIAL | G18 (HC-12, ML-06) | One joint decision |
| NET-13 | L1685 | Initial/interpolation delay при RTT/jitter? | ОТКРЫТО | PROTOTYPE | — (P05) | Remote smoothness | нет | YES | G14 (HC-04) | Measure |
| NET-14 | L1686 | Max payload sizes по типам сообщений? | ОТКРЫТО | PROTOTYPE | — (P05) | DoS protection/compat | нет | YES | G34 | Set after measuring frames |
| NET-15 | L1687 | Частота snapshots и throttling неподвижных сущностей? | ОТКРЫТО | PROTOTYPE | — (P05) | Traffic/server load | нет | YES | G34 (HC-13) | Measure on test room |
| NET-16 | L1688 | Нужен ли replay API для command status? | ОТКРЫТО | PROTOTYPE | — (reconnect reliability) | Lost command result handling | нет | YES | G33 | Prototype decision with NET-11 |
| NET-17 | L1689 | Какие Observer interventions доступны на первом этапе? | ОТКРЫТО | DEFERRED | — (P11) | Capability model | нет | YES | G32 | Defer to P11 after owner approval |
| NET-18 | L1690 | Разрешены ли private messages игроку в Captured/Stasis? | ОТКРЫТО | DEFERRED | — (P09/P10) | Chat mechanics for captured | нет | PARTIAL | G25, G30 | Defer with P10 captured states |
| NET-19 | L1691 | Compatibility policy при rolling deployment? | ОТКРЫТО | DEFERRED | — (release ops) | Update without breaking match | нет | YES | G35 | Decide before first public deploy |
| NET-20 | L1692 | Лимит connections/commands per IP/actor? | ОТКРЫТО | PROTOTYPE | — (P05 security) | Abuse prevention vs false positives | нет | YES | G36 | Tune after traffic model |

*All five inline anchors (L190, L280, L479, L1115, L1185) duplicate numbered rows NET-01, NET-03, NET-05, NET-10, NET-11 respectively; no unnumbered decision exists in this document.*

### §3.5. MATCH_LIFECYCLE.md — ML-01…ML-38

Table sources: §24.1 (ML-01–07), §24.2 (ML-08–15), §24.3 (ML-16–21), §24.4 (ML-22–32), §24.5 (ML-33–38); lines 1334–1391. Inline anchors verified at 320, 347, 353, 395, 468, 480, 537, 554, 569, 584, 600, 696, 710, 752, 766, 797, 852, 881, 887, 914, 922, 928, 942, 948, 960, 980, 1082, 1095, 1240.

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| ML-01 | L1334, L320 | Кто создаёт комнату и какие права у создателя? | ОТКРЫТО | **BLOCKER** | production P10 (lobby) | Lobby/authorization UX undefined | нет | YES | G37 | Owner defines minimal lobby model |
| ML-02 | L1335, L347 | Нужен ли Ready Check каждого игрока? | ОТКРЫТО | **BLOCKER** | production P10 | Start preconditions unknown | нет | YES | G37 | Owner decides; prototype can start without |
| ML-03 | L1336, L320 | Как игроки приглашаются и могут ли присоединиться после старта? | ОТКРЫТО | **BLOCKER** | production P10 | Membership/security undefined | нет | YES | G37 | Owner defines invitation model |
| ML-04 | L1337, L395 | Распределение ролей для 7, 8, 9 и 10 игроков? | ОТКРЫТО | **BLOCKER** | production P10 | Cannot configure a real match roster | нет | YES | G38 | Owner authors role tables; no linear extrapolation |
| ML-05 | L1338 | Нужно ли более одной активной партии на сервере? | ОТКРЫТО | **BLOCKER** | production P02/P10 architecture | Match isolation model undefined | нет | YES | G37 | Owner decides; prototype one match |
| ML-06 | L1339, L1082 | Правила disconnect, AFK, voluntary leave во время партии? | ОТКРЫТО | **BLOCKER** | production P10 | Same decision as HC-12/NET-12 | нет | PARTIAL | G18 | One joint decision |
| ML-07 | L1340, L1095 | Можно ли поставить матч на паузу и кто имеет право? | ОТКРЫТО | **BLOCKER** | production P10 | Pause policy undefined (default: no auto-pause) | по решению группы / из-за техпроблемы | YES | G18 | Owner ratifies default |
| ML-08 | L1346, L537 | Точный threshold большинства у порога? | ОТКРЫТО | **BLOCKER** | production P10 (progression) | Vote resolver undefined | нет | YES | G40 | Owner sets threshold per player count |
| ML-09 | L1347, L537 | Что делать при ничьей/отсутствии большинства? | ОТКРЫТО | **BLOCKER** | production P10 | Deadlock policy undefined | нет | YES | G40 | Owner defines |
| ML-10 | L1348 | Может ли остаться один или несколько игроков наверху? | ОТКРЫТО | **BLOCKER** | production P10 | Floor-split model undefined | нет | YES | G40 | Owner defines |
| ML-11 | L1349, L797 | Можно ли вернуться наверх/организовать спасение? | ОТКРЫТО | **BLOCKER** | production P10 | Irreversibility rule undefined | нет | YES | G40 | Owner defines |
| ML-12 | L1350, L696 | Какие задачи и лимиты доступны оставленному наверху? | ОТКРЫТО | CONTENT | — (support content) | Support action catalog undefined | функции из §10.2 (фильтры, связь, охрана, присмотр, ресурсы) | YES | G40 | Author support catalog after ML-10/11 |
| ML-13 | L1351, L584 | Условия завершения фазы, если игроки не выполняют цели? | ОТКРЫТО | **BLOCKER** | production P10 | Progression liveness undefined | нет | YES | G40 | Owner defines completion fallback |
| ML-14 | L1352 | Длительности фаз и таймауты? | ОТКРЫТО | CONTENT | — (balance) | Logical clock unknown | нет | YES | G40 | Owner sets via config |
| ML-15 | L1353, L468, L480 | Как масштабируется пролог «шесть просыпаются» на 7–10? | ОТКРЫТО | CONTENT | — (scenario text) | Start scene content undefined | нет | YES | G39 | Author prologue variants |
| ML-16 | L1359, L710 | Что может делать захваченный в Детской? | ОТКРЫТО | **BLOCKER** | production P10/P08B | Captured action set undefined | нет | YES | G25 | Owner defines participant states first |
| ML-17 | L1360, L710 | Как работает одна подсказка захваченного? | ОТКРЫТО | CONTENT | — | Hint policy content | нет | YES | G25 | Author with ML-16 |
| ML-18 | L1361, L710 | Как заражённый захваченный саботирует через шёпот кукол? | ОТКРЫТО | **BLOCKER** | production P10 | Restricted sabotage channel undefined | нет | YES | G25, G41 | Owner defines |
| ML-19 | L1362, L710 | Условия спасения из Детской? | ОТКРЫТО | **BLOCKER** | production P10 | Rescue flow undefined | нет | YES | G25 | Owner defines |
| ML-20 | L1363 | Может ли перенос/захват быть прерван? | ОТКРЫТО | **BLOCKER** | production P10/P08B | Capture transaction semantics | нет | YES | G25 | Owner defines with DOLL-OPEN-07 |
| ML-21 | L1364, L942 | Что считается активным участником на Э7? | ОТКРЫТО | **BLOCKER** | production P13 | Finale count criterion undefined | не Captured / физически на Э7 / может взаимодействовать | YES | G43 | Owner defines; store facts independently meanwhile |
| ML-22 | L1370, L942 | Минимумы активных на Э7 для 7 и 9 игроков? | ОТКРЫТО | **BLOCKER** | production P13 | Finale admission incomplete | задано только 6→3, 8→4, 10→5 | YES | G43 | Owner adds 7 and 9 |
| ML-23 | L1371, L942 | Учитываются ли оставленные наверху в minimum active count? | ОТКРЫТО | **BLOCKER** | production P13 | Count semantics undefined | нет | YES | G43 | Owner decides |
| ML-24 | L1372, L852, L948 | Приоритеты, если истинны условия нескольких концовок? | ОТКРЫТО | **BLOCKER** | production P13 (EndingResolver) | Source explicitly blocks EndingResolver | нет; таблицы приоритетов нет | YES | G44 | Owner authors priority table; store facts independently |
| ML-25 | L1373, L881 | Обязательно ли имя «Алиса» для Идеальной концовки? | ОТКРЫТО | **BLOCKER** | production P13 | Ideal condition ambiguous (альт/доп) | обязательное / дополнительное | YES | G44 | Owner decides |
| ML-26 | L1374, L881 | «Оба стартовых заражённых исцелены» при новых заражённых? | ОТКРЫТО | **BLOCKER** | production P13 | Ideal condition undefined | нет | YES | G44 | Owner decides |
| ML-27 | L1375, L914 | Адаптация «все пятеро остальных детей заражены» для 7–10? | ОТКРЫТО | **BLOCKER** | production P13 | Oblivion condition undefined | нет | YES | G44 | Owner decides |
| ML-28 | L1376, L914 | Условия, при которых Андрей нажимает рычаг? | ОТКРЫТО | **BLOCKER** | production P13 | Rewind trigger undefined | нет | YES | G44 | Owner decides |
| ML-29 | L1377, L922 | Перемотка — новый Match или новая Cycle Iteration? | ОТКРЫТО | **BLOCKER** | production P13 (persistence) | Meta-history model undefined | новый Match / новая Cycle Iteration | YES | G45 | Owner decides; §14.5.1 proposes CycleInstance |
| ML-30 | L1378, L914 | Какие роли/пары/seed меняются при перемотке? | ОТКРЫТО | **BLOCKER** | production P13 | Next-cycle config undefined | нет | YES | G45 | Owner decides |
| ML-31 | L1379 | Что игроки помнят между циклами, а персонажи забывают? | ОТКРЫТО | **BLOCKER** | production P13 | Meta-memory model undefined | нет | YES | G45 | Owner decides |
| ML-32 | L1380, L928 | Как Доминация взаимодействует с инъекцией и исходами? | ОТКРЫТО | **BLOCKER** | production P13 | Ending precedence undefined | нет | YES | G44 | Owner decides |
| ML-33 | L1386, L353 | Может ли Observer подключаться до старта/в любой момент/по приглашению? | ОТКРЫТО | DEFERRED | — (P11) | Access policy | до старта / в любой момент / по приглашению | YES | G32 | Defer to P11 |
| ML-34 | L1387 | Может ли быть несколько Observer? | ОТКРЫТО | DEFERRED | — (P11) | Capacity | нет | YES | G32 (NET-10) | Defer to P11 |
| ML-35 | L1388 | Видно ли игрокам присутствие Observer? | ОТКРЫТО | DEFERRED | — (P11) | Social fairness | нет | YES | G32 | Defer to P11 |
| ML-36 | L1389 | God Actions видны игрокам или только в audit? | ОТКРЫТО | DEFERRED | — (P11) | Trust/transparency | видимы / только audit | YES | G32 | Defer to P11 |
| ML-37 | L1390 | Может ли Observer вмешаться в голосование/концовку? | ОТКРЫТО | DEFERRED | — (P11) | Intervention policy | голосование-концовка / только окружение | YES | G32 | Defer to P11 |
| ML-38 | L1391, L960, L980 | Как выглядит post-game reveal? | ОТКРЫТО | CONTENT | — (UX content) | Endgame UX | нет | YES | G46 | Author reveal with epilogue |
| UNASSIGNED-ML-L554 | L554 | Кому принадлежит лимит саботажа «раз на этаж»? | ОТКРЫТО | **BLOCKER** | production P10 | Sabotage economy undefined | нет | PARTIAL | G41 | Owner decides owner of limit |
| UNASSIGNED-ML-L752 | L752 | Лимиты общие на команду заражённых или персональные? | ОТКРЫТО | **BLOCKER** | production P10 | Limit accounting undefined | общие / индивидуальные | YES | G41 | Owner decides |
| UNASSIGNED-ML-L766 | L766 | Выбор цели, контрмеры, момент расхода лимита? | ОТКРЫТО | **BLOCKER** | production P10 | Kill-attempt mechanics undefined | одна командная / персональная | YES | G41 | Owner decides |
| UNASSIGNED-ML-L569 | L569 | Каталог инцидентов этажей, выбор, обязательность, тайминги? | ОТКРЫТО | CONTENT | — | Incident content undefined | нет | YES | G42 | Author incident catalog |
| UNASSIGNED-ML-L1240 | L1240 | Можно ли повторить генерацию с другим seed автоматически? | ОТКРЫТО | DEFERRED | — (ops rule) | Retry UX | автоматически / действием создателя | YES | G37 | Defer |

*Folded duplicate anchors (facets of numbered rows): L320→ML-01/03, L347→ML-02, L353→ML-33, L395→ML-04, L468/L480→ML-15, L537→ML-08/09/13, L584→ML-13, L600→ML-08/10/11/12, L696→ML-11/12, L710→ML-16–20, L797→ML-11, L852/L887/L948→ML-24/32, L881→ML-25/26, L914→ML-27/28/30, L922→ML-29/31, L928→ML-32, L942→ML-21/22/23, L960/L980→ML-38, L1082→ML-06, L1095→ML-07.*

### §3.6. ANDREY_AI.md — AND-OPEN-01…23

Table source: `docs/ANDREY_AI.md` §26 (lines 1608–1630). Inline anchors verified at 136, 147, 189, 371, 414, 428, 526, 556, 805, 918, 1103, 1125.

| ID | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| AND-OPEN-01 | L1608, L136, L414 | Как определяется «ребёнок/дети» в восприятии Андрея? | ОТКРЫТО | **BLOCKER** | production P12 (knowledge model) | Knowledge category undefined | нет | YES | G47 | Owner defines category source |
| AND-OPEN-02 | L1609, L189 | Какие игроки и как могут обращаться к Андрею на каждом этаже? | ОТКРЫТО | **BLOCKER** | production P12 | Interaction permissions undefined | нет | YES | G48 | Owner defines channel permissions |
| AND-OPEN-03 | L1610, L556 | Ответ Андрея слышит комплекс, этаж, комната или адресат? | ОТКРЫТО | **BLOCKER** | production P12/P09 privacy | Audience rules undefined | публичное объявление / конкретному игроку или группе / комната или канал / без ответа | YES | G48 (WS-14, NET-06) | Owner decides audience |
| AND-OPEN-04 | L1611, L1103 | Одновременные обращения нескольких игроков? | ОТКРЫТО | PROTOTYPE | — (P12 tuning) | Queue/concurrency model | сериализация очереди предложена для прототипа | YES | G48 | Prototype serialized queue |
| AND-OPEN-05 | L1612 | Какие данные/события Андрей может знать из каждого источника? | ОТКРЫТО | **BLOCKER** | production P12 | Knowledge policy undefined | нет | YES | G47 | Owner authors knowledge matrix |
| AND-OPEN-06 | L1613, L371 | Какие утверждения считаются «сверенными» и кто проверяет? | ОТКРЫТО | **BLOCKER** | production P12 | Verification model undefined | нет | YES | G47 | Owner defines; never auto-verify via LLM tone |
| AND-OPEN-07 | L1614, L428 | Как моделируется доверие к каждому игроку? | ОТКРЫТО | PROTOTYPE | — (P12) | Belief model scope | уровень доверия / качественное состояние | YES | G49 | Prototype qualitative belief state |
| AND-OPEN-08 | L1615 | Как фиксируется ложь игрока и когда Андрей верит? | ОТКРЫТО | **BLOCKER** | production P12 | Deception mechanic undefined | нет | YES | G49 | Owner defines |
| AND-OPEN-09 | L1616, L147 | Что считается помощью для «комплекс замечает чаще»? | ОТКРЫТО | CONTENT | — (balance) | Escalation trigger undefined | нет | YES | G50 | Owner defines |
| AND-OPEN-10 | L1617, L147 | Пороги/этапы и последствия цены помощи? | ОТКРЫТО | CONTENT | — (balance) | Escalation numbers undefined | нет | YES | G50 | Owner sets via config |
| AND-OPEN-11 | L1618 | Какие кэши, терминалы и шлюзы доступны Андрею? | ОТКРЫТО | **BLOCKER** | production P12 | COLD use-case set undefined | нет | YES | G51 | Owner defines access set |
| AND-OPEN-12 | L1619 | Как реализуется список 47 групп на Э6? | ОТКРЫТО | CONTENT | — (authored data) | Reveal content undefined | нет | YES | G47 | Author data |
| AND-OPEN-13 | L1620 | Точные триггеры арки Э3–Э7? | ОТКРЫТО | CONTENT | — (narrative) | Narrative controller content | нет | YES | G53 | Author with scenario |
| AND-OPEN-14 | L1621, L918 | Неофрон на канале Андрея на Э6: кто источник реплики? | ОТКРЫТО | CONTENT | — (story) | Channel identity | нет | YES | G53 | Author with scenario |
| AND-OPEN-15 | L1622 | Что происходит на Э7: запрет ответа, шум, финальный отклик? | ОТКРЫТО | CONTENT | — (finale UX) | Final scene content | нет | YES | G53 | Author with P13 |
| AND-OPEN-16 | L1623, L805, L1125 | Timeout, retries, output length, token budget, rate limits? | ОТКРЫТО | PROTOTYPE | — (P12 ops) | Provider cost/UX unknown | нет | YES | G52 | Measure with real latency |
| AND-OPEN-17 | L1624 | Какой provider/model для production? | ОТКРЫТО | **BLOCKER** | production P12 (adapter config) | Provider capabilities undefined | нет | YES | G52 | Owner selects provider |
| AND-OPEN-18 | L1625 | Сколько истории хранить и какой retention? | ОТКРЫТО | **BLOCKER** | production P12 (privacy) | Persistence/privacy undefined | нет | YES | G51 | Owner defines retention |
| AND-OPEN-19 | L1626 | Какие authored fallback lines нужны? | ОТКРЫТО | CONTENT | — (content) | Fallback coverage undefined | нет | YES | G52 | Author fallbacks per channel/floor/error |
| AND-OPEN-20 | L1627 | Belief summaries — LLM, алгоритм или вручную? | ОТКРЫТО | PROTOTYPE | — (P12 cost) | Memory pipeline choice | LLM / алгоритм / вручную | YES | G52 | Compare cost/quality on prototype |
| AND-OPEN-21 | L1628 | Что из убеждений Андрея видит Observer? | ОТКРЫТО | DEFERRED | — (P11) | Observer permissions | нет | YES | G32 | Defer to P11 |
| AND-OPEN-22 | L1629 | Какие prompt/provider diagnostics доступны разработчику? | ОТКРЫТО | DEFERRED | — (P11) | Dev diagnostics/privacy | нет | YES | G32 | Defer to P11 |
| AND-OPEN-23 | L1631 | Повторный вопрос во время генерации и отмена? | ОТКРЫТО | PROTOTYPE | — (P12 UX) | UX/concurrency | нет | YES | G48 | Prototype cancel semantics |

*Folded duplicate anchors: L136→AND-OPEN-01, L147→AND-OPEN-09/10, L189→AND-OPEN-02, L371→AND-OPEN-06, L414→AND-OPEN-01/07, L428→AND-OPEN-07, L526→AND-OPEN-02/03, L556→AND-OPEN-03/04, L805→AND-OPEN-16, L918→AND-OPEN-14, L1103→AND-OPEN-04/23, L1125→AND-OPEN-16.*

### §3.7. SYSTEM_ARCHITECTURE.md — unnumbered open items

This document has no numbered open-question IDs. Ten inline `ОТКРЫТО` items were found; all carry real decisions and are registered with register-local keys.

| Local key | Anchor | Question | Status | Class | Blocks | Impact | Options | Proto? | Cross-ref | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| UNASSIGNED-ARCH-L385 | L385 (§5.4) | Как гарантировать доставку HOT-события при падении до фиксации в COLD без синхронной записи каждый тик? | ОТКРЫТО | **BLOCKER** | production P06 (durability) | Same guarantee decision as HC-06…HC-10 | очередь / подтверждение / снимок (выбрать и протестировать) | YES | G15 (HC-06…09) | Prototype mechanism; owner approves guarantee |
| UNASSIGNED-ARCH-L419 | L419 (§6.3) | Алгоритм навигации и формат навигационных данных? | ОТКРЫТО | PROTOTYPE | — (production P08A) | Doll navigation undefined | A* по сетке с динамической проходимостью (ПРЕДЛАГАЕТСЯ для прототипа) | YES | G3 (WS-06) | Prototype A*; owner ratifies format |
| UNASSIGNED-ARCH-L429 | L429 (§6.4) | Как представлять поле загрязнения воздуха? | ОТКРЫТО | PROTOTYPE | — (production P07) | Same model as WS-08 | зоны по клеткам / компактная сетка концентраций / иная модель | YES | G6 (WS-08) | Fold into WS-08 decision |
| UNASSIGNED-ARCH-L435 | L435 (§6.5) | Точная модель видимости: конус, LOS, освещённость, источники, темнота? | ОТКРЫТО | **BLOCKER** | production P08A | Detection model undefined | нет (перечислены компоненты) | PARTIAL | G7 (WS-11/12, DOLL-OPEN-01) | Owner defines together with sensor model |
| UNASSIGNED-ARCH-L445 | L445 (§6.6) | Акустика геометрическая или упрощённый радиус? | ОТКРЫТО | PROTOTYPE | — (production P08A) | Same choice as WS-13 | геометрическая / упрощённый радиус с коэффициентами | YES | G8 (WS-13) | Fold into WS-13 |
| UNASSIGNED-ARCH-L487 | L487 (§7.4) | Вместимость укрытий, совместное укрытие, защита и последствия? | ОТКРЫТО | **BLOCKER** | production P07 | Same rules as WS-15/16 | нет | PARTIAL | G9 (WS-15/16) | Fold into WS-15/16 |
| UNASSIGNED-ARCH-L525 | L525 (§8.3) | Профили Э1–Э6, каталог поведений, координация, кто обменивается информацией? | ОТКРЫТО | CONTENT | — | Same content as DOLL-OPEN-04/05/08 | нет | YES | G24 (DOLL-OPEN-04/08) | Fold into floor profile authoring |
| UNASSIGNED-ARCH-L801 | L801 (§12.4) | Семантика шёпота: кто слышит, виден ли факт обмена, какие следы? | ОТКРЫТО | **BLOCKER** | production P09 | Same decision as WS-14/NET-06 | весь текст в радиусе / только адресат; виден ли факт; следы аудио и радио | PARTIAL | G30 (WS-14, NET-06) | Fold into privacy matrix |
| UNASSIGNED-ARCH-L850 | L850 (§13.3) | Частота snapshots, формат tick clock, pending HOT events, правила replay? | ОТКРЫТО | PROTOTYPE | — (P06) | Recovery fidelity parameters | нет | YES | G15 (HC-07, NET-15) | Measure; fold into HC-07 decision |
| UNASSIGNED-ARCH-L903 | L903 (§16) | Поведение персонажа при длительном disconnect и возможность паузы? | ОТКРЫТО | **BLOCKER** | production P10 | Same decision as HC-12/NET-12/ML-06/07 | остаться / AFK / автеукрытие / иное; пауза | PARTIAL | G18 | Fold into disconnect/AFK decision |

## §4. Classification Rules

A single question receives exactly one class.

### BLOCKER

The decision blocks a safe implementation of a **named** capability or the transition to a **named** phase. Every BLOCKER row states what exactly is blocked:

- `first vertical slice` (P03–P05: one test room, authoritative movement, two browsers);
- `prototype` (a narrow experiment is impossible without the answer);
- `production implementation` (named subsystem cannot ship safely);
- `full game lifecycle` (a named phase cannot be completed end-to-end).

A question that only blocks a late optional mechanic is **not** a whole-project blocker and is not labelled as one.

### PROTOTYPE

The question can be answered by measurement, experiment or comparison **without** approving game canon. Each such row names:

- the hypothesis;
- what to measure;
- the minimal experiment;
- the comparison criterion;
- which part still requires the project owner.

### CONTENT

Production content questions: texts, floor profiles, authored data, assets, ability tables, fallback lines and similar material that does not have to be final to test base movement.

### DEFERRED

Not needed for the next vertical slice; can wait without architectural damage. `DEFERRED` is never used to hide a serious production blocker.

### Rule against over-blocking

BLOCKER means "cannot safely implement X". If X is a late optional feature, the class is `DEFERRED` or `CONTENT`, not `BLOCKER`.

---

## §5. Cross-Document Deduplication Groups

The register keeps every original ID. Group keys exist only inside this document.

| Group | Decision at the centre | Primary source | Linked IDs |
|---|---|---|---|
| G1 | Movement input mode | WS-03 | WS-03, HC-02, NET-02 |
| G2 | World coordinate convention | WS-02 | WS-02, UNASSIGNED-WSIM-L235 |
| G3 | Movement/collision/navigation basis | WS-05 | WS-05, WS-06, HC-03, UNASSIGNED-WSIM-L722, UNASSIGNED-ARCH-L419 |
| G4 | Player body blocking | WS-04 | WS-04 |
| G5 | Floor/world space topology | WS-01 | WS-01 |
| G6 | Gas field model and units | WS-08 | WS-08, UNASSIGNED-WSIM-L797, UNASSIGNED-ARCH-L429 |
| G7 | Light, vision and occlusion model | WS-11 | WS-10, WS-11, WS-12, UNASSIGNED-ARCH-L435 |
| G8 | Acoustics and local stimuli | WS-13 | WS-07, WS-13, UNASSIGNED-ARCH-L445 |
| G9 | Hideouts | WS-15 | WS-15, WS-16, UNASSIGNED-ARCH-L487 |
| G10 | Doors and dynamic geometry | WS-17 | WS-17, DOLL-OPEN-12 |
| G11 | World Pack authoring, projection and art | WS-20 | WS-18, WS-19, WS-20 |
| G12 | Interaction gating and event priority | WS-21 | WS-21, WS-22 |
| G13 | Simulation tick rate | HC-01 | HC-01 |
| G14 | Interpolation and extrapolation | HC-04 | HC-04, HC-05, NET-13 |
| G15 | HOT durability, snapshots and recovery | HC-06 | HC-06, HC-07, HC-08, HC-09, UNASSIGNED-ARCH-L385, UNASSIGNED-ARCH-L850 |
| G16 | COLD mutation serialization | HC-10 | HC-10 |
| G17 | Spatial validation TTL | HC-11 | HC-11 |
| G18 | Disconnect, AFK and pause | HC-12 | HC-12, NET-12, ML-06, ML-07, UNASSIGNED-ARCH-L903 |
| G19 | Static/remote entity update rate | HC-13 | HC-13 |
| G20 | Observer transport | HC-14 | HC-14, NET-08, NET-09 |
| G21 | Doll sensor model | DOLL-OPEN-01 | DOLL-OPEN-01, DOLL-OPEN-02, DOLL-OPEN-03 |
| G22 | Doll detection and capture catalog | DOLL-OPEN-06 | DOLL-OPEN-06, DOLL-OPEN-13 |
| G23 | Doll coordination and crowd conflicts | DOLL-OPEN-05 | DOLL-OPEN-05, DOLL-OPEN-11 |
| G24 | Doll profiles, abilities and agent roster | DOLL-OPEN-04 | DOLL-OPEN-04, DOLL-OPEN-08, DOLL-OPEN-09, DOLL-OPEN-10, UNASSIGNED-DOLL-L520, UNASSIGNED-ARCH-L525 |
| G25 | Capture handoff and Nursery states | DOLL-OPEN-07 | DOLL-OPEN-07, ML-16, ML-17, ML-18, ML-19, ML-20, NET-18 |
| G26 | Doll runtime and replay scope | DOLL-OPEN-16 | DOLL-OPEN-16, DOLL-OPEN-17, DOLL-OPEN-18, DOLL-OPEN-19, UNASSIGNED-DOLL-L323 |
| G27 | WS handshake security | NET-01 | NET-01 |
| G28 | Multiple connections per actor | NET-03 | NET-03 |
| G29 | Heartbeat and input lease | NET-04 | NET-04, NET-05 |
| G30 | Whisper and private-channel semantics | WS-14 | WS-14, NET-06, AND-OPEN-03, UNASSIGNED-ARCH-L801 |
| G31 | Scene visibility of other players | NET-07 | NET-07 |
| G32 | Observer capacity, access and permissions | ML-33 | NET-10, NET-17, ML-33, ML-34, ML-35, ML-36, ML-37, AND-OPEN-21, AND-OPEN-22 |
| G33 | Reconnect command replay | NET-11 | NET-11, NET-16 |
| G34 | Payload limits and scene pacing | NET-14 | NET-14, NET-15 |
| G35 | Client/server compatibility policy | NET-19 | NET-19 |
| G36 | Connection and command rate limits | NET-20 | NET-20 |
| G37 | Lobby, membership and room creation | ML-01 | ML-01, ML-02, ML-03, ML-05, UNASSIGNED-ML-L1240 |
| G38 | Role distribution 7–10 | ML-04 | ML-04 |
| G39 | Prologue scaling | ML-15 | ML-15 |
| G40 | Floor progression rules | ML-08 | ML-08, ML-09, ML-10, ML-11, ML-12, ML-13, ML-14 |
| G41 | Infected sabotage economy | ML-18 | ML-18, UNASSIGNED-ML-L554, UNASSIGNED-ML-L752, UNASSIGNED-ML-L766 |
| G42 | Floor incidents catalog | UNASSIGNED-ML-L569 | UNASSIGNED-ML-L569 |
| G43 | Finale admission criteria | ML-21 | ML-21, ML-22, ML-23 |
| G44 | Ending conditions and priority | ML-24 | ML-24, ML-25, ML-26, ML-27, ML-28, ML-32, DOLL-OPEN-15 |
| G45 | Rewind and meta-memory | ML-29 | ML-29, ML-30, ML-31 |
| G46 | Post-game reveal | ML-38 | ML-38 |
| G47 | Andrey knowledge and verification | AND-OPEN-01 | AND-OPEN-01, AND-OPEN-05, AND-OPEN-06, AND-OPEN-12 |
| G48 | Andrey interaction channels | AND-OPEN-02 | AND-OPEN-02, AND-OPEN-04, AND-OPEN-23 |
| G49 | Andrey trust and deception | AND-OPEN-07 | AND-OPEN-07, AND-OPEN-08 |
| G50 | Andrey help cost | AND-OPEN-09 | AND-OPEN-09, AND-OPEN-10 |
| G51 | Andrey infrastructure and retention | AND-OPEN-11 | AND-OPEN-11, AND-OPEN-18 |
| G52 | Andrey LLM operations | AND-OPEN-16 | AND-OPEN-16, AND-OPEN-17, AND-OPEN-19, AND-OPEN-20 |
| G53 | Andrey narrative arc | AND-OPEN-13 | AND-OPEN-13, AND-OPEN-14, AND-OPEN-15 |

**Summary:** 53 register groups; 38 of them link two or more IDs (141 IDs in total), 15 are single-decision groups. `WS-09` is the only row not attached to a group (dynamic gas leaks — standalone topic).

**Cross-document conflicts found:** none of the seven specifications contradicts another on these questions. What exists is expected overlap of *facets* (for example WS-03 / HC-02 / NET-02 describe one input decision from three viewpoints), not contradictory rules. Two internal tensions are recorded as questions rather than conflicts:

1. `DOLL_AI` «слепые, слышат» versus light trigger and detection cone — already registered by the source as `DOLL-OPEN-01` and inline `UNASSIGNED-DOLL-L408`; the source itself calls it a blocker for detection rules.
2. Ending precedence: `ML-24`/`UNASSIGNED-ML-L948` state that several ending conditions may be true simultaneously and that no priority table exists; the source explicitly flags this as blocking `EndingResolver`.

No conflict was found that would require editing any specification in P01.

---

## §6. First Vertical Slice (P03–P05) — Decision Priority

Target: one test room, server-authoritative movement, two browser clients (PixiJS + Svelte), prediction / reconciliation / interpolation.

### §6.1. MUST DECIDE BEFORE PROTOTYPE — 5 groups (8 IDs)

| Group | IDs | Why it cannot be left provisional |
|---|---|---|
| Coordinate convention | WS-02 | Every movement, projection and collision contract derives from it; changing it later invalidates prediction code |
| Input mode | WS-03 = HC-02 = NET-02 | Defines the input message schema, prediction model and client UX; cannot be swapped without rewriting P05 |
| Collision algorithm and tolerance | HC-03 (with WS-05) | Server-authoritative movement requires an agreed collision basis; divergence client/server is unrecoverable |
| Collider shape | WS-05 | Needed to implement the first collision pass; the source itself proposes a circle for the prototype, so the owner only ratifies one shape |
| World-space topology | WS-01 | Determines whether the test room is a `WorldSpace` or a segment of one — affects ids and scene loading in P03 |

### §6.2. CAN PROTOTYPE WITH PROVISIONAL DETAILS — 20 items

| Item | Provisional value used by prototype | Owner decision still required |
|---|---|---|
| WS-04 player body-block | pass-through | final rule |
| WS-06 grid adjacency | 4-neighbour | final |
| WS-08 / ARCH-L429 gas model | normalized scale, no filters yet | canonical unit/model |
| WS-10/11/12 light and vision | room-level light only, no FOV | final visibility model |
| WS-13 acoustics | no stimulus propagation yet | final model |
| WS-17 doors | refuse closing when occupied | final rule |
| WS-20 World Pack format | hand-authored JSON | production authoring format |
| HC-01 tick rate | 20 Hz (`СОГЛАСОВАНО` as start) | 20 vs 30 |
| HC-04/HC-05/NET-13 buffer | ~100 ms interpolation, no extrapolation | tuned values |
| HC-07 snapshot interval | conservative interval | measured value |
| HC-11 validation TTL | short TTL | tuned value |
| NET-01 handshake | keep existing `mnemosin.v1.<jwt>` | security model |
| NET-03 connections | single controlling connection | final policy |
| NET-04/NET-05 timings | prototype values | tuned |
| NET-07 visibility | same-room players visible | final spatial rules |
| NET-11/NET-16 offline queue | disabled for time-sensitive commands | per-category TTL |
| NET-14/NET-15 pacing | prototype caps | final caps |
| NET-20 rate limits | disabled locally | production limits |
| WS-21/WS-22 interaction gating | not implemented yet | final gating/priority |
| DOLL-* / ML-* / AND-* | not required | later phases |

### §6.3. NOT REQUIRED FOR FIRST VERTICAL SLICE

Everything in §3 that is classified `DOLL-OPEN-*` (except none needed), `ML-*`, `AND-*`, all Observer items, ending resolver, rewind, post-game, art pipeline and production World Packs. For the slice: no endings, no doll sensor model, no art pipeline, no full lobby/roles rules.

This is deliberate: the slice must not wait for P08/P10/P12/P13.

---

## §7. ADR Status

### §7.1. Existing ADR infrastructure

No ADR directory or ADR files exist in the repository (checked via `git ls-files`: no `docs/adr`, no `decisions/`, no ADR templates). Therefore P01 **does not create** an ADR structure automatically.

**No new ADR created — no additional confirmed decision required an ADR in this P01 pass.** All already-confirmed positions are listed below; if the owner wants a formal ADR directory, that is a separate decision.

### §7.2. Already-confirmed decisions (inventory, not new ADRs)

| Confirmed decision | Evidence anchor | Status |
|---|---|---|
| Server stack: TypeScript strict, Node 22+, Fastify | SYS L92–93 | СОГЛАСОВАНО |
| Real-time transport: WebSocket (WSS in production) | SYS L94, NET L160 | СОГЛАСОВАНО |
| DB: SQLite + Drizzle (driver = implementation detail) | SYS L95 | СОГЛАСОВАНО |
| Contracts: TypeScript + Zod in `shared/contracts` | SYS L96 | СОГЛАСОВАНО |
| Client: Svelte 5 + Vite SPA; PixiJS for 2D | SYS L97–98 | СОГЛАСОВАНО |
| Art pipeline: Blender → PNG → palette → PixiJS | SYS L99 | СОГЛАСОВАНО |
| Modular monolith, Ports & Adapters, dependency rules | SYS L101 | СОГЛАСОВАНО |
| HOT: in-memory, fixed 20 Hz (50 ms step) | SYS L254, L767; HC L272; DOLL L984 | СОГЛАСОВАНО |
| Server uses plain square grid `(gx, gy)`; tilt only on client | SYS L395; WS L189, L463 | СОГЛАСОВАНО |
| `StateService` is the single controlled path for durable state | SYS L316 | СОГЛАСОВАНО |
| Dolls run algorithmic behaviour, never LLM | SYS L495; DOLL L895, L984 | СОГЛАСОВАНО |
| Andrey is the only mandatory interactive LLM character | SYS L605; AND L60 | СОГЛАСОВАНО |
| Observer is optional, occupies no player slot, omniscient read access, view/intervention split | SYS L680, L684, L706; NET L733; DOLL L1240 | СОГЛАСОВАНО |
| Match configuration is algorithmic from seed, no LLM | SYS L556; DOLL L1067 | СОГЛАСОВАНО |
| No mandatory GM Review / no human GM in production | AND L1318 | СОГЛАСОВАНО |
| 6–10 game participants per match | ML L318, L336 | СОГЛАСОВАНО |
| Five cycle phases per floor Э1–Э6 | ML L263 | СОГЛАСОВАНО |
| Captured player stays in the match (Dolls/Nursery/Stasis) | ML L671, L706; DOLL L895 | СОГЛАСОВАНО |
| Local stimuli only; no global public noise scale | WS L904; DOLL L157 | СОГЛАСОВАНО |
| Proximity channel requires same space + distance threshold, server-computed | WS L1011 | СОГЛАСОВАНО |
| Server geometry independent from presentation/art | SYS L219; WS L327 | СОГЛАСОВАНО |

---

## §8. Owner Decision Queue

### Queue A — before P03–P05 (5 groups)

| # | IDs | Why here | If postponed | Prototype possible without it? |
|---|---|---|---|---|
| A1 | WS-02 | coordinate convention underpins all slice contracts | every movement/projection contract stays unstable | PARTIAL — code can start, contracts cannot be frozen |
| A2 | WS-03 / HC-02 / NET-02 | one input decision, three IDs | P05 client and prediction blocked | PARTIAL |
| A3 | HC-03 + WS-05 | collision basis + collider shape | server movement cannot be specified | PARTIAL |
| A4 | WS-01 | world-space topology | P03 schema churn | YES (one-space test room) |
| A5 | WS-20 (format only) | test-room Pack authoring | loader can use hand JSON | YES |

### Queue B — before the next systems (grouped, in dependency order)

1. **Durability & recovery (P06):** G15 — HC-06, HC-07, HC-08, HC-09, ARCH-L385, ARCH-L850. Needed before production guarantees; prototype harness first.
2. **Tick and pacing (P04/P05 tuning):** HC-01, G14, G19, G34.
3. **Spatial mechanics (P07):** G7, G8, G9, G10, G12 — plus WS-09.
4. **Doll AI baseline (P08A):** G21, G22, G23, G24, G26. Sensor model (G21) is the gate.
5. **Capture integration (P08B/P10):** G25 — requires P10 participant states.
6. **Match lifecycle (P10):** G37, G38, G39, G40, G41, G42, plus G18 (disconnect/AFK/pause).
7. **Observer & developer tooling (P11):** G32, G20.
8. **Andrey (P12):** G47, G48, G49, G50, G51, G52 (G53 = content).
9. **Finale & endings (P13):** G43, G44, G45, G46.

### Queue C — can be postponed

Production content and balancing: doll floor profiles and ability tables (G24), incidents catalog (G42), prologue variants (G39), Andrey fallback lines and arc texts (G53), post-game UX (G46), art pipeline/projection (G11), balance numbers (WS speeds, filter formula, help cost, phase durations), network compatibility and rate limits (G35, G36), multi-match support (ML-05) beyond a single prototype match.

**Recommendation:** approve Queue A as one short decision session (5 questions), then start P02/P03 while Queue B groups are decided per phase.

---

## §9. Provenance and Method

- **Method:** each specification was processed separately. For every document the numbered open-question table and every inline `ОТКРЫТО` paragraph were located, read with surrounding context, and transcribed; each transcription was then cross-checked against a global `grep` of the ID patterns and status markers.
- **Verification:** numbered IDs found and filled: WS 22/22, HC 14/14, DOLL-OPEN 19/19, NET 20/20, ML 38/38, AND-OPEN 23/23 — **136/136**. Inline items found: 78 (WSIM 13, DOLL 9, NET 5, ML 29, AND 12, ARCH 10, HC 0) — of which 21 are registered as distinct rows and 57 are recorded as duplicate facets in the numbered rows.
- **Anchors:** line numbers refer to the specification files at the current working tree (HEAD `d292715`). Git history confirms the seven specification files are unchanged between the audited source-tree snapshot `55ddad6` and current HEAD, so the anchors are stable.
- **Not done in P01:** no specification was edited, no decision was enacted, no code, test, contract, CI, migration or package file was touched, no ADR structure was invented.
- **Known limits:** for a few items the source provides no option list and no measurement route (`OPTIONS = нет`, `PROTO = PARTIAL`); those are marked `OWNER INPUT REQUIRED` in the queue rather than filled with assumptions. `WS-09` remains ungrouped because it is a standalone topic.

