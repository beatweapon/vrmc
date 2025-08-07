export const createIndexedDB = (dbName, storeName) => {
  const openDatabase = () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  return {
    saveData: async (key, data) => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(data, key);
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
    },
    loadData: async (key) => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = reject;
      });
    },
  };
};
