(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cacheGetMeta,
    cachePut,
    compactCourseKey,
    normalizeText,
    scoreCourseMatch,
    storageGet,
    storageSet
  } = window.KeioSurveyShared;

  const STYLE_ID = "keio-survey-result-overlay-style";
  const ITEM_SELECTOR = ".search-result-item";
  const AUTO_FETCH_CONCURRENCY = 2;
  const autoFetchSeen = new Set();
  const observedItems = new WeakSet();
  let activeFetches = 0;
  let intersectionObserver = null;
  const fetchQueue = [];
  let syncRequested = false;
  let syncPollingTimer = 0;
  const SYNC_TTL_MS = 21 * 24 * 60 * 60 * 1000;

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, code: "RUNTIME_MESSAGE_FAILED", message: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, code: "EMPTY_RUNTIME_RESPONSE" });
      });
    });
  }

  function objectStore(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function uniqueEvaluations(store) {
    const seen = new Set();
    const evaluations = [];
    for (const value of Object.values(store || {})) {
      if (!value || typeof value !== "object") continue;
      const id = value.recordId || JSON.stringify(value.course || {});
      if (seen.has(id)) continue;
      seen.add(id);
      evaluations.push(value);
    }
    return evaluations;
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

  function findBestEvaluation(course, evaluations) {
    let best = null;
    for (const evaluation of evaluations) {
      const score = scoreCourseMatch(course, evaluation.course || {});
      if (!best || score > best.score) best = { evaluation, score };
    }
    return best && best.score >= 55 ? best : null;
  }

  function normalizeEvaluation(event) {
    const course = event.course || {};
    return {
      source: "keio-ksupport-ksei",
      recordId: normalizeText(event.recordId),
      capturedAt: event.capturedAt || event.at || new Date().toISOString(),
      course: {
        recordId: normalizeText(event.recordId || course.recordId),
        courseName: normalizeText(course.courseName),
        lecturer: normalizeText(course.lecturer),
        semester: normalizeText(course.semester),
        dayPeriod: normalizeText(course.dayPeriod),
        campus: normalizeText(course.campus),
        faculty: normalizeText(course.faculty),
        answerPercent: typeof course.answerPercent === "number" ? course.answerPercent : null
      },
      questions: Array.isArray(event.questions)
        ? event.questions.map((question) => ({
            index: question.index,
            ja: normalizeText(question.ja),
            en: normalizeText(question.en),
            avg: typeof question.avg === "number" ? question.avg : null,
            counts: Array.isArray(question.counts) ? question.counts.slice(0, 5).map((count) => Number(count) || 0) : []
          }))
        : [],
      commentSections: Array.isArray(event.commentSections)
        ? event.commentSections.map((section) => ({
            kind: normalizeText(section.kind),
            title: normalizeText(section.title),
            en: normalizeText(section.en),
            comments: Array.isArray(section.comments)
              ? section.comments.map((comment) => normalizeText(comment)).filter(Boolean)
              : []
          })).filter((section) => section.comments.length)
        : []
    };
  }

  async function saveEvaluation(event) {
    const evaluation = normalizeEvaluation(event);
    if (!evaluation.recordId && !evaluation.questions.length) return evaluation;
    const storageEvaluation = {
      ...evaluation,
      commentSections: []
    };

    const current = await storageGet({
      [STORAGE_KEYS.courses]: {},
      [STORAGE_KEYS.evaluations]: {}
    });
    const courses = objectStore(current[STORAGE_KEYS.courses]);
    const evaluations = objectStore(current[STORAGE_KEYS.evaluations]);
    const key = compactCourseKey(evaluation.course);

    if (evaluation.recordId) {
      courses[`record:${evaluation.recordId}`] = { ...evaluation.course, recordId: evaluation.recordId };
      evaluations[`record:${evaluation.recordId}`] = storageEvaluation;
    }
    if (key.replace(/\|/g, "")) {
      courses[`key:${key}`] = { ...evaluation.course, recordId: evaluation.recordId };
      evaluations[`key:${key}`] = storageEvaluation;
    }
    await cachePut("evaluations", evaluation);
    if (evaluation.course?.recordId) await cachePut("courses", evaluation.course);

    await storageSet({
      [STORAGE_KEYS.courses]: courses,
      [STORAGE_KEYS.evaluations]: evaluations,
      [STORAGE_KEYS.lastSeen]: {
        url: location.href,
        title: document.title,
        at: new Date().toISOString()
      }
    });
    return evaluation;
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
      .ksso-result-button {
        appearance: none;
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .ksso-result-button:hover {
        text-decoration: underline;
      }
    `;
    document.head.appendChild(style);
  }

  function courseKey(course) {
    return [course.courseName, course.lecturer, course.semester, course.dayPeriod, course.campus, course.faculty]
      .map((value) => normalizeText(value))
      .join("|");
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

  function renderRetryBadge(course, item, label = "再取得") {
    const badge = document.createElement("span");
    badge.className = "ksso-result-badge ksso-result-badge--error";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ksso-result-button";
    button.textContent = label;
    button.addEventListener("click", () => enqueueFetch(course, item, true));
    badge.appendChild(button);
    return badge;
  }

  function isKSupportAuthError(response) {
    const code = response?.code || "";
    return code === "KSUPPORT_TAB_NOT_FOUND"
      || code === "KSUPPORT_CONTEXT_MISSING"
      || code === "KSUPPORT_CONTEXT_EXPIRED"
      || code === "KSUPPORT_TABS_UNAVAILABLE"
      || code === "TAB_MESSAGE_FAILED";
  }

  function syncIsFresh(meta) {
    const finishedAt = Date.parse(meta?.value?.finishedAt || "");
    return Number.isFinite(finishedAt) && Date.now() - finishedAt < SYNC_TTL_MS;
  }

  async function requestCacheSync(items) {
    if (syncRequested) return;
    const meta = await cacheGetMeta("lastSyncAllEvaluations").catch(() => null);
    if (syncIsFresh(meta)) return;
    syncRequested = true;
    runtimeMessage({
      type: "keioSurvey.syncAllEvaluations",
      options: { includeComments: true }
    }).then((response) => {
      if (!response?.ok) {
        for (const item of items) {
          const course = parseResultItem(item);
          insertBadge(item, renderRetryBadge(course, item, "K-Supportログイン後に同期"));
        }
        return;
      }
      syncPollingTimer = window.setInterval(() => void renderResultList(), 5000);
      window.setTimeout(() => {
        window.clearInterval(syncPollingTimer);
        syncPollingTimer = 0;
      }, 30 * 60 * 1000);
    });
  }

  async function fetchAndRender(course, item, force = false) {
    if (!force && item.dataset.kssoFetched === "1") return;
    item.dataset.kssoFetched = "1";
    item.dataset.kssoQueued = "";
    insertBadge(item, renderStatusBadge("取得中...", "ksso-result-badge--loading"), "loading");

    const response = await runtimeMessage({ type: "keioSurvey.fetchEvaluationForSyllabus", syllabus: course });
    if (response?.ok && response.evaluation) {
      const evaluation = await saveEvaluation(response.evaluation);
      insertBadge(item, renderMatchedBadge({
        evaluation,
        score: response.match?.score ?? scoreCourseMatch(course, response.evaluation.course || {})
      }), `match:${evaluation.recordId || courseKey(course)}:${findOverallQuestion(evaluation)?.avg ?? ""}`);
      return;
    }
    if (response?.code === "NO_MATCH") {
      insertBadge(item, renderStatusBadge("評価なし", "ksso-result-badge--missing"), `missing:${courseKey(course)}`);
      return;
    }
    if (isKSupportAuthError(response)) {
      item.dataset.kssoFetched = "";
      insertBadge(item, renderRetryBadge(course, item, "K-Supportログイン後に再取得"), `auth:${courseKey(course)}`);
      return;
    }
    item.dataset.kssoFetched = "";
    insertBadge(item, renderRetryBadge(course, item, "取得失敗 / 再取得"), `error:${courseKey(course)}`);
  }

  function runQueue() {
    while (activeFetches < AUTO_FETCH_CONCURRENCY && fetchQueue.length) {
      const job = fetchQueue.shift();
      activeFetches += 1;
      fetchAndRender(job.course, job.item, job.force)
        .finally(() => {
          activeFetches -= 1;
          runQueue();
        });
    }
  }

  function enqueueFetch(course, item, force = false) {
    const key = courseKey(course);
    if (!force && (autoFetchSeen.has(key) || item.dataset.kssoQueued === "1" || item.dataset.kssoFetched === "1")) return;
    autoFetchSeen.add(key);
    item.dataset.kssoQueued = "1";
    fetchQueue.push({ course, item, force });
    runQueue();
  }

  function getIntersectionObserver() {
    if (intersectionObserver) return intersectionObserver;
    intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = entry.target;
        const course = parseResultItem(item);
        if (!course.courseName) continue;
        enqueueFetch(course, item);
      }
    }, {
      root: null,
      rootMargin: "240px 0px 320px 0px",
      threshold: 0.01
    });
    return intersectionObserver;
  }

  function observeForAutoFetch(item) {
    if (observedItems.has(item) || item.dataset.kssoFetched === "1") return;
    observedItems.add(item);
    getIntersectionObserver().observe(item);
  }

  async function renderResultList() {
    ensureStyle();
    const current = await storageGet({ [STORAGE_KEYS.evaluations]: {} });
    const cachedEvaluations = await cacheGetAll("evaluations").catch(() => []);
    const evaluations = [
      ...cachedEvaluations,
      ...uniqueEvaluations(objectStore(current[STORAGE_KEYS.evaluations]))
    ];
    const items = Array.from(document.querySelectorAll(ITEM_SELECTOR));

    for (const item of items) {
      const course = parseResultItem(item);
      if (!course.courseName) continue;
      const match = findBestEvaluation(course, evaluations);
      if (match) {
        insertBadge(item, renderMatchedBadge(match), `match:${match.evaluation.recordId || courseKey(course)}:${findOverallQuestion(match.evaluation)?.avg ?? ""}`);
        continue;
      }
      if (item.dataset.kssoFetched === "1" || item.dataset.kssoQueued === "1") continue;
      insertBadge(item, renderStatusBadge("保存なし", "ksso-result-badge--missing"), `unsynced:${courseKey(course)}`);
    }
  }

  function main() {
    void renderResultList();
    const target = document.querySelector("#search-result-timetable") || document.body;
    const observer = new MutationObserver(() => {
      window.clearTimeout(observer._kssoTimer);
      observer._kssoTimer = window.setTimeout(() => void renderResultList(), 250);
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  main();
})();
