export function createIndexedDB(
  dbName = "localdb",
  storeName = "keyValueStore",
) {
  const openDatabase = () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id" });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  };

  const saveData = (id, data) => {
    return openDatabase().then((db) => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], "readwrite");
        const store = transaction.objectStore(storeName);
        const request = store.put({ id, data });

        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
      });
    });
  };

  const saveFile = (id, file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        saveData(id, event.target.result).then(resolve).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const loadData = (id) => {
    return openDatabase().then((db) => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.get(id);

        request.onsuccess = (event) => {
          const result = event.target.result;
          if (result) {
            resolve(result.data);
          } else {
            resolve(undefined);
          }
        };

        request.onerror = (event) => reject(event.target.error);
      });
    });
  };

  return { saveData, saveFile, loadData };
}
