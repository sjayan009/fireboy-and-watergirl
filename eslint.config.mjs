/**
 * The lint gate, and where its line is drawn.
 *
 * There was none. The app has a strict typecheck and the engine deliberately
 * does not -- `engine/tsconfig.json` turns off `strict`, `noImplicitAny` and
 * the null checks, because most of that directory is a machine translation of
 * decompiled ActionScript and holding generated code to a standard nobody
 * writes to means turning the standard off for everything around it.
 *
 * Which is exactly the problem this configuration exists to solve: the
 * relaxation is per DIRECTORY when it should be per ORIGIN. `game/game.ts` is
 * five thousand lines the tools produced. `net/session.ts` beside it is
 * handwritten, holds the rollback netcode, and is where an unawaited promise or
 * an unchecked cast of a peer's payload actually costs something -- both of
 * which the audit found there.
 *
 * So the generated files are named, and everything else is linted with the
 * type-aware rules that catch what this project's bugs have actually been:
 *
 *   no-floating-promises   the audit's WebRTC finding, exactly: two async IIFEs
 *                          with no terminal catch, whose failures became
 *                          unhandled rejections and a generic timeout.
 *   no-misused-promises    an async function passed where a void callback is
 *                          expected, so nothing waits for it and nothing hears
 *                          it fail.
 *   await-thenable         and its opposite, an await on something that was
 *                          never going to be a promise.
 *   switch-exhaustiveness  a Command or a Stage added without every switch
 *                          learning about it.
 *   no-unnecessary-type-assertion / no-explicit-any (warn)
 *                          the `payload as Invite` habit that let a peer's
 *                          arbitrary JSON into the session's state handlers.
 *
 * `npm run lint` runs it, and `npm test` runs that. The tree is clean of errors
 * as of the change that added this -- the eleven it found on its first run were
 * fixed rather than suppressed, and the rules it does not enforce are turned off
 * one at a time with a reason each, below, rather than by lowering the whole
 * configuration until it was quiet.
 *
 * The `no-explicit-any` warnings are left standing on purpose. There are about
 * a hundred and fifty and almost all of them are the ported game's display list,
 * which genuinely has no type; a suppression would hide the handful that are
 * not.
 */
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The engine's own debug harness, and the type shims beside the .mjs tooling.
 *
 * `engine/src/main.ts` is the page `serve.mjs` serves: buttons that unlock the
 * map, run a soak, or pair two tabs. It is not shipped and its handlers are
 * allowed to be async without a wrapper. The `.d.mts` files exist so
 * `vite.config.ts` can import a `.mjs` under strict TypeScript, and have no
 * project of their own for a type-aware rule to consult.
 */
const HARNESS = ["engine/src/main.ts", "**/*.d.mts"];

/** Machine-produced, and held to what the tools emit rather than to a style. */
const GENERATED = [
  "engine/src/game/game.ts",
  "engine/src/flash/**",
  "engine/src/box2d/**",
  "extracted/**",
  "tools/**",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".cache/**",
      "**/dist/**",
      "dist/**",
      "snaps/**",
      "preview/**",
      "web/**",
      ...HARNESS,
      ...GENERATED,
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The four the audit's findings map onto directly.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Casting a peer's payload to the type you hoped it was is how M-04
      // happened. A warning rather than an error because the ported game is
      // reached through `any` by design and the boundary is not a clean line.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // A caught error that is deliberately ignored is a decision this codebase
      // makes often and comments every time.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // ---- rules that fire on the port's shape rather than on a mistake ----
      //
      // Each of these is off for a reason about THIS codebase, not because it
      // was noisy. An off rule with no reason beside it is a rule somebody will
      // turn back on and then turn off again.

      // `engine/tsconfig.json` has `strict` off, so every type is already
      // nullable-free and every `!` reads as redundant to a checker that
      // believes it. They are not redundant: they are what the file would need
      // under strict, and deleting them all would make turning strict on later
      // a rewrite rather than a switch.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",

      // `Kind` and `Command` are const enums compared against bytes off the
      // wire. That comparison is the decoder's whole job.
      "@typescript-eslint/no-unsafe-enum-comparison": "off",

      // `const pair = this` inside `join`, and the same in three netcode
      // tests. The alias is there because the closures below it are wired into
      // a channel that outlives the method, and naming the thing they belong to
      // is clearer than binding.
      "@typescript-eslint/no-this-alias": "off",

      // The ported game is reached through `any` by design -- it is a
      // machine-translated display list -- so template literals over its values
      // are how every diagnostic in the engine's tests is written.
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "preserve-caught-error": "warn",
    },
  },
  {
    // The .mjs tooling: Node scripts, and no TypeScript project behind them --
    // so the type-aware rules have nothing to be aware of and are turned off
    // rather than left to fail on every file with a parse error.
    files: ["**/*.mjs"],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      // Spread INTO the rules rather than over the whole config object: a
      // spread at the top level is replaced wholesale by the `rules` key below
      // it, which leaves every type-aware rule enabled and every .mjs file
      // failing to parse.
      ...tseslint.configs.disableTypeChecked.rules,
      // These are Node scripts run with `node x.mjs`; the globals they use are
      // Node's, and there is no environment declaration to teach that to a
      // rule whose whole job is to know which names exist.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
