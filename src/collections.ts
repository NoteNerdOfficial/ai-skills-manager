import { Collection, ItemMetadata, SkillSpacePluginSettings } from "./types";
import { ShadowNoteStore } from "./store";

/** Persists a collection edit (new or existing) and syncs every affected item's `collections`
 *  field in the shadow store. Shared by the library sidebar and the file view's "add to
 *  collection" action so both mutate the same membership bookkeeping the same way. */
export async function upsertCollectionAndSync(
  store: ShadowNoteStore,
  settings: SkillSpacePluginSettings,
  saveSettings: () => Promise<void>,
  items: ItemMetadata[],
  collection: Collection
): Promise<void> {
  const idx = settings.collections.findIndex((c) => c.id === collection.id);
  const previous = idx >= 0 ? settings.collections[idx] : null;
  if (idx >= 0) settings.collections[idx] = collection;
  else settings.collections.push(collection);
  await saveSettings();

  const removedFrom = new Set(previous ? previous.itemIds.filter((id) => !collection.itemIds.includes(id)) : []);
  const addedTo = new Set(collection.itemIds);

  for (const entryId of removedFrom) {
    const item = items.find((i) => i.entryId === entryId);
    if (item) {
      await store.update(entryId, { collections: item.collections.filter((c) => c !== collection.id) });
    }
  }
  for (const entryId of addedTo) {
    const item = items.find((i) => i.entryId === entryId);
    if (item && !item.collections.includes(collection.id)) {
      await store.update(entryId, { collections: [...item.collections, collection.id] });
    }
  }
}
