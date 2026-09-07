#!/usr/bin/env node
/*
 * typecheck.ts — запуск `tsc --noEmit` с отсевом чужих ошибок.
 *
 * `@l2js/core` подключается как СЫРОЙ TypeScript-исходник (см. CLAUDE.md,
 * `optimizeDeps.exclude` в vite.config.ts), поэтому `tsc` начинает
 * типизировать и его `.ts`-файлы. Собственный tsconfig ядра, его ambient-типы
 * (`IConstructable`, `EnumKeys.*`) и `@types/pako` при этом недоступны, так что
 * ядро даёт ~30 ошибок, к нашему коду отношения не имеющих. `exclude` в tsconfig
 * их не убирает — файл, импортированный из проекта, всё равно проверяется.
 *
 * Обёртка прогоняет `tsc`, показывает ВЕСЬ вывод как есть, но код возврата
 * ставит только по строкам НЕ из `node_modules/`. Аналог `npm run lint` /
 * `npm run knip` — advisory для чужого, строгий для своего.
 *
 * Запуск: `npm run typecheck` (через tsx, без зависимостей).
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/lib/tsc.js");

const tsc = spawnSync(
    process.execPath,
    [tscBin, "--noEmit", "--pretty", "false"],
    { encoding: "utf8" },
);

if (tsc.error) {
    console.error(tsc.error);
    process.exit(1);
}

const output = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;
const isErrorLine = (l: string) => /\.[cm]?tsx?\(\d+,\d+\): error TS\d+/.test(l);

const allErrors = output.split(/\r?\n/).filter(isErrorLine);
const ownErrors = allErrors.filter((l) => !l.includes("node_modules/"));
const vendorErrors = allErrors.length - ownErrors.length;

// свои ошибки печатаем целиком; чужие (@l2js/core как исходник, кривой @types/webxr)
// глушим вместе с их отступными строками-продолжениями
let suppressing = false;
for (const line of output.split(/\r?\n/)) {
    if (isErrorLine(line)) suppressing = line.includes("node_modules/");
    else if (!/^\s/.test(line)) suppressing = false;
    if (suppressing || line.length === 0) continue;
    console.log(line);
}

console.log(
    `\ntypecheck: ${ownErrors.length} ошибок в src/, ${vendorErrors} в node_modules (игнорируются)`,
);

process.exit(ownErrors.length > 0 ? 1 : 0);
