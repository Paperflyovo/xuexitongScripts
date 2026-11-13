(() => {
  const { visibleText, decodeText } = globalThis.XtCourseFont;
  const reviewRoute = /\/(?:view|reVersionPaperMarkContentNew)\/?$/.test(location.pathname);
  const workRoute = /\/(?:dowork|preview|reVersionTestStartNew)\/?$/.test(location.pathname);
  const questionText = ".questionLi, .singleQuesId, #fanyaMarking";

  if (reviewRoute || workRoute) {
    const style = document.createElement("style");
    style.textContent = `${questionText} { user-select: text !important; }
      :is(${questionText}) * { user-select: text !important; }
      @media print { @page { margin: 20mm; }
        .fanyaMarking_right, #topicNumberScroll { display: none !important; }
        .fanyaMarking_left { width: 100% !important; } .subNav { position: static !important; } }`;
    document.head.append(style);
    document.addEventListener("copy", (event) => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !event.clipboardData) return;
      const range = selection.getRangeAt(0);
      const start = range.startContainer.parentElement;
      const end = range.endContainer.parentElement;
      if (!start?.closest(questionText) || !end?.closest(questionText) || start.closest("[contenteditable=true], textarea, input")) return;
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      const pieces = [];
      let node = walker.currentNode;
      do {
        if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        pieces.push(decodeText(node, node.data.slice(from, to)).text);
      } while ((node = walker.nextNode()));
      if (!pieces.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.clipboardData.setData("text/plain", pieces.join("\n"));
    }, true);
  }

  function text(doc, selector) {
    return visibleText(doc.querySelector(selector), (node) => (node?.innerText || node?.textContent || "").trim()).text;
  }

  function published(doc) {
    return Boolean(doc?.querySelector(".rightAnswerContent, .correctAnswerBx, .correctAnswer, .marking_dui, .marking_cuo, .mark_score i"));
  }

  function exportResults(doc) {
    const selector = "#fanyaMarking .questionLi, #ZyBottom .singleQuesId, .questionLi";
    const roots = [...doc.querySelectorAll(selector)].filter((root) => !root.parentElement.closest(selector));
    if (!roots.length) throw new Error("当前页面未找到可导出的批阅题目。");
    const questions = roots.map((root, index) => {
      const heading = text(root, ".mark_name, .Zy_TItle, .qtContent, h3");
      return { number: index + 1, prompt: heading, type: heading.match(/【([^】]+)】|\[([^\]]+题)\]/)?.slice(1).find(Boolean) || "",
        options: [...root.querySelectorAll(".qtDetail li, .Zy_ulTop li")].map((option) => visibleText(option, (node) => node.textContent.trim()).text),
        answer: text(root, ".rightAnswerContent, .correctAnswerBx, .correctAnswer"),
        response: text(root, ".stuAnswerContent, .myAllAnswerBx, .myAnswer"), score: text(root, ".mark_score i, .answerScore"),
        result: root.querySelector(".marking_dui") ? "正确" : root.querySelector(".marking_cuo") ? "错误" : "" };
    });
    return { title: text(doc, ".mark_title, .ceyan_name") || doc.title, course: text(doc, ".courseName, .course-name, .course_title"),
      score: text(doc, ".resultNum .custom-style, .Finalresult span i, .achievement i"),
      total: text(doc, ".infoHead span:nth-child(2), .ceyan_name p span:nth-child(2)"), questions };
  }

  async function archive(doc) {
    if (!published(doc)) return;
    const data = exportResults(doc);
    const reply = await chrome.runtime.sendMessage({ type: "archive-review", data, source: doc.URL });
    if (!reply?.ok) throw new Error(reply?.error || "批阅归档未保存。");
  }

  async function archiveWhenReady(getDoc, signal, timeout) {
    let previous = "";
    let stableSince = 0;
    const doc = await globalThis.XtCoursePage.waitFor(() => {
      const currentDoc = getDoc();
      if (!published(currentDoc) || !currentDoc.querySelector(".questionLi, #ZyBottom .singleQuesId")) return false;
      const current = JSON.stringify(exportResults(currentDoc));
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= 750 && currentDoc;
    }, signal, timeout);
    if (doc) await archive(doc);
  }

  if (reviewRoute) {
    const signal = new AbortController().signal;
    archiveWhenReady(() => document, signal, 30000).catch((error) => console.warn("批阅归档", error.message));
  }

  globalThis.XtReview = { exportResults, archiveWhenReady };
})();
