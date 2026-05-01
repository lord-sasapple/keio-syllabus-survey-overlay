(() => {
  const {
    STORAGE_KEYS,
    normalizeText,
    scoreCourseMatch,
    storageGet
  } = window.KeioSurveyShared;

  const STYLE_ID = "keio-survey-result-overlay-style";
  const ITEM_SELECTOR = ".search-result-item";

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

  function removeExistingBadge(item) {
    item.querySelector(".ksso-result-badge")?.remove();
  }

  function insertBadge(item, badge) {
    removeExistingBadge(item);
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

  function renderFetchButton(course, item) {
    const badge = document.createElement("span");
    badge.className = "ksso-result-badge ksso-result-badge--missing";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ksso-result-button";
    button.textContent = "授業評価を取得";
    button.addEventListener("click", async () => {
      badge.className = "ksso-result-badge ksso-result-badge--loading";
      badge.textContent = "取得中...";
      const response = await runtimeMessage({ type: "keioSurvey.fetchEvaluationForSyllabus", syllabus: course });
      if (response?.ok && response.evaluation) {
        insertBadge(item, renderMatchedBadge({ evaluation: response.evaluation, score: response.match?.score ?? scoreCourseMatch(course, response.evaluation.course || {}) }));
        return;
      }
      badge.className = "ksso-result-badge ksso-result-badge--error";
      badge.textContent = response?.code === "NO_MATCH" ? "評価なし" : "取得失敗";
      badge.title = response?.message || response?.code || "授業評価の取得に失敗しました";
    });
    badge.appendChild(button);
    return badge;
  }

  async function renderResultList() {
    ensureStyle();
    const current = await storageGet({ [STORAGE_KEYS.evaluations]: {} });
    const evaluations = uniqueEvaluations(objectStore(current[STORAGE_KEYS.evaluations]));
    const items = Array.from(document.querySelectorAll(ITEM_SELECTOR));
    for (const item of items) {
      const course = parseResultItem(item);
      if (!course.courseName) continue;
      const match = findBestEvaluation(course, evaluations);
      insertBadge(item, match ? renderMatchedBadge(match) : renderFetchButton(course, item));
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
