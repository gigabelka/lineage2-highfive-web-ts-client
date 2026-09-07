import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Flat-config ESLint (v10). Advisory: не завязан на `build` / `test`, запускается
 * через `npm run lint` по аналогии с `npm run knip`.
 *
 * Строгость: `eslint` recommended + `typescript-eslint` recommended (без
 * type-aware). Правила, которые лишь стилистический шум на намеренно "грязном"
 * RE-коде, переведены в `warn`; ошибками остаётся то, что указывает на реальные
 * дефекты (присваивание в условии, недостижимый код, дубли ключей, `case`-провалы
 * и т.п. — дефолты recommended).
 */
export default tseslint.config(
    {
        // генерённое / вендорное / бинарники / декларации не линтим
        ignores: [
            "bin/**",
            "coverage/**",
            "configs/**",
            "reference/**",
            "docs/**",
            "html/**",
            "node_modules/**",
            "**/*.d.ts",
            "*-report.jsonl"
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: { ...globals.browser, ...globals.node }
        },
        rules: {
            // --- шум -> warn (намеренно "грязный" код реверс-инжиниринга) ---
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrors: "none"
                }
            ],
            "@typescript-eslint/no-empty-function": "warn",
            "@typescript-eslint/no-empty-object-type": "warn",
            "@typescript-eslint/no-unsafe-function-type": "warn",
            "@typescript-eslint/no-wrapper-object-types": "warn",
            "@typescript-eslint/no-this-alias": "warn",
            "@typescript-eslint/ban-ts-comment": "warn",
            "@typescript-eslint/no-namespace": "warn",
            // UE2-флаговые enum'ы намеренно переиспользуют битовые значения
            "@typescript-eslint/no-duplicate-enum-values": "warn",
            "no-empty": ["warn", { allowEmptyCatch: true }],
            "prefer-const": "warn",
            // терпимый к терсовому RE-стилю: `var`, comma-оператор, escape в regexp
            "no-var": "warn",
            "@typescript-eslint/no-unused-expressions": "warn",
            "no-useless-escape": "warn",
            "no-case-declarations": "warn",
            "no-useless-assignment": "warn"
        }
    },
    {
        // worker-граф: свои глобалы
        files: ["src/assets/decode-worker/**/*.ts"],
        languageOptions: { globals: { ...globals.worker } }
    },
    {
        // конфиги и tooling — чистый Node
        files: ["*.config.ts", "vite.config.ts", "vitest.config.ts", "tools/**/*.ts"],
        languageOptions: { globals: { ...globals.node } }
    }
);
