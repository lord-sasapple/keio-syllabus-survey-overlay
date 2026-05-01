(() => {
  const {
    STORAGE_KEYS,
    compactCourseKey,
    normalizeText,
    storageGet,
    storageSet
  } = window.KeioSurveyShared;

  const SOURCE = "keio-survey-page-probe";
  const COMMAND_SOURCE = "keio-survey-content-command";
  const RESPONSE_SOURCE = "keio-survey-page-response";
  const COMMAND_TIMEOUT_MS = 45000;

  function objectStore(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function normalizeCourse(course) {
    return {
      recordId: normalizeText(course.recordId),
      courseName: normalizeText(course.courseName),
      lecturer: normalizeText(course.lecturer),
      semester: normalizeText(course.semester),
      dayPeriod: normalizeText(course.dayPeriod),
      campus: normalizeText(course.campus),
      faculty: normalizeText(course.faculty),
      answerPercent: typeof course.answerPercent === "number" ? course.answerPercent : null
    };
  }

  function normalizeEvaluation(event) {
    const course = normalizeCourse(event.course || {});
    const questions = Array.isArray(event.questions)
      ? event.questions.map((question) => ({
          index: question.index,
          ja: normalizeText(question.ja),
          en: normalizeText(question.en),
          avg: typeof question.avg === "number" ? question.avg : null,
          counts: Array.isArray(question.counts) ? question.counts.slice(0, 5).map((count) => Number(count) || 0) : []
        }))
      : [];

    return {
      source: "keio-ksupport-ksei",
      recordId: normalizeText(event.recordId || course.recordId),
      capturedAt: event.at || new Date().toISOString(),
      course,
      questions
    };
  }

  async function saveCourses(courses) {
    if (!Array.isArray(courses) || !courses.length) return;
    const current = await storageGet({ [STORAGE_KEYS.courses]: {} });
    const store = objectStore(current[STORAGE_KEYS.courses]);

    for (const rawCourse of courses) {
      const course = normalizeCourse(rawCourse);
      const key = compactCourseKey(course);
      if (course.recordId) store[`record:${course.recordId}`] = course;
      if (key.replace(/\|/g, "")) store[`key:${key}`] = course;
    }

    await storageSet({
      [STORAGE_KEYS.courses]: store,
      [STORAGE_KEYS.lastSeen]: {
        url: location.href,
        title: document.title,
        at: new Date().toISOString()
      }
    });
  }

  async function saveEvaluation(event) {
    const evaluation = normalizeEvaluation(event);
    if (!evaluation.recordId && !evaluation.questions.length) return;

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
      evaluations[`record:${evaluation.recordId}`] = evaluation;
    }
    if (key.replace(/\|/g, "")) {
      courses[`key:${key}`] = {
        ...evaluation.course,
        recordId: evaluation.recordId
      };
      evaluations[`key:${key}`] = evaluation;
    }

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

  function pageCommand(command, payload = {}) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({
          ok: false,
          code: "KSUPPORT_COMMAND_TIMEOUT",
          message: "K-Support ページから時間内に応答がありませんでした。"
        });
      }, COMMAND_TIMEOUT_MS);

      function onMessage(messageEvent) {
        if (messageEvent.source !== window) return;
        if (messageEvent.origin !== window.location.origin) return;
        const data = messageEvent.data;
        if (!data || data.source !== RESPONSE_SOURCE || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data.response || { ok: false, code: "KSUPPORT_EMPTY_RESPONSE" });
      }

      window.addEventListener("message", onMessage);
      window.postMessage({
        source: COMMAND_SOURCE,
        requestId,
        command,
        payload
      }, window.location.origin);
    });
  }

  async function handleRuntimeMessage(message) {
    if (message?.type === "keioSurvey.fetchEvaluationForSyllabus") {
      const response = await pageCommand("fetchEvaluationForSyllabus", {
        syllabus: message.syllabus || {}
      });
      if (response?.evaluation) await saveEvaluation(response.evaluation);
      if (Array.isArray(response?.candidates)) await saveCourses(response.candidates);
      return response;
    }

    if (message?.type === "keioSurvey.ksupportStatus") {
      return pageCommand("status");
    }

    return null;
  }

  window.addEventListener("message", (messageEvent) => {
    if (messageEvent.source !== window) return;
    if (messageEvent.origin !== window.location.origin) return;
    const data = messageEvent.data;
    if (!data || data.source !== SOURCE || !data.event) return;

    if (data.event.kind === "ksupport.searchCourses") {
      void saveCourses(data.event.courses);
    }
    if (data.event.kind === "ksupport.evaluationAggregate") {
      void saveEvaluation(data.event);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("keioSurvey.")) return false;
    handleRuntimeMessage(message)
      .then((response) => sendResponse(response || { ok: false, code: "UNHANDLED_MESSAGE" }))
      .catch((error) => sendResponse({
        ok: false,
        code: error?.code || "KSUPPORT_CONTENT_ERROR",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  });
})();
