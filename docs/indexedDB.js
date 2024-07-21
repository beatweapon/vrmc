const DB_NAME = "localdb";
const STORE_NAME = "keyValueStore";

const saveData = (id, data) => {
  return new Promise((resolve, reject) => {
    openDatabase(DB_NAME).then((db) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      const request = store.put({ id, data });

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  });
};

const saveFile = (id, file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const data = event.target.result;
      saveData(id, data)
        .then(() => {
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    };

    reader.readAsArrayBuffer(file);
  });
};

const loadData = (id) => {
  return new Promise((resolve, reject) => {
    return openDatabase(DB_NAME).then((db) => {
      const transaction = db.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = (event) => {
        const result = event.target.result;
        if (result) {
          resolve(result.data);
        } else {
          reject("Data not found");
        }
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  });
};

const openDatabase = (db) => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(db);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
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

export default {
  saveData,
  saveFile,
  loadData,
};
