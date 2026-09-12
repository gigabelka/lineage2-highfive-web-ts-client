# Lineage II: High Five — веб-клиент на TypeScript

Реализация с нуля браузерного клиента игры **Lineage II: High Five**. Клиент читает оригинальные зашифрованные бинарники движка UE2 (`.unr`, `.utx`, `.usx`, `.uax`, `.ukx`, `.u`, `.ogg`) и рендерит игровой мир через three.js + WebGL.

На данный момент это потоковый вьюер ассетов, а не полноценный геймплей.

Основано на проекте [realratchet/Lineage2JS](https://github.com/realratchet/Lineage2JS). Часть кода (`@l2js/core`) провендорена в этот репозиторий из [realratchet/l2js-core](https://github.com/realratchet/l2js-core).

## Требования

- `c:/Games/HighFive/` — установленный клиент игры (исходные ассеты). Без него сборка и запуск работают, но грузить будет нечего.
- Node.js для сборки/запуска через Vite.

## Установка

```bash
npm install
```

`npm install` не требует доступа к GitHub по SSH — `@l2js/core` и `gmp-wasm` уже провендорены в `vendor/`.

## Команды

- `npm run dev` — dev-сервер Vite на `127.0.0.1:8888`. Раздаёт приложение, каталог `html/` (publicDir) и дерево `c:/Games/HighFive/` под `/assets` (с поддержкой HTTP byte-range).
- `npm run build-dev` — сборка в `bin/` (`vite build --mode development`, сорсмапы, `target: chrome80`).
- `npm run preview` — просмотр ранее собранного `bin/`.
- `npm test` — тесты (Vitest).
- `npm run test:watch` / `npm run test:ui` — тесты в интерактивном режиме.
- `npm run lint` / `npm run lint:fix` — линт (ESLint), носит рекомендательный характер.
- `npm run typecheck` — проверка типов (`tsc --noEmit` через обёртку `tools/typecheck.ts`).
- `npm run knip` — поиск неиспользуемых файлов/экспортов/зависимостей.

`LIVE_RELOAD=0 npm run dev` — отключает HMR (полезно для автоматических прогонов `?sectorTest`).

### `?sectorTest`

Специальный режим (`src/sector-test.ts`), декодирующий и рендерящий все секторы уровня, служит основным интеграционным тестом проекта. Результаты пишутся построчно (JSONL) в `sector-test-report.jsonl`.

## Архитектура (кратко)

- **Клиент** (`src/index.ts`) — рендерер: three.js, материалы, камера, DOM. Не содержит кода парсинга ассетов UE2.
- **Decode worker** (`src/assets/decode-worker/`) — отдельный граф модулей, владеет всем пайплайном разбора ассетов UE2 (десериализация пакетов, декодирование текстур DXT→RGBA и т.д.), выполняется в Web Worker'ах.
- **Sector streaming** (`src/assets/asset-manager.ts`) — потоковая подгрузка/выгрузка мира вокруг камеры.
- **Rendering** (`src/rendering/render-manager.ts`) — игровой цикл, камера, постобработка, окружение/небо/туман, звук, отладочная панель (`lil-gui`).
- **Actors** (`src/base-actor.ts`, `src/player.ts`, `src/objects/`) — зачаточная стадия геймплея (физика на rapier3d, анимации), пока не полноценная фича.

Подробное описание архитектуры, соглашений и внутренних деталей — в [CLAUDE.md](CLAUDE.md).

## Лицензия

ISC
