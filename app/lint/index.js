// The lint toolchain is its own npm project (package.json and package-lock.json in this folder) because
// typescript-eslint needs the TypeScript JavaScript API, and the root typescript@7 package is the native compiler,
// which ships tsc only. Installing here keeps TypeScript 5 and typescript-eslint out of the app's dependency tree,
// where npm would otherwise hoist parts of them next to typescript@7. `npm run lint` installs this folder first.
export { default as tseslint } from 'typescript-eslint';
