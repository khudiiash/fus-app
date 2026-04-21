/**
 * Persists last RTDB `worldBlockEdits/{worldId}/cells` snapshot in IndexedDB so revisiting
 * a world can reconcile deletes vs stale cache and avoid repeat full-network cold starts where possible.
 */

const DB_NAME = "fus-world-cells-v1";
const STORE = "snapshots";
const DB_VER = 1;

let dbPromise = null;

export function isWorldCellsIdbSupported() {
    return typeof indexedDB !== "undefined";
}

function openDb() {
    if (!isWorldCellsIdbSupported()) {
        return Promise.reject(new Error("no idb"));
    }
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const r = indexedDB.open(DB_NAME, DB_VER);
            r.onerror = () => {
                dbPromise = null;
                reject(r.error);
            };
            r.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            r.onsuccess = () => resolve(r.result);
        });
    }
    return dbPromise;
}

/**
 * @param {string} worldId
 * @returns {Promise<{ savedAt: number, cells: Record<string, unknown> } | null>}
 */
export async function loadWorldCellsCache(worldId) {
    if (!worldId || typeof worldId !== "string") {
        return null;
    }
    try {
        const db = await openDb();
        const row = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const g = tx.objectStore(STORE).get(worldId);
            g.onsuccess = () => resolve(g.result);
            g.onerror = () => reject(g.error);
        });
        if (
            row &&
            typeof row === "object" &&
            row.cells &&
            typeof row.cells === "object" &&
            typeof row.savedAt === "number"
        ) {
            return /** @type {{ savedAt: number, cells: Record<string, unknown> }} */ (row);
        }
    } catch {
        /* quota / private mode */
    }
    return null;
}

/**
 * Fire-and-forget save; never throws to caller.
 * @param {string} worldId
 * @param {Record<string, unknown>} cells
 */
export function saveWorldCellsCache(worldId, cells) {
    if (!worldId || typeof worldId !== "string" || !cells || typeof cells !== "object") {
        return;
    }
    void (async () => {
        try {
            const payload = JSON.stringify({ savedAt: Date.now(), cells });
            /** ~45MB guard — worlds beyond this skip cache (still sync live). */
            if (payload.length > 45 * 1024 * 1024) {
                return;
            }
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).put({ savedAt: Date.now(), cells }, worldId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch {
            /* quota / stringify OOM */
        }
    })();
}
