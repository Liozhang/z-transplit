/**
 * latexToPlain — turn LaTeX spans into text a PDF font can actually draw.
 *
 * Why this exists: the formula pipeline's success path puts LaTeX into the
 * paragraph text (`$E = mc^2$`), and the renderer draws that text verbatim.
 * Two things go wrong when it does:
 *   1. `sanitizeForFont` replaces every glyph the font cannot encode with `?`,
 *      so `\frac{\alpha}{\beta}` becomes a row of question marks and backslashes.
 *   2. Even when the glyphs survive, the reader sees LaTeX source, not math.
 *
 * This module converts the common constructs to their Unicode equivalents —
 * `\frac{a}{b}` to `a/b`, `x^{2}` to `x²`, `x_{i}` to `xᵢ`, `\alpha` to `α` —
 * so a successfully extracted formula renders as readable math. It is not a
 * LaTeX typesetter and does not try to be: anything it does not recognise has
 * its command name stripped and its arguments kept, which is the least-lossy
 * fallback available.
 *
 * Only the content between `$` delimiters is touched. Body text passes through
 * unchanged, which matters because the same string carries the translation.
 *
 * @module core/pdf/translation/latexToPlain
 */

/** Greek letters, lower and upper case. */
const GREEK: Readonly<Record<string, string>> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

/** Operators, relations and set symbols with a direct Unicode counterpart. */
const SYMBOL: Readonly<Record<string, string>> = {
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗", star: "⋆",
  circ: "∘", bullet: "∙", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
  approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", propto: "∝", infty: "∞",
  partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", iint: "∬",
  oint: "∮", sqrt: "√", angle: "∠", perp: "⊥", parallel: "∥", in: "∈",
  notin: "∉", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅", forall: "∀",
  exists: "∃", nexists: "∄", neg: "¬", land: "∧", lor: "∨", to: "→",
  rightarrow: "→", longrightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", mapsto: "↦",
  ldots: "…", cdots: "…", dots: "…", prime: "′", ell: "ℓ", Re: "ℜ", Im: "ℑ",
  aleph: "ℵ", hbar: "ℏ", deg: "°", degc: "℃", forallx: "∀", checkmark: "✓",
};

/**
 * Commands that wrap their argument without changing it — `\mathbb{R}` is just
 * a stylised `R`. Keeping the argument is always right for these.
 */
const PASSTHROUGH_COMMANDS = new Set([
  "mathbb", "mathcal", "mathbf", "mathrm", "mathit", "mathsf", "mathtt",
  "boldsymbol", "text", "textrm", "textnormal", "operatorname", "mbox",
]);

const SUPERSCRIPT_MAP = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ";
const SUBSCRIPT_MAP = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₙᵢ";
const SUPERSCRIPT_SRC = "0123456789+-=()ni";
const SUBSCRIPT_SRC = "0123456789+-=()ni";

function mapChars(text: string, source: string, target: string): string {
  let out = "";
  for (const ch of text) {
    const i = source.indexOf(ch);
    out += i >= 0 ? target[i] : ch;
  }
  return out;
}

function toSuperscript(text: string): string {
  return mapChars(text, SUPERSCRIPT_SRC, SUPERSCRIPT_MAP);
}

function toSubscript(text: string): string {
  return mapChars(text, SUBSCRIPT_SRC, SUBSCRIPT_MAP);
}

/** Convert the body of a `$...$` span. */
function latexBodyToPlain(input: string): string {
  let s = input;

  // 1. Fractions and roots first. They carry braced arguments, so stripping the
  //    braces before handling them would fuse the numerator into the
  //    denominator (`\frac{a}{b}` becoming `ab`).
  s = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2");
  s = s.replace(/\\sqrt\s*\[[^\]]*\]\s*\{([^{}]*)\}/g, "√($1)");
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");

  // 2. Styling commands that only restyle their argument.
  s = s.replace(
    new RegExp(`\\\\(${[...PASSTHROUGH_COMMANDS].join("|")})\\s*\\{([^{}]*)\\}`, "g"),
    "$2",
  );

  // 3. Superscripts and subscripts, braced then bare.
  s = s.replace(/\^\s*\{([^{}]*)\}/g, (_m, group: string) => toSuperscript(group));
  s = s.replace(/_\s*\{([^{}]*)\}/g, (_m, group: string) => toSubscript(group));
  s = s.replace(/\^\s*(\S)/g, (_m, ch: string) => toSuperscript(ch));
  s = s.replace(/_\s*(\S)/g, (_m, ch: string) => toSubscript(ch));

  // 4. Known command names. Unknown ones (`\left`, `\big`, `\quad`) lose their
  //    name and keep whatever followed — that is the least-lossy option.
  s = s.replace(/\\([A-Za-z]+)/g, (match, name: string) => GREEK[name] ?? SYMBOL[name] ?? "");

  // 5. Leftover braces and stray backslashes.
  s = s.replace(/[{}]/g, "").replace(/\\/g, "");

  return s.trim();
}

/**
 * Convert every `$...$` span in a text to plain readable form.
 * Text outside the delimiters is returned unchanged.
 */
export function latexToPlain(text: string): string {
  if (!text || !text.includes("$")) return text;
  return text.replace(/\$\$([^$]*)\$\$|\$([^$]*)\$/g, (match, double, single) => {
    const body = latexBodyToPlain(double ?? single ?? "");
    // An empty result means the span held nothing but commands — dropping the
    // delimiters is better than leaving a bare `$$` in the output.
    return body || "";
  });
}
