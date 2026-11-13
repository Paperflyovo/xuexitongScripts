(() => {
  const knownTypes = new Set(["video", "audio", "pdf", "work"]);

  function frameDocument(frame) {
    try {
      return frame?.contentDocument;
    } catch {
      return null;
    }
  }

  function visible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    const view = element.ownerDocument.defaultView;
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if (style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return false;
    }
    const frame = view.frameElement;
    return !frame || visible(frame);
  }

  function canNavigate(element) {
    return visible(element) && !element.closest('[disabled], [aria-disabled="true"], .disabled, [aria-current="true"]');
  }

  function videoTab() {
    const heading = document.querySelector(".prev_title");
    const title = (heading?.title || heading?.textContent || "").replace(/\s/g, "");
    if (!title.includes("学习目标")) return null;
    return [...document.querySelectorAll("#prev_tab li, .prev_white")].find((tab) =>
      canNavigate(tab) && /^\d*视频$/.test(tab.textContent.replace(/\s/g, "")) &&
      !tab.closest('[aria-selected="true"]'));
  }

  function nextCatalogSection() {
    const tree = document.getElementById("coursetree");
    if (!tree) return null;
    const sections = [...tree.querySelectorAll(".posCatalog_select:not(.firstLayer)")];
    const active = sections.filter((item) => item.classList.contains("posCatalog_active"));
    if (active.length !== 1) return null;
    const next = sections[sections.indexOf(active[0]) + 1];
    const control = next?.querySelector(".posCatalog_name");
    return canNavigate(control) ? control : null;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function waitFor(check, signal, timeout, message) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const value = check();
      if (value) return value;
      await sleep(250, signal);
    }
    if (message) throw new Error(message);
    return null;
  }

  function route() {
    const frame = document.getElementById("iframe");
    const doc = frameDocument(frame);
    const currentSection = document.querySelector("#coursetree .posCatalog_select.posCatalog_active:not(.firstLayer)");
    return { href: location.href, frame, src: frame?.src, doc, docUrl: doc?.URL, currentSection };
  }

  function sameRoute(a, b) {
    return a.href === b.href && a.frame === b.frame && a.src === b.src && a.doc === b.doc && a.docUrl === b.docUrl;
  }

  function frameType(frame) {
    if (!frame) return "";
    let pathname;
    try {
      pathname = new URL(frame.src).pathname;
    } catch {
      return "";
    }
    const module = pathname.match(/\/ananas\/modules\/([^/]+)/)?.[1];
    return module || (pathname.includes("/ananas/dialog/ballchart") ? "ballchart" : "");
  }

  function scan(doc) {
    const tasks = [];
    for (const node of doc.querySelectorAll("iframe, .blockquote-wrap")) {
      if (node.matches("iframe")) {
        if (node.closest(".cmd-autoblockquote")) continue;
        const type = frameType(node);
        if (type) tasks.push({ node, type, block: false });
      } else if (node.querySelector(".cmd-autoblockquote") &&
          node.querySelector(".ans-blockquote-handle, .cmd-autoblockquote iframe")) {
        const type = frameType(node.querySelector(".cmd-autoblockquote iframe"));
        tasks.push({ node, type: type || "work", block: true });
      }
    }
    return tasks;
  }

  async function loadChapter(signal) {
    const deadline = Date.now() + 30000;
    let previous;
    let previousTasks;
    let stableSince = 0;
    let lastLoaded;
    while (Date.now() < deadline) {
      const current = route();
      if (current.doc?.readyState === "complete" && current.docUrl !== "about:blank" && current.doc.body) {
        const tasks = scan(current.doc);
        const sameTasks = previousTasks?.length === tasks.length && tasks.every((task, index) =>
          task.node === previousTasks[index].node && task.type === previousTasks[index].type);
        if (!previous || !sameRoute(current, previous) || !sameTasks) stableSince = Date.now();
        previous = current;
        previousTasks = tasks;
        lastLoaded = current;
        if (Date.now() - stableSince >= 1800) return { current, tasks };
      } else {
        previous = null;
      }
      await sleep(200, signal);
    }
    throw new Error(lastLoaded ? "章节内容持续变化，请等待加载后重试。" : "无法读取章节内容，请确认已打开课程学习页。");
  }

  async function resolveTask(task, signal) {
    if (!task.node.isConnected) throw new Error("当前任务点已变化，请重新识别。");
    if (task.block) {
      const locate = () => task.node.querySelector(".cmd-autoblockquote iframe");
      if (!locate() && !task.node.classList.contains("open")) task.node.querySelector(".ans-blockquote-handle")?.click();
      const frame = await waitFor(locate, signal, 20000, "未找到嵌入任务的内容，请手动展开后重试。");
      return { frame, type: frameType(frame) || task.type };
    }
    return { frame: task.node, type: task.type };
  }

  function jobContainer(frame) {
    return frame?.closest(".ans-job, .ans-attach-ct, .ans-job-finished") || frame?.parentElement;
  }

  function finished(frame) {
    const job = jobContainer(frame);
    return Boolean(job?.classList.contains("ans-job-finished") || frame?.parentElement?.classList.contains("ans-job-finished"));
  }

  function markedJob(frame) {
    const job = jobContainer(frame);
    return Boolean(job?.matches(".ans-job") || job?.querySelector(".ans-job-icon") || frame?.parentElement?.querySelector(".ans-job-icon"));
  }

  function workStatus(doc) {
    const status = doc?.querySelector(".testTit_status");
    if (status?.classList.contains("testTit_status_complete") || /待批阅|已完成|已提交|已交卷/.test(status?.textContent || "")) return true;
    if (doc?.querySelector("#fanyaMarking .questionLi")) return true;
    const result = doc?.querySelector("#ZyBottom, #fanyaMarking") ? doc.body.innerText : "";
    return /本次成绩\s*[:：]?\s*\d+(?:\.\d+)?\s*分/.test(result) && /我的答案\s*[:：]|章节测验\s*已完成/.test(result);
  }

  async function confirmJob(frame, signal) {
    if (!markedJob(frame) || finished(frame)) return;
    await waitFor(() => finished(frame), signal, 18000, "页面尚未确认任务点完成，请检查后重试。");
  }

  globalThis.XtCoursePage = { frameDocument, visible, sleep, waitFor, route, sameRoute, scan, loadChapter,
    resolveTask, finished, workStatus, confirmJob, knownTypes, canNavigate, videoTab, nextCatalogSection };
})();
