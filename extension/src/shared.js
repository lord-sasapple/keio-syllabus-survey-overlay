(() => {
  const STORAGE_KEYS = {
    courses: "keioSurvey.courses",
    evaluations: "keioSurvey.evaluations",
    networkEvents: "keioSurvey.networkEvents",
    settings: "keioSurvey.settings",
    lastSeen: "keioSurvey.lastSeen",
    lastSyncAllEvaluations: "keioSurvey.lastSyncAllEvaluations",
    lastSyncProgress: "keioSurvey.lastSyncProgress"
  };
  const DB_NAME = "keioSurveyCache";
  const DB_VERSION = 1;

  const DAY_MAP = {
    月: "月",
    火: "火",
    水: "水",
    木: "木",
    金: "金",
    土: "土",
    日: "日"
  };

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizePerson(value) {
    return normalizeText(value).replace(/\s+/g, "");
  }

  function normalizeDayPeriod(value) {
    return normalizeText(value)
      .replace(/[限時]/g, "")
      .replace(/\s+/g, "")
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[月火水木金土日]/g, (ch) => DAY_MAP[ch] || ch);
  }

  function normalizeSemester(value) {
    const text = normalizeText(value);
    const year = text.match(/20\d{2}/)?.[0] || "";
    const season = text.includes("春") || /spring/i.test(text) ? "春" : text.includes("秋") || /fall|autumn/i.test(text) ? "秋" : "";
    return `${year}${season}`;
  }

  function toNumber(value) {
    if (value == null || value === "") return null;
    const number = Number(String(value).replace("%", ""));
    return Number.isFinite(number) ? number : null;
  }

  function compactCourseKey(course) {
    return [
      normalizeText(course.courseName || course.title),
      normalizePerson(course.lecturer || course.mainLecturer || course.instructor),
      normalizeSemester(course.semester || course.term),
      normalizeDayPeriod(course.dayPeriod),
      normalizeText(course.campus),
      normalizeText(course.faculty)
    ].join("|");
  }

  function scoreCourseMatch(syllabus, candidate) {
    let score = 0;
    if (normalizeText(syllabus.courseName) === normalizeText(candidate.courseName)) score += 40;
    if (normalizePerson(syllabus.lecturer) === normalizePerson(candidate.lecturer)) score += 25;
    if (normalizeSemester(syllabus.semester) === normalizeSemester(candidate.semester)) score += 15;
    if (normalizeDayPeriod(syllabus.dayPeriod) === normalizeDayPeriod(candidate.dayPeriod)) score += 10;
    if (normalizeText(syllabus.campus) === normalizeText(candidate.campus)) score += 6;
    if (normalizeText(syllabus.faculty) === normalizeText(candidate.faculty)) score += 4;
    return score;
  }

  function storageGet(defaults) {
    return chrome.storage.local.get(defaults);
  }

  function storageSet(values) {
    return chrome.storage.local.set(values);
  }

  function usesExtensionCacheBridge() {
    return location.protocol !== "chrome-extension:" && Boolean(chrome?.runtime?.id);
  }

  function cacheMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "keioSurvey.cache", ...message }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.message || response?.code || "Cache request failed."));
          return;
        }
        resolve(response);
      });
    });
  }

  function dbOpen() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("courses")) db.createObjectStore("courses", { keyPath: "recordId" });
        if (!db.objectStoreNames.contains("evaluations")) db.createObjectStore("evaluations", { keyPath: "recordId" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbStore(mode, storeName, callback) {
    const db = await dbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }).finally(() => db.close());
  }

  function dbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function cachePut(storeName, value) {
    if (!value?.recordId && storeName !== "meta") return;
    if (usesExtensionCacheBridge()) {
      await cacheMessage({ op: "put", storeName, value });
      return;
    }
    await dbStore("readwrite", storeName, (store) => store.put(value));
  }

  async function cachePutMany(storeName, values) {
    const clean = Array.isArray(values) ? values.filter((value) => value?.recordId || storeName === "meta") : [];
    if (!clean.length) return;
    if (usesExtensionCacheBridge()) {
      await cacheMessage({ op: "putMany", storeName, values: clean });
      return;
    }
    await dbStore("readwrite", storeName, (store) => {
      for (const value of clean) store.put(value);
    });
  }

  async function cacheGetAll(storeName) {
    if (usesExtensionCacheBridge()) {
      const response = await cacheMessage({ op: "getAll", storeName });
      return response.values || [];
    }
    const db = await dbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function cacheSetMeta(key, value) {
    if (usesExtensionCacheBridge()) {
      await cacheMessage({ op: "setMeta", storeName: "meta", key, value });
      return;
    }
    await dbStore("readwrite", "meta", (store) => store.put({ key, value, updatedAt: new Date().toISOString() }));
  }

  async function cacheGetMeta(key) {
    if (usesExtensionCacheBridge()) {
      const response = await cacheMessage({ op: "getMeta", storeName: "meta", key });
      return response.value || null;
    }
    return dbStore("readonly", "meta", (store) => dbRequest(store.get(key)));
  }

  function debounce(fn, delay) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  window.KeioSurveyShared = {
    STORAGE_KEYS,
    compactCourseKey,
    debounce,
    normalizeDayPeriod,
    normalizePerson,
    normalizeSemester,
    normalizeText,
    cacheGetAll,
    cacheGetMeta,
    cachePut,
    cachePutMany,
    cacheSetMeta,
    scoreCourseMatch,
    storageGet,
    storageSet,
    toNumber
  };
})();
