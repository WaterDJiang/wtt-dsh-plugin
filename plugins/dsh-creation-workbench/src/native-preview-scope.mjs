/** Compose a published document-preview plugin instance into workbench-owned
 * slots. All registries, stores and renderer components come from that plugin;
 * only its mounting names and two host-wide registration ports are adapted. */
export const nativePreviewSlot = name => name.startsWith('sidebar.right.') ? `wtt.preview.${name}` : name;
export function previewPluginScope(ctx, wrapComponent) {
  let previews;
  const scope = original => new Proxy(original, { get(target, key) {
    if (key === 'documentPreviews') return previews;
    if (key === 'reflect') return { provide(name, value) {
      if (name !== 'documentPreviews' || previews) throw new Error(`原生预览装配接口已变化：${name}`);
      previews = value; return () => { if (previews === value) previews = undefined; };
    } };
    // This instance has no host-wide tab type or locale ownership. Its caller
    // owns the embedded tab and reuses the installed provider's dictionaries.
    if (key === 'sidebarRightTabs') return { register: () => () => {} };
    if (key === 'locale') return { bind: target.locale.bind.bind(target.locale), register: () => () => {} };
    if (key === 'inject') return (dependencies, apply) => target.inject(dependencies, child => apply(scope(child)));
    if (key === 'slots') return {
      inject: (name, apply) => target.slots.inject(nativePreviewSlot(name), apply),
      register: (options, Component) => target.slots.register({ ...options,
        name: nativePreviewSlot(options.name),
        ...(options.children ? { children: Object.fromEntries(Object.entries(options.children).map(([name, spec]) => [nativePreviewSlot(name), spec])) } : {}),
      }, wrapComponent(Component, nativePreviewSlot)),
    };
    return Reflect.get(target, key, target);
  } });
  return scope(ctx);
}
