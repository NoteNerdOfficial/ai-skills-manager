import { Collection, ItemMetadata, SkillManagerPluginSettings } from "./types";
import { ShadowNoteStore } from "./store";

/** Persists a collection edit (new or existing) and syncs every affected item's `collections`
 *  field in the shadow store. Shared by the library sidebar and the file view's "add to
 *  collection" action so both mutate the same membership bookkeeping the same way. */
export async function upsertCollectionAndSync(
  store: ShadowNoteStore,
  settings: SkillManagerPluginSettings,
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

  // Each store.update() writes a different item's own shadow note, so these are independent file
  // writes — no reason to serialize them with await-in-a-loop.
  await Promise.all(
    [...removedFrom].map((entryId) => {
      const item = items.find((i) => i.entryId === entryId);
      if (!item) return Promise.resolve();
      return store.update(entryId, { collections: item.collections.filter((c) => c !== collection.id) });
    })
  );
  await Promise.all(
    [...addedTo].map((entryId) => {
      const item = items.find((i) => i.entryId === entryId);
      if (!item || item.collections.includes(collection.id)) return Promise.resolve();
      return store.update(entryId, { collections: [...item.collections, collection.id] });
    })
  );
}

/** Drops a collection and scrubs its id out of every member's `collections` field, so deleted
 *  items don't keep pointing at a collection that no longer exists in settings. */
export async function deleteCollectionAndSync(
  store: ShadowNoteStore,
  settings: SkillManagerPluginSettings,
  saveSettings: () => Promise<void>,
  items: ItemMetadata[],
  collectionId: string
): Promise<void> {
  settings.collections = settings.collections.filter((c) => c.id !== collectionId);
  await saveSettings();

  await Promise.all(
    items
      .filter((item) => item.collections.includes(collectionId))
      .map((item) => store.update(item.entryId, { collections: item.collections.filter((c) => c !== collectionId) }))
  );
}
