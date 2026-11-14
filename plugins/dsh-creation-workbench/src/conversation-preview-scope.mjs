export const conversationPreviewSlot = name => `wtt.file.${name}`;

// Mount published native occupants in an owned tree. Original registrations,
// declarations, stores and Session sources are never rewritten.
export function registerConversationPreviewScope(ctx, wrapComponent) {
  return ctx.slots.inject(conversationPreviewSlot('conversation.session'), () => {
    let disposers = [], watches = [], sources = new Set(), syncing = false;
    const unwatch = () => { for (const stop of watches) stop(); watches = []; };
    const clear = () => { for (const dispose of disposers.reverse()) dispose(); disposers = []; };
    const sync = () => {
      if (syncing) return;
      syncing = true;
      try {
        unwatch(); clear(); sources = new Set();
        const copy = name => {
          if (sources.has(name)) return;
          sources.add(name);
          watches.push(ctx.slots.subscribe(name, sync));
          const entries = ctx.slots.entriesOfSlot(name).filter(entry => name !== 'conversation.view' || entry.options.id === 'chat');
          for (const entry of entries) {
            const children = Object.fromEntries(Object.entries(entry.children || {}).map(([child, spec]) => [conversationPreviewSlot(child), spec]));
            disposers.push(ctx.slots.register({ ...entry.options, name: conversationPreviewSlot(name),
              ...(entry.store ? { store: entry.store } : {}), ...(entry.inject ? { inject: entry.inject } : {}),
              ...(entry.locale ? { locale: entry.locale } : {}), ...(entry.select ? { select: entry.select } : {}),
              ...(entry.children ? { children } : {}),
            }, wrapComponent(entry.component, name)));
            for (const child of Object.keys(entry.children || {})) copy(child);
          }
        };
        copy('conversation.session');
      } catch (error) { unwatch(); clear(); throw error; }
      finally { syncing = false; }
    };
    sync();
    return () => { unwatch(); clear(); };
  });
}
