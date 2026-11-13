import { batchMessages, complete, parseAnswer, parseBatchAnswers, parseEndpoint, questionMessages,
  validateBatch, validateQuestion } from "./model.js";

const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const pending = new Map();

function learningPage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)(chaoxing\.com|xuexitong\.com)$/.test(url.hostname)) return "";
    if (/^\/(?:mooc-ans\/)?mycourse\/studentstudy\/?$/.test(url.pathname)) return "course";
    if (/^\/(?:mooc-ans\/mooc2\/work\/dowork|exam-ans\/mooc2\/exam\/preview|exam-ans\/exam\/test\/reVersionTestStartNew)\/?$/.test(url.pathname)) return "work";
  } catch {
    return "";
  }
  return "";
}

async function finishPdf(message, sender) {
  if (!Number.isInteger(message.index) || message.index < 0 || message.index > 500 ||
      typeof message.frameUrl !== "string" || typeof message.chapterUrl !== "string") return false;
  const [result] = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN",
    args: [sender.url, message.chapterUrl, message.frameUrl, message.index],
    func: (url, chapterUrl, frameUrl, index) => {
      if (location.href !== url) return false;
      const chapter = document.getElementById("iframe")?.contentDocument;
      if (chapter?.URL !== chapterUrl) return false;
      const frame = chapter.querySelectorAll("iframe")[index];
      if (frame?.src !== frameUrl || !new URL(frameUrl).pathname.startsWith("/ananas/modules/pdf/")) return false;
      const pan = frame.contentDocument?.getElementById("panView");
      const viewport = pan?.contentDocument?.scrollingElement || pan;
      if (!viewport?.clientHeight || viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 5 ||
          typeof frame.contentWindow?.finishJob !== "function") return false;
      frame.contentWindow.finishJob();
      return true;
    } });
  return result?.result === true;
}

async function setPlayerRate(message, sender) {
  if (!Number.isInteger(message.index) || message.index < 0 || typeof message.chapterUrl !== "string" ||
      typeof message.frameUrl !== "string" || !Number.isFinite(message.rate) || message.rate < 0.5 || message.rate > 3) return false;
  const [result] = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN",
    args: [sender.url, message.chapterUrl, message.frameUrl, message.index, message.rate],
    func: (url, chapterUrl, frameUrl, index, rate) => {
      if (location.href !== url) return false;
      const chapter = document.getElementById("iframe")?.contentDocument;
      if (chapter?.URL !== chapterUrl) return false;
      const frame = chapter.querySelectorAll("iframe")[index];
      if (frame?.src !== frameUrl || !new URL(frameUrl).pathname.startsWith("/ananas/modules/video/")) return false;
      const video = frame.contentDocument?.querySelector("video");
      if (!video) return false;
      const player = Object.values(frame.contentWindow?.videojs?.getPlayers?.() || {}).find((item) =>
        item?.el?.()?.querySelector("video") === video);
      if (!player || typeof player.playbackRate !== "function") return false;
      player.playbackRate(rate);
      return true;
    } });
  return result?.result === true;
}

async function fillEditor(message, sender) {
  if (typeof message.editor !== "string" || !/^[\w:.-]{1,100}$/.test(message.editor) ||
      typeof message.text !== "string" || !message.text.trim() || message.text.length > 8000) return false;
  const formulas = message.formulas ?? [];
  if (!Array.isArray(formulas) || formulas.length > 8 || !formulas.every(({ offset, source, tex, png }) =>
    Number.isInteger(offset) && offset >= 0 && typeof source === "string" && source.length > 0 &&
    message.text.slice(offset, offset + source.length) === source && typeof tex === "string" && tex.length <= 3000 &&
    typeof png === "string" && png.length <= 240000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(png))) return false;
  const [result] = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN",
    args: [sender.url, message.editor, message.text, message.target, formulas],
    func: (url, id, text, target, images) => {
      if (location.href !== url) return false;
      let doc = document;
      if (target) {
        const chapter = document.getElementById("iframe")?.contentDocument;
        if (chapter?.URL !== target.chapterUrl || !Number.isInteger(target.index) || target.index < 0) return false;
        const frame = chapter.querySelectorAll("iframe")[target.index];
        if (!frame || !new URL(frame.src).pathname.startsWith("/ananas/modules/work/")) return false;
        doc = frame.contentDocument?.getElementById("frame_content")?.contentDocument;
        if (!doc || doc.URL !== target.workUrl) return false;
      }
      const node = doc.getElementById(id) || doc.getElementsByName(id)[0];
      const answer = node?.closest(".Answer, .sub_que_div_parent, .blankItemDiv, .singleQuesId, .questionLi");
      const save = answer?.querySelector(".savebtndiv .saveButtonClass");
      const editor = answer && doc.defaultView.UE?.getEditor(id);
      if (typeof editor?.setContent !== "function" || !editor.isReady) return false;
      const paragraph = doc.createElement("p");
      let position = 0;
      for (const { offset, source, tex, png } of images) {
        if (offset < position) return false;
        paragraph.append(text.slice(position, offset));
        const image = doc.createElement("img");
        image.className = "ans-edrawmath-moudle";
        image.alt = source;
        image.setAttribute("data", escape(JSON.stringify(`\\[{${tex}}\\]`)));
        image.style.verticalAlign = "middle";
        image.src = png;
        paragraph.append(image);
        position = offset + source.length;
      }
      paragraph.append(text.slice(position));
      editor.setContent(paragraph.outerHTML);
      editor.sync?.();
      const copy = editor.body?.cloneNode(true);
      for (const image of copy?.querySelectorAll("img.ans-edrawmath-moudle[alt]") || []) image.replaceWith(image.alt);
      if ((copy?.textContent ?? editor.getContentTxt?.() ?? "").trim() !== text.trim()) return false;
      editor.fireEvent?.("blur");
      save?.click();
      return true;
    } });
  return result?.result === true;
}

async function archiveReview(message, sender) {
  if (sender.frameId !== 0 || !sender.tab || typeof message.source !== "string" || message.source.length > 4000) {
    throw new Error("无效的批阅归档来源。");
  }
  const source = new URL(message.source);
  const page = new URL(sender.url);
  const review = /\/(?:view|reVersionPaperMarkContentNew)\/?$/.test(page.pathname);
  if (!/(^|\.)(chaoxing\.com|xuexitong\.com)$/.test(page.hostname) || page.protocol !== "https:" ||
      source.protocol !== "https:" || !/(^|\.)(chaoxing\.com|xuexitong\.com)$/.test(source.hostname) ||
      !review && learningPage(sender.url) !== "course") {
    throw new Error("当前页面不能归档批阅结果。");
  }
  const data = message.data;
  const serialized = JSON.stringify(data);
  if (!Array.isArray(data?.questions) || !data.questions.length || !serialized || serialized.length > 150000) {
    throw new Error("批阅结果为空或超出单份归档大小。");
  }
  const identifiers = [...source.searchParams].filter(([key]) =>
    /^(courseId|classId|clazzId|workId|examId|testId|answerId|knowledgeId|chapterId)$/i.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const identity = JSON.stringify([source.origin, source.pathname, identifiers, data.title,
    data.questions.map((question) => question.prompt)]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const id = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ [`review:${id}`]: { id, data, savedAt: Date.now() } });
}

async function readConfig() {
  const [{ modelSettings, savedKey }, { sessionKey }] = await Promise.all([
    chrome.storage.local.get(["modelSettings", "savedKey"]), chrome.storage.session.get("sessionKey")
  ]);
  const origin = modelSettings?.baseUrl && parseEndpoint(modelSettings.baseUrl).origin;
  const currentSessionKey = sessionKey?.origin === origin ? sessionKey?.key : undefined;
  return { ...modelSettings, key: currentSessionKey || savedKey || "", remember: Boolean(savedKey) };
}

async function requireConfig() {
  const config = await readConfig();
  if (!config.key || !config.baseUrl || !config.model) throw new Error("请先在扩展设置中配置模型和 API Key。");
  const { origin } = parseEndpoint(config.baseUrl);
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error("请在设置页授权 API 域名。");
  return config;
}

async function saveConfig(value) {
  const { base, origin } = parseEndpoint(value.baseUrl);
  const model = value.model.trim();
  const previous = await readConfig();
  const sameOrigin = !previous.baseUrl || parseEndpoint(previous.baseUrl).origin === origin;
  const key = value.key.trim() || (sameOrigin ? previous.key : "");
  if (!sameOrigin && !key) throw new Error("API 域名已更改，请重新输入该服务商的 API Key。");
  if (!model || model.length > 200 || key.length > 4096 || /[\r\n]/.test(key)) throw new Error("请检查模型名和 API Key。");
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error("未授权该 API 域名。");
  await chrome.storage.session.set({ sessionKey: value.remember ? null : { origin, key } });
  await chrome.storage.local.set({ modelSettings: { baseUrl: base, model }, savedKey: value.remember ? key : "" });
}

async function captureCrop(crop, tab) {
  const { x, y, width, height, viewportWidth, viewportHeight } = crop;
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) ||
      x < 0 || y < 0 || width < 2 || height < 2 || x + width > viewportWidth + 1 || y + height > viewportHeight + 1) {
    throw new Error("题图没有完整显示在窗口内，请调整页面后重试。");
  }
  const activeInWindow = async () => (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id === tab.id;
  if (!await activeInWindow()) throw new Error("请切回课程标签页后重试含图题。");
  let capture;
  try {
    capture = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    throw new Error("无法截取题图，请在课程页点击扩展图标后重试。");
  }
  if (!await activeInWindow()) throw new Error("截图期间切换了标签页，请重试。");
  const bitmap = await createImageBitmap(await (await fetch(capture)).blob());
  try {
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;
    if (Math.abs(scaleX / scaleY - 1) > 0.05) throw new Error("截图比例与页面不一致，请调整浏览器缩放后重试。");
    const ratio = Math.min(1, 1600 / Math.max(width * scaleX, height * scaleY));
    const canvas = new OffscreenCanvas(Math.ceil(width * scaleX * ratio), Math.ceil(height * scaleY * ratio));
    canvas.getContext("2d").drawImage(bitmap, x * scaleX, y * scaleY, width * scaleX, height * scaleY,
      0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } finally {
    bitmap.close();
  }
}

async function solve(message, sender) {
  const batch = message.type === "solve-batch";
  const questions = batch ? validateBatch(message.questions) : null;
  const question = batch ? null : validateQuestion(message.question);
  const requestKey = `${sender.tab.id}:${message.id}`;
  if (pending.has(requestKey)) throw new Error("这道题已在请求中。");
  const controller = new AbortController();
  pending.set(requestKey, controller);
  const timer = setTimeout(() => controller.abort("timeout"), 25000);
  try {
    const config = await requireConfig();
    if (batch) {
      const content = await complete(config, batchMessages(questions), controller.signal);
      return parseBatchAnswers(content, questions);
    }
    const image = message.image;
    if (image && (typeof image !== "string" || image.length > 4000000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image))) {
      throw new Error("题图格式或大小超出限制。");
    }
    const imageUrl = image || (message.crop ? await captureCrop(message.crop, sender.tab) : undefined);
    controller.signal.throwIfAborted();
    const content = await complete(config, questionMessages(question, imageUrl), controller.signal);
    return parseAnswer(content, question);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(controller.signal.reason === "timeout" ? "模型请求超时，请重试。" : "请求已取消。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    pending.delete(requestKey);
  }
}

async function dispatch(message, sender) {
  await storageReady;
  if (sender.url === chrome.runtime.getURL("popup.html") && message.type === "review-archive-list") {
    const storage = await chrome.storage.local.get(null);
    return Object.entries(storage).filter(([key]) => key.startsWith("review:"))
      .map(([, { id, data, savedAt }]) => ({ id, title: data.title, savedAt, count: data.questions.length }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  if (sender.url === chrome.runtime.getURL("popup.html") && message.type === "review-archive-read") {
    if (typeof message.id !== "string" || !/^[a-f0-9]{64}$/.test(message.id)) throw new Error("无效的归档编号。");
    const key = `review:${message.id}`;
    return (await chrome.storage.local.get(key))[key]?.data || null;
  }
  if (sender.id === chrome.runtime.id && message.type === "archive-review") return archiveReview(message, sender);
  if (sender.url === chrome.runtime.getURL("options.html")) {
    switch (message.type) {
      case "get-config": {
        const { key, ...config } = await readConfig();
        return { ...config, hasKey: Boolean(key) };
      }
      case "save-config":
        return saveConfig(message.value);
      case "clear-config-key":
        await Promise.all([chrome.storage.local.remove("savedKey"), chrome.storage.session.remove("sessionKey")]);
        return;
      case "test-config": {
        const config = await requireConfig();
        await complete(config, [{ role: "user", content: "Reply with OK." }], AbortSignal.timeout(15000))
          .catch((error) => {
            if (error.name === "TimeoutError") throw new Error("连接测试超时。");
            throw error;
          });
        return;
      }
    }
  }
  const page = learningPage(sender.url);
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || !page) {
    throw new Error("无效的扩展请求来源。");
  }
  if (message.type === "finish-pdf" && page === "course") return finishPdf(message, sender);
  if (message.type === "player-rate" && page === "course") return setPlayerRate(message, sender);
  if (message.type === "site-video-rate" && page === "course") {
    if (!await chrome.permissions.contains({ permissions: ["cookies"] })) return null;
    const stores = await chrome.cookies.getAllCookieStores();
    const storeId = stores.find((store) => store.tabIds.includes(sender.tab.id))?.id;
    const url = new URL(sender.url);
    const cookie = await chrome.cookies.get({ url: url.href, name: "doubleSpeedValue", storeId }) ||
      await chrome.cookies.get({ url: url.origin + "/ananas/modules/video/index.html", name: "doubleSpeedValue", storeId });
    const rate = Number(cookie?.value);
    return Number.isFinite(rate) && rate >= 0.5 && rate <= 3 ? rate : null;
  }
  if (message.type === "fill-editor" && (page === "work" && !message.target || page === "course" && message.target)) {
    return fillEditor(message, sender);
  }
  if (message.type === "chapter-handoff") {
    const key = `chapterHandoff:${sender.tab.id}`;
    if (message.action === "set") {
      const token = crypto.randomUUID();
      await chrome.storage.session.set({ [key]: { token, options: message.options, expires: Date.now() + 15000 } });
      return token;
    }
    const { [key]: handoff } = await chrome.storage.session.get(key);
    if (message.action === "take") {
      await chrome.storage.session.remove(key);
      return handoff?.expires > Date.now() ? handoff.options : null;
    }
    if (message.action === "clear" && (!message.token || handoff?.token === message.token)) {
      return chrome.storage.session.remove(key);
    }
    return;
  }
  if (typeof message.id !== "string" || message.id.length > 80) throw new Error("无效的请求编号。");
  if (message.type === "solve" || message.type === "solve-batch") return solve(message, sender);
  if (message.type === "cancel-solve") return pending.get(`${sender.tab.id}:${message.id}`)?.abort("cancelled");
  throw new Error("未知请求。");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!["get-config", "save-config", "clear-config-key", "test-config", "solve", "solve-batch", "cancel-solve", "chapter-handoff", "finish-pdf", "fill-editor", "site-video-rate", "player-rate", "archive-review", "review-archive-list", "review-archive-read"].includes(message?.type)) return false;
  dispatch(message, sender).then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error?.message || "请求失败。" })
  );
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  chrome.storage.session.remove(`chapterHandoff:${id}`).catch(() => {});
  for (const [key, controller] of pending) {
    if (key.startsWith(`${id}:`)) controller.abort("cancelled");
  }
});
