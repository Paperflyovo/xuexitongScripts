(() => {
  const cachedFonts = new WeakMap();
  const secretClass = "font-cxsecret";
  const hanCharacter = /[\u4e00-\u9fa5]/gu;

  function isSecret(node) {
    return node.parentElement?.closest(`.${secretClass}`);
  }

  function embeddedFont(doc) {
    const styles = doc.head?.querySelectorAll("style") || [];
    for (const style of styles) {
      if (!style.textContent.includes(secretClass)) continue;
      const data = style.textContent.match(/data:[^,()'"\s]+;base64,([A-Za-z0-9+/=\s]+)/i)?.[1];
      if (data) return data.replace(/\s/g, "");
    }
    return "";
  }

  function fontFor(doc) {
    if (cachedFonts.has(doc)) return cachedFonts.get(doc);
    const source = embeddedFont(doc);
    if (!source) return null;
    let decoder;
    try {
      const bytes = Uint8Array.from(atob(source), (char) => char.charCodeAt(0));
      const parsed = Typr.parse(bytes);
      const font = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!font?.cmap) return null;
      const glyphs = new Map();
      decoder = (char) => {
        if (!glyphs.has(char)) {
          const glyph = Typr.U.codeToGlyph(font, char.codePointAt(0));
          const outline = glyph ? Typr.U.glyphToPath(font, glyph) : null;
          const codePoint = outline ? globalThis.XtGlyphs[md5(JSON.stringify(outline)).slice(-8)] : undefined;
          glyphs.set(char, codePoint ? String.fromCodePoint(codePoint) : null);
        }
        return glyphs.get(char);
      };
    } catch {
      return null;
    }
    cachedFonts.set(doc, decoder);
    return decoder;
  }

  function decodeText(original, value = original.data) {
    if (!isSecret(original)) return { text: value, unresolved: false };
    const decode = fontFor(original.ownerDocument);
    let unresolved = false;
    try {
      const text = value.replace(hanCharacter, (char) => {
        const decoded = decode?.(char);
        if (!decoded) unresolved = true;
        return decoded || char;
      });
      return { text, unresolved };
    } catch { return { text: value, unresolved: true }; }
  }

  function visibleText(element, readText) {
    if (!element || !(element.closest(`.${secretClass}`) || element.querySelector(`.${secretClass}`))) {
      return { text: readText(element), unresolved: false };
    }
    const doc = element.ownerDocument;
    const copy = element.cloneNode(true);
    const originalNodes = doc.createTreeWalker(element, 4);
    const copyNodes = doc.createTreeWalker(copy, 4);
    let unresolved = false;
    while (originalNodes.nextNode() && copyNodes.nextNode()) {
      const decoded = decodeText(originalNodes.currentNode);
      copyNodes.currentNode.data = decoded.text;
      unresolved ||= decoded.unresolved;
    }
    return { text: readText(copy), unresolved };
  }

  globalThis.XtCourseFont = { visibleText, decodeText };
})();
