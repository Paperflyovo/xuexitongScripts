(() => {
  const { frameDocument, visible, sleep, waitFor, workStatus, finished } = globalThis.XtCoursePage;
  const { visibleText } = globalThis.XtCourseFont;
  const workTypes = { 0: "single", 1: "multiple", 2: "blank", 3: "judgment", 4: "written", 5: "written",
    6: "written", 7: "written", 8: "written", 9: "written", 10: "written", 11: "match", 14: "blank", 15: "written" };
  const textTypes = new Set(["blank", "written"]);
  const objectiveTypes = new Set(["single", "multiple", "judgment"]);
  const workRoots = "#ZyBottom .singleQuesId, .questionLi";
  const pendingSubmissions = new WeakMap();

  function readText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function questionType(text) {
    if (text.includes("多选")) return "multiple";
    if (text.includes("单选")) return "single";
    if (text.includes("判断")) return "judgment";
    if (text.includes("填空")) return "blank";
    if (text.includes("连线") || text.includes("匹配题")) return "match";
    if (/简答|名词解释|论述|计算|分录|资料题|阅读理解/.test(text)) return "written";
    return undefined;
  }

  function mathSources(element) {
    return [...(element?.querySelectorAll('math, script[type^="math/tex"], [data-latex]') || [])]
      .filter((node) => !node.parentElement?.closest("math, [data-latex]"))
      .map((node) => node.getAttribute("data-latex") || node.getAttribute("alttext") ||
        node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.textContent)
      .map((text) => text?.trim()).filter(Boolean);
  }

  function readQuestionText(element) {
    const plain = visibleText(element, readText);
    const formulas = mathSources(element);
    if (formulas.length) plain.text += `\n公式：${formulas.join("；")}`;
    return plain;
  }

  function tableText(table) {
    return [...table.rows].map((row) => [...row.cells].map((cell) => visibleText(cell, readText).text).join(" | ")).join("\n");
  }

  function typeFromField(root) {
    const questionId = root.querySelector('input[name^="questionId"]')?.value;
    const typeField = root.querySelector('input[id^="answertype"]') || (questionId &&
      [...root.querySelectorAll('input[name^="type"]')].find((input) => input.name === `type${questionId}`)) ||
      root.querySelector('input[name^="type"]');
    return workTypes[typeField?.value];
  }

  function optionSelector(type, video) {
    if (video) return ".ans-videoquiz-opt";
    return type === "multiple" ? ".before-after-checkbox, .answerBg" : ".before-after, .answerBg";
  }

  const workHeading = ".Zy_TItle, .mark_name, .qtContent, .sub_que_div_title, .sub_que_div_stem, h3";

  function question(root, video) {
    const heading = root.querySelector(video ? ".tkTopic_title" : workHeading);
    const promptElement = heading || (video ? root.querySelector(".tkTopic") || root : null);
    const prompt = readQuestionText(promptElement);
    const type = typeFromField(root) || questionType(prompt.text) || questionType(readText(heading));
    if (!type) throw new Error("检测到暂不支持的题型，请在页面上手动处理。");
    const options = objectiveTypes.has(type) ? [...root.querySelectorAll(optionSelector(type, video))] : [];
    let blanks = [];
    if (textTypes.has(type)) {
      blanks = [...root.querySelectorAll(".blankItemDiv")];
      if (!blanks.length) blanks = [...root.querySelectorAll(".Answer, .sub_que_div_parent")]
        .filter((field) => !field.querySelector(".Answer, .sub_que_div_parent") && editableBlank(field));
      if (!blanks.length && editableBlank(root)) blanks = [root];
    }
    const matches = type === "match" ? matchFields(root) : [];
    if (textTypes.has(type) && !blanks.length) throw new Error("未找到此题的可编辑输入框。");
    const optionTexts = options.map(readQuestionText);
    const group = video ? null : root.parentElement?.closest(".stem_answer, .questionLi, .singleQuesId");
    const material = video ? null : (group || root).querySelector(".stem_material, .material, .material-content, .question-material");
    const tables = [...(heading?.querySelectorAll("table") || []), ...(material?.querySelectorAll("table") || [])];
    const materialText = readQuestionText(material);
    const contextText = [materialText.text, ...tables.map(tableText)].filter(Boolean).join("\n\n");
    if (contextText) prompt.text += `\n\n题目材料：\n${contextText}`;
    const imageRegions = video ? [root.querySelector(".tkTopic") || root, ...options] : [heading, material, ...options, ...matches.map(({ row }) => row)];
    const images = [...new Set(imageRegions.flatMap((element) => [...(element?.querySelectorAll("img") || [])]))]
      .filter((image) => visible(image) && (image.currentSrc || image.getAttribute("src")));
    const unresolvedFont = prompt.unresolved || materialText.unresolved || optionTexts.some((option) => option.unresolved);
    const requiresImage = images.length > 0 || unresolvedFont;
    const data = { type, prompt: prompt.unresolved ? "请以截图中的题干为准。" : prompt.text || (requiresImage ? "请阅读题图。" : ""),
      options: optionTexts.map((option) => option.unresolved ? "请以截图中的选项为准。" : option.text), blanks: blanks.length,
      ...(type === "match" && { rows: matches.map(({ text, choices }) => ({ text, options: choices.map(readText) })) }) };
    const identity = JSON.stringify([readText(promptElement), options.map(readText), data, images.map((image) => image.currentSrc || image.src)]);
    return { data, options, blanks, matches, images, requiresImage, unresolvedFont, identity,
      imageRoot: material && !root.contains(material) ? group : root };
  }

  function matchFields(root) {
    const selects = [...root.querySelectorAll("select")].filter((select) => !select.disabled && !select.multiple);
    if (selects.length) return selects.map((select, index) => {
      const row = select.closest("li, tr, .lineItem, .match-row") || select.parentElement;
      const label = select.labels?.[0] || row.querySelector(".line-title, .match-label, .lineItemText, .leftText");
      const copy = (label || row).cloneNode(true);
      copy.querySelectorAll("select, .chosen-container").forEach((element) => element.remove());
      return { select, row, choices: [...select.options].filter((option) => option.value && !option.disabled),
        text: readText(copy) || `第 ${index + 1} 项` };
    });
    return [...root.querySelectorAll(".beautiSelect .thirdUlList li[index]")].map((row, index) => ({
      row, text: readText(row.querySelector(".line-title, .match-label, .leftText")) || `第 ${index + 1} 项`,
      choices: [...row.querySelectorAll("[value]")].filter((choice) => choice.getAttribute("value") && !choice.disabled)
    }));
  }

  function selectionControl(row) {
    return row.querySelector('input[type="checkbox"], input[type="radio"], [role="radio"], [role="checkbox"], [name^="answer"], .num_option, .num_option_dx') || row;
  }

  function selected(row) {
    const control = selectionControl(row);
    if (control.matches('input[type="checkbox"], input[type="radio"]')) return control.checked;
    return control.getAttribute("aria-checked") === "true" ||
      [control, row].some((element) => element.matches(".check_answer, .check_answer_dx"));
  }

  function editorId(blank) {
    if (!blank.querySelector(".savebtndiv .saveButtonClass, textarea[id^='ueditor'], textarea[name^='answer'] + iframe, .edui-editor iframe")) return "";
    const textarea = blank.querySelector("textarea[id], textarea[name]");
    return textarea?.id || textarea?.name || "";
  }

  function editableBlank(blank) {
    const fields = [...blank.querySelectorAll("textarea, input:not([type=hidden]), [contenteditable=true], iframe")];
    if (editorId(blank)) fields.sort((left, right) => Number(right.matches("iframe")) - Number(left.matches("iframe")));
    for (const field of fields) {
      if (!visible(field) || field.disabled || field.readOnly) continue;
      if (field.matches("iframe")) {
        const doc = frameDocument(field);
        if (doc?.body?.isContentEditable || doc?.designMode === "on") return doc.body;
        continue;
      }
      return field;
    }
    return null;
  }

  function fieldText(field) {
    if (field?.matches("textarea, input")) return field.value.trim();
    if (!field) return "";
    const copy = field.cloneNode(true);
    for (const formula of copy.querySelectorAll("math")) {
      const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (tex) formula.replaceWith(`\\(${tex}\\)`);
    }
    for (const image of copy.querySelectorAll("img.ans-edrawmath-moudle[alt]")) image.replaceWith(image.alt);
    return copy.textContent.trim();
  }

  const formulaPattern = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$\$([^$]+)\$\$/gs;

  async function formulaImages(text, context) {
    const formulas = [];
    for (const match of text.matchAll(formulaPattern)) {
      context.check();
      const tex = match[1] || match[2] || match[3];
      let svg;
      try { svg = globalThis.XtFormulaSvg(tex); } catch { continue; }
      try {
        const img = new Image();
        const svgNode = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
        const size = svgNode.getAttribute("viewBox")?.split(/\s+/).map(Number);
        if (!size || size.length !== 4 || !size.every(Number.isFinite) || size[2] <= 0 || size[3] <= 0) continue;
        const canvas = document.createElement("canvas");
        canvas.height = Math.min(140, Math.max(32, Math.ceil(size[3] / 15)));
        canvas.width = Math.min(1500, Math.max(1, Math.ceil(canvas.height * size[2] / size[3])));
        svgNode.setAttribute("width", canvas.width);
        svgNode.setAttribute("height", canvas.height);
        const bitmap = new XMLSerializer().serializeToString(svgNode);
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bitmap)}`;
        await img.decode();
        context.check();
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        formulas.push({ offset: match.index, source: match[0], tex, png: canvas.toDataURL("image/png") });
        if (formulas.length >= 8) break;
      } catch {
        context.check();
      }
    }
    return formulas;
  }

  async function writeNativeEditor(blank, id, text, context) {
    const workDoc = blank.ownerDocument;
    const frame = workDoc.defaultView.frameElement;
    const outer = frame?.ownerDocument.defaultView.frameElement;
    const chapter = outer?.ownerDocument;
    const index = chapter ? [...chapter.querySelectorAll("iframe")].indexOf(outer) : -1;
    const formulas = await formulaImages(text, context);
    context.check();
    const reply = await chrome.runtime.sendMessage({ type: "fill-editor", editor: id, text, formulas,
      target: workDoc === document ? null : { index, chapterUrl: chapter?.URL, workUrl: workDoc.URL } });
    context.check();
    if (!reply?.ok || !reply.data) throw new Error(reply?.error || "学习通编辑器未确认保存，请检查该题后重试。");
  }

  function writeRichText(field, text) {
    const doc = field.ownerDocument;
    const content = doc.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(formulaPattern)) {
      content.append(text.slice(offset, match.index));
      const container = doc.createElement("span");
      try {
        globalThis.katex.render(match[1] || match[2] || match[3], container, { output: "mathml", trust: false, maxExpand: 100, maxSize: 12 });
        content.append(container);
      } catch {
        content.append(match[0]);
      }
      offset = match.index + match[0].length;
    }
    content.append(text.slice(offset));
    field.replaceChildren(content);
  }

  function answerMatches(current, answer) {
    if (textTypes.has(current.data.type)) {
      return current.blanks.every((blank, index) => {
        const field = editableBlank(blank);
        return fieldText(field) === answer.blanks[index];
      });
    }
    if (current.data.type === "match") return current.matches.every((item, index) =>
      item.choices[answer.matches[index] - 1]?.selected === true);
    return current.options.every((row, index) => selected(row) === answer.choices.includes(index + 1));
  }

  async function fill(current, answer, context) {
    if (textTypes.has(current.data.type)) {
      const fields = current.blanks.map(editableBlank);
      if (fields.some((field) => !field)) throw new Error("有填空控件无法编辑，请手动处理。");
      for (const [index, field] of fields.entries()) {
        context.check();
        const editor = editorId(current.blanks[index]);
        if (editor) {
          await writeNativeEditor(current.blanks[index], editor, answer.blanks[index], context);
          continue;
        }
        if (field.matches("textarea, input")) field.value = answer.blanks[index];
        else writeRichText(field, answer.blanks[index]);
        const EventType = field.ownerDocument.defaultView.Event;
        field.dispatchEvent(new EventType("input", { bubbles: true }));
        field.dispatchEvent(new EventType("change", { bubbles: true }));
      }
      return;
    }
    if (current.data.type === "match") {
      current.matches.forEach(({ select, row, choices }, index) => {
        const choice = choices[answer.matches[index] - 1];
        choice.selected = true;
        const label = row.querySelector(".chosen-single span");
        if (label) label.textContent = readText(choice);
        const target = select || choice;
        const EventType = target.ownerDocument.defaultView.Event;
        target.dispatchEvent(new EventType("input", { bubbles: true }));
        target.dispatchEvent(new EventType("change", { bubbles: true }));
      });
      return;
    }

    const choices = new Set(answer.choices);
    if (current.data.type !== "multiple") {
      const row = current.options[answer.choices[0] - 1];
      if (!selected(row)) selectionControl(row).click();
    } else {
      current.options.forEach((row, index) => {
        if (selected(row) !== choices.has(index + 1)) selectionControl(row).click();
      });
    }
  }

  function cropBounds(element) {
    const rect = element.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    let right = rect.right;
    let bottom = rect.bottom;
    let view = element.ownerDocument.defaultView;
    while (view !== window) {
      const frame = view.frameElement;
      if (!frame || left < -1 || top < -1 || right > view.innerWidth + 1 || bottom > view.innerHeight + 1) {
        throw new Error("含图题超出可见区域，请调整页面缩放后重试。");
      }
      const frameRect = frame.getBoundingClientRect();
      const scaleX = frameRect.width / frame.offsetWidth;
      const scaleY = frameRect.height / frame.offsetHeight;
      left = frameRect.left + (frame.clientLeft + left) * scaleX;
      right = frameRect.left + (frame.clientLeft + right) * scaleX;
      top = frameRect.top + (frame.clientTop + top) * scaleY;
      bottom = frameRect.top + (frame.clientTop + bottom) * scaleY;
      view = frame.ownerDocument.defaultView;
    }
    if (left < -1 || top < -1 || right > innerWidth + 1 || bottom > innerHeight + 1) {
      throw new Error("含图题超出可见区域，请调整页面缩放后重试。");
    }
    const x = Math.max(0, Math.ceil(left));
    const y = Math.max(0, Math.ceil(top));
    return { x, y, width: Math.floor(Math.min(right, innerWidth)) - x,
      height: Math.floor(Math.min(bottom, innerHeight)) - y, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }

  async function renderQuestion(root, images, signal) {
    const box = root.getBoundingClientRect();
    if (!globalThis.html2canvas || !box.width || !box.height) return null;
    const doc = root.ownerDocument;
    try {
      const canvas = doc.createElement("canvas");
      canvas.width = canvas.height = 1;
      const probe = canvas.getContext("2d");
      if (!images.every((image) => {
        if (!image.complete || !image.naturalWidth) return false;
        probe.drawImage(image, 0, 0, 1, 1);
        probe.getImageData(0, 0, 1, 1);
        return true;
      })) return null;
      const rendered = await Promise.race([
        globalThis.html2canvas(root, { logging: false, useCORS: true, allowTaint: false, imageTimeout: 4500,
          backgroundColor: "#fff", scale: Math.min(1.5, 2200 / Math.max(box.width, box.height)),
          ignoreElements: (element) => element.matches("iframe, textarea, [contenteditable], button, input[type=hidden]") }),
        sleep(7000, signal).then(() => null)
      ]);
      signal.throwIfAborted();
      const image = rendered?.toDataURL("image/jpeg", 0.85);
      return image && image.length < 4000000 ? image : null;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  async function solve(root, video, context, ready, rejected = [], autoFill = true) {
    const before = question(root, video);
    const initialAnswer = !video && JSON.stringify(answerValues(before));
    let crop;
    const image = before.requiresImage ? await renderQuestion(before.imageRoot || root, before.images, context.signal) : null;
    if (before.requiresImage && !image) {
      if (document.visibilityState !== "visible") {
        context.report(before.unresolvedFont ? "此题字体无法还原，切回课程标签页后将改用截图。" : "此题含图，切回课程标签页后将继续。");
        await waitFor(() => document.visibilityState === "visible", context.signal, Infinity);
        context.check();
      }
      (before.imageRoot || root).scrollIntoView({ block: "center", behavior: "instant" });
      await sleep(250, context.signal);
      crop = cropBounds(before.imageRoot || root);
    }
    context.check();
    if (!root.isConnected || !ready()) throw new Error("题目已变化，请重新识别。");
    if (question(root, video).identity !== before.identity) throw new Error("读取期间题目内容已变化，请重试。");
    const answer = await requestAnswer({ type: "solve",
      question: { ...before.data, ...(rejected.length && { rejected }) }, crop, image }, context);
    return applyAnswer(root, video, before.identity, initialAnswer, answer, context, ready, autoFill);
  }

  async function requestAnswer(message, context) {
    const id = crypto.randomUUID();
    const cancel = () => chrome.runtime.sendMessage({ type: "cancel-solve", id }).catch(() => {});
    context.signal.addEventListener("abort", cancel, { once: true });
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ ...message, id });
    } catch {
      context.check();
      throw new Error("扩展后台未响应，请重试。");
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }
    context.check();
    if (!reply?.ok) throw new Error(reply?.error || "模型求解失败。");
    return reply.data;
  }

  async function applyAnswer(root, video, identity, initialAnswer, result, context, ready, autoFill) {
    context.check();
    if (!root.isConnected || !ready()) throw new Error("题目已变化，已丢弃刚收到的答案。");
    const after = question(root, video);
    if (after.identity !== identity) throw new Error("题目或选项已变化，已丢弃刚收到的答案。");
    if (autoFill) {
      if (!video && JSON.stringify(answerValues(after)) !== initialAnswer) {
        const answer = readAnswer(after);
        if (answer) return { root, identity: after.identity, answer };
        throw new Error("求解期间检测到手动编辑，已保留当前输入。");
      }
      await fill(after, result, context);
      context.check();
      if (!answerMatches(after, result)) throw new Error("未能确认答案已回填，请在题目页面检查。");
    }
    return { root, identity: after.identity, answer: result };
  }

  function showAnswer(root, answer, video = false) {
    const current = question(root, video);
    const summary = answer.blanks?.join(" / ") || answer.choices?.map((id) => `${id}. ${current.data.options[id - 1]}`).join(" / ") ||
      answer.matches?.map((id, index) => `${index + 1} → ${id}. ${current.data.rows[index].options[id - 1]}`).join(" / ");
    let note = video ? root.querySelector("[data-xt-suggestion]") : root.nextElementSibling;
    if (!note?.matches("[data-xt-suggestion]")) {
      note = root.ownerDocument.createElement("p");
      note.dataset.xtSuggestion = "";
      note.style.cssText = "padding:8px 10px;margin:4px 0;color:#174b39;background:#e2efe7;white-space:pre-wrap;";
      if (video) root.append(note);
      else root.after(note);
    }
    note.textContent = `模型建议：${summary}`;
  }

  function verifyFill(result, video) {
    if (!result.root.isConnected) return false;
    const current = question(result.root, video);
    return current.identity === result.identity && answerMatches(current, result.answer);
  }

  function answerValues(current) {
    if (textTypes.has(current.data.type)) {
      return { blanks: current.blanks.map((blank) => fieldText(editableBlank(blank))) };
    }
    if (current.data.type === "match") {
      return { matches: current.matches.map(({ choices }) => choices.findIndex((choice) => choice.selected) + 1) };
    }
    return { choices: current.options.flatMap((row, index) => selected(row) ? [index + 1] : []) };
  }

  function readAnswer(current) {
    const answer = answerValues(current);
    const values = answer.blanks || answer.matches || answer.choices;
    if (!values.length || !values.every(Boolean)) return null;
    if (answer.choices && current.data.type !== "multiple" && values.length !== 1) return null;
    return answer;
  }

  function clickable(element) {
    return visible(element) && !element.matches('[disabled], [aria-disabled="true"], .disabled');
  }

  function videoQuiz(doc) {
    const topic = doc?.querySelector(".ans-videoquiz .tkTopic");
    const next = doc?.getElementById("videoquiz-continue");
    let quiz = visible(topic) ? topic.closest(".ans-videoquiz") : null;
    if (!quiz && clickable(next)) quiz = next.closest(".ans-videoquiz") || next;
    if (!quiz) return null;
    return { root: quiz, submit: quiz.querySelector("#videoquiz-submit") || doc.getElementById("videoquiz-submit") };
  }

  async function handleVideoQuiz(doc, context, options) {
    const autoSubmit = options.autoSubmit && options.autoFill;
    const quiz = videoQuiz(doc);
    if (!quiz) return;
    const next = () => {
      const button = doc.getElementById("videoquiz-continue");
      return clickable(button) ? button : null;
    };
    const continueButton = next();
    if (autoSubmit && continueButton) {
      context.check();
      continueButton.click();
      await waitFor(() => videoQuiz(doc)?.root !== quiz.root, context.signal, 12000, "弹题未关闭，请在播放器里检查。");
      return;
    }
    if (!clickable(quiz.submit)) {
      if (autoSubmit) throw new Error("播放器未显示可用的提交或继续按钮，请检查弹题结果。");
      context.report("请在播放器中处理弹题结果并继续播放。");
    } else {
      const ready = () => videoQuiz(doc)?.root === quiz.root && clickable(quiz.submit);
      context.report("正在请求模型解答视频弹题…");
      if (autoSubmit) {
        return submitVideoQuiz(doc, quiz, context, ready, next);
      }
      const result = await solve(quiz.root, true, context, ready, [], options.autoFill);
      if (!options.autoFill) showAnswer(quiz.root, result.answer, true);
      context.report(options.autoFill ? "弹题已回填。请检查答案，在播放器内提交并继续。" : "弹题建议已显示，请在播放器内选择和提交。");
    }
    while (videoQuiz(doc)) {
      context.check();
      await sleep(300, context.signal);
    }
  }

  async function submitVideoQuiz(doc, quiz, context, ready, next) {
    const rejected = [];
    const original = question(quiz.root, true).identity;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      context.check();
      if (!ready() || question(quiz.root, true).identity !== original) throw new Error("视频弹题已变化，请检查后重试。");
      if (attempt > 1) context.report(`弹题答错，正在重新求解（第 ${attempt} 次）…`);
      const result = await solve(quiz.root, true, context, ready, rejected);
      context.check();
      if (!ready() || !verifyFill(result, true)) throw new Error("视频弹题的答案或提交状态已变化，请检查后重试。");
      context.report("正在提交视频弹题…");
      quiz.submit.click();
      await sleep(650, context.signal);
      const outcome = await waitFor(() => {
        if (next()) return "continue";
        const wrong = ["spanNotBackPoint", "spanNot"].some((id) => visible(doc.getElementById(id)));
        if (wrong && ready() && result.answer.choices) return "retry";
        if (wrong || visible(doc.getElementById("knowledgeBack"))) return "blocked";
        if (videoQuiz(doc)?.root !== quiz.root) return "closed";
      }, context.signal, 15000, "学习通未确认视频弹题提交，请检查播放器。");
      if (outcome === "closed") return;
      if (outcome === "blocked") throw new Error("视频弹题提交后仍需处理，请检查播放器提示。");
      if (outcome === "continue") {
        context.check();
        next()?.click();
        await waitFor(() => videoQuiz(doc)?.root !== quiz.root, context.signal, 12000, "弹题未关闭，请在播放器里检查。");
        return;
      }
      rejected.push(result.answer.choices);
    }
    throw new Error("视频弹题连续三次未通过，请检查播放器中的答案。");
  }

  function workDocument(frame) {
    return frame ? frameDocument(frameDocument(frame)?.getElementById("frame_content")) : document;
  }

  function workInventory(doc) {
    const candidates = [...doc.querySelectorAll(workRoots)];
    const roots = candidates.filter((root) => !root.parentElement.closest(workRoots));
    const text = doc.body?.innerText || "";
    const count = text.match(/(?:^|\n)\s*(?:题量|总题数|题目总数)\s*[:：]?\s*(\d+)/)?.[1] ??
      text.match(/(?:题量|总题数|题目总数)\s*[:：]\s*(\d+)/)?.[1];
    const sheetCount = [...doc.querySelectorAll("#topicNumberScroll .topicNumber_list li, #topicNumberScroll li[id^='answerSheet']")]
      .filter((item) => /^\d+$/.test(readText(item)) || item.id.startsWith("answerSheet")).length;
    return { roots, expected: count === undefined ? sheetCount || null : Number(count) };
  }

  function loadedWorkCard(root) {
    const heading = root.querySelector(workHeading);
    const text = readText(heading);
    if (!heading || (!text && !heading.querySelector("img, math, [data-latex]"))) return false;
    const type = typeFromField(root) || questionType(text);
    if (!objectiveTypes.has(type)) return true;
    const rows = [...root.querySelectorAll(optionSelector(type, false))];
    return rows.length >= 2 && rows.every((row) => readText(row) || row.querySelector("img, math, [data-latex]"));
  }

  function answerUnits(root) {
    const selector = ".sub_que_div_parent, .singleQuesId, .questionLi";
    const nested = [...root.querySelectorAll(selector)].filter((part) => !part.querySelector(selector));
    // Plain groups of blank controls are one question. An identified subquestion group keeps every leaf for validation.
    if (!nested.some((part) => part.querySelector(workHeading) &&
        (typeFromField(part) || questionType(readText(part.querySelector(workHeading)))))) return [root];
    return nested;
  }

  async function loadWorkQuestions(doc, context, ready) {
    let previous = [];
    let previousSignature;
    let stableSince = 0;
    let inventory;
    const scroller = doc.scrollingElement;
    const originalScroll = scroller?.scrollTop;
    context.report("正在等待测验题目加载并核对题量…");
    try {
      const loaded = await waitFor(() => {
        context.check();
        if (!ready()) return { changed: true };
        inventory = workInventory(doc);
        const { roots, expected } = inventory;
        const signature = JSON.stringify([expected, roots.map((root) => readText(root))]);
        if (previousSignature !== signature || roots.some((root, index) => root !== previous[index])) {
          previous = roots;
          previousSignature = signature;
          stableSince = Date.now();
        }
        const atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        if (!atBottom && (expected === null || roots.length < expected)) {
          scroller.scrollTop += Math.max(150, Math.floor(scroller.clientHeight * 0.85));
          stableSince = Date.now();
          return;
        }
        if (doc.readyState === "complete" && roots.length && (expected === null || roots.length === expected) &&
            Date.now() - stableSince >= 1250 && roots.every((root) => answerUnits(root).every(loadedWorkCard))) return inventory;
      }, context.signal, 60000);
      if (loaded?.changed) throw new Error("测验页面已变化，请重新识别。");
      if (!loaded) {
        const count = inventory?.expected;
        if (count != null && count !== inventory.roots.length) {
          throw new Error(`页面显示 ${count} 道题，当前识别到 ${inventory.roots.length} 道。请检查页面后重试。`);
        }
        throw new Error("测验题目或选项尚未完整加载，请检查页面后重试。");
      }
      return loaded;
    } finally {
      if (scroller?.isConnected && scroller.scrollTop !== originalScroll) scroller.scrollTop = originalScroll;
    }
  }

  function workDialog(doc) {
    for (const candidate of new Set([document, doc])) {
      if (!candidate) continue;
      const dialog = ["workpopFocus", "workpop"].map((id) => candidate.getElementById(id)).find(visible) ||
        [...candidate.querySelectorAll('[role="dialog"], .popDiv, .popBox')].find((element) =>
          visible(element) && /提交|交卷/.test(readText(element)));
      if (dialog) {
        const content = dialog.querySelector("#popcontent") || candidate.getElementById("popcontent");
        const confirm = dialog.querySelector("#popok, .popBottom .confirm") || candidate.getElementById("popok") ||
          [...dialog.querySelectorAll("button, [role='button']")].find((control) => /^(确定|确认|确认提交|交卷)$/.test(readText(control)));
        return { dialog, confirm, message: readText(content) || readText(dialog) };
      }
      const footer = [...candidate.querySelectorAll(".popBottom")].find((element) =>
        visible(element) && visible(element.querySelector(".confirm")) && /交卷|提交/.test(readText(element.parentElement)));
      if (footer) return { dialog: footer.parentElement, confirm: footer.querySelector(".confirm"), message: readText(footer.parentElement) };
    }
    return null;
  }

  const rejection = /未做完|未(?:作)?答|未完成|没有作答|尚未填写|未达(?:到)?及格|未通过|不及格|提交失败|提交错误|无法提交/;

  function workSubmitButton(doc, standalone = false) {
    const button = doc.querySelector(".btnSubmit.workBtnIndex, #workSubmit");
    if (clickable(button)) return button;
    if (!standalone) return null;
    return [...doc.querySelectorAll(".completeBtn, #submitFocus button, #submitFocus a, input[type='submit']")].find((element) =>
      clickable(element) && /^(提交|提交作业|提交试卷|交卷|确认交卷)$/.test(element.value || readText(element))) || null;
  }

  function submitWork(frame, doc, context) {
    const button = workSubmitButton(doc, !frame);
    if (!clickable(button)) throw new Error("未找到章节测验的提交按钮，请在页面检查。");
    if (workDialog(doc)) throw new Error("测验页面已有弹窗，请先检查提示。");
    context.check();
    const submission = { src: frame?.src };
    pendingSubmissions.set(frame || doc, submission);
    button.click();
    return submission;
  }

  async function confirmSubmission(frame, submission, context, complete) {
    context.report("已请求提交，正在等待学习通确认…");
    const start = Date.now();
    let lastReport = start;
    await waitFor(() => {
      context.check();
      const popup = workDialog(workDocument(frame));
      if (popup && rejection.test(popup.message)) {
        pendingSubmissions.delete(frame || document);
        throw new Error(`学习通未确认完成：${popup.message.slice(0, 120)}`);
      }
      if (complete()) return true;
      if (Date.now() - lastReport >= 15000) {
        lastReport = Date.now();
        context.report(`已等待学习通确认 ${Math.round((lastReport - start) / 1000)} 秒…`);
      }
      if (!popup) return false;
      if (submission.dialog === popup.dialog && submission.message === popup.message) return false;
      if (submission.dialog || !clickable(popup.confirm) || !/确认.*提交|确定.*提交|是否.*提交|提交后|交卷/.test(popup.message)) {
        throw new Error(`请检查学习通的提交提示：${popup.message.slice(0, 120) || "未识别的弹窗"}`);
      }
      submission.dialog = popup.dialog;
      submission.message = popup.message;
      popup.confirm.click();
      return false;
    }, context.signal, 120000, "学习通尚未确认测验完成。重试会继续检查这次提交。");
    pendingSubmissions.delete(frame || document);
    if (frame) {
      await globalThis.XtReview.archiveWhenReady(() => workDocument(frame), context.signal, 3000)
        .catch((error) => { context.check(); console.warn("批阅归档", error.message); });
    }
  }

  function saveWork(doc, context) {
    const nativeSave = doc.querySelector("#submitFocus a");
    const button = doc.querySelector(".btnSave.workBtnIndex, #workSave") ||
      (/暂[时存]|保存/.test(readText(nativeSave)) ? nativeSave : null);
    if (!clickable(button) || workDialog(doc)) return false;
    context.check();
    button.click();
    return true;
  }

  async function handleWork(frame, context, options) {
    const complete = () => finished(frame) || workStatus(workDocument(frame));
    const submission = pendingSubmissions.get(frame || document);
    if (submission && submission.src === frame?.src) return confirmSubmission(frame, submission, context, complete);
    const doc = await waitFor(() => {
      const nested = workDocument(frame);
      const status = readText(nested?.querySelector(".testTit_status"));
      return workStatus(nested) || status.includes("教师未创建完成") ||
        nested?.querySelector(workRoots) ? nested : null;
    }, context.signal, 30000, "章节测验未加载或页面结构已变化。");
    if (workStatus(doc)) {
      if (frame) await globalThis.XtReview.archiveWhenReady(() => workDocument(frame), context.signal, 1500)
        .catch((error) => { context.check(); console.warn("批阅归档", error.message); });
      return;
    }
    const status = doc.querySelector(".testTit_status");
    if (readText(status).includes("教师未创建完成")) throw new Error("教师尚未完成此测验，请手动检查。");
    const ready = () => !complete() && workDocument(frame) === doc;
    const { roots, expected } = await loadWorkQuestions(doc, context, ready);
    const units = roots.flatMap(answerUnits);
    const filled = [];
    let batch = [];
    let batchLength = 0;
    function retain(result) {
      if (options.autoFill) filled.push(result);
      else showAnswer(result.root, result.answer);
    }
    async function flush() {
      if (!batch.length) return;
      context.check();
      batch = batch.filter((item) => {
        if (!ready() || !item.root.isConnected) throw new Error("测验页面已变化，请重新识别。");
        const current = question(item.root, false);
        if (item.identity !== current.identity) throw new Error("批量求解前题目已变化，请重试。");
        const answer = readAnswer(current);
        if (!answer || options.redoAnswered) {
          if (item.initialAnswer !== JSON.stringify(answerValues(current))) throw new Error("求解前检测到手动编辑，请检查当前输入。");
          return true;
        }
        filled.push({ root: item.root, identity: current.identity, answer });
        return false;
      });
      batchLength = 0;
      if (!batch.length) return;
      if (batch.length === 1) {
        context.report(`正在解答测验 ${batch[0].number}/${units.length}…`);
        retain(await solve(batch[0].root, false, context, ready, [], options.autoFill));
      } else {
        context.report(`正在批量解答 ${batch.length} 道文字客观题…`);
        const results = await requestAnswer({ type: "solve-batch", questions: batch.map(({ data }) => data) }, context);
        const failures = [];
        for (const [index, item] of batch.entries()) {
          const result = results[index];
          if (result.error) failures.push(`第 ${item.number} 题：${result.error}`);
          else retain(await applyAnswer(item.root, false, item.identity, item.initialAnswer, result.answer,
            context, ready, options.autoFill));
        }
        if (failures.length) throw new Error(failures.join(" "));
      }
      batch = [];
    }
    if (options.saveDraft) context.onPause(() => filled.length > 0 && ready() && saveWork(doc, context));
    try {
      for (const [index, root] of units.entries()) {
        context.check();
        if (!ready()) break;
        const current = question(root, false);
        const answer = readAnswer(current);
        if (answer && !options.redoAnswered) {
          filled.push({ root, identity: current.identity, answer });
          continue;
        }
        if (!current.requiresImage && objectiveTypes.has(current.data.type)) {
          const length = JSON.stringify(current.data).length;
          if (batch.length && batchLength + length > 12000) await flush();
          batch.push({ root, identity: current.identity, data: current.data,
            initialAnswer: JSON.stringify(answerValues(current)), number: index + 1 });
          batchLength += length;
          if (batch.length === 6) await flush();
          continue;
        }
        await flush();
        context.report(`正在解答测验 ${index + 1}/${units.length}…`);
        retain(await solve(root, false, context, ready, [], options.autoFill));
      }
      if (ready()) await flush();
    } catch (error) {
      if (!context.signal.aborted && ready() && filled.length && options.saveDraft && saveWork(doc, context)) {
        throw new Error(`${error.message} 已请求暂存 ${filled.length} 道已填写的题。`);
      }
      throw error;
    }
    if (complete()) return;
    if (!options.autoFill) {
      context.report("模型建议已显示，请在页面填写并提交。");
      if (frame) await waitFor(complete, context.signal, Infinity);
      return;
    }
    if (options.autoSubmit) {
      context.check();
      if (expected === null) {
        const saved = options.saveDraft && saveWork(doc, context);
        context.onPause(null);
        context.report(saved ? "未读到页面总题量，已请求暂存。请在页面核对后提交。" : "未读到页面总题量，请在页面核对后提交。");
        if (frame) await waitFor(complete, context.signal, Infinity);
        return;
      }
      const current = workInventory(doc);
      const byRoot = new Map(filled.map((result) => [result.root, result]));
      const currentUnits = current.roots.flatMap(answerUnits);
      if (!ready() || current.expected !== expected || current.roots.length !== expected || byRoot.size !== units.length ||
          current.roots.some((root, index) => root !== roots[index]) ||
          currentUnits.length !== units.length || currentUnits.some((root, index) =>
            root !== units[index] || !byRoot.has(root) || !verifyFill(byRoot.get(root), false))) {
        throw new Error("测验题目或已回填的答案发生变化，请检查后重试。");
      }
      context.onPause(null);
      await confirmSubmission(frame, submitWork(frame, doc, context), context, complete);
      return;
    }
    const saved = options.saveDraft && saveWork(doc, context);
    context.onPause(null);
    context.report(saved ? "已请求暂存答案，请检查后提交测验。" : "请检查已回填的答案，在学习通页面提交测验。");
    if (frame) await waitFor(complete, context.signal, Infinity);
  }

  const typeLabels = { single: "单选", multiple: "多选", judgment: "判断", blank: "填空", written: "主观题", match: "连线" };

  function standalonePanel() {
    const { roots, expected } = workInventory(document);
    const items = roots.map((root, index) => {
      const heading = readText(root.querySelector(workHeading));
      const type = typeFromField(root) || questionType(heading);
      let answered = false;
      try { answered = answerUnits(root).every((unit) => readAnswer(question(unit, false))); }
      catch { /* Question controls can be incomplete while loading. */ }
      const label = heading.match(/简答|名词解释|论述|计算|分录|资料题|阅读理解|完形填空/)?.[0] || typeLabels[type];
      return { number: index + 1, type: label || "其他", answered };
    });
    return { items, expected, submitted: workStatus(document),
      canSubmit: pendingSubmissions.has(document) || expected !== null && Boolean(workSubmitButton(document, true)) };
  }

  function goToQuestion(number) {
    const root = workInventory(document).roots[number - 1];
    if (!root) throw new Error("没有找到该题，请等题目加载后重试。");
    root.scrollIntoView({ block: "center", behavior: "instant" });
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    root.focus({ preventScroll: true });
  }

  async function submitStandalone(context) {
    const complete = () => workStatus(document);
    if (complete()) return;
    const submission = pendingSubmissions.get(document);
    if (submission) return confirmSubmission(null, submission, context, complete);
    const { roots, expected } = await loadWorkQuestions(document, context, () => !complete());
    if (expected === null) throw new Error("未读到平台总题量，请在学习通页面核对并交卷。");
    const unanswered = roots.flatMap((root, index) => {
      try { return answerUnits(root).every((unit) => readAnswer(question(unit, false))) ? [] : [index + 1]; }
      catch { return [index + 1]; }
    });
    if (unanswered.length) throw new Error(`请先检查第 ${unanswered.join("、")} 题的作答。`);
    const current = workInventory(document);
    if (current.expected !== expected || current.roots.length !== roots.length || current.roots.some((root, index) => root !== roots[index])) {
      throw new Error("题目列表已变化，请重新检查后交卷。");
    }
    await confirmSubmission(null, submitWork(null, document, context), context, complete);
  }

  globalThis.XtQuestions = { videoQuiz, handleVideoQuiz, handleWork, standalonePanel, goToQuestion, submitStandalone };
})();
