'use strict';

/* =====================================================================
   State & DOM references
   ===================================================================== */
const state = {
  expression: '',      // what the user has typed (uses ×, ÷, −, π ...)
  lastResult: 0,       // numeric value of the last "=" (or reused history item)
  justEvaluated: false,// true right after "=", so the next input starts fresh or chains
  error: null,         // CalcError currently shown, if any
  preview: '0',        // last valid live preview
  memory: 0,
  hasMemory: false,
  degrees: true,       // angle unit for trig functions
  history: []
};

const $ = id => document.getElementById(id);
const els = {
  expression: $('expression'), result: $('result'), hint: $('hint'),
  memory: $('memIndicator'), history: $('historyList'), toast: $('toast'),
  angle: $('angleBtn'), mode: $('modeBtn'), theme: $('themeBtn')
};

/** An error we expect and show nicely (division by zero, bad factorial ...). */
class CalcError extends Error {
  constructor(message, hint = '') { super(message); this.hint = hint; }
}

/* =====================================================================
   Formatting helpers
   ===================================================================== */

/** Remove floating-point noise: 0.1 + 0.2 -> 0.3 (integers are left alone). */
function clean(value) {
  return Number.isInteger(value) ? value : Number(value.toPrecision(12));
}

/** Turn a number into a string the expression parser can read again. */
function plain(value) {
  return (value < 0 ? '−' : '') + String(Math.abs(value));
}

/** Pretty display: thousands separators, exponent form for huge/tiny values. */
function formatNumber(value) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-9) return value.toExponential(6).replace(/\.?0+e/, 'e');
  return Number(value.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/** Format a number while it is being typed, keeping a trailing "." or zeros. */
function formatTyped(text) {
  const [whole, fraction] = text.split('.');
  const grouped = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : grouped + '.' + fraction;
}

/* =====================================================================
   Math helpers (pure functions used by the parser)
   ===================================================================== */

/** Guard against NaN / Infinity ever reaching the screen. */
function check(value) {
  if (Number.isNaN(value)) throw new CalcError('Invalid Input');
  if (!Number.isFinite(value)) throw new CalcError('Result Too Large', 'The number is too big to display');
  return value;
}

function divide(a, b) {
  if (b === 0) throw new CalcError('Error', 'Cannot divide by zero');
  return a / b;
}

function calculatePercentage(value) { return value / 100; }

function calculateFactorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) {
    throw new CalcError('Invalid Factorial', 'Use a whole number from 0 to 170');
  }
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function calculateSquareRoot(x) {
  if (x < 0) throw new CalcError('Invalid Input', 'Square root of a negative number');
  return Math.sqrt(x);
}

function calculatePower(base, exponent) {
  if (base === 0 && exponent < 0) throw new CalcError('Error', 'Cannot divide by zero');
  const result = Math.pow(base, exponent);
  if (Number.isNaN(result)) throw new CalcError('Invalid Input', 'A negative base needs a whole-number exponent');
  return result;
}

/** sin/cos/tan and inverses, respecting the degree/radian setting. */
function calculateTrigFunction(name, x) {
  const toRadians = state.degrees ? x * Math.PI / 180 : x;
  let result;
  if (name === 'sin') result = Math.sin(toRadians);
  else if (name === 'cos') result = Math.cos(toRadians);
  else if (name === 'tan') {
    if (Math.abs(Math.cos(toRadians)) < 1e-12) throw new CalcError('Undefined', 'Tangent is undefined at this angle');
    result = Math.tan(toRadians);
  } else {
    if ((name === 'asin' || name === 'acos') && Math.abs(x) > 1) {
      throw new CalcError('Invalid Input', 'Inverse sin/cos need a value from -1 to 1');
    }
    result = Math[name](x);
    if (state.degrees) result = result * 180 / Math.PI;
  }
  if (Math.abs(result) < 1e-12) result = 0; // sin(180°) should be 0, not 1.2e-16
  return clean(result);
}

function applyFunction(name, x) {
  switch (name) {
    case 'sqrt': return calculateSquareRoot(x);
    case 'abs': return Math.abs(x);
    case 'exp': return check(Math.exp(x));
    case 'ln':
    case 'log10':
      if (x <= 0) throw new CalcError('Invalid Input', 'Logarithm needs a value above zero');
      return name === 'ln' ? Math.log(x) : Math.log10(x);
    default: return calculateTrigFunction(name, x);
  }
}

/* =====================================================================
   Expression parser (no eval): tokenizer + recursive descent
   Order of operations: parentheses > postfix (! %) > powers > unary minus
   > × ÷ mod > + −
   ===================================================================== */
const FUNCTIONS = ['asin', 'acos', 'atan', 'log10', 'sqrt', 'abs', 'exp', 'sin', 'cos', 'tan', 'ln'];
const TOKEN_RE = new RegExp(
  '(\\d+\\.?\\d*(?:e[+-]?\\d+)?|\\.\\d+(?:e[+-]?\\d+)?)' + // 1: number
  '|(' + FUNCTIONS.join('|') + '|mod|√|π|e)' +             // 2: name
  '|([+\\-−×÷*/^()!%])|(\\s+)|(.)', 'y');                  // 3: symbol, 4: space, 5: junk

function tokenize(text) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < text.length) {
    const m = TOKEN_RE.exec(text);
    if (m[1] !== undefined) tokens.push({ type: 'num', value: parseFloat(m[1]) });
    else if (m[2] !== undefined) {
      if (m[2] === 'mod') tokens.push({ type: 'op', value: 'mod' });
      else if (m[2] === 'π' || m[2] === 'e') tokens.push({ type: 'const', value: m[2] });
      else tokens.push({ type: 'fn', value: m[2] === '√' ? 'sqrt' : m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ type: 'op', value: { '-': '−', '*': '×', '/': '÷' }[m[3]] || m[3] });
    } else if (m[5] !== undefined) throw new CalcError('Invalid Expression');
  }
  return tokens;
}

function evaluate(text) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops) => peek() && peek().type === 'op' && ops.includes(peek().value);
  const startsValue = t => t && (t.type === 'num' || t.type === 'fn' || t.type === 'const' || (t.type === 'op' && t.value === '('));

  function expectClose() {
    if (!peek()) throw new CalcError('Invalid Parentheses', 'A "(" is missing its ")"');
    if (!isOp(')')) throw new CalcError('Invalid Expression');
    pos++;
  }

  function parseExpression() {              // + and −
    let value = parseTerm();
    while (isOp('+', '−')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      value = check(op === '+' ? value + right : value - right);
    }
    return value;
  }

  function parseTerm() {                    // × ÷ mod, plus implicit multiplication: 2π, 3(4+1)
    let value = parseUnary();
    for (; ;) {
      if (isOp('×', '÷', 'mod')) {
        const op = tokens[pos++].value;
        const right = parseUnary();
        if (op === '×') value = check(value * right);
        else if (op === '÷') value = check(divide(value, right));
        else value = check(value - right * Math.floor(divide(value, right))); // mathematical mod
      } else if (startsValue(peek())) {
        value = check(value * parseUnary());
      } else return value;
    }
  }

  function parseUnary() {                   // leading + or −  (so −2^2 = −4)
    if (isOp('−')) { pos++; return -parseUnary(); }
    if (isOp('+')) { pos++; return parseUnary(); }
    return parsePower();
  }

  function parsePower() {                   // right-associative: 2^3^2 = 2^9
    const base = parsePostfix();
    if (isOp('^')) { pos++; return check(calculatePower(base, parseUnary())); }
    return base;
  }

  function parsePostfix() {                 // n!  and  n%
    let value = parsePrimary();
    while (isOp('!', '%')) {
      value = tokens[pos++].value === '!' ? check(calculateFactorial(value)) : calculatePercentage(value);
    }
    return value;
  }

  function parsePrimary() {
    const token = tokens[pos++];
    if (!token) throw new CalcError('Invalid Expression');
    if (token.type === 'num') return token.value;
    if (token.type === 'const') return token.value === 'π' ? Math.PI : Math.E;
    if (token.type === 'fn') {
      if (!isOp('(')) throw new CalcError('Invalid Expression');
      pos++;
      const arg = parseExpression();
      expectClose();
      return check(applyFunction(token.value, arg));
    }
    if (token.value === '(') {
      const value = parseExpression();
      expectClose();
      return value;
    }
    throw new CalcError(token.value === ')' ? 'Invalid Parentheses' : 'Invalid Expression');
  }

  if (!tokens.length) return 0;
  const value = parseExpression();
  if (pos < tokens.length) throw new CalcError(isOp(')') ? 'Invalid Parentheses' : 'Invalid Expression');
  return clean(check(value));
}

/* =====================================================================
   Input handling
   ===================================================================== */
const OPERAND_END = /[\d.)!%πe]$/;                   // an expression ending here can take a postfix op
const BINARY_END = /( mod |[+−×÷^])$/;
const TRAILING_TOKEN = new RegExp('(?:(?:' + FUNCTIONS.join('|') + ')\\(|√\\(| mod |.)$');

/** Reset error / decide what happens to the previous result before new input. */
function prepareForInput(continueWithResult) {
  if (state.error) {
    state.error = null; state.expression = ''; state.justEvaluated = false;
  } else if (state.justEvaluated) {
    state.expression = continueWithResult ? plain(state.lastResult) : '';
    state.justEvaluated = false;
  }
}

function appendNumber(digit) {
  prepareForInput(false);
  const e = state.expression;
  const trailing = (e.match(/[\d.]+$/) || [''])[0];
  if (digit === '.') {
    if (!trailing.includes('.')) state.expression += trailing ? '.' : (OPERAND_END.test(e) ? '×0.' : '0.');
  } else if (trailing === '0') {
    state.expression = e.slice(0, -1) + digit;          // avoid leading zeros like 007
  } else {
    state.expression += (/[)!%πe]$/.test(e) ? '×' : '') + digit;
  }
  updateDisplay();
}

function appendOperator(op) {
  prepareForInput(true);
  const text = op === 'mod' ? ' mod ' : op;
  let e = state.expression;
  if (!e) { if (op === '−') e = '−'; }                   // only a minus can start an expression
  else if (BINARY_END.test(e)) {
    // allow negative after × ÷ ^ (5×−3); otherwise replace the previous operator
    e = (op === '−' && /[×÷^]$| mod $/.test(e)) ? e + op : e.replace(BINARY_END, text);
  } else if (/\($/.test(e)) { if (op === '−') e += op; }
  else e += text;
  state.expression = e;
  updateDisplay();
}

/** Append ! % ^2 ^3 to the last operand. */
function appendPostfix(text) {
  prepareForInput(true);
  if (OPERAND_END.test(state.expression)) state.expression += text;
  updateDisplay();
}

/** Insert text such as "(" , "π", "10^" (adds × when needed). */
function insertText(text) {
  prepareForInput(false);
  if (/[\d.]$/.test(state.expression) && /^[\deπ]/.test(text)) text = '×' + text;
  state.expression += text;
  updateDisplay();
}

/** Functions apply to the last result if one is showing: 25 = then √ -> √(25). */
function insertFunction(name) {
  if (state.justEvaluated && !state.error) {
    state.expression = name + plain(state.lastResult) + ')';
    state.justEvaluated = false;
    updateDisplay();
  } else insertText(name);
}

function appendCloseParen() {
  prepareForInput(true);
  const e = state.expression;
  const open = (e.match(/\(/g) || []).length, close = (e.match(/\)/g) || []).length;
  if (open > close && OPERAND_END.test(e)) state.expression += ')';
  updateDisplay();
}

function applyReciprocal() {
  prepareForInput(true);
  if (state.expression) state.expression = '1÷(' + state.expression + ')';
  updateDisplay();
}

function insertRandom() { insertText(String(Number(Math.random().toFixed(6)))); }

function toggleSign() {
  prepareForInput(true);
  let e = state.expression;
  const wrapped = e.match(/\(−([\d.]+(?:e[+-]?\d+)?)\)$/);
  const num = e.match(/[\d.]+(?:e[+-]?\d+)?$/);
  if (/^−[\d.]+(?:e[+-]?\d+)?$/.test(e)) e = e.slice(1);                       // −5 -> 5
  else if (wrapped) e = e.slice(0, wrapped.index) + wrapped[1];                // (−5) -> 5
  else if (num) e = e.slice(0, num.index) + '(−' + num[0] + ')';               // 5 -> (−5)
  else e = e ? '−(' + e + ')' : '−';
  state.expression = e;
  updateDisplay();
}

function deleteLast() {
  if (state.error) { clearCalculator(); return; }
  prepareForInput(true);
  state.expression = state.expression.replace(TRAILING_TOKEN, '');
  updateDisplay();
}

/** C: clear the current number; if there isn't one, delete the last token. */
function clearEntry() {
  if (state.error || state.justEvaluated) { clearCalculator(); return; }
  const shorter = state.expression.replace(/[\d.]+$/, '');
  if (shorter !== state.expression) { state.expression = shorter; updateDisplay(); }
  else deleteLast();
}

function clearCalculator() {
  Object.assign(state, { expression: '', lastResult: 0, justEvaluated: false, error: null, preview: '0' });
  updateDisplay();
}

function calculate() {
  if (state.error || !state.expression || state.justEvaluated) return;
  try {
    const value = evaluate(state.expression);
    if (!/^−?[\d.]+$/.test(state.expression)) addToHistory(state.expression, value); // skip bare numbers
    state.lastResult = value;
    state.justEvaluated = true;
  } catch (err) {
    showError(err);
  }
  updateDisplay();
}

function showError(err) {
  state.error = err instanceof CalcError ? err : new CalcError('Invalid Expression');
  state.justEvaluated = false;
}

function toggleDegreeRadians() { state.degrees = !state.degrees; updateDisplay(); }

/* =====================================================================
   Memory
   ===================================================================== */
function getCurrentValue() {
  if (state.justEvaluated) return state.lastResult;
  return state.expression ? evaluate(state.expression) : 0;
}

function changeMemory(sign) {
  try {
    const value = getCurrentValue();
    state.memory = clean(state.memory + sign * value);
    state.hasMemory = true;
    Object.assign(state, { expression: plain(value), lastResult: value, justEvaluated: true });
  } catch (err) { showError(err); }
  updateDisplay();
}
function memoryAdd() { changeMemory(1); }
function memorySubtract() { changeMemory(-1); }
function memoryClear() { state.memory = 0; state.hasMemory = false; updateDisplay(); }
function memoryRecall() {
  if (!state.hasMemory) return;
  insertText(state.memory < 0 ? '(' + plain(state.memory) + ')' : plain(state.memory));
}

/* =====================================================================
   History
   ===================================================================== */
function addToHistory(expression, value) {
  state.history.unshift({ expression, value });
  if (state.history.length > 50) state.history.pop();
  renderHistory();
}

function clearHistory() { state.history = []; renderHistory(); }

function renderHistory() {
  els.history.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'Finished calculations appear here. Select one to reuse its result.';
    els.history.append(empty);
    return;
  }
  for (const item of state.history) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    button.setAttribute('aria-label', `Reuse ${item.expression} = ${formatNumber(item.value)}`);
    const expr = document.createElement('span');
    expr.className = 'h-expr';
    expr.textContent = item.expression + ' =';
    const res = document.createElement('span');
    res.className = 'h-res';
    res.textContent = formatNumber(item.value);
    button.append(expr, res);
    button.addEventListener('click', () => useHistoryItem(item));
    li.append(button);
    els.history.append(li);
  }
}

function useHistoryItem(item) {
  Object.assign(state, { expression: plain(item.value), lastResult: item.value, error: null, justEvaluated: false });
  updateDisplay();
}

/* =====================================================================
   Display
   ===================================================================== */
function getPreview() {
  const e = state.expression;
  if (!e) return '0';
  if (/^[\d.]+$/.test(e)) return formatTyped(e);       // plain number being typed
  try { state.preview = formatNumber(evaluate(e)); } catch (err) { /* incomplete input: keep last preview */ }
  return state.preview;
}

function updateDisplay() {
  els.expression.textContent = state.expression ? state.expression + (state.justEvaluated ? ' =' : '') : '';
  els.expression.scrollLeft = els.expression.scrollWidth;
  let text;
  if (state.error) text = state.error.message;
  else text = state.justEvaluated ? formatNumber(state.lastResult) : getPreview();
  els.result.textContent = text;
  els.result.classList.toggle('error', !!state.error);
  els.result.dataset.size = text.length > 16 ? 'xs' : text.length > 11 ? 'sm' : 'md';
  els.hint.textContent = state.error ? (state.error.hint ? state.error.hint + '. ' : '') + 'Press AC or C to continue.' : '';
  els.memory.hidden = !state.hasMemory;
  els.memory.title = 'Memory: ' + formatNumber(state.memory);
  els.angle.textContent = state.degrees ? 'DEG' : 'RAD';
}

/* =====================================================================
   Copy, theme, mode
   ===================================================================== */
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 1500);
}

async function copyResult() {
  if (state.error) return;
  const text = state.justEvaluated ? String(state.lastResult) : els.result.textContent.replace(/,/g, '');
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {                                       // fallback for file:// or older browsers
    const box = document.createElement('textarea');
    box.value = text;
    document.body.append(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
  showToast('Copied ' + text);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  els.theme.textContent = next === 'dark' ? 'Light' : 'Dark';
}

function toggleMode() {
  const next = document.body.dataset.mode === 'sci' ? 'basic' : 'sci';
  document.body.dataset.mode = next;
  els.mode.textContent = next === 'sci' ? 'Basic' : 'Scientific';
}

/* =====================================================================
   Keyboard support
   ===================================================================== */
/** Briefly animate the on-screen key that matches a keyboard press. */
function flashKey(value) {
  const key = document.querySelector(`.key[data-value="${value}"]`);
  if (!key) return;
  key.classList.add('pressed');
  setTimeout(() => key.classList.remove('pressed'), 120);
}

function handleKeyboardInput(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;   // keep browser shortcuts (copy, reload ...)
  const k = event.key;
  if (k === 'Enter' && event.target.closest('.history, .toolbar, .display')) return; // let focused buttons work
  let flash = null;

  if (/^[0-9.]$/.test(k)) { appendNumber(k); flash = k; }
  else if (k.length === 1 && '+-*/^'.includes(k)) {
    const op = { '-': '−', '*': '×', '/': '÷' }[k] || k;
    appendOperator(op); flash = op;
  }
  else if (k === '%' || k === '!') { appendPostfix(k); flash = k; }
  else if (k === '(') { insertText('('); flash = k; }
  else if (k === ')') { appendCloseParen(); flash = k; }
  else if (k === 'Enter' || k === '=') { calculate(); flash = '='; }
  else if (k === 'Escape') { clearCalculator(); flash = 'Escape'; }
  else if (k === 'Backspace') { deleteLast(); flash = 'Backspace'; }
  else return;

  event.preventDefault();      // stops "/" quick-find, Enter re-clicking a focused button, etc.
  if (flash) flashKey(flash);
}

/* =====================================================================
   Wiring: one delegated click listener for every calculator key
   ===================================================================== */
const ACTIONS = {
  digit: appendNumber, operator: appendOperator, postfix: appendPostfix,
  insert: insertText, func: insertFunction, close: appendCloseParen,
  reciprocal: applyReciprocal, random: insertRandom, sign: toggleSign,
  equals: calculate, allClear: clearCalculator, clearEntry, backspace: deleteLast,
  memClear: memoryClear, memRecall: memoryRecall, memAdd: memoryAdd, memSubtract: memorySubtract
};

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (button) ACTIONS[button.dataset.action](button.dataset.value);
});
document.addEventListener('keydown', handleKeyboardInput);
els.mode.addEventListener('click', toggleMode);
els.angle.addEventListener('click', toggleDegreeRadians);
els.theme.addEventListener('click', toggleTheme);
$('copyBtn').addEventListener('click', copyResult);
$('clearHistoryBtn').addEventListener('click', clearHistory);

/* Initial setup: follow the system theme, use basic layout on small screens */
if (window.matchMedia('(prefers-color-scheme: dark)').matches) toggleTheme();
if (window.innerWidth < 640) toggleMode();
els.mode.textContent = document.body.dataset.mode === 'sci' ? 'Basic' : 'Scientific';
renderHistory();
updateDisplay();
