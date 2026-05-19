(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cachePut,
    compactCourseKey,
    normalizePerson,
    normalizeSemester,
    normalizeText,
    scoreCourseMatch,
    storageGet,
    storageSet
  } = window.KeioSurveyShared;

  const STYLE_ID = "keio-survey-result-overlay-style";
  const BEAR_ROOT_ID = "keio-survey-bear-root";
  const KSUPPORT_SEARCH_URL =
    "https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch";
  const KSUPPORT_LOGIN_BEAR_MESSAGE = "アンケート結果を読み込むために、";
  const KSUPPORT_LOGIN_BEAR_AFTER_LINK =
    "K-Supportを開いてログインしてね。できたらこのタブに戻って再読み込みしてね。";
  const ITEM_SELECTOR = ".search-result-item";
  const CACHE_REFRESH_MS = 5 * 60 * 1000;
  const MISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 45 * 1000;
  const MAX_FALLBACK_CANDIDATES = 40;
  const PREFETCH_ROOT_MARGIN = "2400px 0px";
  const FETCH_CONCURRENCY = 3;

  let cacheIndexPromise = null;
  let cacheIndexLoadedAt = 0;
  let renderTimer = 0;
  let observer = null;
  let activeFetches = 0;
  let queue = [];
  let ksupportUnavailable = false;
  const queuedKeys = new Set();
  const fetchingKeys = new Set();
  const sessionMissKeys = new Set();

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

  function buildCacheIndex(evaluations, missStore = {}) {
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
      misses: objectStore(missStore),
      count: evaluations.length
    };
  }

  async function loadCacheIndex(force = false) {
    const fresh = cacheIndexPromise && Date.now() - cacheIndexLoadedAt < CACHE_REFRESH_MS;
    if (!force && fresh) return cacheIndexPromise;

    cacheIndexPromise = Promise.all([
      cacheGetAll("evaluations").catch(() => []),
      storageGet({
        [STORAGE_KEYS.evaluations]: {},
        [STORAGE_KEYS.evaluationMisses]: {}
      }).catch(() => ({
        [STORAGE_KEYS.evaluations]: {},
        [STORAGE_KEYS.evaluationMisses]: {}
      }))
    ]).then(([cachedEvaluations, storageState]) => {
      const storageEvaluations = Object.values(objectStore(storageState[STORAGE_KEYS.evaluations]));
      const evaluations = uniqueByRecordId([...cachedEvaluations, ...storageEvaluations]);
      cacheIndexLoadedAt = Date.now();
      return buildCacheIndex(evaluations, storageState[STORAGE_KEYS.evaluationMisses]);
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

  function courseFetchKey(course) {
    return compactCourseKey(course) || [
      normalizeText(course.courseName),
      normalizePerson(course.lecturer),
      normalizeText(course.registrationNumber)
    ].join("|");
  }

  function hasFreshMiss(index, key) {
    const miss = index.misses?.[key];
    if (!miss) return false;
    const at = Date.parse(miss.at || "");
    return Number.isFinite(at) && Date.now() - at < MISS_TTL_MS;
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

  function runtimeMessage(message, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : null;
    return new Promise((resolve) => {
      let settled = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            settled = true;
            resolve({
              ok: false,
              code: "RUNTIME_MESSAGE_TIMEOUT",
              message: "K-Support から時間内に応答がありませんでした。"
            });
          }, timeoutMs)
        : null;
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            code: "RUNTIME_MESSAGE_FAILED",
            message: chrome.runtime.lastError.message
          });
          return;
        }
        resolve(response || { ok: false, code: "EMPTY_RUNTIME_RESPONSE" });
      });
    });
  }

  async function rememberMiss(key, course, code = "NO_MATCH") {
    sessionMissKeys.add(key);
    const current = await storageGet({ [STORAGE_KEYS.evaluationMisses]: {} }).catch(() => ({
      [STORAGE_KEYS.evaluationMisses]: {}
    }));
    const misses = objectStore(current[STORAGE_KEYS.evaluationMisses]);
    misses[key] = {
      at: new Date().toISOString(),
      code,
      courseName: course.courseName,
      lecturer: course.lecturer,
      semester: course.semester,
      campus: course.campus
    };
    await storageSet({ [STORAGE_KEYS.evaluationMisses]: misses });
  }

  async function saveEvaluation(evaluation) {
    if (!evaluation?.recordId) return;
    await cachePut("evaluations", evaluation);
    if (evaluation.course?.recordId || evaluation.recordId) {
      await cachePut("courses", {
        ...(evaluation.course || {}),
        recordId: evaluation.course?.recordId || evaluation.recordId
      });
    }
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
      #${BEAR_ROOT_ID} {
        position: fixed;
        right: max(16px, env(safe-area-inset-right));
        bottom: max(14px, env(safe-area-inset-bottom));
        z-index: 2147483646;
        display: grid;
        justify-items: end;
        width: min(340px, calc(100vw - 24px));
        color: #172554;
        font-family: inherit;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
      }
      #${BEAR_ROOT_ID} * {
        user-select: none;
        -webkit-user-select: none;
      }
      #${BEAR_ROOT_ID} .ksso-bear-close {
        position: absolute;
        top: 12px;
        right: 28px;
        z-index: 2;
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border: 1px solid #f8d67a;
        border-radius: 999px;
        background: #ffffff;
        color: #854d0e;
        cursor: pointer;
        font: inherit;
        font-size: 16px;
        font-weight: 800;
        line-height: 1;
        pointer-events: auto;
      }
      #${BEAR_ROOT_ID} .ksso-bear-close:hover,
      #${BEAR_ROOT_ID} .ksso-bear-close:focus-visible {
        background: #fffbeb;
      }
      #${BEAR_ROOT_ID} .ksso-bear-bubble {
        position: relative;
        width: min(300px, calc(100vw - 40px));
        margin: 0 18px -10px 0;
        border: 2px solid #f6c453;
        border-radius: 18px;
        padding: 13px 38px 13px 15px;
        background: #ffffff;
        box-shadow: 0 12px 28px rgba(15, 35, 95, 0.16);
        font-size: 14px;
        font-weight: 800;
        line-height: 1.55;
        letter-spacing: 0;
        word-break: break-word;
        box-sizing: border-box;
        pointer-events: auto;
      }
      #${BEAR_ROOT_ID} .ksso-bear-bubble::after {
        content: "";
        position: absolute;
        right: 54px;
        bottom: -10px;
        width: 18px;
        height: 18px;
        border-right: 2px solid #f6c453;
        border-bottom: 2px solid #f6c453;
        background: #ffffff;
        transform: rotate(45deg);
      }
      #${BEAR_ROOT_ID} .ksso-bear-link {
        color: #1d4ed8;
        font-weight: 900;
        text-decoration: underline;
        text-underline-offset: 2px;
        pointer-events: auto;
        user-select: none;
        -webkit-user-select: none;
      }
      #${BEAR_ROOT_ID} .ksso-bear-link:hover {
        color: #1e40af;
      }
      #${BEAR_ROOT_ID} .ksso-bear-stage {
        width: 132px;
        height: 162px;
        margin-right: 16px;
        filter: drop-shadow(0 16px 18px rgba(15, 35, 95, 0.16));
        pointer-events: none;
      }
      #${BEAR_ROOT_ID} .ksso-bear-svg {
        display: block;
        width: 100%;
        height: 100%;
      }
      @media (max-width: 720px) {
        #${BEAR_ROOT_ID} {
          width: min(250px, calc(100vw - 18px));
        }
        #${BEAR_ROOT_ID} .ksso-bear-bubble {
          width: min(220px, calc(100vw - 30px));
          margin-right: 8px;
          padding: 10px 34px 10px 12px;
          font-size: 12px;
        }
        #${BEAR_ROOT_ID} .ksso-bear-close {
          top: 8px;
          right: 16px;
        }
        #${BEAR_ROOT_ID} .ksso-bear-stage {
          width: 86px;
          height: 106px;
          margin-right: 12px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function renderBearSvg() {
    return `
      <svg class="ksso-bear-svg" viewBox="0 0 260 320" role="img" aria-label="Syllabus Lens のクマのマスコット">
        <defs>
          <radialGradient id="ksso-result-bear-fur" cx="42%" cy="30%" r="75%">
            <stop offset="0%" stop-color="#fffaf0" />
            <stop offset="100%" stop-color="#efe1c9" />
          </radialGradient>
          <linearGradient id="ksso-result-bear-stripe" x1="0" x2="1">
            <stop offset="0%" stop-color="#f7b500" />
            <stop offset="100%" stop-color="#ffd25a" />
          </linearGradient>
          <clipPath id="ksso-result-bear-romper">
            <path d="M78 174 C82 143 101 126 130 126 C159 126 178 143 182 174 L190 238 C194 269 173 291 145 291 L115 291 C87 291 66 269 70 238Z" />
          </clipPath>
        </defs>
        <ellipse cx="130" cy="302" rx="70" ry="12" fill="#d6c5ad" opacity="0.28" />
        <path d="M78 174 C82 143 101 126 130 126 C159 126 178 143 182 174 L190 238 C194 269 173 291 145 291 L115 291 C87 291 66 269 70 238Z" fill="url(#ksso-result-bear-fur)" />
        <g clip-path="url(#ksso-result-bear-romper)">
          <rect x="66" y="132" width="128" height="160" fill="#fffdf6" />
          <rect x="66" y="144" width="128" height="20" fill="url(#ksso-result-bear-stripe)" />
          <rect x="66" y="188" width="128" height="21" fill="url(#ksso-result-bear-stripe)" />
          <rect x="66" y="232" width="128" height="21" fill="url(#ksso-result-bear-stripe)" />
          <rect x="66" y="276" width="128" height="19" fill="url(#ksso-result-bear-stripe)" />
        </g>
        <path d="M86 154 C105 136 155 136 174 154" fill="none" stroke="#fff7e9" stroke-width="18" stroke-linecap="round" />
        <path d="M84 164 C105 150 155 150 176 164" fill="none" stroke="#f7b500" stroke-width="7" stroke-linecap="round" />
        <path d="M73 165 C54 173 45 197 51 222 C57 247 73 258 88 247 C101 237 103 206 94 185 C89 173 81 164 73 165Z" fill="url(#ksso-result-bear-fur)" />
        <circle cx="58" cy="170" r="8" fill="#fff8ea" opacity="0.8" />
        <path d="M187 165 C206 173 215 197 209 222 C203 247 187 258 172 247 C159 237 157 206 166 185 C171 173 179 164 187 165Z" fill="url(#ksso-result-bear-fur)" />
        <circle cx="202" cy="170" r="8" fill="#fff8ea" opacity="0.8" />
        <ellipse cx="102" cy="286" rx="27" ry="21" fill="url(#ksso-result-bear-fur)" />
        <path d="M91 287 L91 298" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <path d="M104 289 L104 300" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <ellipse cx="158" cy="286" rx="27" ry="21" fill="url(#ksso-result-bear-fur)" />
        <path d="M150 289 L150 300" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <path d="M163 287 L163 298" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <circle cx="82" cy="66" r="29" fill="url(#ksso-result-bear-fur)" />
        <circle cx="178" cy="66" r="29" fill="url(#ksso-result-bear-fur)" />
        <circle cx="83" cy="68" r="16" fill="#fff6e8" opacity="0.72" />
        <circle cx="177" cy="68" r="16" fill="#fff6e8" opacity="0.72" />
        <circle cx="130" cy="104" r="68" fill="url(#ksso-result-bear-fur)" />
        <ellipse cx="102" cy="106" rx="8.5" ry="11" fill="#06112e" />
        <ellipse cx="158" cy="106" rx="8.5" ry="11" fill="#06112e" />
        <circle cx="105" cy="101" r="2.4" fill="white" opacity="0.95" />
        <circle cx="161" cy="101" r="2.4" fill="white" opacity="0.95" />
        <ellipse cx="130" cy="129" rx="18" ry="14" fill="#4b2c20" />
        <path d="M130 142 L130 154" stroke="#4b2c20" stroke-width="4" stroke-linecap="round" />
        <path d="M112 153 Q130 164 148 153" fill="none" stroke="#4b2c20" stroke-width="4" stroke-linecap="round" />
      </svg>
    `;
  }

  function removeBearMascot() {
    document.getElementById(BEAR_ROOT_ID)?.remove();
  }

  function bindBearSelectionGuard(root) {
    root.addEventListener("selectstart", (event) => {
      if (event.target.closest?.(".ksso-bear-link")) return;
      event.preventDefault();
    });
    root.addEventListener("mousedown", (event) => {
      if (event.target.closest?.(".ksso-bear-link, .ksso-bear-close")) return;
      event.preventDefault();
    });
    root.addEventListener("dragstart", (event) => {
      event.preventDefault();
    });
  }

  function mountKSupportLoginBear() {
    if (document.getElementById(BEAR_ROOT_ID)) return;
    ensureStyle();
    const root = document.createElement("aside");
    root.id = BEAR_ROOT_ID;
    root.setAttribute("aria-label", "クマのK-Supportログイン案内");
    root.innerHTML = `
      <button type="button" class="ksso-bear-close" aria-label="クマを閉じる">×</button>
      <div class="ksso-bear-bubble">
        ${KSUPPORT_LOGIN_BEAR_MESSAGE}<a class="ksso-bear-link" href="${KSUPPORT_SEARCH_URL}" target="_blank" rel="noopener noreferrer">ここから</a>${KSUPPORT_LOGIN_BEAR_AFTER_LINK}
      </div>
      <div class="ksso-bear-stage">${renderBearSvg()}</div>
    `;
    document.body.appendChild(root);
    bindBearSelectionGuard(root);
    root.querySelector(".ksso-bear-close")?.addEventListener("click", removeBearMascot);
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

  function renderMissBadge(item, key) {
    insertBadge(
      item,
      renderStatusBadge("公開評価なし", "ksso-result-badge--missing", "K-Support でこの授業の公開評価は見つかりませんでした。"),
      `miss:${key}`
    );
  }

  function observeForLazyFetch(item) {
    if (!observer || item.dataset.kssoObserved === "1") return;
    item.dataset.kssoObserved = "1";
    observer.observe(item);
  }

  async function renderResultList(forceReloadCache = false) {
    ensureStyle();
    const index = await loadCacheIndex(forceReloadCache);
    const items = Array.from(document.querySelectorAll(ITEM_SELECTOR));

    for (const item of items) {
      const course = parseResultItem(item);
      if (!course.courseName) continue;
      const key = courseFetchKey(course);
      const match = findBestEvaluation(course, index);
      if (match) {
        const overall = findOverallQuestion(match.evaluation);
        insertBadge(
          item,
          renderMatchedBadge(match),
          `match:${match.evaluation.recordId || compactCourseKey(match.evaluation.course || {})}:${overall?.avg ?? ""}:${match.evaluation.course?.answerPercent ?? ""}`
        );
        item.dataset.kssoFetchState = "cached";
        continue;
      }
      if (sessionMissKeys.has(key) || hasFreshMiss(index, key)) {
        renderMissBadge(item, key);
        item.dataset.kssoFetchState = "miss";
        continue;
      }
      observeForLazyFetch(item);
    }
  }

  function scheduleRender(forceReloadCache = false) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => void renderResultList(forceReloadCache), 250);
  }

  function enqueueItem(item) {
    if (ksupportUnavailable) return;
    const course = parseResultItem(item);
    if (!course.courseName) return;
    const key = courseFetchKey(course);
    if (queuedKeys.has(key) || fetchingKeys.has(key) || sessionMissKeys.has(key)) return;
    if (item.dataset.kssoFetchState === "cached" || item.dataset.kssoFetchState === "miss") return;

    queuedKeys.add(key);
    item.dataset.kssoFetchState = "queued";
    insertBadge(
      item,
      renderStatusBadge("確認中", "ksso-result-badge--loading", "K-Support でこの授業の評価を確認しています。"),
      `loading:${key}`
    );
    queue.push({ item, course, key });
    processQueue();
  }

  function processQueue() {
    while (activeFetches < FETCH_CONCURRENCY && queue.length) {
      const task = queue.shift();
      queuedKeys.delete(task.key);
      if (!task.item.isConnected || fetchingKeys.has(task.key)) continue;
      activeFetches += 1;
      fetchingKeys.add(task.key);
      void fetchTask(task).finally(() => {
        activeFetches -= 1;
        fetchingKeys.delete(task.key);
        processQueue();
      });
    }
  }

  function isKSupportUnavailable(response) {
    const text = `${response?.code || ""} ${response?.message || ""}`;
    return (
      response?.code === "KSUPPORT_TAB_NOT_FOUND" ||
      response?.code === "KSUPPORT_TABS_UNAVAILABLE" ||
      response?.code === "TAB_MESSAGE_FAILED" ||
      response?.code === "RUNTIME_MESSAGE_FAILED" ||
      response?.code === "RUNTIME_MESSAGE_TIMEOUT" ||
      /ログイン|Receiving end does not exist|Could not establish connection|Aura token|アクセス権|権限/i.test(text)
    );
  }

  async function fetchTask({ item, course, key }) {
    const response = await runtimeMessage(
      {
        type: "keioSurvey.fetchEvaluationForSyllabus",
        syllabus: course
      },
      { timeoutMs: FETCH_TIMEOUT_MS }
    );

    if (response?.ok && response.evaluation) {
      await saveEvaluation(response.evaluation);
      cacheIndexPromise = null;
      const index = await loadCacheIndex(true);
      const match = findBestEvaluation(course, index) || {
        evaluation: response.evaluation,
        score: response.match?.score ?? scoreCourseMatch(course, response.evaluation.course || {})
      };
      insertBadge(item, renderMatchedBadge(match), `match:${response.evaluation.recordId}:${findOverallQuestion(response.evaluation)?.avg ?? ""}`);
      item.dataset.kssoFetchState = "cached";
      return;
    }

    if (response?.code === "NO_MATCH") {
      await rememberMiss(key, course, response.code);
      renderMissBadge(item, key);
      item.dataset.kssoFetchState = "miss";
      return;
    }

    if (isKSupportUnavailable(response)) {
      ksupportUnavailable = true;
      mountKSupportLoginBear();
      insertBadge(
        item,
        renderStatusBadge("ログインが必要", "ksso-result-badge--loading", "K-Support にログインしてから、このページを再読み込みしてください。"),
        `login:${key}`
      );
      item.dataset.kssoFetchState = "login";
      return;
    }

    insertBadge(
      item,
      renderStatusBadge("確認できません", "ksso-result-badge--error", response?.message || "授業評価の確認に失敗しました。"),
      `error:${key}:${response?.code || ""}`
    );
    item.dataset.kssoFetchState = "error";
  }

  function setupObserver() {
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) enqueueItem(entry.target);
      }
    }, {
      root: null,
      rootMargin: PREFETCH_ROOT_MARGIN,
      threshold: 0
    });
  }

  function main() {
    setupObserver();
    void renderResultList();
    const mutationObserver = new MutationObserver(() => scheduleRender(false));
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEYS.evaluations] || changes[STORAGE_KEYS.evaluationMisses]) {
        scheduleRender(true);
      }
    });
  }

  main();
})();
