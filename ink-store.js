const DB_NAME = 'booklet-checker-ink';
const STORE_NAME = 'documents';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error || new Error('保存を中断しました'));
    });
  } finally {
    db.close();
  }
}

export async function loadInk(id) {
  return (await withStore('readonly', store => store.get(id)))?.pages || {};
}

export async function saveInk(id, pages) {
  await withStore('readwrite', store => store.put({ id, pages, updatedAt: Date.now() }));
}
