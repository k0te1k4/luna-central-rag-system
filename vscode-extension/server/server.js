const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  CompletionItemKind,
  DiagnosticSeverity,
  CodeActionKind
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const fs = require('fs');
const { fileURLToPath } = require('url');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

// .fa → фрагменты, ядра, типы, импорты
// ucodes.cpp → реализованные ядра и их параметры
const faData = new Map();      // uri -> { fragments, kernelsUsed (aliases), varTypes, cfCalls, imports(alias->cName) }
const ucodesData = new Map();  // uri -> { kernelsImplemented (C names), kernelParams (C names -> [types]) }

// Если ucodes.cpp не открыт в редакторе, читаем и анализируем его с диска,
// чтобы диагностики в .fa работали без необходимости «открывать вкладку ucodes.cpp».
// Храним mtime, чтобы переанализировать файл при изменении на диске.
const ucodesDiskMtime = new Map(); // uri -> mtimeMs

function isFa(uri) {
  return uri.toLowerCase().endsWith('.fa');
}

function isUcodes(uri) {
  return uri.toLowerCase().endsWith('ucodes.cpp');
}

// ----------- УТИЛИТЫ -----------

function getSiblingUcodesUri(faUri) {
  const slash = faUri.lastIndexOf('/');
  if (slash < 0) return null;
  return faUri.substring(0, slash) + '/ucodes.cpp';
}

function ensureUcodesAnalyzedFromDisk(ucodesUri) {
  if (!ucodesUri) return;
  // Если документ открыт — анализ идёт по events документов.
  if (documents.get(ucodesUri)) return;

  let ucodesPath;
  try {
    ucodesPath = fileURLToPath(ucodesUri);
  } catch {
    return;
  }

  if (!ucodesPath || !fs.existsSync(ucodesPath)) {
    ucodesData.delete(ucodesUri);
    ucodesDiskMtime.delete(ucodesUri);
    return;
  }

  try {
    const st = fs.statSync(ucodesPath);
    const mtimeMs = st.mtimeMs;
    const prev = ucodesDiskMtime.get(ucodesUri);
    if (prev === mtimeMs && ucodesData.has(ucodesUri)) {
      return; // актуально
    }

    const text = fs.readFileSync(ucodesPath, 'utf8');
    const res = analyzeUcodes(text);
    ucodesData.set(ucodesUri, res);
    ucodesDiskMtime.set(ucodesUri, mtimeMs);
    connection.console.log(
      `[LuNA] analyzed ucodes.cpp from disk: ${ucodesUri}, kernelsImplemented=${res.kernelsImplemented.size}`
    );
  } catch (e) {
    // В случае ошибки чтения/парсинга не ломаем весь LSP.
    connection.console.error(
      '[LuNA] failed to analyze ucodes.cpp from disk: ' + (e && e.stack ? e.stack : String(e))
    );
  }
}

function normalizeLuNAType(t) {
  if (!t) return 'unknown';
  t = t.toLowerCase();
  if (t === 'int')    return 'int';
  if (t === 'real')   return 'real';
  if (t === 'string') return 'string';
  return 'value';
}

// ----------- АНАЛИЗ .fa -----------

// Разбор .fa: фрагменты, используемые ядра (алиасы), типы переменных, вызовы cf, импорты
function analyzeFa(text) {
  const fragments = new Set();
  const kernelsUsed = new Set(); // Алиасы ядер (init_rand, zero_block, ...)
  const varTypes = new Map();    // имя переменной -> тип LuNA (int/real/string/name/value)
  const cfCalls = [];            // { kernelName (alias), line, args: [{ name, line, start, end }] }
  const imports = new Map();     // alias -> C-имя (init_rand -> c_init_rand)

  const lines = text.split(/\r?\n/);

  const importRe  = /\bimport\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*as\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const cfCallRe  = /\bcf\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])*\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/;
  const cfRe      = /\bcf\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])*\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/;
  const subRe     = /\bsub\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  const varRe     = /\b(?:value\s+)?(int|real|string|name|value)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  lines.forEach((line, lineIdx) => {
    // Импорты: import c_init_rand(...) as init_rand;
    const mi = importRe.exec(line);
    if (mi) {
      const cName = mi[1];
      const alias = mi[2];
      imports.set(alias, cName);
    }

    // Объявления переменных
    let mv;
    while ((mv = varRe.exec(line)) !== null) {
      const type = mv[1];
      const name = mv[2];
      varTypes.set(name, type);
    }

    // cf с аргументами и индексами cf foo[i][j]: kernel(a,b);
    let m = cfCallRe.exec(line);
    if (m) {
      const fragName   = m[1];
      const kernelAlias = m[2];    // alias (init_rand, mult_block, ...)
      const argList    = m[3].trim();

      fragments.add(fragName);
      kernelsUsed.add(kernelAlias);

      const args = [];
      if (argList.length > 0) {
        const rawArgs = argList.split(',');
        let searchIndex = line.indexOf('(');
        for (const raw of rawArgs) {
          const argName = raw.trim();
          if (!argName) continue;
          const colStart = line.indexOf(argName, searchIndex);
          const colEnd   = colStart + argName.length;
          args.push({ name: argName, line: lineIdx, start: colStart, end: colEnd });
          searchIndex = colEnd;
        }
      }
      cfCalls.push({ kernelName: kernelAlias, line: lineIdx, args });
      return; // эту строку уже разобрали как cfCall, дальше не проверяем cfRe/subRe
    }

    // cf без аргументов
    m = cfRe.exec(line);
    if (m) {
      const fragName    = m[1];
      const kernelAlias = m[2];
      fragments.add(fragName);
      kernelsUsed.add(kernelAlias);
    }

    // sub
    m = subRe.exec(line);
    if (m) {
      const subName = m[1];
      fragments.add(subName);
    }
  });

  return { fragments, kernelsUsed, varTypes, cfCalls, imports };
}

// ----------- АНАЛИЗ ucodes.cpp -----------

// Разбор ucodes.cpp: extern "C" void name(type1 a, type2 b, ...)
function analyzeUcodes(text) {
  const kernelsImplemented = new Set();     // C-имена
  const kernelParams = new Map();          // C-имя -> массив ожидаемых LuNA-типов (int/real/string/value)

  // Ловим определения ядра: void c_xxx(...)
  // Работает и для случая внутри extern "C" { ... }, и для одиночных функций.
  const re = /\bvoid\s+(c_[A-Za-z0-9_]*)\s*\(([^)]*)\)/g;

  let m;
  while ((m = re.exec(text)) !== null) {
    const name      = m[1];        // C-имя: c_init_rand
    const paramsStr = m[2].trim(); // содержимое скобок

    kernelsImplemented.add(name);
    const params = [];

    if (paramsStr.length > 0) {
      const parts = paramsStr.split(',');
      for (const pRaw of parts) {
        const p = pRaw.trim();
        if (!p) continue;

        const tokens = p.split(/\s+/);
        if (tokens.length === 0) continue;

        const typeTokens = tokens.slice(0, -1); // последний токен — имя аргумента
        const typeStr = typeTokens.join(' ');
        const baseMatch = /(int|double|float|char|void|long|short)/.exec(typeStr);
        let base = baseMatch ? baseMatch[1] : 'unknown';
        const pointerLevel = (typeStr.match(/\*/g) || []).length;

        let finalType;
        if (base === 'int' || base === 'long' || base === 'short') {
          finalType = 'int';
        } else if (base === 'double' || base === 'float') {
          finalType = 'real';
        } else if (base === 'char' && pointerLevel > 0) {
          finalType = 'string';
        } else {
          finalType = 'value'; // всё остальное считаем обобщённым
        }

        params.push(finalType);
      }
    }

    kernelParams.set(name, params);
  }

  return { kernelsImplemented, kernelParams };
}


// ----------- ГЛОБАЛЬНЫЙ ИНДЕКС ПРОЕКТА -----------

function recomputeProjectIndex() {
  const allFragments = new Set();          // имена sub/cf
  const allUsedKernels = new Set();        // C-имена ядер, которые реально вызываются
  const allImplementedKernels = new Set(); // C-имена ядер, реализованных в ucodes.cpp
  const kernelToUri = new Map();           // C-имя -> uri ucodes.cpp
  const aliasToCNameGlobal = new Map();    // alias -> C-имя (по всем .fa)

  for (const [uri, data] of faData.entries()) {
    const { fragments, kernelsUsed, imports } = data;
    for (const f of fragments) allFragments.add(f);

    if (imports) {
      for (const [alias, cName] of imports.entries()) {
        if (!aliasToCNameGlobal.has(alias)) {
          aliasToCNameGlobal.set(alias, cName);
        }
      }
    }

    for (const alias of kernelsUsed) {
      const cName = (imports && imports.get(alias)) || alias;
      allUsedKernels.add(cName);
    }
  }

  for (const [uri, { kernelsImplemented }] of ucodesData.entries()) {
    for (const cName of kernelsImplemented) {
      allImplementedKernels.add(cName);
      if (!kernelToUri.has(cName)) {
        kernelToUri.set(cName, uri);
      }
    }
  }

  return { allFragments, allUsedKernels, allImplementedKernels, kernelToUri, aliasToCNameGlobal };
}

// ----------- ОБЩИЕ ХЭНДЛЕРЫ ДЛЯ ДОКУМЕНТОВ -----------

function analyzeDocument(doc) {
  const uri = doc.uri;
  const text = doc.getText();

  if (isFa(uri)) {
    const res = analyzeFa(text);
    faData.set(uri, res);
    connection.console.log(
      `[LuNA] analyzed .fa: ${uri}, fragments=${res.fragments.size}, kernelsUsed(aliases)=${res.kernelsUsed.size}, imports=${res.imports.size}`
    );
  } else if (isUcodes(uri)) {
    const res = analyzeUcodes(text);
    ucodesData.set(uri, res);
    connection.console.log(
      `[LuNA] analyzed ucodes.cpp: ${uri}, kernelsImplemented=${res.kernelsImplemented.size}`
    );
  }
}

documents.onDidChangeContent(change => {
  try {
    analyzeDocument(change.document);
    publishDiagnosticsForAll();
  } catch (e) {
    connection.console.error('Error analyzing document: ' + (e && e.stack ? e.stack : String(e)));
  }
});

documents.onDidOpen(e => {
  try {
    analyzeDocument(e.document);
    publishDiagnosticsForAll();
  } catch (e) {
    connection.console.error('Error in onDidOpen: ' + (e && e.stack ? e.stack : String(e)));
  }
});

documents.onDidClose(e => {
  const uri = e.document.uri;
  faData.delete(uri);
  ucodesData.delete(uri);
  connection.sendDiagnostics({ uri, diagnostics: [] });
  publishDiagnosticsForAll();
});

// ----------- ДИАГНОСТИКИ -----------

function publishDiagnosticsForAll() {
  // Важно: ucodes.cpp может быть не открыт в редакторе.
  // Чтобы не было ложных предупреждений «не найдено ни в одном ucodes.cpp» до открытия вкладки,
  // подхватываем и анализируем соседний ucodes.cpp с диска для каждого .fa.
  for (const faUri of faData.keys()) {
    const ucodesUri = getSiblingUcodesUri(faUri);
    if (ucodesUri) ensureUcodesAnalyzedFromDisk(ucodesUri);
  }

  const { allUsedKernels, allImplementedKernels } = recomputeProjectIndex();

  // карта: C-имя ядра -> ожидаемые типы аргументов
  const kernelParamTypes = new Map();
  for (const { kernelParams } of ucodesData.values()) {
    if (!kernelParams) continue;
    for (const [k, params] of kernelParams.entries()) {
      if (!kernelParamTypes.has(k)) {
        kernelParamTypes.set(k, params);
      }
    }
  }

  // Диагностики для .fa
  for (const [uri, data] of faData.entries()) {
    const textDoc = documents.get(uri);
    const diagnostics = [];

    if (textDoc) {
      const text = textDoc.getText();
      const lines = text.split(/\r?\n/);
      const cfRe = /\bcf\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])*\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/;

      const { varTypes, cfCalls, imports } = data;

      // 1) ядра (по алиасам), которых нет в ucodes.cpp
      lines.forEach((line, lineIdx) => {
        const m = cfRe.exec(line);
        if (m) {
          const kernelAlias = m[2];
          const cName = (imports && imports.get(kernelAlias)) || kernelAlias;

          if (!allImplementedKernels.has(cName)) {
            const colStart = line.indexOf(kernelAlias);
            const colEnd = colStart + kernelAlias.length;

            diagnostics.push({
              severity: DiagnosticSeverity.Warning,
              message: `Функция ядра "${kernelAlias}" (C: "${cName}") не найдена ни в одном ucodes.cpp`,
              range: {
                start: { line: lineIdx, character: colStart },
                end: { line: lineIdx, character: colEnd }
              },
              source: 'LuNA',
              code: 'missing-kernel',
              data: { alias: kernelAlias, cName }
            });
          }
        }
      });

      // 2) проверки числа и типов аргументов для существующих ядер
      for (const call of cfCalls) {
        const kernelAlias = call.kernelName;
        const cName = (imports && imports.get(kernelAlias)) || kernelAlias;
        const expected = kernelParamTypes.get(cName);
        if (!expected) continue; // если C-функции нет или не распознали сигнатуру

        const got = call.args;

        // число аргументов
        if (expected.length !== got.length) {
          const line = lines[call.line];
          const colStart = line.indexOf(kernelAlias);
          const colEnd = colStart + kernelAlias.length;

          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            message: `Несовпадение числа аргументов для ядра "${kernelAlias}" (C: "${cName}"): ожидается ${expected.length}, передано ${got.length}`,
            range: {
              start: { line: call.line, character: colStart },
              end: { line: call.line, character: colEnd }
            },
            source: 'LuNA',
            code: 'arg-count-mismatch'
          });

          continue;
        }

        // типы аргументов
        for (let i = 0; i < expected.length; i++) {
          const argInfo = got[i];
          const lunaType = normalizeLuNAType(varTypes.get(argInfo.name));
          const cType = expected[i]; // int/real/string/value

          if (cType === 'value') continue;
          if (lunaType === 'unknown') continue;
          if (lunaType !== cType) {
            diagnostics.push({
              severity: DiagnosticSeverity.Warning,
              message: `Несовпадение типов аргумента ${i + 1} для ядра "${kernelAlias}" (C: "${cName}"): в LuNA '${lunaType}', в C ожидается '${cType}'`,
              range: {
                start: { line: argInfo.line, character: argInfo.start },
                end: { line: argInfo.line, character: argInfo.end }
              },
              source: 'LuNA',
              code: 'arg-type-mismatch'
            });
          }
        }
      }
    }

    connection.sendDiagnostics({ uri, diagnostics });
  }

  // Диагностики для ucodes.cpp — ядра, которые нигде не используются (по C-именам)
  for (const [uri, data] of ucodesData.entries()) {
    const textDoc = documents.get(uri);
    const diagnostics = [];

    if (textDoc) {
      const text = textDoc.getText();
      const lines = text.split(/\r?\n/);
      const { kernelsImplemented } = data;

      kernelsImplemented.forEach(kernelName => {
        if (!allUsedKernels.has(kernelName)) {
          const lineIdx = lines.findIndex(line => line.includes(kernelName));
          if (lineIdx >= 0) {
            const colStart = lines[lineIdx].indexOf(kernelName);
            const colEnd = colStart + kernelName.length;

            diagnostics.push({
              severity: DiagnosticSeverity.Hint,
              message: `Функция ядра "${kernelName}" не используется ни в одном .fa`,
              range: {
                start: { line: lineIdx, character: colStart },
                end: { line: lineIdx, character: colEnd }
              },
              source: 'LuNA'
            });
          }
        }
      });
    }

    connection.sendDiagnostics({ uri, diagnostics });
  }
}

// ----------- ИНИЦИАЛИЗАЦИЯ -----------

connection.onInitialize(() => {
  connection.console.log('[LuNA] Language server initialized');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {},
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      definitionProvider: true,
      hoverProvider: true
    }
  };
});

// ----------- КОМПЛИШНЫ -----------

const KEYWORDS = [
  'sub', 'df', 'cf', 'stealable', 'import',
  'request', 'req_count', 'delete',
  'nfparam', 'locator_cyclic', 'locator_replicating',
  'after', 'let', 'for', 'while', 'if'
];

connection.onCompletion(params => {
  try {
    const uri = params.textDocument.uri;
    const { allFragments, allUsedKernels, allImplementedKernels, aliasToCNameGlobal } = recomputeProjectIndex();

    const items = [];

    // Ключевые слова
    for (const kw of KEYWORDS) {
      items.push({
        label: kw,
        kind: CompletionItemKind.Keyword
      });
    }

    // Имена фрагментов (sub/cf)
    for (const frag of allFragments) {
      items.push({
        label: frag,
        kind: CompletionItemKind.Function,
        detail: 'Фрагмент LuNA (sub/cf)'
      });
    }

    // В .fa подсказываем алиасы ядер + cf-сниппеты
    if (isFa(uri)) {
      // просто имена alias’ов
      for (const [alias, cName] of aliasToCNameGlobal.entries()) {
        items.push({
          label: alias,
          kind: CompletionItemKind.Function,
          detail: `Ядро C "${cName}", импортированное как "${alias}"`
        });
      }

      // cf-строки для alias’ов, у которых есть реализация в C
      for (const [alias, cName] of aliasToCNameGlobal.entries()) {
        if (!allImplementedKernels.has(cName)) continue;
        items.push({
          label: `cf ${alias}`,
          kind: CompletionItemKind.Snippet,
          detail: `Создать cf-фрагмент для ядра "${alias}" (C: "${cName}")`,
          insertText: `cf ${alias}: ${alias}();`
        });
      }
    }

    // В ucodes.cpp предлагаем заглушки для отсутствующих ядер (по C-именам)
    if (isUcodes(uri)) {
      const missing = [];
      allUsedKernels.forEach(k => {
        if (!allImplementedKernels.has(k)) {
          missing.push(k);
        }
      });

      for (const cName of missing) {
        items.push({
          label: `implement ${cName}`,
          kind: CompletionItemKind.Snippet,
          detail: 'Создать заглушку ядра для LuNA',
          insertText: [
            `extern "C" void ${cName}() {`,
            '    // TODO: реализовать ядро',
            '}',
            ''
          ].join('\n')
        });
      }
    }

    return items;
  } catch (e) {
    connection.console.error('Error in onCompletion: ' + (e && e.stack ? e.stack : String(e)));
    return [];
  }
});

// ----------- GO TO DEFINITION -----------

connection.onDefinition(params => {
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  if (!doc) return null;

  const pos = params.position;
  const text = doc.getText();
  const offset = doc.offsetAt(pos);

  // слово под курсором
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  const word = text.slice(start, end);
  if (!word) return null;

  const { kernelToUri, aliasToCNameGlobal } = recomputeProjectIndex();

  let lookupNames = [];

  if (isFa(uri)) {
    // 1) локальные импорты этого файла
    const data = faData.get(uri);
    const imports = data && data.imports;

    if (imports && imports.get(word)) {
      // alias -> C-имя
      lookupNames.push(imports.get(word));
    }

    // 2) глобальная карта alias->C (на случай если локальные импорты не разобрались)
    if (aliasToCNameGlobal.has(word)) {
      const cName = aliasToCNameGlobal.get(word);
      if (!lookupNames.includes(cName)) {
        lookupNames.push(cName);
      }
    }

    // 3) сам alias как есть (если вдруг кто-то делает cf add_double: add_double()
    // и C-функция тоже так называется)
    lookupNames.push(word);
  } else {
    // в ucodes.cpp ищем только по самому слову
    lookupNames.push(word);
  }

  // ищем первый C-идентификатор, для которого реально есть файл
  let targetUri = null;
  let effectiveName = null;
  for (const name of lookupNames) {
    const uriCandidate = kernelToUri.get(name);
    if (uriCandidate) {
      targetUri = uriCandidate;
      effectiveName = name;
      break;
    }
  }

  if (!targetUri || !effectiveName) return null;

  // Получаем текст ucodes.cpp
  let targetText;
  const targetDoc = documents.get(targetUri);
  if (targetDoc) {
    targetText = targetDoc.getText();
  } else {
    try {
      const fsPath = fileURLToPath(targetUri);
      targetText = fs.readFileSync(fsPath, 'utf8');
    } catch {
      return null;
    }
  }

  const re = new RegExp(`\\bvoid\\s+${effectiveName}\\s*\\(`);
  const match = re.exec(targetText);
  if (!match) return null;

  const index = match.index + match[0].indexOf(effectiveName);
  const lines = targetText.split(/\r?\n/);
  let acc = 0;
  let lineNum = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length + 1;
    if (acc + len > index) {
      lineNum = i;
      break;
    }
    acc += len;
  }
  const charNum = index - acc;

  return {
    uri: targetUri,
    range: {
      start: { line: lineNum, character: charNum },
      end: { line: lineNum, character: charNum + effectiveName.length }
    }
  };
});


// ----------- HOVER -----------

connection.onHover(params => {
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  if (!doc) return null;

  const pos = params.position;
  const text = doc.getText();
  const offset = doc.offsetAt(pos);

  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  const word = text.slice(start, end);
  if (!word) return null;

  const { allUsedKernels, allImplementedKernels } = recomputeProjectIndex();

  if (isFa(uri)) {
    const data = faData.get(uri);
    const imports = data && data.imports;
    const cName = (imports && imports.get(word)) || word;

    if (allImplementedKernels.has(cName)) {
      return {
        contents: {
          kind: 'markdown',
          value: `Ядро \`${word}\` реализовано в C как \`${cName}\`.`
        }
      };
    } else {
      if (imports && imports.get(word)) {
        return {
          contents: {
            kind: 'markdown',
            value: `Ядро \`${word}\` (C: \`${cName}\`) **не найдено** в \`ucodes.cpp\`.`
          }
        };
      }
    }
  } else if (isUcodes(uri)) {
    if (allImplementedKernels.has(word)) {
      const used = allUsedKernels.has(word);
      return {
        contents: {
          kind: 'markdown',
          value: used
            ? `Ядро C \`${word}\` **используется** в одном или нескольких \`.fa\`.`
            : `Ядро C \`${word}\` **нигде не используется** в \`.fa\`.`
        }
      };
    }
  }

  return null;
});

// ----------- QUICK FIX (создание заглушек) -----------

connection.onCodeAction(params => {
  const actions = [];

  const uri = params.textDocument.uri;
  const dirUri = uri.substring(0, uri.lastIndexOf('/'));
  const ucodesUri = dirUri + '/ucodes.cpp';

  let ucodesPath;
  try {
    ucodesPath = fileURLToPath(ucodesUri);
  } catch {
    ucodesPath = undefined;
  }

  for (const diag of params.context.diagnostics) {
    if (diag.code === 'missing-kernel' && diag.data) {
      const alias = diag.data.alias || diag.data.kernelName || 'kernel';
      const cName = diag.data.cName || alias;

      let text = undefined;
      const ucodesDoc = documents.get(ucodesUri);
      if (ucodesDoc) {
        text = ucodesDoc.getText();
      } else if (ucodesPath && fs.existsSync(ucodesPath)) {
        try {
          text = fs.readFileSync(ucodesPath, 'utf8');
        } catch {
          text = undefined;
        }
      }

      let edit;

      if (text === undefined) {
        const newText =
          '#include <cstdio>\n\n' +
          `extern "C" void ${cName}() {\n` +
          '    // TODO: реализовать ядро\n' +
          '}\n';

        edit = {
          changes: {
            [ucodesUri]: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 }
                },
                newText
              }
            ]
          }
        };
      } else {
        const lines = text.split(/\r?\n/);
        const lastLine = lines.length;
        const insertText =
          '\n' +
          `extern "C" void ${cName}() {\n` +
          '    // TODO: реализовать ядро\n' +
          '}\n';

        edit = {
          changes: {
            [ucodesUri]: [
              {
                range: {
                  start: { line: lastLine, character: 0 },
                  end: { line: lastLine, character: 0 }
                },
                newText: insertText
              }
            ]
          }
        };
      }

      actions.push({
        title: `Создать заглушку ядра "${alias}" (C: "${cName}") в ucodes.cpp`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit
      });
    }
  }

  return actions;
});

connection.listen();
