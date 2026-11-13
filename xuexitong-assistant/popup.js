const get = (id) => document.getElementById(id);
const status = get("status");
const rate = get("rate");
const autoNext = get("auto-next");
const autoSubmit = get("auto-submit");
const autoFill = get("auto-fill");
const mode = get("mode");
const saveDraft = get("save-draft");
const skipUnsupported = get("skip-unsupported");
const exportButton = get("export");
const exportCsv = get("export-csv");
const start = get("start");
const pause = get("pause");
const stop = get("stop");
const redo = get("redo-answered");
const workSubmit = get("work-submit");
const submitConfirm = get("submit-confirm");
const archiveSelect = get("archive-select");
let tabId;
let revision = 0;
let requestActive = false;
let workSignature;

function renderWork(work) {
  const signature = JSON.stringify(work);
  if (signature === workSignature) return;
  workSignature = signature;
  const answered = work.items.filter((item) => item.answered).length;
  get("work-count").textContent = `已答 ${answered} / ${work.expected ?? work.items.length} 题` +
    (work.expected !== null && work.expected !== work.items.length ? ` · 已识别 ${work.items.length} 题` : "");
  const groups = new Map();
  for (const item of work.items) {
    if (!groups.has(item.type)) groups.set(item.type, []);
    groups.get(item.type).push(item);
  }
  const content = document.createDocumentFragment();
  for (const [type, items] of groups) {
    const section = document.createElement("fieldset");
    section.className = "work-group";
    const label = document.createElement("legend");
    label.textContent = `${type} · ${items.length} 题`;
    const numbers = document.createElement("div");
    numbers.className = "work-numbers";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.number;
      button.classList.toggle("answered", item.answered);
      button.setAttribute("aria-label", `第 ${item.number} 题，${item.answered ? "已答" : "未答"}`);
      button.addEventListener("click", () => send("work-locate", { number: item.number }));
      numbers.append(button);
    }
    section.append(label, numbers);
    content.append(section);
  }
  get("work-groups").replaceChildren(content);
}

function render(state) {
  status.textContent = state.message;
  status.classList.toggle("error", state.phase === "blocked");
  const running = state.phase === "running";
  const unavailable = state.phase === "unavailable";
  const work = state.work;
  get("work-panel").hidden = !work;
  for (const element of document.querySelectorAll(".course-only")) element.hidden = Boolean(state.standalone);
  if (work) renderWork(work);
  workSubmit.hidden = !work?.canSubmit || Boolean(work?.submitted);
  workSubmit.disabled = running || unavailable;
  redo.disabled = running || unavailable;
  if (workSubmit.hidden || running) submitConfirm.hidden = true;
  get("course-controls").hidden = Boolean(state.resultsPage);
  get("review-actions").hidden = !state.resultsPage;
  start.disabled = running || unavailable || Boolean(work?.submitted);
  pause.disabled = !running;
  stop.disabled = !running && state.phase !== "paused" && state.phase !== "blocked";
  for (const field of [mode, rate, autoNext, autoSubmit, skipUnsupported]) {
    field.disabled = running || unavailable || Boolean(state.standalone);
  }
  autoFill.disabled = running || unavailable;
  autoSubmit.disabled ||= !autoFill.checked;
  saveDraft.disabled = running || unavailable;
  start.textContent = state.phase === "paused" ? "继续" : state.phase === "blocked" ? "重试" : "开始";
}

async function send(type, options) {
  const requestRevision = ++revision;
  requestActive = true;
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type, options });
    if (requestRevision === revision && state) render(state);
  } catch {
    if (requestRevision === revision) render({ phase: "unavailable", message: "请打开学习通的课程、作业、考试预览或批阅页。刚加载扩展时，请刷新页面。" });
  } finally {
    if (requestRevision === revision) requestActive = false;
  }
}

get("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
start.addEventListener("click", async () => {
  if (rate.value === "site" && !rate.disabled) {
    try {
      if (!await chrome.permissions.request({ permissions: ["cookies"] })) {
        status.textContent = "跟随学习通需要读取其倍速设置。可以改选固定倍速。";
        return;
      }
    } catch (error) { status.textContent = error.message; return; }
  }
  const options = { rate: rate.value === "site" ? "site" : Number(rate.value), autoNext: autoNext.checked, autoSubmit: autoSubmit.checked,
    mode: mode.value, autoFill: autoFill.checked, saveDraft: saveDraft.checked, skipUnsupported: skipUnsupported.checked,
    redoAnswered: redo.checked };
  chrome.storage.local.set({ courseOptions: options }).catch(() => {});
  send("course-start", options);
});
pause.addEventListener("click", () => send("course-pause"));
stop.addEventListener("click", () => send("course-stop"));
workSubmit.addEventListener("click", () => {
  submitConfirm.hidden = false;
  get("confirm-submit").focus();
});
get("cancel-submit").addEventListener("click", () => { submitConfirm.hidden = true; workSubmit.focus(); });
get("confirm-submit").addEventListener("click", () => {
  submitConfirm.hidden = true;
  send("work-submit");
});
function resultsCsv(data) {
  const escapeCell = (value) => {
    const text = String(value ?? "");
    return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [["试卷", "课程", "成绩", "满分", "题号", "题型", "题干", "选项", "参考答案", "我的答案", "得分", "结果"],
    ...data.questions.map((item) => [data.title, data.course, data.score, data.total, item.number, item.type,
      item.prompt, item.options.join(" / "), item.answer, item.response, item.score, item.result])]
    .map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

function saveResults(data, format) {
  const content = format === "json" ? JSON.stringify(data, null, 2) : resultsCsv(data);
  const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `学习通批阅结果.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadResults(format, button) {
  requestActive = true;
  button.disabled = true;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "course-export" });
    if (!result?.data) throw new Error(result?.error || "无法读取批阅结果。");
    saveResults(result.data, format);
    status.textContent = `已导出 ${result.data.questions.length} 道题。`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    requestActive = false;
  }
}

exportButton.addEventListener("click", () => downloadResults("json", exportButton));
exportCsv.addEventListener("click", () => downloadResults("csv", exportCsv));
get("print-review").addEventListener("click", () => send("course-print"));

async function listArchive() {
  const reply = await chrome.runtime.sendMessage({ type: "review-archive-list" });
  if (!reply?.ok) throw new Error(reply?.error || "无法读取本地归档。");
  if (!reply.data.length) return;
  archiveSelect.replaceChildren(...reply.data.map(({ id, title, count, savedAt }) =>
    new Option(`${title} · ${count} 题 · ${new Date(savedAt).toLocaleDateString()}`, id)));
  for (const element of [archiveSelect, get("archive-json"), get("archive-csv")]) element.disabled = false;
}

for (const format of ["json", "csv"]) {
  get(`archive-${format}`).addEventListener("click", async () => {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "review-archive-read", id: archiveSelect.value });
      if (!reply?.ok || !reply.data) throw new Error(reply?.error || "没有找到该份归档。");
      saveResults(reply.data, format);
      get("archive-status").textContent = "已下载归档。";
    } catch (error) { get("archive-status").textContent = error.message; }
  });
}

document.querySelector(".archive").addEventListener("toggle", (event) => {
  if (event.currentTarget.open) listArchive().catch((error) => { get("archive-status").textContent = error.message; });
});

const [{ courseOptions }, [tab]] = await Promise.all([
  chrome.storage.local.get("courseOptions"), chrome.tabs.query({ active: true, currentWindow: true })
]);
if (courseOptions) {
  rate.value = String(courseOptions.rate);
  autoNext.checked = courseOptions.autoNext;
  autoSubmit.checked = courseOptions.autoSubmit !== false;
  autoFill.checked = courseOptions.autoFill !== false;
  mode.value = courseOptions.mode || "all";
  saveDraft.checked = courseOptions.saveDraft !== false;
  skipUnsupported.checked = courseOptions.skipUnsupported === true;
  redo.checked = courseOptions.redoAnswered === true;
}
tabId = tab?.id;
await send("course-status");
setInterval(() => { if (!requestActive) send("course-status"); }, 450);
