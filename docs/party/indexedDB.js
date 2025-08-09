export const createIndexedDB = (dbName, storeName) => {
  let dbPromise = null;

  const openDatabase = () => {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(storeName);
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  };

  const withStore = async (mode, callback) => {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = callback(store);

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  };

  return {
    saveData: (key, data) =>
      withStore("readwrite", (store) => store.put(data, key)),

    loadData: (key) =>
      withStore("readonly", (store) => {
        return new Promise((resolve, reject) => {
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = reject;
        });
      }),

    existsKey: (key) =>
      withStore("readonly", (store) => {
        return new Promise((resolve, reject) => {
          const req = store.getKey(key);
          req.onsuccess = () => resolve(req.result !== undefined);
          req.onerror = reject;
        });
      }),
  };
};
