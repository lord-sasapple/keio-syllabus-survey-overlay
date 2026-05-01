(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cachePut,
    compactCourseKey,
    normalizeText,
    scoreCourseMatch,
    storageGet,
    storageSet
  } = window.KeioSurveyShared;

  const ROOT_ID = "keio-survey-overlay-root";
  const STYLE_ID = "keio-survey-overlay-style";
  const CHOICE_LABELS = [
    "①そう思わない",
    "②あまりそう思わない",
    "③どちらともいえない",
    "④ややそう思う",
    "⑤そう思う"
  ];
  const CHOICE_COLORS = ["#f4aaa0", "#f4d2c1", "#e8e8e8", "#c8d9f8", "#9fb6ef"];

  function readText(selector, root = document) {
    return normalizeText(root.querySelector(selector)?.textContent || "");
  }

  function readInfoMap() {
    const map = new Map();
    for (const row of document.querySelectorAll(".syllabus-header tr, #screen-detail tr")) {
      const label = normalizeText(row.querySelector("th")?.textContent || "");
      const value = normalizeText(row.querySelector("td")?.textContent || "");
      if (label && value) map.set(label, value);
    }
    return map;
  }

  function pick(map, patterns) {
    for (const [label, value] of map.entries()) {
      if (patterns.some((pattern) => pattern.test(label))) return value;
    }
    return "";
  }

  function parseSyllabusCourse() {
    const info = readInfoMap();
    const url = new URL(location.href);
    return {
      courseName: readText(".syllabus-header h2.class-name") || readText("h2.class-name") || readText("h1,h2"),
      lecturer: pick(info, [/担当/, /教員/, /Lecturer|Instructor/i]),
      semester: pick(info, [/学期/, /Semester|Term/i]) || url.searchParams.get("ttblyr") || "",
      dayPeriod: pick(info, [/曜日|時限/, /Day|Period/i]),
      campus: pick(info, [/キャンパス/, /Campus/i]),
      faculty: pick(info, [/学部|研究科|設置/, /Faculty|Department/i]),
      registrationNumber: url.searchParams.get("entno") || ""
    };
  }

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
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

  function findBestEvaluation(syllabus, evaluations) {
    let best = null;
    for (const evaluation of evaluations) {
      const score = scoreCourseMatch(syllabus, evaluation.course || {});
      if (!best || score > best.score) best = { evaluation, score };
    }
    return best && best.score >= 55 ? best : null;
  }

  function normalizeCommentSections(sections) {
    return Array.isArray(sections)
      ? sections.map((section) => ({
          kind: normalizeText(section.kind),
          title: normalizeText(section.title),
          en: normalizeText(section.en),
          comments: Array.isArray(section.comments)
            ? section.comments.map((comment) => normalizeText(comment)).filter(Boolean).slice(0, 30)
            : []
        })).filter((section) => section.comments.length)
      : [];
  }

  function normalizeEvaluation(event, options = {}) {
    const course = event.course || {};
    const evaluation = {
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
        : []
    };
    if (options.includeComments) {
      evaluation.commentSections = normalizeCommentSections(event.commentSections);
    }
    return evaluation;
  }

  async function saveEvaluation(event) {
    const evaluation = normalizeEvaluation(event, { includeComments: true });
    if (!evaluation.recordId && !evaluation.questions.length) return;
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
      courses[`record:${evaluation.recordId}`] = {
        ...evaluation.course,
        recordId: evaluation.recordId
      };
      evaluations[`record:${evaluation.recordId}`] = storageEvaluation;
    }
    if (key.replace(/\|/g, "")) {
      courses[`key:${key}`] = {
        ...evaluation.course,
        recordId: evaluation.recordId
      };
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
  }

  function formatPercent(value) {
    return typeof value === "number" ? `${value.toFixed(1).replace(/\.0$/, "")}%` : "-";
  }

  function formatAvg(value) {
    return typeof value === "number" ? value.toFixed(2) : "-";
  }

  function renderRating(value) {
    const score = typeof value === "number" ? clampPercent((value / 5) * 100) : 0;
    return `
      <span class="ksso-rating">
        <span class="ksso-rating-number">${formatAvg(value)}</span>
        <span class="ksso-stars" aria-label="5点中 ${formatAvg(value)}">
          <span class="ksso-stars-base">★★★★★</span>
          <span class="ksso-stars-fill" style="width: ${score}%">★★★★★</span>
        </span>
      </span>
    `;
  }

  function choiceTotal(counts) {
    return counts.reduce((sum, count) => sum + count, 0);
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function choicePercent(count, total) {
    return total ? (count / total) * 100 : null;
  }

  function renderLegend() {
    return `
      <div class="ksso-legend" aria-label="回答選択肢">
        ${CHOICE_LABELS.map((label, index) => `
          <span class="ksso-legend-item">
            <span class="ksso-swatch" style="background: ${CHOICE_COLORS[index]}"></span>
            <span>${escapeHtml(label)}</span>
          </span>
        `).join("")}
      </div>
    `;
  }

  function renderDistributionBar(counts, total) {
    if (!total) {
      return '<div class="ksso-distribution ksso-distribution-empty" aria-hidden="true"></div>';
    }
    return `
      <div class="ksso-distribution" aria-hidden="true">
        ${CHOICE_LABELS.map((label, index) => {
          const percent = clampPercent(choicePercent(counts[index] || 0, total) || 0);
          if (percent === 0) return "";
          const shortLabel = label.slice(0, 1);
          return `
            <span
              class="ksso-distribution-segment"
              style="width: ${percent}%; background: ${CHOICE_COLORS[index]}"
              title="${escapeHtml(label)} ${formatPercent(percent)}"
            >
              ${percent >= 12 ? `${escapeHtml(shortLabel)} ${formatPercent(percent)}` : ""}
            </span>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderCommentSections(sections) {
    const visibleSections = normalizeCommentSections(sections);
    if (!visibleSections.length) return "";
    return `
      <div class="ksso-comments">
        <div class="ksso-section-title">自由記述コメント</div>
        ${visibleSections.map((section) => `
          <section class="ksso-comment-section ksso-comment-${escapeHtml(section.kind || "other")}">
            <h4><span class="ksso-comment-tone" aria-hidden="true"></span>${escapeHtml(section.title)} <span>${escapeHtml(section.en)}</span></h4>
            <div class="ksso-comment-bubbles">
              ${section.comments.map((comment) => `<p class="ksso-comment-bubble">${escapeHtml(comment)}</p>`).join("")}
            </div>
          </section>
        `).join("")}
      </div>
    `;
  }

  function renderQuestion(question) {
    const counts = Array.isArray(question.counts) ? question.counts : [];
    const total = choiceTotal(counts);
    const title = question.ja || question.en || `Q${question.index}`;
    return `
      <li class="ksso-question">
        <div class="ksso-question-head">
          <span class="ksso-question-title">${escapeHtml(title)}</span>
          <span class="ksso-question-avg">平均 ${formatAvg(question.avg)}</span>
        </div>
        ${renderDistributionBar(counts, total)}
      </li>
    `;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        border: 1px solid #d7dee8;
        border-radius: 8px;
        margin: 16px 0;
        padding: 16px;
        background: #ffffff;
        color: #1f2937;
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
        font-size: 14px;
        line-height: 1.55;
      }
      #${ROOT_ID} .ksso-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      #${ROOT_ID} .ksso-title {
        font-size: 16px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-meta {
        color: #64748b;
        font-size: 12px;
        white-space: nowrap;
      }
      #${ROOT_ID} .ksso-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      #${ROOT_ID} .ksso-button {
        appearance: none;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 7px 10px;
        background: #ffffff;
        color: #1f2937;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
      }
      #${ROOT_ID} .ksso-button:hover {
        background: #f1f5f9;
      }
      #${ROOT_ID} .ksso-status {
        color: #475569;
        white-space: pre-line;
      }
      #${ROOT_ID} .ksso-error {
        color: #b91c1c;
        white-space: pre-line;
      }
      #${ROOT_ID} .ksso-summary {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 12px;
      }
      #${ROOT_ID} .ksso-metric {
        border: 1px solid #e5eaf1;
        border-radius: 6px;
        padding: 8px 10px;
        background: #f8fafc;
      }
      #${ROOT_ID} .ksso-label {
        color: #64748b;
        font-size: 12px;
      }
      #${ROOT_ID} .ksso-value {
        display: block;
        font-size: 18px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-rating {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      #${ROOT_ID} .ksso-rating-number {
        flex: 0 0 auto;
      }
      #${ROOT_ID} .ksso-stars {
        position: relative;
        display: inline-block;
        color: #cbd5e1;
        font-size: 18px;
        line-height: 1;
        letter-spacing: 0;
      }
      #${ROOT_ID} .ksso-stars-fill {
        position: absolute;
        inset: 0 auto 0 0;
        overflow: hidden;
        color: #f59e0b;
        white-space: nowrap;
      }
      #${ROOT_ID} .ksso-stars-base {
        color: #cbd5e1;
      }
      #${ROOT_ID} .ksso-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        align-items: center;
        border-top: 1px solid #eef2f7;
        border-bottom: 1px solid #eef2f7;
        margin: 8px 0 12px;
        padding: 10px 0;
        color: #334155;
      }
      #${ROOT_ID} .ksso-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      #${ROOT_ID} .ksso-swatch {
        display: inline-block;
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 2px;
      }
      #${ROOT_ID} .ksso-questions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        list-style: none;
        margin: 0;
        padding: 0;
      }
      #${ROOT_ID} .ksso-question {
        border: 1px solid #eef2f7;
        border-radius: 6px;
        padding: 10px;
        background: #ffffff;
      }
      #${ROOT_ID} .ksso-question-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      #${ROOT_ID} .ksso-question-title {
        min-width: 0;
        font-weight: 600;
      }
      #${ROOT_ID} .ksso-question-avg {
        color: #64748b;
        font-size: 12px;
        white-space: nowrap;
      }
      #${ROOT_ID} .ksso-distribution {
        display: flex;
        height: 24px;
        overflow: hidden;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        margin: 8px 0;
        background: #f8fafc;
      }
      #${ROOT_ID} .ksso-distribution-empty {
        background: #f1f5f9;
      }
      #${ROOT_ID} .ksso-distribution-segment {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        min-width: 2px;
        color: #1f2937;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        white-space: nowrap;
      }
      #${ROOT_ID} .ksso-distribution-segment + .ksso-distribution-segment {
        border-left: 2px solid #ffffff;
      }
      #${ROOT_ID} .ksso-comments {
        border-top: 1px solid #eef2f7;
        margin-top: 14px;
        padding-top: 12px;
      }
      #${ROOT_ID} .ksso-section-title {
        margin-bottom: 8px;
        font-size: 15px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-comment-section {
        border: 1px solid #eef2f7;
        border-radius: 8px;
        margin-top: 8px;
        padding: 10px 12px 12px;
        background: #ffffff;
      }
      #${ROOT_ID} .ksso-comment-positive {
        border-color: #dcfce7;
      }
      #${ROOT_ID} .ksso-comment-improvement {
        border-color: #ffedd5;
      }
      #${ROOT_ID} .ksso-comment-other {
        border-color: #dbeafe;
      }
      #${ROOT_ID} .ksso-comment-section h4 {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 0 0 8px;
        color: #1f2937;
        font-size: 14px;
        line-height: 1.45;
      }
      #${ROOT_ID} .ksso-comment-tone {
        flex: 0 0 auto;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #64748b;
      }
      #${ROOT_ID} .ksso-comment-positive .ksso-comment-tone {
        background: #22c55e;
      }
      #${ROOT_ID} .ksso-comment-improvement .ksso-comment-tone {
        background: #f97316;
      }
      #${ROOT_ID} .ksso-comment-other .ksso-comment-tone {
        background: #3b82f6;
      }
      #${ROOT_ID} .ksso-comment-section h4 span {
        color: #475569;
        font-weight: 600;
      }
      #${ROOT_ID} .ksso-comment-bubbles {
        display: grid;
        gap: 10px;
        margin: 0;
      }
      #${ROOT_ID} .ksso-comment-bubble {
        width: fit-content;
        max-width: min(100%, 78ch);
        margin: 0;
        border: 1px solid #e2e8f0;
        border-left-width: 4px;
        border-radius: 12px;
        padding: 10px 14px;
        background: #f8fafc;
        color: #1f2937;
        font-size: 15px;
        font-weight: 600;
        line-height: 1.65;
        white-space: pre-wrap;
        word-break: break-word;
        box-sizing: border-box;
      }
      #${ROOT_ID} .ksso-comment-bubble::before,
      #${ROOT_ID} .ksso-comment-bubble::after {
        content: none;
      }
      #${ROOT_ID} .ksso-comment-positive .ksso-comment-bubble {
        border-color: #bbf7d0;
        border-left-color: #22c55e;
        background: #f0fdf4;
      }
      #${ROOT_ID} .ksso-comment-improvement .ksso-comment-bubble {
        border-color: #fed7aa;
        border-left-color: #f97316;
        background: #fff7ed;
      }
      #${ROOT_ID} .ksso-comment-other .ksso-comment-bubble {
        border-color: #bfdbfe;
        border-left-color: #3b82f6;
        background: #eff6ff;
      }
      @media (max-width: 720px) {
        #${ROOT_ID} .ksso-summary,
        #${ROOT_ID} .ksso-questions {
          grid-template-columns: 1fr;
        }
        #${ROOT_ID} .ksso-top {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function renderOverlay(match) {
    const previous = document.getElementById(ROOT_ID);
    if (previous) previous.remove();
    injectStyle();

    const evaluation = match.evaluation;
    const questions = Array.isArray(evaluation.questions) ? evaluation.questions : [];
    const q7 = questions.find((question) => question.index === 7);
    const total = questions[0] ? choiceTotal(questions[0].counts || []) : null;
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="ksso-top">
        <div class="ksso-title">授業評価</div>
        <div class="ksso-meta">K-Support / 照合スコア ${match.score}</div>
      </div>
      <div class="ksso-summary">
        <div class="ksso-metric"><span class="ksso-label">総合満足度</span><span class="ksso-value">${renderRating(q7?.avg)}</span></div>
        <div class="ksso-metric"><span class="ksso-label">回答率</span><span class="ksso-value">${formatPercent(evaluation.course?.answerPercent)}</span></div>
        <div class="ksso-metric"><span class="ksso-label">回答数</span><span class="ksso-value">${total || "-"}</span></div>
      </div>
      ${renderLegend()}
      <ul class="ksso-questions">
        ${questions.map(renderQuestion).join("")}
      </ul>
      ${renderCommentSections(evaluation.commentSections)}
    `;

    const anchor = document.querySelector(".syllabus-header") || document.querySelector("#screen-detail") || document.body;
    if (anchor === document.body) {
      document.body.prepend(root);
    } else {
      anchor.insertAdjacentElement("afterend", root);
    }
  }

  function mountRoot() {
    injectStyle();
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = ROOT_ID;
    const anchor = document.querySelector(".syllabus-header") || document.querySelector("#screen-detail") || document.body;
    if (anchor === document.body) {
      document.body.prepend(root);
    } else {
      anchor.insertAdjacentElement("afterend", root);
    }
    return root;
  }

  function renderStatus(title, message, options = {}) {
    const root = mountRoot();
    const actions = [];
    if (options.openKSupport) {
      actions.push(`<button type="button" class="ksso-button" data-ksso-action="open-ksupport">${escapeHtml(options.openKSupportLabel || "K-Supportを開く")}</button>`);
    }
    if (options.retry) {
      actions.push('<button type="button" class="ksso-button" data-ksso-action="retry">再取得</button>');
    }
    root.innerHTML = `
      <div class="ksso-top">
        <div class="ksso-title">${escapeHtml(title)}</div>
        <div class="ksso-meta">Keio Survey Overlay</div>
      </div>
      <div class="${options.error ? "ksso-error" : "ksso-status"}">${escapeHtml(message)}</div>
      ${actions.length ? `<div class="ksso-actions">${actions.join("")}</div>` : ""}
    `;
  }

  function bindActions(syllabus) {
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.(`#${ROOT_ID} [data-ksso-action]`);
      if (!button) return;
      const action = button.getAttribute("data-ksso-action");
      if (action === "open-ksupport") {
        void runtimeMessage({ type: "keioSurvey.openKSupport" });
      }
      if (action === "retry") {
        void fetchAndRender(syllabus, { force: true });
      }
    });
  }

  function candidateSummary(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return "";
    return candidates
      .slice(0, 3)
      .map((course) => `${course.courseName || "-"} / ${course.lecturer || "-"} / ${course.semester || "-"} / score ${course.score ?? "-"}`)
      .join("\n");
  }

  function isKSupportConnectionError(response) {
    const code = response?.code || "";
    const message = response?.message || "";
    return code === "TAB_MESSAGE_FAILED"
      || code === "KSUPPORT_TABS_UNAVAILABLE"
      || /Receiving end does not exist|Could not establish connection/i.test(message);
  }

  async function fetchAndRender(syllabus) {
    renderStatus("授業評価", "K-Support から授業評価を取得中です...");
    const response = await runtimeMessage({
      type: "keioSurvey.fetchEvaluationForSyllabus",
      syllabus
    });

    if (response?.ok && response.evaluation) {
      await saveEvaluation(response.evaluation);
      renderOverlay({
        evaluation: normalizeEvaluation(response.evaluation, { includeComments: true }),
        score: response.match?.score ?? scoreCourseMatch(syllabus, response.evaluation.course || {})
      });
      return;
    }

    if (isKSupportConnectionError(response)) {
      renderStatus("授業評価", [
        "K-Support との接続が切れています。",
        "K-Support を開いてログイン、または K-Support タブを再読み込みしてから、このページで再取得してください。"
      ].join("\n"), {
        openKSupport: true,
        openKSupportLabel: "K-Supportでログイン",
        retry: true,
        error: true
      });
      return;
    }

    if (response?.code === "KSUPPORT_TAB_NOT_FOUND") {
      renderStatus("授業評価", "ログイン済みの K-Support タブが見つかりません。K-Support を開いてログイン後、このページで再取得してください。", {
        openKSupport: true,
        openKSupportLabel: "K-Supportでログイン",
        retry: true,
        error: true
      });
      return;
    }

    if (response?.code === "KSUPPORT_CONTEXT_MISSING" || response?.code === "KSUPPORT_CONTEXT_EXPIRED") {
      renderStatus("授業評価", "K-Support の認証情報が古いか、まだ取得できていません。K-Support タブを再読み込みしてから再取得してください。", {
        openKSupport: true,
        openKSupportLabel: "K-Supportでログイン",
        retry: true,
        error: true
      });
      return;
    }

    if (response?.code === "NO_MATCH") {
      const summary = candidateSummary(response.candidates);
      renderStatus("授業評価", `一致する授業評価を見つけられませんでした。${summary ? `\n候補:\n${summary}` : ""}`, {
        retry: true,
        error: true
      });
      return;
    }

    renderStatus("授業評価", response?.message || "授業評価の取得に失敗しました。", {
      retry: true,
      error: true
    });
  }

  async function main() {
    const syllabus = parseSyllabusCourse();
    if (!syllabus.courseName) {
      renderStatus("授業評価", "シラバスから科目名を読み取れませんでした。", { error: true });
      return;
    }
    bindActions(syllabus);

    const current = await storageGet({ [STORAGE_KEYS.evaluations]: {} });
    const cachedEvaluations = await cacheGetAll("evaluations").catch(() => []);
    const match = findBestEvaluation(syllabus, [
      ...cachedEvaluations,
      ...uniqueEvaluations(current[STORAGE_KEYS.evaluations])
    ]);
    if (match) {
      renderOverlay(match);
    } else {
      renderStatus("授業評価", "保存済み評価は未検出です。K-Support から取得します...");
    }
    void fetchAndRender(syllabus);
  }

  void main();
})();
