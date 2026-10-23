// Node resolve hook: send the bare 'three' import to the vendored build,
// which is what the import map in index.html does in the browser.
const THREE = new URL('../lib/three.module.js', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: THREE, shortCircuit: true };
  return next(specifier, context);
}
