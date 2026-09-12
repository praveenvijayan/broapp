/**
 * `dist/templates.json` is a build artefact — `scripts/build-template.ts`
 * writes it, and it is not in git. Without this declaration a checkout that has
 * not built it cannot typecheck, because `resolveJsonModule` makes a missing
 * JSON file an error. The shape here is `Templates`; `main.ts` casts to the
 * real type at the import.
 */
declare module '*/dist/templates.json' {
  const templates: Readonly<Record<string, { readonly files: Readonly<Record<string, string>> }>>;
  export default templates;
}
