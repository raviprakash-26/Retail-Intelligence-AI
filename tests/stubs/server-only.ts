/**
 * Test stub for the `server-only` package.
 *
 * `server-only` resolves to a module that throws unless the bundler applies
 * the `react-server` export condition. Vitest runs plain Node, so modules
 * carrying the server-only guard — the accounting engine, the password
 * helpers — would be unimportable and therefore untestable. Aliasing it to a
 * no-op keeps the guard meaningful in the application build while letting the
 * suite reach the code it protects.
 */
export {};
