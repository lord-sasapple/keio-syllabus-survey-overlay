(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cacheGetMeta,
    compactCourseKey,
    normalizePerson,
    normalizeSemester,
    normalizeText,
    scoreCourseMatch,
    storageGet
  } = window.KeioSurveyShared;

  const STYLE_ID = "keio-survey-result-overlay-style";
  const ITEM_SELECTOR = ".search-result-item";
  const CACHE_REFRESH_MS = 5 * 60 * 1000;
  const MAX_FALLBACK_CANDIDATES = 40;

  let cacheIndexPromise = null;
  let cacheIndexLoadedAt = 0;
  let renderTimer = 0;

  function objectStore(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function uniqueByRecordId(values) {
    const seen = new Set();
    const results = [];
    for (const value of values || []) {
      if (!value || typeof value !== "object") continue;
      const id = value.recordId || JSON.stringify(value.course || {});
      if (seen.has(id)) continue;
      seen.add(id);
      results.push(value);
    }
    return results;
  }

  function readDetailMap(item) {
    const details = {};
    for (const row of item.querySelectorAll(".detail-outer")) {
      const key = normalizeText(row.querySelector(".detail-heading")?.textContent || "");
      const value = normalizeText(row.querySelector(".detail-contents")?.textContent || "");
      if (key && value) details[key] = value;
    }
    return details;
  }

  function parseResultItem(item) {
    const detailLink = item.querySelector("a.syllabus-detail");
    const details = readDetailMap(item);
    const url = detailLink?.href ? new URL(detailLink.href, location.href) : null;
    const year = url?.searchParams.get("ttblyr") || "";
    const term = details["学期"] || "";
    return {
      courseName: normalizeText(item.querySelector(".sbjtnm")?.textContent || ""),
      lecturer: normalizeText(item.querySelector(".lctnm")?.textContent || ""),
      credit: normalizeText(item.querySelector(".credit")?.textContent || ""),
      semester: year && term ? `${year}${term}` : term,
      dayPeriod: details["曜日時限"] || "",
      campus: details["キャンパス"] || "",
      faculty: details["設置"] || "",
      format: details["実施形態"] || "",
      registrationNumber: details["登録番号"] || url?.searchParams.get("entno") || "",
      detailUrl: url?.href || ""
    };
  }

  function courseNameKey(value) {
    return normalizeText(value);
  }

  function looseCourseKey(course) {
    return [
      normalizeText(course.courseName),
      normalizePerson(course.lecturer),
      normalizeSemester(course.semester),
      normalizeText(course.campus)
    ].join("|");
  }

  function addToMapList(map, key, value) {
    if (!key.replace(/\|/g, "")) return;
    const list = map.get(key) || [];
    list.push(value);
    map.set(key, list);
  }

  function buildCacheIndex(evaluations) {
    const exact = new Map();
    const loose = new Map();
    const byName = new Map();

    for (const evaluation of evaluations) {
      const course = evaluation.course || {};
      const exactKey = compactCourseKey(course);
      if (exactKey.replace(/\|/g, "")) exact.set(exactKey, evaluation);
      addToMapList(loose, looseCourseKey(course), evaluation);
      addToMapList(byName, courseNameKey(course.courseName), evaluation);
    }

    return {
      exact,
      loose,
      byName,
      count: evaluations.length
    };
  }

  function facultyMatches(courseFaculty, selectedFaculty) {
    const courseValue = normalizeFacultyName(courseFaculty);
    const selected = normalizeFacultyName(selectedFaculty);
    if (!selected) return true;
    if (!courseValue) return false;
    return courseValue === selected || courseValue.includes(selected) || selected.includes(courseValue);
  }

  function normalizeFacultyName(value) {
    const text = normalizeText(value);
    const compact = text.replace(/[・\s]/g, "");
    if (!compact) return "";
    if (/総環|総合政策環境情報|環境情報|総合政策/.test(compact)) return "総合政策環境情報学部";
    if (/政メ|政策メディア/.test(compact)) return "政策メディア研究科";
    if (/文学研究科/.test(compact)) return "文学研究科";
    if (/経済学研究科/.test(compact)) return "経済学研究科";
    if (/法学研究科/.test(compact)) return "法学研究科";
    if (/社会学研究科/.test(compact)) return "社会学研究科";
    if (/商学研究科/.test(compact)) return "商学研究科";
    if (/医学研究科/.test(compact)) return "医学研究科";
    if (/理工学研究科/.test(compact)) return "理工学研究科";
    if (/健康マネジメント研究科/.test(compact)) return "健康マネジメント研究科";
    if (/薬学研究科/.test(compact)) return "薬学研究科";
    if (/経営管理研究科/.test(compact)) return "経営管理研究科";
    if (/システムデザインマネジメント研究科/.test(compact)) return "システムデザインマネジメント研究科";
    if (/メディアデザイン研究科/.test(compact)) return "メディアデザイン研究科";
    if (/法務研究科/.test(compact)) return "法務研究科";
    if (/理工/.test(compact)) return "理工学部";
    if (/看護/.test(compact)) return "看護医療学部";
    if (/薬/.test(compact)) return "薬学部";
    if (/医/.test(compact)) return "医学部";
    if (/文/.test(compact)) return "文学部";
    if (/経済/.test(compact)) return "経済学部";
    if (/法/.test(compact)) return "法学部";
    if (/商/.test(compact)) return "商学部";
    return compact;
  }

  function progressIsRunning(progress) {
    if (progress?.state !== "running") return false;
    const updatedAt = Date.parse(progress.updatedAt || progress.at || progress.startedAt || "");
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt <= 10 * 60 * 1000;
  }

  function syncCoversFaculty(syncMeta, selectedFaculty) {
    const sync = syncMeta?.value || syncMeta || {};
    const targetFaculty = normalizeText(sync.targetFaculty);
    const selected = normalizeText(selectedFaculty);
    if (!selected) return false;
    return Boolean(sync.ok) && targetFaculty === selected;
  }

  function statusForUnmatchedCourse(course, index) {
    const selectedFaculty = normalizeText(index.selectedFaculty);
    if (!selectedFaculty) {
      return {
        text: "学部未設定",
        className: "ksso-result-badge--missing",
        title: "拡張機能の画面で自分の学部を選ぶと、必要な授業評価だけを確認できます。"
      };
    }
    if (!facultyMatches(course.faculty, selectedFaculty)) {
      return {
        text: "学部設定外",
        className: "ksso-result-badge--missing",
        title: `現在は ${selectedFaculty} の授業評価だけを確認する設定です。`
      };
    }
    if (progressIsRunning(index.progressMeta?.value)) {
      return {
        text: "確認中",
        className: "ksso-result-badge--loading",
        title: `${selectedFaculty} の評価データを更新しています。終わるとこの一覧にも反映されます。`
      };
    }
    if (syncCoversFaculty(index.syncMeta, selectedFaculty)) {
      const sync = index.syncMeta?.value || {};
      if (sync.coverageComplete === false) {
        return {
          text: "一部未確認",
          className: "ksso-result-badge--loading",
          title: "検索結果が多すぎた条件があり、この授業の公開評価を確認しきれていない可能性があります。"
        };
      }
      return {
        text: "公開評価なし",
        className: "ksso-result-badge--missing",
        title: "更新済みデータ内に、この授業の公開評価は見つかりませんでした。"
      };
    }
    return {
      text: "未確認",
      className: "ksso-result-badge--loading",
      title: `${selectedFaculty} の評価データはまだ更新されていません。拡張機能の画面から更新すると確認できます。`
    };
  }

  async function loadCacheIndex(force = false) {
    const fresh = cacheIndexPromise && Date.now() - cacheIndexLoadedAt < CACHE_REFRESH_MS;
    if (!force && fresh) return cacheIndexPromise;

    cacheIndexPromise = Promise.all([
      cacheGetAll("evaluations").catch(() => []),
      cacheGetMeta("lastSyncAllEvaluations").catch(() => null),
      cacheGetMeta("lastSyncProgress").catch(() => null),
      storageGet({
        [STORAGE_KEYS.evaluations]: {},
        [STORAGE_KEYS.settings]: {},
        [STORAGE_KEYS.lastSyncAllEvaluations]: null,
        [STORAGE_KEYS.lastSyncProgress]: null
      }).catch(() => ({
        [STORAGE_KEYS.evaluations]: {},
        [STORAGE_KEYS.settings]: {},
        [STORAGE_KEYS.lastSyncAllEvaluations]: null,
        [STORAGE_KEYS.lastSyncProgress]: null
      }))
    ]).then(([cachedEvaluations, syncMeta, progressMeta, storageState]) => {
      const storageEvaluations = Object.values(objectStore(storageState[STORAGE_KEYS.evaluations]));
      const evaluations = uniqueByRecordId([...cachedEvaluations, ...storageEvaluations]);
      cacheIndexLoadedAt = Date.now();
      return {
        ...buildCacheIndex(evaluations),
        selectedFaculty: normalizeText(storageState[STORAGE_KEYS.settings]?.faculty),
        syncMeta: syncMeta || (storageState[STORAGE_KEYS.lastSyncAllEvaluations] ? { value: storageState[STORAGE_KEYS.lastSyncAllEvaluations] } : null),
        progressMeta: progressMeta || (storageState[STORAGE_KEYS.lastSyncProgress] ? { value: storageState[STORAGE_KEYS.lastSyncProgress] } : null)
      };
    });
    return cacheIndexPromise;
  }

  function bestFromCandidates(course, candidates) {
    let best = null;
    for (const evaluation of candidates.slice(0, MAX_FALLBACK_CANDIDATES)) {
      const score = scoreCourseMatch(course, evaluation.course || {});
      if (!best || score > best.score) best = { evaluation, score };
    }
    return best && best.score >= 55 ? best : null;
  }

  function findBestEvaluation(course, index) {
    const exact = index.exact.get(compactCourseKey(course));
    if (exact) return { evaluation: exact, score: 100 };

    const looseCandidates = index.loose.get(looseCourseKey(course));
    if (looseCandidates?.length) return bestFromCandidates(course, looseCandidates);

    const nameCandidates = index.byName.get(courseNameKey(course.courseName));
    if (nameCandidates?.length) return bestFromCandidates(course, nameCandidates);

    return null;
  }

  function formatAvg(value) {
    return typeof value === "number" ? value.toFixed(2) : "-";
  }

  function formatPercent(value) {
    return typeof value === "number" ? `${value.toFixed(1).replace(/\.0$/, "")}%` : "-";
  }

  function findOverallQuestion(evaluation) {
    const questions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
    return questions.find((question) => question.index === 7) || questions.find((question) => typeof question.avg === "number") || null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ksso-result-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 8px;
        padding: 4px 8px;
        border: 1px solid #dbeafe;
        border-radius: 999px;
        background: #eff6ff;
        color: #1e3a8a;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.2;
        vertical-align: middle;
      }
      .ksso-result-badge--missing {
        border-color: #e2e8f0;
        background: #f8fafc;
        color: #64748b;
      }
      .ksso-result-badge--loading {
        border-color: #fde68a;
        background: #fffbeb;
        color: #92400e;
      }
      .ksso-result-badge--error {
        border-color: #fecaca;
        background: #fef2f2;
        color: #991b1b;
      }
    `;
    document.head.appendChild(style);
  }

  function removeExistingBadge(item) {
    item.querySelector(".ksso-result-badge")?.remove();
    item.dataset.kssoBadgeKey = "";
  }

  function insertBadge(item, badge, key = badge.textContent || badge.className) {
    if (item.dataset.kssoBadgeKey === key) return;
    removeExistingBadge(item);
    item.dataset.kssoBadgeKey = key;
    const titleRow = item.querySelector(".mb-2") || item;
    const courseName = titleRow.querySelector(".sbjtnm") || titleRow;
    courseName.insertAdjacentElement("afterend", badge);
  }

  function renderMatchedBadge(match) {
    const evaluation = match.evaluation;
    const overall = findOverallQuestion(evaluation);
    const badge = document.createElement("span");
    badge.className = "ksso-result-badge";
    badge.title = `K-Support 授業評価 / 照合スコア ${match.score}`;
    badge.textContent = `★ ${formatAvg(overall?.avg)} / 回答率 ${formatPercent(evaluation.course?.answerPercent)}`;
    return badge;
  }

  function renderStatusBadge(text, className = "ksso-result-badge--missing", title = "") {
    const badge = document.createElement("span");
    badge.className = `ksso-result-badge ${className}`;
    badge.textContent = text;
    if (title) badge.title = title;
    return badge;
  }

  async function renderResultList(forceReloadCache = false) {
    ensureStyle();
    const index = await loadCacheIndex(forceReloadCache);
    const items = Array.from(document.querySelectorAll(ITEM_SELECTOR));

    for (const item of items) {
      const course = parseResultItem(item);
      if (!course.courseName) continue;
      const match = findBestEvaluation(course, index);
      if (match) {
        const overall = findOverallQuestion(match.evaluation);
        insertBadge(
          item,
          renderMatchedBadge(match),
          `match:${match.evaluation.recordId || compactCourseKey(match.evaluation.course || {})}:${overall?.avg ?? ""}:${match.evaluation.course?.answerPercent ?? ""}`
        );
      } else {
        const status = statusForUnmatchedCourse(course, index);
        insertBadge(
          item,
          renderStatusBadge(status.text, status.className, status.title),
          `missing:${status.text}:${compactCourseKey(course)}`
        );
      }
    }
  }

  function scheduleRender(forceReloadCache = false) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => void renderResultList(forceReloadCache), 300);
  }

  function main() {
    void renderResultList();
    const target = document.querySelector("#search-result-timetable") || document.body;
    const observer = new MutationObserver(() => scheduleRender(false));
    observer.observe(target, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEYS.evaluations] || changes[STORAGE_KEYS.lastSyncAllEvaluations]) {
        scheduleRender(true);
      }
    });
  }

  main();
})();
