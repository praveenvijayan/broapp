/**
 * `dist/starter-template.json` is a build artefact — `scripts/build-template.ts`
 * writes it, and it is not in git. Without this declaration a checkout that has
 * not built it cannot typecheck, because `resolveJsonModule` makes a missing
 * JSON file an error. The shape here is `StarterTemplate`; `main.ts` casts to
 * the real type at the import.
 */
declare module '*/dist/starter-template.json' {
  const template: { readonly files: Readonly<Record<string, string>> };
  export default template;
}
