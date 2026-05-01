(() => {
  const STORAGE_KEYS = {
    courses: "keioSurvey.courses",
    evaluations: "keioSurvey.evaluations",
    networkEvents: "keioSurvey.networkEvents",
    settings: "keioSurvey.settings",
    lastSeen: "keioSurvey.lastSeen"
  };

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
    scoreCourseMatch,
    storageGet,
    storageSet,
    toNumber
  };
})();
