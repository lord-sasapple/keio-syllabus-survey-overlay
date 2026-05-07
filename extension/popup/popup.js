(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cacheGetMeta,
    normalizeText,
    storageGet,
    storageSet
  } = window.KeioSurveyShared;

  let progressTimer = null;
  let optimisticProgress = null;
  let currentSettings = { faculty: "" };
  let ksupportReadyState = null;
  const DEBUG = false;
  const FACULTY_OPTIONS = [
    "文学部",
    "経済学部",
    "法学部",
    "商学部",
    "医学部",
    "理工学部",
    "総合政策・環境情報学部",
    "看護医療学部",
    "薬学部",
    "文学研究科",
    "経済学研究科",
    "法学研究科",
    "社会学研究科",
    "商学研究科",
    "医学研究科",
    "理工学研究科",
    "政策・メディア研究科",
    "健康マネジメント研究科",
    "薬学研究科",
    "経営管理研究科",
    "システムデザイン・マネジメント研究科",
    "メディアデザイン研究科",
    "法務研究科",
    "通信教育課程",
    "日本語・日本文化教育センター",
    "大学院共通",
    "体育研究所",
    "保健管理センター"
  ];

  function debugLog(label, payload = null) {
    if (!DEBUG) return;
    if (payload == null) {
      console.log(`[KSSO popup] ${label}`);
      return;
    }
    console.log(`[KSSO popup] ${label}`, payload);
  }

  function $(id) {
    const element = document.getElementById(id);
    if (!element) debugLog("missing popup element", { id });
    return element;
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function setWidth(id, value) {
    const element = $(id);
    if (element) element.style.width = value;
  }

  function toggleClass(id, className, enabled) {
    const element = $(id);
    if (element) element.classList.toggle(className, enabled);
  }

  function countValues(value, predicate = () => true) {
    if (!value || typeof value !== "object") return 0;
    return new Set(
      Object.values(value)
        .filter((entry) => predicate(entry))
        .map((entry) => entry?.recordId || JSON.stringify(entry))
        .filter(Boolean)
    ).size;
  }

  function normalizeSettings(settings = {}) {
    return {
      ...settings,
      faculty: normalizeText(settings.faculty)
    };
  }

  function facultyMatchesCourse(course, faculty) {
    const selected = normalizeText(faculty);
    if (!selected) return true;
    const value = normalizeText(course?.faculty);
    if (!value) return false;
    return value === selected || value.includes(selected) || selected.includes(value);
  }

  function facultyMatchesEvaluation(evaluation, faculty) {
    return facultyMatchesCourse(evaluation?.course, faculty);
  }

  function progressIsStale(progress) {
    if (progress?.state !== "running") return false;
    const updatedAt = Date.parse(progress.updatedAt || progress.at || progress.startedAt || "");
    return Number.isFinite(updatedAt) && Date.now() - updatedAt > 10 * 60 * 1000;
  }

  function progressMatchesFaculty(progress, faculty) {
    const targetFaculty = normalizeText(progress?.targetFaculty);
    const selected = normalizeText(faculty);
    if (!selected) return true;
    return targetFaculty === selected;
  }

  function formatLastSeen(lastSeen) {
    const raw = lastSeen?.at || lastSeen?.finishedAt;
    if (!raw) return "-";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function commentSectionCount(evaluation) {
    return Array.isArray(evaluation?.commentSections)
      ? evaluation.commentSections.reduce((sum, section) => sum + (Array.isArray(section.comments) && section.comments.length ? 1 : 0), 0)
      : 0;
  }

  function syncStatusText(meta) {
    const value = meta?.value;
    if (!value) return "未同期";
    if (Array.isArray(value.cappedSegments) && value.cappedSegments.length) return "上限注意";
    if (value.ok) return "完了";
    return "失敗";
  }

  function syncCountText(meta) {
    const value = meta?.value;
    if (!value) return "-";
    const courseCount = Number.isFinite(value.courseCount) ? value.courseCount : "-";
    const fetched = Number.isFinite(value.fetched) ? value.fetched : "-";
    const failed = Number.isFinite(value.failed) ? value.failed : 0;
    const capped = Array.isArray(value.cappedSegments) ? value.cappedSegments.length : 0;
    return `${fetched}/${courseCount}${failed ? ` 失敗${failed}` : ""}${capped ? ` 要分割${capped}` : ""}`;
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString("ja-JP") : "-";
  }

  function storageMeta(value) {
    return value ? { value } : null;
  }

  function populateFacultySelect() {
    const select = $("faculty-select");
    if (!select || select.dataset.ready === "1") return;
    for (const faculty of FACULTY_OPTIONS) {
      const option = document.createElement("option");
      option.value = faculty;
      option.textContent = faculty;
      select.appendChild(option);
    }
    select.dataset.ready = "1";
  }

  function renderFacultySetting() {
    const select = $("faculty-select");
    const syncButton = $("sync-all");
    if (select && select.value !== currentSettings.faculty) select.value = currentSettings.faculty;
    if (currentSettings.faculty) {
      setText("faculty-note", `${currentSettings.faculty}の授業評価と自由記述コメントを保存します。`);
      if (syncButton) syncButton.disabled = false;
      return;
    }
    setText("faculty-note", "保存する範囲を絞るため、先に自分の学部を選んでください。");
    if (syncButton) syncButton.disabled = true;
  }

  async function saveFacultySetting(faculty) {
    const current = await storageGet({ [STORAGE_KEYS.settings]: {} });
    const settings = normalizeSettings({
      ...(current[STORAGE_KEYS.settings] || {}),
      faculty
    });
    currentSettings = settings;
    optimisticProgress = null;
    await storageSet({ [STORAGE_KEYS.settings]: settings });
    renderFacultySetting();
    await renderCounts();
  }

  function phaseText(progress) {
    if (progress?.derivedPartial) return "保存済みデータあり";
    const phaseName = progress?.phaseName;
    if (phaseName === "starting") return "更新を開始中";
    if (phaseName === "searching") return "授業一覧を取得中";
    if (phaseName === "details") return "評価データを保存中";
    if (phaseName === "complete") return progress?.coverageComplete === false ? "完了（上限注意）" : "完了";
    if (phaseName === "failed") return "失敗";
    if (progress?.state === "running") return "更新中";
    return "未更新";
  }

  function progressPercent(progress, syncMeta) {
    const useSyncFallback = !progress?.state;
    const expected = Number(progress?.searchExpectedTotal ?? (useSyncFallback ? syncMeta?.value?.searchExpectedTotal : undefined));
    const detailTotal = Number(progress?.detailTotal ?? (useSyncFallback ? syncMeta?.value?.courseCount : undefined));
    const detailFetched = Number(progress?.detailFetched ?? (useSyncFallback ? syncMeta?.value?.fetched : undefined));
    const searchFound = Number(progress?.searchFoundUnique ?? (useSyncFallback ? syncMeta?.value?.courseCount : undefined));
    if (Number.isFinite(detailTotal) && detailTotal > 0 && Number.isFinite(detailFetched)) {
      return Math.max(0, Math.min(100, Math.round((detailFetched / detailTotal) * 100)));
    }
    if (Number.isFinite(expected) && expected > 0 && Number.isFinite(searchFound)) {
      return Math.max(0, Math.min(100, Math.round((searchFound / expected) * 100)));
    }
    return null;
  }

  function renderProgress(progressMeta, syncMeta) {
    const progress = progressMeta?.value || {};
    const sync = syncMeta?.value || {};
    const useSyncFallback = !progress.state;
    const expected = Number(progress.searchExpectedTotal ?? (useSyncFallback ? sync.searchExpectedTotal : undefined));
    const found = Number(progress.searchFoundUnique ?? (useSyncFallback ? sync.courseCount : undefined));
    const detailFetched = Number(progress.detailFetched ?? (useSyncFallback ? sync.fetched : undefined));
    const detailTotal = Number(progress.detailTotal ?? (useSyncFallback ? sync.courseCount : undefined));
    const detailFailed = Number(progress.detailFailed ?? (useSyncFallback ? sync.failed : 0) ?? 0);
    const capped = Number(progress.cappedSegmentsCount ?? (useSyncFallback && Array.isArray(sync.cappedSegments) ? sync.cappedSegments.length : 0));
    const percent = progressPercent(progress, syncMeta);
    const isRunning = progress.state === "running";

    debugLog("renderProgress", {
      state: progress.state || "none",
      phaseName: progress.phaseName || null,
      expected,
      found,
      detailFetched,
      detailTotal,
      detailFailed,
      capped,
      percent,
      progressUpdatedAt: progress.updatedAt || null,
      syncFinishedAt: sync.finishedAt || null
    });

    setText("progress-stage", phaseText(progress));
    setText("progress-percent", percent == null ? (isRunning ? "同期中" : "-") : `${percent}%`);
    setText("expected-total", formatNumber(expected));
    setText("search-found", formatNumber(found));
    setText("detail-progress", `${formatNumber(detailFetched)} / ${formatNumber(detailTotal)}`);
    setText("progress-note", progress.message || (capped ? "まだ 1,500 件上限に当たっている検索条件があります。" : "同期中はこの画面を閉じても大丈夫です。K-Supportタブは開いたままにしてください。"));
    setText("cache-detail", Number.isFinite(detailFetched) || Number.isFinite(detailTotal)
      ? `保存済み評価 ${formatNumber(detailFetched)} / ${formatNumber(detailTotal)} 件${detailFailed ? `（失敗 ${formatNumber(detailFailed)} 件）` : ""}`
      : "保存済み評価 - 件");
    setWidth("progress-bar", percent == null ? (isRunning ? "100%" : "0%") : `${percent}%`);
    toggleClass("progress-bar", "is-running", isRunning);
    toggleClass("progress-bar", "is-indeterminate", isRunning && percent == null);
    toggleClass("progress-bar", "is-warning", capped > 0 || detailFailed > 0);
  }

  function renderReadiness({ evaluationCount, progressMeta, syncMeta, ksupportReady = null }) {
    const progress = progressMeta?.value || {};
    const sync = syncMeta?.value || {};
    if (progress.state === "running") {
      setText("readiness-title", "更新中");
      setText("readiness-note", `${currentSettings.faculty || "選択した学部"}の授業評価を保存しています。`);
      return;
    }
    if (!currentSettings.faculty) {
      setText("readiness-title", "学部を選択してください");
      setText("readiness-note", "自分の学部を選ぶと、必要な授業評価だけを保存できます。");
      return;
    }
    if (evaluationCount > 0) {
      setText("readiness-title", "表示できます");
      setText("readiness-note", `${currentSettings.faculty ? `${currentSettings.faculty}で` : ""}${evaluationCount.toLocaleString("ja-JP")}件の授業評価をシラバス上で表示できます。`);
      return;
    }
    if (sync.ok === false) {
      setText("readiness-title", "更新に失敗");
      setText("readiness-note", "K-Supportを開いてログインし直してから、もう一度更新してください。");
      return;
    }
    setText("readiness-title", ksupportReady ? "更新できます" : "未更新");
    setText("readiness-note", ksupportReady
      ? `${currentSettings.faculty}の授業評価を更新できます。`
      : "まずK-Supportを開いてログインしてください。"
    );
  }

  async function renderCounts() {
    debugLog("renderCounts:start");
    const state = await storageGet({
      [STORAGE_KEYS.courses]: {},
      [STORAGE_KEYS.evaluations]: {},
      [STORAGE_KEYS.lastSeen]: null,
      [STORAGE_KEYS.lastSyncAllEvaluations]: null,
      [STORAGE_KEYS.lastSyncProgress]: null,
      [STORAGE_KEYS.settings]: {}
    });
    currentSettings = normalizeSettings(state[STORAGE_KEYS.settings]);
    renderFacultySetting();
    let [cachedCourses, cachedEvaluations, syncMeta, progressMeta] = await Promise.all([
      cacheGetAll("courses").catch((error) => {
        console.warn("[KSSO popup] cacheGetAll(courses) failed", error);
        return [];
      }),
      cacheGetAll("evaluations").catch((error) => {
        console.warn("[KSSO popup] cacheGetAll(evaluations) failed", error);
        return [];
      }),
      cacheGetMeta("lastSyncAllEvaluations").catch((error) => {
        console.warn("[KSSO popup] cacheGetMeta(lastSyncAllEvaluations) failed", error);
        return null;
      }),
      cacheGetMeta("lastSyncProgress").catch((error) => {
        console.warn("[KSSO popup] cacheGetMeta(lastSyncProgress) failed", error);
        return null;
      })
    ]);
    syncMeta ||= storageMeta(state[STORAGE_KEYS.lastSyncAllEvaluations]);
    progressMeta ||= storageMeta(state[STORAGE_KEYS.lastSyncProgress]) || optimisticProgress;
    if (syncMeta?.value && !progressMatchesFaculty(syncMeta.value, currentSettings.faculty)) {
      syncMeta = null;
    }
    if (progressMeta?.value && (!progressMatchesFaculty(progressMeta.value, currentSettings.faculty) || progressIsStale(progressMeta.value))) {
      progressMeta = null;
    }
    const faculty = currentSettings.faculty;
    const cachedCoursesForFaculty = cachedCourses.filter((course) => facultyMatchesCourse(course, faculty));
    const cachedEvaluationsForFaculty = cachedEvaluations.filter((evaluation) => facultyMatchesEvaluation(evaluation, faculty));
    const storageCourseCount = countValues(state[STORAGE_KEYS.courses], (course) => facultyMatchesCourse(course, faculty));
    const storageEvaluationCount = countValues(state[STORAGE_KEYS.evaluations], (evaluation) => facultyMatchesEvaluation(evaluation, faculty));
    const courseCount = Math.max(cachedCoursesForFaculty.length, storageCourseCount);
    const evaluationCount = Math.max(cachedEvaluationsForFaculty.length, storageEvaluationCount);
    const commentsCount = cachedEvaluationsForFaculty.filter((evaluation) => commentSectionCount(evaluation) > 0).length;

    debugLog("renderCounts:data", {
      selectedFaculty: faculty || null,
      cachedCourses: cachedCoursesForFaculty.length,
      cachedEvaluations: cachedEvaluationsForFaculty.length,
      storageCourses: storageCourseCount,
      storageEvaluations: storageEvaluationCount,
      syncMeta: syncMeta?.value || null,
      progressMeta: progressMeta?.value || null
    });

    setText("evaluation-count", String(evaluationCount));
    setText("comment-count", String(commentsCount));
    setText("last-seen", formatLastSeen(syncMeta?.value) !== "-" ? formatLastSeen(syncMeta.value) : formatLastSeen(state[STORAGE_KEYS.lastSeen]));
    setText("sync-all", evaluationCount > 0 ? "未保存分を更新" : "評価データを保存");
    if (!progressMeta?.value && (courseCount || evaluationCount)) {
      progressMeta = storageMeta({
        derivedPartial: true,
      message: faculty
        ? `${faculty}の保存済みデータがあります。更新すると最新の授業評価を確認できます。`
          : "保存済みデータがあります。学部を選ぶと、その範囲だけを更新できます。",
        searchFoundUnique: courseCount || null,
        detailFetched: evaluationCount || null
      });
    }
    renderProgress(progressMeta, syncMeta);
    renderReadiness({ evaluationCount, progressMeta, syncMeta, ksupportReady: ksupportReadyState });
    if (progressMeta?.value?.state === "running" && !progressTimer) {
      debugLog("progressTimer:start");
      progressTimer = setInterval(() => void renderCounts(), 2000);
    }
    if (progressMeta?.value?.state !== "running" && progressTimer) {
      debugLog("progressTimer:stop", { state: progressMeta?.value?.state || null });
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function renderKSupportStatus() {
    debugLog("ksupportStatus:request");
    chrome.runtime.sendMessage({ type: "keioSurvey.ksupportStatus" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        console.warn("[KSSO popup] ksupportStatus failed", chrome.runtime.lastError, response);
        ksupportReadyState = false;
        setText("ksupport-status", "未接続");
        void renderCounts();
        return;
      }
      const tabs = Array.isArray(response.tabs) ? response.tabs : [];
      const ready = tabs.some((tab) => tab.ok && tab.hasToken);
      ksupportReadyState = ready;
      debugLog("ksupportStatus:response", { ready, tabs });
      setText("ksupport-status", ready ? "準備OK" : tabs.length ? "要再読込" : "未検出");
      void renderCounts();
    });
  }

  async function main() {
    debugLog("main:start");
    populateFacultySelect();
    await renderCounts();
    renderKSupportStatus();
  }

  $("open-ksupport")?.addEventListener("click", () => {
    debugLog("openKSupport:click");
    chrome.runtime.sendMessage({ type: "keioSurvey.openKSupport" }, (response) => {
      debugLog("openKSupport:response", response || chrome.runtime.lastError?.message);
    });
  });

  $("faculty-select")?.addEventListener("change", (event) => {
    const faculty = normalizeText(event.target.value);
    debugLog("facultySetting:change", { faculty });
    void saveFacultySetting(faculty);
  });

  $("sync-all")?.addEventListener("click", () => {
    const faculty = normalizeText($("faculty-select")?.value || currentSettings.faculty);
    debugLog("syncAll:click", { includeComments: true, faculty });
    if (!faculty) {
      setText("debug-message", "先に自分の学部を選んでください。");
      renderReadiness({ evaluationCount: Number($("evaluation-count")?.textContent) || 0, progressMeta: null, syncMeta: null });
      return;
    }
    optimisticProgress = storageMeta({
      state: "running",
      phaseName: "starting",
      message: `${faculty}の未保存分を確認しています。`,
      targetFaculty: faculty,
      startedAt: new Date().toISOString()
    });
    setText("debug-message", "更新を開始しています...");
    void renderCounts();
    chrome.runtime.sendMessage({
      type: "keioSurvey.syncAllEvaluations",
      options: {
        includeComments: true,
        detailConcurrency: 6,
        partitionByFaculty: false,
        criteria: { faculty }
      }
    }, (response) => {
      debugLog("syncAll:response", response || chrome.runtime.lastError?.message);
      if (chrome.runtime.lastError || !response?.ok) {
        optimisticProgress = null;
        setText("debug-message", "同期を開始できませんでした。K-Support を開いてログインしてください。");
        void renderCounts();
        return;
      }
      setText("debug-message", response.started ? "更新を開始しました。進み具合は上に表示されます。" : "更新はすでに実行中です。進み具合を確認しています。");
      if (!progressTimer) {
        debugLog("progressTimer:startAfterSyncClick");
        progressTimer = setInterval(() => void renderCounts(), 2000);
      }
      setTimeout(() => void renderCounts(), 800);
      setTimeout(() => void renderCounts(), 2000);
    });
  });

  void main();
})();
