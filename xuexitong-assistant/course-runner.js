(() => {
  const page = globalThis.XtCoursePage;
  const questions = globalThis.XtQuestions;
  const labels = { video: "视频", audio: "音频", pdf: "PDF", work: "章节测验" };
  const rates = [1, 1.25, 1.5, 1.75, 2];
  const path = location.pathname;
  const resultsPage = /\/(?:view|reVersionPaperMarkContentNew)\/?$/.test(path);
  const standalone = !/\/mycourse\/studentstudy\/?$/.test(path);
  let currentRun;
  let receivedCommand = false;
  let state = { phase: "idle", message: resultsPage ? "可导出当前页面的题目与批阅结果。" : "已打开学习通页面，点击开始。" };

  function report(phase, message) {
    state = { phase, message };
  }

  function optionsFrom(value) {
    return { rate: value?.rate === "site" || rates.includes(value?.rate) ? value.rate : 1,
      mode: ["media", "work", "review"].includes(value?.mode) ? value.mode : "all",
      autoNext: value?.autoNext === true, autoSubmit: value?.autoSubmit !== false, autoFill: value?.autoFill !== false,
      saveDraft: value?.saveDraft !== false, skipUnsupported: value?.skipUnsupported === true,
      redoAnswered: standalone && value?.redoAnswered === true };
  }

  function resumeKnownPause(doc) {
    const overlay = doc.querySelector(".ans-videoannotation");
    const resume = overlay?.textContent.includes("批注") ? overlay.querySelector(".continueLearn") : null;
    const button = [resume, doc.querySelector(".sp_video_pic a.jb_btn.jb_btn_92")].find(page.visible);
    if (!button) return false;
    button.click();
    return true;
  }

  function scope(run, chapter) {
    const { signal } = run.controller;
    return {
      signal,
      check() {
        signal.throwIfAborted();
        if (!page.sameRoute(chapter, page.route())) throw new Error("章节已变化，请重新开始以识别当前章节。");
      },
      report(message) { if (currentRun === run) report("running", message); },
      onPause(action) { run.onPause = action; },
      skip(type) { run.skipped.add(type); }
    };
  }

  async function mediaTask(frame, type, options, context) {
    const findPlayer = () => page.frameDocument(frame)?.querySelector(type);
    let rate = options.rate;
    if (type === "video" && rate === "site") {
      const reply = await chrome.runtime.sendMessage({ type: "site-video-rate" });
      if (!reply?.ok) throw new Error(reply?.error || "无法读取学习通倍速。");
      rate = reply.data;
    }
    for (let replacements = 0; replacements < 4; replacements += 1) {
      const media = await page.waitFor(findPlayer, context.signal, 30000, `未找到${labels[type]}播放器。`);
      if (await playMedia(frame, media, type, rate, options.mode === "review" && replacements === 0, options, context)) return;
      context.report("播放器重新加载，正在恢复播放…");
    }
    throw new Error("播放器反复重新加载，请检查页面后重试。");
  }

  async function playMedia(frame, media, type, rate, rewind, options, context) {
    context.check();
    const originalMute = media.muted;
    const originalRate = media.playbackRate;
    const originalDefaultRate = media.defaultPlaybackRate;
    const pause = () => { if (!media.paused && !media.ended) media.pause(); };
    context.signal.addEventListener("abort", pause, { once: true });
    try {
      if (type === "video" && rewind && page.finished(frame)) {
        media.currentTime = 0;
      }
      media.muted = true;
      if (type === "video" && rate) {
        media.defaultPlaybackRate = rate;
        media.playbackRate = rate;
      }
      let pausedSince = 0;
      let lastRetry = 0;
      let playPending;
      let progressAt = Date.now();
      let previousTime = media.currentTime;
      let lastRate = rate;
      let triedPlayerApi = false;
      while (true) {
        context.check();
        if (!media.isConnected || media.ownerDocument !== page.frameDocument(frame) ||
            media.ownerDocument.querySelector(type) !== media) return false;
        if (media.error) {
          throw new Error(`${labels[type]}播放器已失效，请检查页面后重试。`);
        }
        if (type === "video" && rate && media.playbackRate !== lastRate) {
          if (!triedPlayerApi && media.playbackRate !== rate) {
            triedPlayerApi = true;
            const chapter = frame.ownerDocument;
            const index = [...chapter.querySelectorAll("iframe")].indexOf(frame);
            await chrome.runtime.sendMessage({ type: "player-rate", index, chapterUrl: chapter.URL, frameUrl: frame.src, rate });
            context.check();
          }
          lastRate = media.playbackRate;
          context.report(`视频正在以 ${lastRate}× 播放…`);
        }
        if ((options.mode !== "review" && page.finished(frame)) || media.ended) break;
        if (type === "video" && questions.videoQuiz(media.ownerDocument)) {
          await questions.handleVideoQuiz(media.ownerDocument, context, options);
          pausedSince = 0;
          progressAt = Date.now();
          context.report("继续播放视频…");
          continue;
        }
        const now = Date.now();
        if (media.currentTime !== previousTime) {
          previousTime = media.currentTime;
          progressAt = now;
        }
        if (media.paused) {
          pausedSince ||= now;
          if (now - pausedSince > 12000) throw new Error("播放器一直暂停，请在页面处理弹窗或手动播放后重试。");
          if (!playPending && now - lastRetry >= 2000) {
            lastRetry = now;
            if (type === "video" && resumeKnownPause(media.ownerDocument)) {
              await page.sleep(400, context.signal);
              continue;
            }
            playPending = media.play().then(() => null, (error) => error);
            const attempt = playPending;
            attempt.finally(() => {
              if (context.signal.aborted) pause();
              if (playPending === attempt) playPending = null;
            });
            const result = await Promise.race([attempt, page.sleep(3000, context.signal)]);
            if (result?.name === "NotAllowedError") throw new Error("Chrome 阻止了自动播放，请先在页面点一次播放。");
          }
        } else {
          pausedSince = 0;
        }
        if (now - progressAt > 60000) throw new Error("播放器长时间没有进展，请检查网络或页面提示。");
        await page.sleep(400, context.signal);
      }
      context.report("播放结束，正在确认页面任务状态…");
      await page.confirmJob(frame, context.signal);
      return true;
    } finally {
      pause();
      media.muted = originalMute;
      if (type === "video" && rate) {
        media.defaultPlaybackRate = originalDefaultRate;
        media.playbackRate = originalRate;
      }
      context.signal.removeEventListener("abort", pause);
    }
  }

  async function pdfTask(frame, context) {
    const findViewport = () => {
      const doc = page.frameDocument(frame);
      const pan = doc?.getElementById("panView");
      const pdf = page.frameDocument(pan);
      const pages = [...((pdf || pan)?.querySelectorAll(".fileBox li") || [])];
      if (!pages.length || !pages.every((item) => item.querySelector("img[src]"))) return null;
      return { viewport: pdf ? pdf.scrollingElement : pan, count: pages.length };
    };
    let { viewport } = await page.waitFor(findViewport, context.signal, 120000, "PDF 未加载或需要手动打开。");
    context.check();
    if (document.visibilityState === "visible") frame.scrollIntoView({ block: "center", behavior: "instant" });
    let stalls = 0;
    let lastEnd;
    while (true) {
      context.check();
      const next = findViewport();
      if (!next || next.viewport !== viewport || !viewport.isConnected) {
        const loaded = await page.waitFor(findViewport, context.signal, 30000, "PDF 重新加载后仍未就绪。");
        viewport = loaded.viewport;
        lastEnd = undefined;
        stalls = 0;
        continue;
      }
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5) {
        const end = `${next.count}:${viewport.scrollHeight}`;
        if (lastEnd === end) break;
        lastEnd = end;
        await page.sleep(900, context.signal);
        continue;
      }
      lastEnd = undefined;
      const before = viewport.scrollTop;
      viewport.scrollBy({ top: Math.max(100, viewport.clientHeight * 0.85), behavior: "instant" });
      await page.sleep(900, context.signal);
      stalls = viewport.scrollTop <= before ? stalls + 1 : 0;
      if (stalls >= 4) throw new Error("PDF 未能继续滚动，请检查文档后重试。");
    }
    context.check();
    if (!page.finished(frame)) {
      const doc = frame.ownerDocument;
      const index = [...doc.querySelectorAll("iframe")].indexOf(frame);
      await chrome.runtime.sendMessage({ type: "finish-pdf", index, chapterUrl: doc.URL, frameUrl: frame.src }).catch(() => {});
      context.check();
    }
    await page.confirmJob(frame, context.signal);
  }

  async function execute(task, options, context) {
    context.check();
    const { frame, type } = await page.resolveTask(task, context.signal);
    context.check();
    if (options.mode === "work" && type !== "work" || options.mode === "review" && type !== "video") return;
    if (!page.knownTypes.has(type)) {
      if (page.finished(frame)) return;
      if (options.skipUnsupported) {
        context.skip(type);
        return;
      }
      throw new Error(`检测到暂不支持的任务点（${type}），请手动完成或开启跳过。`);
    }
    if (options.mode === "media" && type === "work") return;
    if (page.finished(frame) && options.mode !== "review") return;
    if (type === "video" || type === "audio") return mediaTask(frame, type, options, context);
    if (type === "pdf") return pdfTask(frame, context);
    await questions.handleWork(frame, context, options);
  }

  async function navigate(run, chapter, context, control, ready) {
    const token = await sendHandoff("set", run.options);
    try {
      let proceeded = false;
      context.check();
      if (!page.canNavigate(control)) throw new Error("页面导航控件已变化，请重试。");
      control.click();
      return await page.waitFor(() => {
        if (!page.sameRoute(chapter, page.route()) || ready?.()) return true;
        if (page.visible(document.querySelector(".jobFinishTip"))) {
          const proceed = document.querySelector(".jobFinishTip .nextChapter, .popBottom .nextChapter");
          if (!run.options.skipUnsupported || !page.canNavigate(proceed)) throw new Error("学习通提示仍有未完成任务，请处理后重试。");
          if (!proceeded) {
            proceeded = true;
            proceed.click();
          }
        }
      }, context.signal, 15000);
    } finally {
      await sendHandoff("clear", undefined, token);
    }
  }

  async function nextChapter(run, chapter, context) {
    const summary = run.skipped.size ? ` 已跳过：${[...run.skipped].join("、")}。` : "";
    const button = document.querySelector("#prevNextFocusNext");
    const next = page.canNavigate(button) ? button : null;
    if (!next && !page.nextCatalogSection()) {
      report("complete", `本节队列已处理，页面没有可用的「下一节」。${summary}`);
      return false;
    }
    if (!run.options.autoNext || run.options.mode === "work") {
      const message = run.options.mode === "work" ? "本节测验任务已处理。" : "本节队列已处理。自动下一节已关闭。";
      report("complete", message + summary);
      return false;
    }
    context.report(`正在切到下一节…${summary}`);
    if (next && await navigate(run, chapter, context, next)) return true;
    const catalog = page.nextCatalogSection();
    if (catalog) {
      context.report("正在通过课程目录进入下一节…");
      if (await navigate(run, chapter, context, catalog)) return true;
    }
    throw new Error("页面没有切换到下一节，请手动检查。");
  }

  async function runStandalone(run) {
    report("running", "正在识别作业或考试题目…");
    let context = scope(run, page.route());
    if (path.includes("reVersionTestStartNew") && !document.querySelector(".questionLi, #ZyBottom .singleQuesId")) {
      const preview = document.querySelector(".top-subNav .completeBtn");
      if (!page.visible(preview) || !preview.textContent.includes("整卷预览")) {
        throw new Error("此考试未提供整卷预览，请从试卷页面打开后重试。");
      }
      const token = await sendHandoff("set", run.options);
      context.check();
      preview.click();
      context.report("正在打开整卷预览…");
      try {
        await page.waitFor(() => document.querySelector(".questionLi, #ZyBottom .singleQuesId"), context.signal, 15000,
          "请在打开的整卷预览页点击开始。");
        context = scope(run, page.route());
      } finally {
        await sendHandoff("clear", undefined, token);
      }
    }
    await questions.handleWork(null, context, { ...run.options, autoSubmit: false });
    context.check();
    report("complete", run.options.autoFill ? "题目已处理。请在页面检查、暂存或提交。" : "模型建议已显示，请在页面填写并提交。");
  }

  async function runCourse(run) {
    while (!run.controller.signal.aborted) {
      report("running", "正在识别本节任务…");
      const { current, tasks } = await page.loadChapter(run.controller.signal);
      const context = scope(run, current);
      const videoTab = !tasks.length && run.options.mode !== "work" ? page.videoTab() : null;
      if (videoTab) {
        const section = current.currentSection || current.href;
        if (run.videoTabs.has(section)) throw new Error("视频页签已尝试切换，请检查当前章节。");
        run.videoTabs.add(section);
        context.report("正在从学习目标切到视频页签…");
        if (!await navigate(run, current, context, videoTab, () => page.scan(current.doc).some(({ type }) => type === "video"))) {
          throw new Error("视频页签未加载，请在页面检查。");
        }
        continue;
      }
      const routeWatch = setInterval(() => {
        if (!page.sameRoute(current, page.route())) {
          run.controller.abort(new Error("章节已变化，请重新开始。"));
        }
      }, 300);
      try {
        if (!tasks.length) {
          context.report("本节没有识别到嵌入任务，正在检查章节导航…");
          await page.sleep(5000, context.signal);
        }
        const processed = new Set();
        for (let queue = page.scan(current.doc); queue.length; queue = page.scan(current.doc)) {
          const task = queue.find(({ node }) => !processed.has(node));
          if (!task) break;
          const index = queue.indexOf(task);
          context.report(`任务 ${index + 1}/${queue.length} · ${labels[task.type] || task.type}`);
          await execute(task, run.options, context);
          processed.add(task.node);
        }
        context.check();
      } finally {
        clearInterval(routeWatch);
      }
      if (!await nextChapter(run, current, context)) return;
    }
  }

  async function sendHandoff(action, options, token) {
    const response = await chrome.runtime.sendMessage({ type: "chapter-handoff", action, options, token });
    if (!response?.ok) throw new Error(response?.error || "无法保存切章状态。");
    return response.data;
  }

  async function submitStandalone(run) {
    report("running", "正在核对作答并交卷…");
    await questions.submitStandalone(scope(run, page.route()));
    report("complete", "学习通已确认交卷。");
  }

  function start(options, action = standalone ? runStandalone : runCourse) {
    if (currentRun && !currentRun.controller.signal.aborted) return;
    const run = { options: optionsFrom(options), controller: new AbortController(), skipped: new Set(), videoTabs: new Set() };
    currentRun = run;
    action(run).catch((error) => {
      if (currentRun === run && !["paused", "idle"].includes(state.phase)) report("blocked", error?.message || "课程任务已中断。");
    }).finally(() => { if (currentRun === run) currentRun = null; });
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
    switch (message.type) {
      case "course-status": break;
      case "work-locate":
        if (!standalone || resultsPage || !Number.isInteger(message.options?.number)) return false;
        try { questions.goToQuestion(message.options.number); }
        catch (error) { respond({ ...state, message: error.message, standalone }); return false; }
        break;
      case "work-submit":
        if (!standalone || resultsPage) return false;
        start({}, submitStandalone);
        break;
      case "course-export":
        try { respond({ data: globalThis.XtReview.exportResults(document) }); }
        catch (error) { respond({ error: error.message }); }
        return false;
      case "course-print":
        if (!resultsPage) return false;
        respond({ ...state, resultsPage, standalone });
        setTimeout(() => window.print(), 0);
        return false;
      case "course-start":
        receivedCommand = true;
        if (!resultsPage && !(standalone && page.workStatus(document))) start(message.options);
        break;
      case "course-pause":
      case "course-stop": {
        const paused = message.type === "course-pause";
        receivedCommand = true;
        let draft = false;
        if (paused && state.phase === "running") {
          try { draft = Boolean(currentRun?.onPause?.()); } catch { /* The page changed before saving. */ }
        }
        currentRun?.controller.abort(new Error("课程已暂停。"));
        report(paused ? "paused" : "idle", paused ?
          (draft ? "已暂停，已请求暂存当前答案。" : "已暂停，继续时保留页面上的答案。") : "已停止。");
        sendHandoff("clear").catch(() => {});
        break;
      }
      default: return false;
    }
    respond({ ...state, resultsPage, standalone, work: standalone && !resultsPage ? questions.standalonePanel() : undefined });
    return false;
  });

  if (!standalone || path.includes("/exam/preview")) sendHandoff("take").then((options) => {
    if (options && !receivedCommand) start(options);
  }).catch(() => {});
})();
