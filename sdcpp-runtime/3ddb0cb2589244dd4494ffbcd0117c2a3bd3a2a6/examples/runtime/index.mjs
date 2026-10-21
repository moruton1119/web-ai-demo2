/** Optional, policy-free host helpers. The caller creates the module and owns its lifetime. */
export { attachCore } from './bindings.mjs';
export { mountReadOnlyFile } from './read-only-file.mjs';
export { default as schema } from '../../api/schema.mjs';
