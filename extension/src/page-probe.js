(() => {
  if (window.__keioSurveyPageProbeInstalled) return;
  window.__keioSurveyPageProbeInstalled = true;

  const SOURCE = "keio-survey-page-probe";
  const COMMAND_SOURCE = "keio-survey-content-command";
  const RESPONSE_SOURCE = "keio-survey-page-response";
  const SENSITIVE_KEY = /(token|jwt|authorization|cookie|sid|session|password|passwd|secret|saml|csrf|xsrf|credential|email|mail|phone|address)/i;
  const KEEP_PARAM_KEY = /(course|class|evaluation|record|offering|schedule|semester|term|campus|faculty|lecturer|teacher|subject|keyword|search|page|limit|offset|sort|filter|where|query|name)/i;
  const SALESFORCE_COURSE_ID = /^a0A[A-Za-z0-9]{12,15}$/;
  const COURSE_OBJECT = "hed__Course_Offering_Schedule__c";
  const DETAIL_FIELDS = [
    "SubjectNm_JaEng__c",
    "Display_Faculty_JaEng__c",
    "Display_Term_JaEng__c",
    "wdcol_JaEng__c",
    "CampusJaEng__c",
    "Department_JaEng__c",
    "Sp_CeAnsPercent__c",
    "Sp_CeFacComment__c"
  ];
  const EVALUATION_FIELDS = (() => {
    const fields = [...DETAIL_FIELDS];
    for (let question = 1; question <= 7; question += 1) {
      for (let choice = 1; choice <= 5; choice += 1) fields.push(`Sp_CeCntQ${question}_${choice}__c`);
      fields.push(`Sp_CeAvgQ${question}__c`);
      fields.push(`Sp_CeQ${question}_ja__c`);
      fields.push(`Sp_CeQ${question}_en__c`);
    }
    return fields;
  })();
  const DEFAULT_AURA_CONTEXT = {
    mode: "PROD",
    app: "siteforce:communityApp",
    loaded: {
      "APPLICATION@markup://siteforce:communityApp": "1544_-QE8H35gPOQmfpGx0OKiMg"
    },
    dn: [],
    globals: {},
    uad: true
  };
  const DEFAULT_SYNC_CAMPUSES = [
    "三田",
    "日吉",
    "矢上",
    "信濃町",
    "湘南藤沢",
    "芝共立",
    "新川崎",
    "その他"
  ];
  const DEFAULT_SYNC_FACULTIES = [
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
    "日本語・日本文化教育センター"
  ];
  const DEFAULT_SYNC_SEMESTERS = [
    "2025年春学期",
    "2025年秋学期"
  ];
  const SEARCH_RESULT_CAP = 1500;

  let lastAuraRequest = null;
  let nextAuraRequestNumber = Math.floor(Math.random() * 1000) + 1000;

  function emit(event) {
    window.postMessage({ source: SOURCE, event }, window.location.origin);
  }

  function emitCommandResponse(requestId, response) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      requestId,
      response
    }, window.location.origin);
  }

  function sanitizeUrl(raw) {
    try {
      const url = new URL(String(raw), window.location.href);
      return {
        origin: url.origin,
        path: url.pathname,
        queryKeys: [...url.searchParams.keys()].sort(),
        redacted: url.origin + url.pathname + (url.search ? "?" + [...url.searchParams.keys()].sort().map((key) => `${key}=...`).join("&") : "")
      };
    } catch {
      return { raw: String(raw).slice(0, 200) };
    }
  }

  function safePrimitive(key, value) {
    if (value == null) return value;
    const text = String(value);
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (SALESFORCE_COURSE_ID.test(text)) return text;
    if (KEEP_PARAM_KEY.test(key) && text.length <= 120) return text;
    return `[${typeof value}:${text.length}]`;
  }

  function sanitizeObject(value, key = "", depth = 0) {
    if (depth > 5) return "[MAX_DEPTH]";
    if (value == null || typeof value !== "object") return safePrimitive(key, value);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeObject(item, key, depth + 1));
    const out = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
      if (SENSITIVE_KEY.test(childKey)) {
        out[childKey] = "[REDACTED]";
      } else {
        out[childKey] = sanitizeObject(childValue, childKey, depth + 1);
      }
    }
    return out;
  }

  function extractAuraMessage(rawMessage) {
    try {
      const message = JSON.parse(rawMessage);
      const actions = Array.isArray(message.actions) ? message.actions : [];
      return {
        actionCount: actions.length,
        actions: actions.slice(0, 20).map((action) => ({
          id: action.id,
          descriptor: action.descriptor,
          callingDescriptor: action.callingDescriptor,
          params: sanitizeObject(action.params || {})
        }))
      };
    } catch {
      return { parseError: true, length: String(rawMessage || "").length };
    }
  }

  function sanitizeBody(body) {
    if (body == null) return null;
    if (body instanceof URLSearchParams) {
      return sanitizeFormBody(body);
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const keys = [];
      for (const key of body.keys()) keys.push(key);
      return { kind: "FormData", keys: [...new Set(keys)].sort() };
    }
    if (typeof body === "string") {
      try {
        return sanitizeFormBody(new URLSearchParams(body));
      } catch {
        return sanitizeTextBody(body);
      }
    }
    if (body && typeof body === "object") {
      return { kind: body.constructor?.name || "object" };
    }
    return { kind: typeof body };
  }

  function sanitizeTextBody(text) {
    const descriptorMatches = [...text.matchAll(/aura:\/\/[^"'\s&]+/g)].map((match) => match[0]);
    const courseIds = [...text.matchAll(/a0A[A-Za-z0-9]{12,15}/g)].map((match) => match[0]);
    return {
      kind: "text",
      length: text.length,
      descriptors: [...new Set(descriptorMatches)].slice(0, 20),
      courseIds: [...new Set(courseIds)].slice(0, 20)
    };
  }

  function sanitizeFormBody(params) {
    const keys = [...params.keys()].sort();
    const out = { kind: "URLSearchParams", keys };
    if (params.has("message")) out.auraMessage = extractAuraMessage(params.get("message"));
    if (params.has("aura.context")) out.hasAuraContext = true;
    if (params.has("aura.token")) out.hasAuraToken = true;
    rememberDebugAuraMessage(params);
    rememberAuraRequest(params);
    return out;
  }

  function rememberDebugAuraMessage(params) {
    const message = params.get("message") || "";
    if (!/FlowRuntime|Sp_CeCommentList|flowCommunity/i.test(message)) return;
    try {
      window.__keioSurveyDebugAura = Array.isArray(window.__keioSurveyDebugAura) ? window.__keioSurveyDebugAura : [];
      window.__keioSurveyDebugAura.push({
        at: new Date().toISOString(),
        actionFlag: [...params.keys()].find((key) => key !== "message" && key !== "aura.context" && key !== "aura.token" && key !== "aura.pageURI") || "",
        pageURI: params.get("aura.pageURI") || "",
        message: JSON.parse(message)
      });
      window.__keioSurveyDebugAura = window.__keioSurveyDebugAura.slice(-20);
    } catch {
      // Debug capture is best-effort only.
    }
  }

  function rememberAuraRequest(params) {
    const auraContext = params.get("aura.context");
    const auraToken = params.get("aura.token");
    if (!auraContext || !auraToken) return;
    lastAuraRequest = {
      context: auraContext,
      token: auraToken,
      pageURI: params.get("aura.pageURI") || location.pathname,
      capturedAt: Date.now()
    };
  }

  function asNumber(value) {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function unwrapReturnValue(value) {
    if (!value || typeof value !== "object") return value;
    if (value.returnValue && typeof value.returnValue === "object") return value.returnValue;
    return value;
  }

  function fieldValue(record, apiName) {
    const field = record?.fields?.[apiName];
    if (!field || typeof field !== "object") return null;
    return field.displayValue ?? field.value ?? null;
  }

  function extractCourseIdFromLink(html) {
    const text = String(html || "");
    return text.match(/\/students\/(?:s\/course-offering-schedule\/)?(a0A[A-Za-z0-9]{12,15})/)?.[1] || null;
  }

  function extractSearchCourses(auraPayload) {
    const actions = Array.isArray(auraPayload?.actions) ? auraPayload.actions : [];
    for (const action of actions) {
      const value = unwrapReturnValue(action?.returnValue);
      const rows = Array.isArray(value?.records)
        ? value.records
        : Array.isArray(value?.courses)
          ? value.courses
          : [];
      if (!rows.length) continue;
      const courses = rows.map((row) => ({
        recordId: extractCourseIdFromLink(row.SubjectNm_Link__c) || row.Id || "",
        courseName: String(row.SubjectNm_Link__c || "").replace(/<[^>]*>/g, "").trim(),
        lecturer: row.Display_Faculty_JaEng__c || "",
        semester: row.Display_Term_JaEng__c || "",
        dayPeriod: row.wdcol_JaEng__c || "",
        campus: row.CampusJaEng__c || "",
        faculty: row.Department_JaEng__c || ""
      })).filter((course) => course.recordId || course.courseName);
      if (courses.length) {
        return {
          kind: "ksupport.searchCourses",
          totalCount: asNumber(value?.totalCount),
          pageSize: asNumber(value?.pageSize),
          courses
        };
      }
    }
    return null;
  }

  function emitSyncProgress(progress) {
    emit({
      phase: "progress",
      transport: "aura",
      kind: "ksupport.syncProgress",
      at: new Date().toISOString(),
      ...progress
    });
  }

  function extractRecordContainer(globalValueProvider) {
    const records = globalValueProvider?.values?.records;
    if (!records || typeof records !== "object") return null;
    for (const [recordId, entry] of Object.entries(records)) {
      const record = entry?.[COURSE_OBJECT]?.record || entry?.record || entry;
      if (record?.fields?.Sp_CeAvgQ1__c || record?.fields?.SubjectNm_JaEng__c) {
        return { recordId, record };
      }
    }
    return null;
  }

  function extractEvaluationAggregate(auraPayload) {
    const providers = Array.isArray(auraPayload?.context?.globalValueProviders)
      ? auraPayload.context.globalValueProviders
      : [];
    for (const provider of providers) {
      if (provider?.type !== "$Record") continue;
      const container = extractRecordContainer(provider);
      if (!container) continue;
      const { recordId, record } = container;
      const questions = [];
      for (let index = 1; index <= 7; index += 1) {
        const avg = asNumber(fieldValue(record, `Sp_CeAvgQ${index}__c`));
        const ja = fieldValue(record, `Sp_CeQ${index}_ja__c`);
        const en = fieldValue(record, `Sp_CeQ${index}_en__c`);
        const counts = [];
        for (let choice = 1; choice <= 5; choice += 1) {
          counts.push(asNumber(fieldValue(record, `Sp_CeCntQ${index}_${choice}__c`)) ?? 0);
        }
        if (avg != null || ja || en || counts.some(Boolean)) {
          questions.push({ index, ja, en, avg, counts });
        }
      }
      if (!questions.length) continue;
      const fields = Object.fromEntries(DETAIL_FIELDS.map((apiName) => [apiName, fieldValue(record, apiName)]));
      return {
        kind: "ksupport.evaluationAggregate",
        recordId,
        course: {
          courseName: fields.SubjectNm_JaEng__c || "",
          lecturer: fields.Display_Faculty_JaEng__c || "",
          semester: fields.Display_Term_JaEng__c || "",
          dayPeriod: fields.wdcol_JaEng__c || "",
          campus: fields.CampusJaEng__c || "",
          faculty: fields.Department_JaEng__c || "",
          answerPercent: asNumber(fields.Sp_CeAnsPercent__c)
        },
        teacherComment: fields.Sp_CeFacComment__c || "",
        questions
      };
    }
    return null;
  }

  const COMMENT_SECTIONS = [
    {
      kind: "positive",
      title: "この授業で良かったと思う点をお書きください。",
      en: "What were the positive aspects of the course?"
    },
    {
      kind: "improvement",
      title: "この授業で改善してほしいと思う点をお書きください。",
      en: "Please record any course improvement suggestions."
    },
    {
      kind: "other",
      title: "その他、科目に関するご意見・ご感想など自由にお書きください。",
      en: "Please let us know if you have any requests or opinions."
    }
  ];

  function parseCommentSections(text) {
    const source = String(text || "").replace(/\r\n?/g, "\n");
    const starts = COMMENT_SECTIONS
      .map((section) => ({
        ...section,
        index: source.indexOf(section.title)
      }))
      .filter((section) => section.index >= 0)
      .sort((a, b) => a.index - b.index);
    if (!starts.length) return [];

    return starts.map((section, position) => {
      const nextIndex = starts[position + 1]?.index ?? source.indexOf("授業評価_教員コメント", section.index);
      const end = nextIndex >= 0 ? nextIndex : source.length;
      const headingEnd = source.indexOf("\n", section.index);
      const bodyStart = headingEnd >= 0 ? headingEnd + 1 : section.index + section.title.length;
      const body = source.slice(bodyStart, end)
        .replace(section.en, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(isLikelyCommentLine)
        .slice(0, 30);
      return {
        kind: section.kind,
        title: section.title,
        en: section.en,
        comments: body
      };
    }).filter((section) => section.comments.length);
  }

  function isLikelyCommentLine(line) {
    const text = normalizeText(line);
    if (!text) return false;
    if (COMMENT_SECTIONS.some((section) => text === section.title || text === section.en)) return false;
    if (text === "完了" || /^finish$/i.test(text)) return false;
    if (/^["'{}[\],:]+$/.test(text)) return false;
    if (/^[-–—・•]+$/.test(text)) return false;
    if (/^\{?["']?(outputs|isRequired|regionContainerType|helpText|metadataValues|inputs|dataType|errorMessage|isReactiveOnInit|label|styleProperties|isReadOnly|name|triggersUpdate|isDisabled|choices|contextMap|fields|value|fieldType|visibilityRule|templateField|valueSources|actions|errors|context|perfSummary)["']?\s*:/i.test(text)) return false;
    if (/"(styleProperties|isReadOnly|contextMap|visibilityRule|templateField|valueSources|globalValueProviders|perfSummary|FlowRuntime|FlowRuntimeConnect|screen|flowDevName)"/i.test(text)) return false;
    if ((text.match(/":/g) || []).length >= 3) return false;
    return true;
  }

  function collectFlowLabels(value, labels = []) {
    if (!value || typeof value !== "object") return labels;
    if (Array.isArray(value)) {
      for (const item of value) collectFlowLabels(item, labels);
      return labels;
    }
    if (typeof value.label === "string" && value.label.trim()) {
      labels.push(value.label);
    }
    for (const child of Object.values(value)) collectFlowLabels(child, labels);
    return labels;
  }

  async function extractCommentsFromDocument(doc) {
    const text = doc?.body?.innerText || "";
    const flowStart = text.indexOf(COMMENT_SECTIONS[0].title);
    const teacherCommentStart = text.indexOf("授業評価_教員コメント");
    const relevant = flowStart >= 0
      ? text.slice(flowStart, teacherCommentStart > flowStart ? teacherCommentStart : undefined)
      : text;
    return parseCommentSections(relevant);
  }

  function extractCommentsFromFlowPayload(payload) {
    const labels = collectFlowLabels(payload);
    const structuredText = labels.join("\n")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "\n");
    const structuredSections = parseCommentSections(structuredText);
    if (structuredSections.length) return structuredSections;

    const text = JSON.stringify(payload || {})
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "\n");
    return parseCommentSections(text);
  }

  async function fetchEvaluationCommentsViaFlow(recordId) {
    const detailPageURI = `/students/s/course-offering-schedule/${recordId}/csh163408`;
    const payload = await postAura(
      "aura.FlowRuntimeConnect.startFlow",
      commentFlowMessage(recordId),
      detailPageURI
    );
    return extractCommentsFromFlowPayload(payload);
  }

  async function fetchEvaluationComments(recordId) {
    if (!recordId) return [];
    try {
      const apiComments = await fetchEvaluationCommentsViaFlow(recordId);
      if (apiComments.length) return apiComments;
    } catch {
      // Flow comments are best-effort; fall back to same-origin detail rendering.
    }
    const currentPath = `/students/s/course-offering-schedule/${recordId}/csh163408`;
    const canReadCurrentPage = window.location.pathname === currentPath;
    if (canReadCurrentPage) {
      const currentComments = await extractCommentsFromDocument(document);
      if (currentComments.length) return currentComments;
    }
    return [];
  }

  function emitExtractedAuraData(text, requestId) {
    if (!text || typeof text !== "string" || text.length > 8_000_000) return;
    if (!text.includes("Sp_Ce") && !text.includes("SubjectNm_Link__c")) return;
    try {
      const auraPayload = JSON.parse(text);
      const extracted = extractEvaluationAggregate(auraPayload) || extractSearchCourses(auraPayload);
      if (!extracted) return;
      emit({
        phase: "data",
        transport: "aura",
        requestId,
        ...extracted,
        at: new Date().toISOString()
      });
    } catch {
      // Ignore non-JSON and Salesforce internal payloads that are not relevant.
    }
  }

  function requestUrlFromInput(input) {
    if (typeof input === "string" || input instanceof URL) return String(input);
    return input?.url || "";
  }

  function requestMethod(input, init) {
    return String(init?.method || input?.method || "GET").toUpperCase();
  }

  function requestBody(input, init) {
    return init?.body || input?.body || null;
  }

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
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  function normalizeSemester(value) {
    const text = normalizeText(value);
    const year = text.match(/20\d{2}/)?.[0] || "";
    const season = text.includes("春") || /spring/i.test(text) ? "春" : text.includes("秋") || /fall|autumn/i.test(text) ? "秋" : "";
    return `${year}${season}`;
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

  function auraContextString() {
    if (lastAuraRequest?.context && lastAuraRequest?.token) return lastAuraRequest.context;
    try {
      const context = window.$A?.getContext?.();
      const encoded = context?.encodeForServer?.();
      if (encoded) return typeof encoded === "string" ? encoded : JSON.stringify(encoded);
      if (context) {
        return JSON.stringify({
          mode: context.mode || "PROD",
          fwuid: context.Vr || undefined,
          app: context.getApp?.() || context.Tc || "siteforce:communityApp",
          loaded: context.getLoaded?.() || DEFAULT_AURA_CONTEXT.loaded,
          dn: [],
          globals: {},
          uad: true
        });
      }
    } catch {
      // Fall through to the minimal context used by this Salesforce community.
    }
    return JSON.stringify(DEFAULT_AURA_CONTEXT);
  }

  function auraToken() {
    if (lastAuraRequest?.token) return lastAuraRequest.token;
    try {
      const token = window.$A?.clientService?.getToken?.();
      if (token) return token;
      const clientService = window.$A?.clientService;
      if (clientService) {
        for (const value of Object.values(clientService)) {
          if (typeof value === "string" && /^eyJ/.test(value) && value.length > 80) return value;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function ensureAuraToken() {
    const token = auraToken();
    if (!token) {
      const error = new Error("K-Support の Aura token がまだ取得できていません。K-Support ページを再読み込みしてからもう一度試してください。");
      error.code = "KSUPPORT_CONTEXT_MISSING";
      throw error;
    }
    return token;
  }

  async function postAura(actionFlag, message, pageURI) {
    const token = ensureAuraToken();
    const url = new URL("/students/s/sfsites/aura", location.origin);
    url.searchParams.set("r", String(nextAuraRequestNumber += 1));
    url.searchParams.set(actionFlag, "1");

    const body = new URLSearchParams();
    body.set("message", JSON.stringify(message));
    body.set("aura.context", auraContextString());
    body.set("aura.pageURI", pageURI);
    body.set("aura.token", token);

    const response = await nativeFetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      const error = new Error("K-Support API から JSON ではない応答が返りました。");
      error.code = "KSUPPORT_BAD_RESPONSE";
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`K-Support API request failed: ${response.status}`);
      error.code = "KSUPPORT_HTTP_ERROR";
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    const states = Array.isArray(payload.actions) ? payload.actions.map((action) => action.state).filter(Boolean) : [];
    if (states.some((state) => state !== "SUCCESS")) {
      const errorText = JSON.stringify(payload.actions?.map((action) => action.error || action.state) || payload).slice(0, 500);
      const error = new Error(errorText || "K-Support API action failed.");
      error.code = /clientOutOfSync/i.test(errorText) ? "KSUPPORT_CONTEXT_EXPIRED" : "KSUPPORT_ACTION_ERROR";
      error.payload = payload;
      throw error;
    }
    emitExtractedAuraData(text, `manual-${Date.now()}`);
    return payload;
  }

  function searchMessage(criteria, pageNumber = 1) {
    return {
      actions: [
        {
          id: `${Date.now()};a`,
          descriptor: "aura://ApexActionController/ACTION$execute",
          callingDescriptor: "UNKNOWN",
          params: {
            namespace: "",
            classname: "Sp_CourseEvaluationSearchController",
            method: "searchCourses",
            params: {
              criteria,
              pageNumber,
              checkMaxRecords: false
            },
            cacheable: false,
            isContinuation: false
          }
        }
      ]
    };
  }

  function evaluationMessage(recordId) {
    const descriptor = `${recordId}.null.null.null.null.${EVALUATION_FIELDS.join(",")}.VIEW.true.${Date.now()}.null.null`;
    return {
      actions: [
        {
          id: `${Date.now()};a`,
          descriptor: "serviceComponent://ui.force.components.controllers.recordGlobalValueProvider.RecordGvpController/ACTION$getRecord",
          callingDescriptor: "UNKNOWN",
          params: {
            recordDescriptor: descriptor
          }
        }
      ]
    };
  }

  function commentFlowMessage(recordId) {
    return {
      actions: [
        {
          id: `${Date.now()};a`,
          descriptor: "aura://FlowRuntimeConnectController/ACTION$startFlow",
          callingDescriptor: "UNKNOWN",
          params: {
            flowDevName: "Sp_CeCommentList",
            arguments: JSON.stringify([
              {
                name: "recordId",
                type: "String",
                supportsRecordId: true,
                value: recordId
              }
            ]),
            debugAsUserId: "",
            enableRollbackMode: false,
            enableTrace: false,
            isBuilderDebug: false,
            useLatestSubflow: false
          }
        }
      ]
    };
  }

  function criteriaFromSyllabus(syllabus) {
    return {
      courseName: normalizeText(syllabus.courseName),
      mainLecturer: "",
      semester: "",
      campus: "",
      faculty: ""
    };
  }

  function findBestCourse(syllabus, courses) {
    let best = null;
    for (const course of courses) {
      const score = scoreCourseMatch(syllabus, course);
      if (!best || score > best.score) best = { course, score };
    }
    return best;
  }

  async function fetchEvaluationByRecordId(recordId) {
    const detailPageURI = `/students/s/course-offering-schedule/${recordId}/csh163408`;
    const detailPayload = await postAura(
      "ui-force-components-controllers-recordGlobalValueProvider.RecordGvp.getRecord",
      evaluationMessage(recordId),
      detailPageURI
    );
    const evaluation = extractEvaluationAggregate(detailPayload);
    if (!evaluation) {
      const error = new Error("K-Support の評価集計レスポンスを解析できませんでした。");
      error.code = "EVALUATION_PARSE_FAILED";
      throw error;
    }
    evaluation.commentSections = await fetchEvaluationComments(recordId);
    emit({
      phase: "data",
      transport: "aura",
      requestId: `sync-${recordId}-${Date.now()}`,
      ...evaluation
    });
    return evaluation;
  }

  function syncCriteria(criteria = {}) {
    return {
      courseName: "",
      mainLecturer: "",
      semester: "",
      campus: "",
      faculty: "",
      ...criteria
    };
  }

  async function searchCoursesByCriteria(criteria, maxPages, requestPrefix) {
    const courses = [];
    let totalCount = null;
    let pageCount = 0;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const searchPayload = await postAura(
        "aura.ApexAction.execute",
        searchMessage(criteria, pageNumber),
        "/students/s/ClassEvaluationSearch"
      );
      const search = extractSearchCourses(searchPayload) || { courses: [] };
      const pageCourses = search.courses || [];
      if (!pageCourses.length) break;
      pageCount += 1;
      if (search.totalCount != null) totalCount = search.totalCount;
      courses.push(...pageCourses);
      emit({
        phase: "data",
        transport: "aura",
        requestId: `${requestPrefix}-${pageNumber}-${Date.now()}`,
        kind: "ksupport.searchCourses",
        totalCount,
        courses: pageCourses
      });
      if (totalCount != null && courses.length >= totalCount) break;
    }

    return {
      criteria,
      courses,
      pageCount,
      totalCount,
      capped: totalCount != null && totalCount >= SEARCH_RESULT_CAP
    };
  }

  function isSearchTooBroadError(error) {
    const text = String(error?.message || error || "");
    return /1,?500|1500|検索結果.*超|検索条件.*絞/i.test(text);
  }

  function syncSearchSegments(payload, baseCriteria) {
    if (payload.partitionByCampus === false || normalizeText(baseCriteria.campus)) {
      return [baseCriteria];
    }
    const campuses = Array.isArray(payload.campuses) && payload.campuses.length
      ? payload.campuses
      : DEFAULT_SYNC_CAMPUSES;
    return campuses.map((campus) => ({
      ...baseCriteria,
      campus: normalizeText(campus)
    }));
  }

  function nextSearchSegments(payload, criteria) {
    if (payload.partitionBySemester !== false && !normalizeText(criteria.semester)) {
      const semesters = Array.isArray(payload.semesters) && payload.semesters.length
        ? payload.semesters
        : DEFAULT_SYNC_SEMESTERS;
      return semesters.map((semester) => ({
        ...criteria,
        semester: normalizeText(semester)
      }));
    }

    if (payload.partitionByFaculty !== false && !normalizeText(criteria.faculty)) {
      const faculties = Array.isArray(payload.faculties) && payload.faculties.length
        ? payload.faculties
        : DEFAULT_SYNC_FACULTIES;
      return faculties.map((faculty) => ({
        ...criteria,
        faculty: normalizeText(faculty)
      }));
    }

    return [];
  }

  async function searchCoursesWithFallback(criteria, maxPages, requestPrefix, payload) {
    try {
      const result = await searchCoursesByCriteria(criteria, maxPages, requestPrefix);
      if (!result.capped) return [result];
      const subCriteria = nextSearchSegments(payload, criteria);
      if (!subCriteria.length) return [result];
      const subResults = [];
      for (const [index, childCriteria] of subCriteria.entries()) {
        subResults.push(...await searchCoursesWithFallback(childCriteria, maxPages, `${requestPrefix}-split-${index + 1}`, payload));
      }
      return subResults;
    } catch (error) {
      if (!isSearchTooBroadError(error)) throw error;
      const subCriteria = nextSearchSegments(payload, criteria);
      if (!subCriteria.length) throw error;
      const subResults = [];
      for (const [index, childCriteria] of subCriteria.entries()) {
        subResults.push(...await searchCoursesWithFallback(childCriteria, maxPages, `${requestPrefix}-split-${index + 1}`, payload));
      }
      return subResults;
    }
  }

  async function syncAllEvaluations(payload = {}) {
    const baseCriteria = syncCriteria(payload.criteria || {});
    const maxPages = Number(payload.maxPages) > 0 ? Number(payload.maxPages) : 200;
    const maxDetails = Number(payload.maxDetails) === 0
      ? 0
      : Number(payload.maxDetails) > 0
        ? Number(payload.maxDetails)
        : Infinity;
    const detailConcurrency = Math.max(1, Math.min(8, Number(payload.detailConcurrency) || 4));
    const searchOnly = Boolean(payload.searchOnly) || maxDetails === 0;
    const courses = [];
    const segmentSummaries = [];
    const progressBase = {
      state: "running",
      startedAt: new Date().toISOString()
    };

    emitSyncProgress({
      ...progressBase,
      phaseName: "searching",
      message: "K-Support の検索条件を分割しています。",
      searchExpectedTotal: null,
      searchFoundRaw: 0,
      searchFoundUnique: 0,
      segmentsDone: 0,
      cappedSegmentsCount: 0,
      detailTotal: null,
      detailFetched: 0,
      detailFailed: 0
    });

    for (const [index, criteria] of syncSearchSegments(payload, baseCriteria).entries()) {
      const results = await searchCoursesWithFallback(criteria, maxPages, `sync-search-${index + 1}`, payload);
      for (const result of results) {
        courses.push(...result.courses);
        segmentSummaries.push({
          criteria: result.criteria,
          totalCount: result.totalCount,
          pageCount: result.pageCount,
          fetchedCount: result.courses.length,
          capped: result.capped
        });
        const seenDuringSearch = new Set(courses.map((course) => course.recordId).filter(Boolean));
        emitSyncProgress({
          ...progressBase,
          phaseName: "searching",
          message: `${result.criteria.campus || "全キャンパス"}${result.criteria.faculty ? ` / ${result.criteria.faculty}` : ""} を確認しました。`,
          searchExpectedTotal: segmentSummaries.reduce((sum, segment) => sum + (Number.isFinite(segment.totalCount) ? segment.totalCount : 0), 0),
          searchFoundRaw: courses.length,
          searchFoundUnique: seenDuringSearch.size,
          segmentsDone: segmentSummaries.length,
          cappedSegmentsCount: segmentSummaries.filter((segment) => segment.capped).length,
          detailTotal: null,
          detailFetched: 0,
          detailFailed: 0
        });
      }
    }

    const seen = new Set();
    const uniqueCourses = courses.filter((course) => {
      if (!course.recordId || seen.has(course.recordId)) return false;
      seen.add(course.recordId);
      return true;
    });
    const searchExpectedTotal = segmentSummaries.reduce((sum, segment) => sum + (Number.isFinite(segment.totalCount) ? segment.totalCount : 0), 0);
    const cappedSegments = segmentSummaries.filter((segment) => segment.capped);
    const coverageComplete = cappedSegments.length === 0;

    emitSyncProgress({
      ...progressBase,
      state: searchOnly ? "complete" : "running",
      phaseName: searchOnly ? "complete" : "details",
      message: searchOnly ? "検索カバレッジ確認が完了しました。" : "評価詳細と自由記述を取得しています。",
      searchExpectedTotal,
      searchFoundRaw: courses.length,
      searchFoundUnique: uniqueCourses.length,
      segmentsDone: segmentSummaries.length,
      cappedSegmentsCount: cappedSegments.length,
      coverageComplete,
      detailTotal: uniqueCourses.length,
      detailFetched: 0,
      detailFailed: 0
    });

    if (searchOnly) {
      return {
        ok: true,
        kind: "ksupport.syncAllEvaluations",
        searchOnly: true,
        coverageComplete,
        searchExpectedTotal,
        courseCount: uniqueCourses.length,
        rawCourseCount: courses.length,
        searchedSegments: segmentSummaries,
        cappedSegments,
        fetched: 0,
        failed: 0,
        failures: []
      };
    }

    const detailCourses = uniqueCourses.slice(0, maxDetails);
    const detailTotal = uniqueCourses.length;
    const isLimitedDetailRun = detailCourses.length < uniqueCourses.length;
    let fetched = 0;
    let nextDetailIndex = 0;
    const failures = [];
    async function fetchOneDetail(course) {
      try {
        await fetchEvaluationByRecordId(course.recordId);
        fetched += 1;
      } catch (error) {
        failures.push({
          recordId: course.recordId,
          courseName: course.courseName,
          code: error?.code || "DETAIL_FETCH_FAILED",
          message: String(error?.message || error).slice(0, 200)
        });
      }
      emitSyncProgress({
        ...progressBase,
        phaseName: "details",
        message: course.courseName || "評価詳細を取得しています。",
        searchExpectedTotal,
        searchFoundRaw: courses.length,
        searchFoundUnique: uniqueCourses.length,
        segmentsDone: segmentSummaries.length,
        cappedSegmentsCount: cappedSegments.length,
        coverageComplete,
        detailTotal,
        detailFetched: fetched,
        detailFailed: failures.length
      });
    }

    async function detailWorker() {
      while (nextDetailIndex < detailCourses.length) {
        const course = detailCourses[nextDetailIndex];
        nextDetailIndex += 1;
        await fetchOneDetail(course);
      }
    }

    const workerCount = Math.min(detailConcurrency, detailCourses.length);
    await Promise.all(Array.from({ length: workerCount }, () => detailWorker()));

    emitSyncProgress({
      ...progressBase,
      state: failures.length ? "complete_with_errors" : "complete",
      phaseName: "complete",
      message: isLimitedDetailRun ? "指定件数の同期が完了しました。" : "同期が完了しました。",
      searchExpectedTotal,
      searchFoundRaw: courses.length,
      searchFoundUnique: uniqueCourses.length,
      segmentsDone: segmentSummaries.length,
      cappedSegmentsCount: cappedSegments.length,
      coverageComplete,
      detailTotal,
      detailFetched: fetched,
      detailFailed: failures.length
    });

    return {
      ok: true,
      kind: "ksupport.syncAllEvaluations",
      coverageComplete,
      searchExpectedTotal,
      courseCount: uniqueCourses.length,
      rawCourseCount: courses.length,
      searchedSegments: segmentSummaries,
      cappedSegments,
      fetched,
      failed: failures.length,
      failures: failures.slice(0, 20)
    };
  }

  async function fetchEvaluationForSyllabus(payload) {
    const syllabus = payload?.syllabus || {};
    if (!normalizeText(syllabus.courseName)) {
      const error = new Error("シラバスから科目名を読み取れませんでした。");
      error.code = "SYLLABUS_COURSE_NAME_MISSING";
      throw error;
    }

    const searchPayload = await postAura(
      "aura.ApexAction.execute",
      searchMessage(criteriaFromSyllabus(syllabus)),
      "/students/s/ClassEvaluationSearch"
    );
    const search = extractSearchCourses(searchPayload) || { courses: [] };
    const candidates = search.courses || [];
    const best = findBestCourse(syllabus, candidates);
    if (!best || !best.course?.recordId || best.score < 55) {
      return {
        ok: false,
        code: "NO_MATCH",
        message: "K-Support の検索結果から十分に一致する授業評価を見つけられませんでした。",
        totalCount: search.totalCount ?? candidates.length,
        candidates: candidates.slice(0, 10).map((course) => ({
          ...course,
          score: scoreCourseMatch(syllabus, course)
        })).sort((a, b) => b.score - a.score)
      };
    }

    const evaluation = await fetchEvaluationByRecordId(best.course.recordId);

    return {
      ok: true,
      match: {
        score: best.score,
        course: best.course
      },
      candidates: candidates.slice(0, 10).map((course) => ({
        ...course,
        score: scoreCourseMatch(syllabus, course)
      })).sort((a, b) => b.score - a.score),
      evaluation
    };
  }

  const nativeFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    emit({
      phase: "request",
      transport: "fetch",
      requestId,
      method: requestMethod(input, init),
      url: sanitizeUrl(requestUrlFromInput(input)),
      body: sanitizeBody(requestBody(input, init)),
      at: new Date().toISOString()
    });
    try {
      const response = await nativeFetch.apply(this, arguments);
      const responseForParsing = response.clone();
      responseForParsing.text()
        .then((text) => emitExtractedAuraData(text, requestId))
        .catch(() => {});
      emit({
        phase: "response",
        transport: "fetch",
        requestId,
        status: response.status,
        ok: response.ok,
        url: sanitizeUrl(response.url || requestUrlFromInput(input)),
        contentType: response.headers.get("content-type") || "",
        at: new Date().toISOString()
      });
      return response;
    } catch (error) {
      emit({
        phase: "error",
        transport: "fetch",
        requestId,
        message: String(error?.message || error).slice(0, 300),
        at: new Date().toISOString()
      });
      throw error;
    }
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__keioSurveyProbe = {
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: String(method || "GET").toUpperCase(),
      url: sanitizeUrl(url),
      at: new Date().toISOString()
    };
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const meta = this.__keioSurveyProbe || {
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: "GET",
      url: sanitizeUrl("")
    };
    emit({
      phase: "request",
      transport: "xhr",
      requestId: meta.requestId,
      method: meta.method,
      url: meta.url,
      body: sanitizeBody(body),
      at: new Date().toISOString()
    });
    this.addEventListener("loadend", () => {
      try {
        emitExtractedAuraData(this.responseText, meta.requestId);
      } catch {
        // Some XHR responses are not readable from script; ignore them.
      }
      emit({
        phase: "response",
        transport: "xhr",
        requestId: meta.requestId,
        status: this.status,
        ok: this.status >= 200 && this.status < 400,
        url: sanitizeUrl(this.responseURL || meta.url?.redacted || ""),
        contentType: this.getResponseHeader("content-type") || "",
        at: new Date().toISOString()
      });
    });
    return nativeSend.apply(this, arguments);
  };

  window.addEventListener("message", (messageEvent) => {
    if (messageEvent.source !== window) return;
    if (messageEvent.origin !== window.location.origin) return;
    const data = messageEvent.data;
    if (!data || data.source !== COMMAND_SOURCE || !data.requestId) return;

    if (data.command === "fetchEvaluationForSyllabus") {
      fetchEvaluationForSyllabus(data.payload)
        .then((response) => emitCommandResponse(data.requestId, response))
        .catch((error) => emitCommandResponse(data.requestId, {
          ok: false,
          code: error?.code || "KSUPPORT_UNKNOWN_ERROR",
          message: String(error?.message || error).slice(0, 500)
        }));
    }
    if (data.command === "syncAllEvaluations") {
      syncAllEvaluations(data.payload)
        .then((response) => emitCommandResponse(data.requestId, response))
        .catch((error) => emitCommandResponse(data.requestId, {
          ok: false,
          code: error?.code || "KSUPPORT_SYNC_ERROR",
          message: String(error?.message || error).slice(0, 500)
        }));
    }
    if (data.command === "status") {
      emitCommandResponse(data.requestId, {
        ok: true,
        hasAura: Boolean(window.$A),
        hasToken: Boolean(auraToken()),
        capturedAt: lastAuraRequest?.capturedAt || null,
        pageURI: lastAuraRequest?.pageURI || null
      });
    }
  });

  emit({
    phase: "installed",
    transport: "probe",
    url: sanitizeUrl(window.location.href),
    hasAura: Boolean(window.$A),
    at: new Date().toISOString()
  });
})();
