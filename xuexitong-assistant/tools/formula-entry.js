import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const input = new TeX({
  packages: ["base", "ams"],
  maxBuffer: 3000,
  maxMacros: 150,
  formatError: (_jax, error) => { throw error; }
});
const math = mathjax.document("", { InputJax: input, OutputJax: new SVG({ fontCache: "local" }) });

globalThis.XtFormulaSvg = (tex) => adaptor.outerHTML(adaptor.firstChild(math.convert(tex, { display: false })));
