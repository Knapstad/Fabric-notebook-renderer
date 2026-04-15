(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Settings — loaded from chrome.storage.sync, with sensible defaults
  // ---------------------------------------------------------------------------
  var _settings = {
    defaultView: 'notebook',
    contextLines: 3,
    collapseUnchanged: true,
    syntaxHighlight: true,
    collapseLongCode: true,
  };

  // Load settings async; content runs with defaults until load completes
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(_settings, function (items) {
      Object.assign(_settings, items);
    });
    // Re-load when settings change (user edits options page)
    chrome.storage.onChanged.addListener(function (changes) {
      for (var key in changes) {
        if (key in _settings) _settings[key] = changes[key].newValue;
      }
    });
  }

  const DELIMITER_RE = /^# (METADATA|MARKDOWN|CELL|PARAMETERS) \*{10,}$/;
  const META_LINE_RE = /^# META (.*)$/;
  const MAGIC_RE = /^# MAGIC (.*)$/;
  const MARKDOWN_LINE_RE = /^# ?(.*)$/;

  let originalContent = null;
  let injectedUrl = null;

  // ---------------------------------------------------------------------------
  // Detection — multiple strategies for getting raw text from GitHub
  // ---------------------------------------------------------------------------

  function getRawText() {
    const text = extractFromJsonPayload();
    if (text && isFabricNotebook(text)) return text;

    const clipboardEl = document.querySelector(
      '[data-snippet-clipboard-copy-content]'
    );
    if (clipboardEl) {
      const t = clipboardEl.getAttribute('data-snippet-clipboard-copy-content');
      if (t && isFabricNotebook(t)) return t;
    }

    const selectors = [
      '.blob-code-inner',
      '[data-code-text]',
      '.react-code-lines .react-code-text',
      '.react-file-line',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 5) {
        let lines;
        if (sel === '[data-code-text]') {
          lines = Array.from(els).map((el) => el.getAttribute('data-code-text'));
        } else {
          lines = Array.from(els).map((el) => el.textContent);
        }
        const t = lines.join('\n');
        if (isFabricNotebook(t)) return t;
      }
    }

    const pres = document.querySelectorAll('pre');
    for (const pre of pres) {
      const t = pre.textContent;
      if (t && t.length > 100 && isFabricNotebook(t)) return t;
    }

    const codeContainer = findCodeContainer();
    if (codeContainer) {
      const t = codeContainer.textContent;
      if (t && isFabricNotebook(t)) return t;
    }

    return null;
  }

  function extractFromJsonPayload() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"]'
    );
    for (const script of scripts) {
      try {
        const text = script.textContent;
        if (!text || !text.includes('rawLines')) continue;

        const data = JSON.parse(text);
        const rawLines = findRawLines(data);
        if (rawLines && rawLines.length > 0) {
          return rawLines.join('\n');
        }
      } catch {
        // ignore parse errors
      }
    }
    return null;
  }

  function findRawLines(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 12 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj.rawLines)) return obj.rawLines;

    const keys = Object.keys(obj);
    for (const key of keys) {
      const val = obj[key];
      if (val && typeof val === 'object') {
        const result = findRawLines(val, depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  function isFabricNotebook(text) {
    if (!text) return false;
    return (
      text.includes('# Fabric notebook source') &&
      text.includes('# CELL **')
    );
  }

  // ---------------------------------------------------------------------------
  // Find the code container in the DOM to replace (blob view)
  // ---------------------------------------------------------------------------

  function findCodeContainer() {
    // Target the code blob content precisely — avoid walking up into the
    // page layout which contains the breadcrumb and file tree.
    const selectors = [
      // GitHub React blob view (2024+): the section wrapping the code blob
      '[class*="BlobViewContent-module__blobContentWrapper"]',
      '[class*="CodeBlob-module__codeBlobWrapper"]',
      '.react-code-file-contents',
      // Older / fallback selectors
      '.blob-wrapper',
      '.Box-body .highlight',
      '.highlight',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Parser
  // ---------------------------------------------------------------------------

  function parseNotebook(text) {
    const lines = text.split('\n');
    const notebook = { metadata: null, cells: [] };

    let currentBlock = null;
    let currentLines = [];
    let metaLines = [];
    let isTopLevelMeta = true;

    function flushCell() {
      if (!currentBlock) return;

      if (currentBlock === 'METADATA') {
        const json = parseMetaJson(metaLines);
        if (isTopLevelMeta && !notebook.metadata) {
          notebook.metadata = json;
        } else if (notebook.cells.length > 0) {
          const lastCell = notebook.cells[notebook.cells.length - 1];
          lastCell.metadata = json;
          if (json && json.language) {
            lastCell.language = json.language;
          } else if (json && json.language_group) {
            lastCell.language = mapLanguage(json.language_group);
          }
        }
        metaLines = [];
        isTopLevelMeta = false;
      } else if (currentBlock === 'MARKDOWN') {
        const content = currentLines
          .map((l) => {
            const m = l.match(MARKDOWN_LINE_RE);
            return m ? m[1] : l;
          })
          .join('\n')
          .trim();
        if (content) {
          notebook.cells.push({
            type: 'markdown',
            content,
            language: null,
            metadata: null,
          });
        }
      } else if (currentBlock === 'CELL' || currentBlock === 'PARAMETERS') {
        const raw = currentLines.join('\n').trim();
        if (raw) {
          const cell = parseCellContent(raw);
          cell.isParameters = currentBlock === 'PARAMETERS';
          notebook.cells.push(cell);
        }
      }

      currentLines = [];
    }

    for (const line of lines) {
      const delimMatch = line.match(DELIMITER_RE);
      if (delimMatch) {
        flushCell();
        currentBlock = delimMatch[1];
        continue;
      }

      if (currentBlock === 'METADATA') {
        const metaMatch = line.match(META_LINE_RE);
        if (metaMatch) {
          metaLines.push(metaMatch[1]);
        }
      } else {
        currentLines.push(line);
      }
    }
    flushCell();

    return notebook;
  }

  function parseMetaJson(lines) {
    try {
      return JSON.parse(lines.join('\n'));
    } catch {
      return null;
    }
  }

  function parseCellContent(raw) {
    const lines = raw.split('\n');

    const runMatch = raw.match(/^%run\s+["'](.+?)["']/);
    if (runMatch) {
      return {
        type: 'run',
        content: runMatch[1],
        language: null,
        metadata: null,
      };
    }

    if (lines[0] && lines[0].match(/^# MAGIC %%(\w+)/)) {
      const langMatch = lines[0].match(/^# MAGIC %%(\w+)/);
      const lang = langMatch[1];
      const content = lines
        .slice(1)
        .map((l) => {
          const m = l.match(MAGIC_RE);
          return m ? m[1] : l;
        })
        .join('\n')
        .trim();
      return { type: 'code', content, language: lang, metadata: null };
    }

    const hasMagic = lines.some((l) => MAGIC_RE.test(l));
    if (hasMagic) {
      const content = lines
        .map((l) => {
          const m = l.match(MAGIC_RE);
          return m ? m[1] : l;
        })
        .join('\n')
        .trim();
      return { type: 'code', content, language: 'sql', metadata: null };
    }

    return { type: 'code', content: raw, language: 'python', metadata: null };
  }

  function mapLanguage(group) {
    const map = {
      synapse_pyspark: 'python',
      synapse_sparksql: 'sparksql',
      synapse_sql: 'sql',
    };
    return map[group] || group || 'python';
  }

  // ---------------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------------

  function renderNotebook(notebook, options) {
    const container = document.createElement('div');
    container.className = 'fabric-notebook';
    if (options && options.inline) {
      container.classList.add('fabric-notebook-inline');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'fabric-notebook-header';

    const title = document.createElement('span');
    title.className = 'fabric-notebook-title';
    title.textContent = 'Fabric Notebook';
    header.appendChild(title);

    if (notebook.metadata) {
      const badges = document.createElement('span');
      badges.className = 'fabric-notebook-badges';

      if (notebook.metadata.kernel_info) {
        const kernelBadge = document.createElement('span');
        kernelBadge.className = 'fabric-badge';
        kernelBadge.textContent =
          notebook.metadata.kernel_info.name || 'unknown kernel';
        badges.appendChild(kernelBadge);
      }

      if (notebook.metadata.dependencies?.lakehouse?.default_lakehouse_name) {
        const lhBadge = document.createElement('span');
        lhBadge.className = 'fabric-badge fabric-badge-lakehouse';
        lhBadge.textContent =
          'Lakehouse: ' +
          notebook.metadata.dependencies.lakehouse.default_lakehouse_name;
        badges.appendChild(lhBadge);
      }

      header.appendChild(badges);
    }

    container.appendChild(header);

    // Cells
    let cellIndex = 0;
    for (const cell of notebook.cells) {
      const cellEl = renderCell(cell, cellIndex);
      container.appendChild(cellEl);
      cellIndex++;
    }

    return container;
  }

  function renderCell(cell, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fabric-cell fabric-cell-' + cell.type;

    if (cell.isParameters) {
      wrapper.classList.add('fabric-cell-parameters');
    }

    const header = document.createElement('div');
    header.className = 'fabric-cell-header';

    const indexLabel = document.createElement('span');
    indexLabel.className = 'fabric-cell-index';
    indexLabel.textContent = '[' + (index + 1) + ']';
    header.appendChild(indexLabel);

    const typeLabel = document.createElement('span');
    typeLabel.className = 'fabric-cell-type';

    if (cell.type === 'markdown') {
      typeLabel.textContent = 'Markdown';
    } else if (cell.type === 'run') {
      typeLabel.textContent = 'Run';
    } else if (cell.isParameters) {
      typeLabel.textContent = 'Parameters';
    } else {
      typeLabel.textContent = formatLanguage(cell.language);
    }
    header.appendChild(typeLabel);

    wrapper.appendChild(header);

    const body = document.createElement('div');
    body.className = 'fabric-cell-body';

    if (cell.type === 'markdown') {
      body.innerHTML = marked.parse(cell.content);
    } else if (cell.type === 'run') {
      const runEl = document.createElement('div');
      runEl.className = 'fabric-run-ref';
      runEl.innerHTML =
        '<span class="fabric-run-icon">&#9654;</span> <code>' +
        escapeHtml(cell.content) +
        '</code>';
      body.appendChild(runEl);
    } else {
      const codeBlock = renderCodeBlock(cell.content, cell.language);
      body.appendChild(codeBlock);
    }

    wrapper.appendChild(body);
    return wrapper;
  }

  function renderCodeBlock(content, language, options) {
    const opts = options || {};
    const lines = content.split('\n');
    const startLine = opts.startLine || 1;
    const collapsible = opts.collapsible !== false && _settings.collapseLongCode && lines.length > 20;
    const initiallyCollapsed = opts.collapsed !== false && _settings.collapseLongCode && lines.length > 30;

    const container = document.createElement('div');
    container.className = 'fabric-code-block';

    const table = document.createElement('table');
    table.className = 'fabric-code-table';

    const tbody = document.createElement('tbody');

    lines.forEach((lineText, i) => {
      const tr = document.createElement('tr');
      tr.className = 'fabric-code-row';
      if (opts.diffType) {
        tr.classList.add('fabric-code-row-' + (opts.diffTypes?.[i] || ''));
      }

      // Line number cell
      const tdNum = document.createElement('td');
      tdNum.className = 'fabric-line-num';
      tdNum.setAttribute('data-line', startLine + i);
      tdNum.textContent = startLine + i;
      tr.appendChild(tdNum);

      // Code cell
      const tdCode = document.createElement('td');
      tdCode.className = 'fabric-line-code';
      tdCode.innerHTML = highlightCode(lineText, language);
      tr.appendChild(tdCode);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);

    // Collapse/expand for long cells
    if (collapsible) {
      container.classList.add('fabric-code-collapsible');
      if (initiallyCollapsed) {
        container.classList.add('fabric-code-collapsed');
      }
      const expandBtn = document.createElement('button');
      expandBtn.className = 'fabric-code-expand-btn';
      expandBtn.textContent = initiallyCollapsed
        ? 'Show all ' + lines.length + ' lines'
        : 'Collapse';
      expandBtn.addEventListener('click', () => {
        const isCollapsed = container.classList.toggle('fabric-code-collapsed');
        expandBtn.textContent = isCollapsed
          ? 'Show all ' + lines.length + ' lines'
          : 'Collapse';
      });
      container.appendChild(expandBtn);
    }

    return container;
  }

  function formatLanguage(lang) {
    const names = {
      python: 'Python',
      sql: 'SQL',
      sparksql: 'Spark SQL',
      scala: 'Scala',
      r: 'R',
    };
    return names[lang] || lang || 'Code';
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // Syntax highlighting (lightweight, regex-based)
  // ---------------------------------------------------------------------------

  function highlightCode(text, language) {
    if (!_settings.syntaxHighlight) return escapeHtml(text);
    if (language === 'sql' || language === 'sparksql') {
      return tokenHighlight(text, SQL_TOKENS);
    }
    return tokenHighlight(text, PYTHON_TOKENS);
  }

  // Token-based highlighter: finds tokens in raw text, escapes everything else.
  // Combined regex is compiled once per token set and cached.
  var _compiledRegexCache = new WeakMap();

  function tokenHighlight(code, tokenDefs) {
    var combined = _compiledRegexCache.get(tokenDefs);
    if (!combined) {
      var parts = tokenDefs.map(function (t) { return '(' + t.pattern.source + ')'; });
      combined = new RegExp(parts.join('|'), 'gm');
      _compiledRegexCache.set(tokenDefs, combined);
    }
    // Reset lastIndex since we reuse the global regex
    combined.lastIndex = 0;

    var result = '';
    var lastIndex = 0;
    var match;

    while ((match = combined.exec(code)) !== null) {
      if (match.index > lastIndex) {
        result += escapeHtml(code.slice(lastIndex, match.index));
      }

      for (var i = 0; i < tokenDefs.length; i++) {
        if (match[i + 1] !== undefined) {
          result += '<span class="' + tokenDefs[i].className + '">' +
            escapeHtml(match[0]) + '</span>';
          break;
        }
      }

      lastIndex = combined.lastIndex;
    }

    if (lastIndex < code.length) {
      result += escapeHtml(code.slice(lastIndex));
    }

    return result;
  }

  const PYTHON_TOKENS = [
    // Comments (must come first to avoid partial matches)
    { pattern: /#.*$/m, className: 'fabric-hl-comment' },
    // Triple-quoted strings
    { pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/, className: 'fabric-hl-string' },
    // Strings
    { pattern: /f?"(?:[^"\\]|\\.)*"|f?'(?:[^'\\]|\\.)*'/, className: 'fabric-hl-string' },
    // Decorators
    { pattern: /^@\w+/m, className: 'fabric-hl-decorator' },
    // Keywords
    { pattern: /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/, className: 'fabric-hl-keyword' },
    // Builtins (followed by parenthesis)
    { pattern: /\b(?:print|len|range|int|str|float|list|dict|set|tuple|type|isinstance|enumerate|zip|map|filter|sorted|reversed|open|super|abs|all|any|bool|bytes|callable|chr|dir|divmod|eval|exec|format|getattr|globals|hasattr|hash|help|hex|id|input|iter|max|min|next|oct|ord|pow|repr|round|setattr|slice|sum|vars)(?=\s*\()/, className: 'fabric-hl-builtin' },
    // Numbers
    { pattern: /\b\d+\.?\d*(?:e[+-]?\d+)?\b/i, className: 'fabric-hl-number' },
  ];

  const SQL_TOKENS = [
    // Comments
    { pattern: /--.*$/m, className: 'fabric-hl-comment' },
    // Strings
    { pattern: /'(?:[^'\\]|\\.)*'/, className: 'fabric-hl-string' },
    // SQL keywords
    { pattern: /\b(?:SELECT|FROM|WHERE|AND|OR|NOT|IN|ON|AS|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|VIEW|INDEX|TEMPORARY|TEMP|IF|EXISTS|REPLACE|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|BETWEEN|LIKE|IS|NULL|WITH|OVER|PARTITION|ROW|ROWS|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT|CAST|COALESCE|NULLIF|USING|IFNULL|FORMAT)\b/i, className: 'fabric-hl-sql-keyword' },
    // SQL functions (followed by parenthesis)
    { pattern: /\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|IFNULL|CONCAT|SUBSTRING|TRIM|UPPER|LOWER|LENGTH|ROUND|FLOOR|CEIL|ABS|NOW|DATE|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|FIRST_VALUE|LAST_VALUE|NTH_VALUE)(?=\s*\()/i, className: 'fabric-hl-sql-function' },
    // Data types
    { pattern: /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|VARCHAR|CHAR|TEXT|STRING|BOOLEAN|DATE|TIMESTAMP|DATETIME|BINARY|VARBINARY|ARRAY|MAP|STRUCT)\b/i, className: 'fabric-hl-sql-type' },
    // Numbers
    { pattern: /\b\d+\.?\d*\b/, className: 'fabric-hl-number' },
  ];

  // ---------------------------------------------------------------------------
  // Toggle raw view (blob page)
  // ---------------------------------------------------------------------------

  function toggleRawView(container, btn) {
    if (btn.textContent === 'Show Raw') {
      container.querySelector('.fabric-notebook-cells-wrap').style.display =
        'none';
      if (originalContent) {
        originalContent.style.display = '';
      }
      btn.textContent = 'Show Notebook';
    } else {
      container.querySelector('.fabric-notebook-cells-wrap').style.display = '';
      if (originalContent) {
        originalContent.style.display = 'none';
      }
      btn.textContent = 'Show Raw';
    }
  }

  // ---------------------------------------------------------------------------
  // Blob page injection
  // ---------------------------------------------------------------------------

  function injectBlob() {
    const currentUrl = location.href;

    if (document.querySelector('.fabric-notebook') && injectedUrl === currentUrl)
      return;

    if (!location.pathname.includes('/blob/')) return;

    const rawText = getRawText();
    if (!rawText) return;

    const notebook = parseNotebook(rawText);
    if (!notebook.cells.length) return;

    cleanup();

    const notebookEl = renderNotebook(notebook);

    // Add toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'fabric-toggle-raw';
    toggleBtn.textContent = 'Show Raw';
    toggleBtn.addEventListener('click', () => {
      toggleRawView(notebookEl, toggleBtn);
    });
    notebookEl.querySelector('.fabric-notebook-header').appendChild(toggleBtn);

    // Wrap cells for toggle
    const cellsWrap = document.createElement('div');
    cellsWrap.className = 'fabric-notebook-cells-wrap';
    while (notebookEl.children.length > 1) {
      cellsWrap.appendChild(notebookEl.children[1]);
    }
    notebookEl.appendChild(cellsWrap);

    const codeContainer = findCodeContainer();
    if (!codeContainer) {
      console.log('[Fabric Notebook] Could not find code container to replace');
      return;
    }

    const parent = codeContainer.parentElement;
    if (!parent) return;

    originalContent = codeContainer;
    codeContainer.style.display = 'none';
    parent.insertBefore(notebookEl, codeContainer);
    injectedUrl = currentUrl;
    _hasInjected = true;

    console.log(
      '[Fabric Notebook] Rendered blob notebook with ' +
        notebook.cells.length +
        ' cells'
    );
  }

  // ---------------------------------------------------------------------------
  // PR Diff view — fetch both file versions and render cell-level diff
  // ---------------------------------------------------------------------------

  function isNotebookPath(path) {
    if (!path) return false;
    const lower = path.toLowerCase();
    return lower.endsWith('.py') && lower.includes('notebook-content');
  }

  function formatCellType(blockType) {
    const names = {
      CELL: 'Code Cell',
      MARKDOWN: 'Markdown',
      PARAMETERS: 'Parameters',
      METADATA: 'Metadata',
    };
    return names[blockType] || blockType;
  }

  // Extract PR info from the current URL
  function parsePRUrl() {
    const m = location.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    return { repo: m[1], prNumber: m[2] };
  }

  // Fetch raw file content from GitHub for a given ref (SHA or branch).
  // Uses github.com/raw endpoint (same-origin) so session cookies are sent
  // automatically — works for private repos without needing a token.
  async function fetchRawFile(repo, path, ref) {
    const url = 'https://github.com/' + repo + '/raw/' + ref + '/' + path;
    try {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // PR diff data extraction — find changed notebook files and their commit OIDs
  // ---------------------------------------------------------------------------

  // Returns array of { path, oldOid, newOid } for notebook files changed in this PR.
  // Uses diffContents as primary source (has per-file OIDs and only contains
  // files that actually changed), with DOM fallbacks.
  function getPRDiffFiles() {
    const results = [];

    // Strategy 1: Extract from diffContents in embedded JSON
    // diffContents only contains entries for files actually changed in the PR,
    // unlike diffSummaries which can contain the entire repo's file listing.
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      try {
        const text = script.textContent;
        if (!text || text.length < 100) continue;
        if (!text.includes('diffContents')) continue;
        const data = JSON.parse(text);
        const allContents = [];
        findAllDiffContents(data, 0, allContents);

        // Pick the diffContents array that looks like the PR's actual changes:
        // - Has entries with path and commit OIDs
        // - Prefer smaller arrays (the PR's changed files, not a full tree listing)
        let best = null;
        for (const contents of allContents) {
          if (!Array.isArray(contents) || contents.length === 0) continue;
          // Must have at least one entry with a path
          const hasPath = contents.some(function (c) { return c && c.path; });
          if (!hasPath) continue;
          if (!best || contents.length < best.length) {
            best = contents;
          }
        }

        if (best) {
          for (const entry of best) {
            if (!entry || !entry.path) continue;
            if (!isNotebookPath(entry.path)) continue;
            results.push({
              path: entry.path,
              oldOid: entry.oldCommitOid || null,
              newOid: entry.newCommitOid || null,
            });
          }
          if (results.length > 0) {
            console.log('[Fabric Notebook] Found ' + results.length + ' notebook file(s) from diffContents:', results.map(function (r) { return r.path; }));
            return results;
          }
        }
      } catch { /* ignore */ }
    }

    // Strategy 2: Use diffSummaries but cross-reference with diffContents count
    // Only accept diffSummaries that are siblings of a small diffContents array
    for (const script of scripts) {
      try {
        const text = script.textContent;
        if (!text || !text.includes('diffSummaries')) continue;
        const data = JSON.parse(text);
        const found = findMatchedDiffSummaries(data, 0);
        if (found) {
          for (const s of found.summaries) {
            if (s.path && isNotebookPath(s.path)) {
              results.push({
                path: s.path,
                oldOid: found.baseOid || null,
                newOid: found.headOid || null,
              });
            }
          }
          if (results.length > 0) {
            console.log('[Fabric Notebook] Found ' + results.length + ' notebook file(s) from diffSummaries:', results.map(function (r) { return r.path; }));
            return results;
          }
        }
      } catch { /* ignore */ }
    }

    // Strategy 3: DOM fallbacks
    const domPaths = getNotebookPathsFromDOM();
    if (domPaths.length > 0) {
      // No per-file OIDs available from DOM, caller must use comparison-level SHAs
      for (const p of domPaths) {
        results.push({ path: p, oldOid: null, newOid: null });
      }
      console.log('[Fabric Notebook] Found ' + results.length + ' notebook file(s) from DOM:', domPaths);
    }

    return results;
  }

  // Recursively collect all diffContents arrays found in the JSON
  function findAllDiffContents(obj, depth, collector) {
    if (depth > 10 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.diffContents)) {
      collector.push(obj.diffContents);
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        findAllDiffContents(obj[key], depth + 1, collector);
      }
    }
  }

  // Find diffSummaries that are sibling of a small diffContents (actual PR changes)
  // Returns { summaries, baseOid, headOid } or null
  function findMatchedDiffSummaries(obj, depth) {
    if (depth > 10 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj.diffSummaries) && Array.isArray(obj.diffContents)) {
      // The diffContents array size tells us how many files actually changed.
      // If diffSummaries is much larger than diffContents, this is the wrong payload.
      // A reasonable PR typically changes < 200 files; diffContents should be similar size.
      var ratio = obj.diffSummaries.length / Math.max(obj.diffContents.length, 1);
      if (ratio <= 3) {
        // Looks reasonable — diffSummaries is about the same size as diffContents
        var baseOid = null;
        var headOid = null;
        if (obj.comparison) {
          baseOid = obj.comparison.baseOid;
          headOid = obj.comparison.headOid;
        }
        if (obj.diffContents.length > 0 && obj.diffContents[0]) {
          // Per-file OIDs are more reliable
          baseOid = baseOid || obj.diffContents[0].oldCommitOid;
          headOid = headOid || obj.diffContents[0].newCommitOid;
        }
        return { summaries: obj.diffSummaries, baseOid: baseOid, headOid: headOid };
      }
    }

    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const result = findMatchedDiffSummaries(obj[key], depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  // Extract notebook paths from DOM elements (fallback)
  function getNotebookPathsFromDOM() {
    const files = [];

    // File header links in the diff view
    const fileLinks = document.querySelectorAll(
      '[id^="diff-"] h3 a code, [class*="file-name"] a code, [class*="file-path"] code'
    );
    for (const el of fileLinks) {
      const path = el.textContent.replace(/[\u200e\u200f\u200b]/g, '').trim();
      if (isNotebookPath(path)) files.push(path);
    }

    // data-tagsearch-path attributes
    if (files.length === 0) {
      const tagged = document.querySelectorAll('[data-tagsearch-path]');
      for (const el of tagged) {
        const path = el.getAttribute('data-tagsearch-path');
        if (path && isNotebookPath(path)) files.push(path);
      }
    }

    // File tree items in the PR diff sidebar
    if (files.length === 0) {
      const treeLinks = document.querySelectorAll('[id^="diff-"] a[href^="#diff-"]');
      for (const a of treeLinks) {
        const path = a.textContent.replace(/[\u200e\u200f\u200b]/g, '').trim();
        if (isNotebookPath(path)) files.push(path);
      }
    }

    return [...new Set(files)];
  }

  // Get comparison-level base/head SHAs (fallback when per-file OIDs aren't available)
  function getPRShas() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      try {
        const text = script.textContent;
        if (!text || text.length < 100) continue;
        if (!text.includes('baseOid') && !text.includes('base_sha') && !text.includes('headOid')) continue;
        const data = JSON.parse(text);
        const shas = findShasInData(data, 0);
        if (shas) {
          console.log('[Fabric Notebook] Found SHAs:', shas.base.substring(0, 8), shas.head.substring(0, 8));
          return shas;
        }
      } catch { /* ignore */ }
    }

    const baseInput = document.querySelector('input[name="base_sha"], [data-base-sha]');
    const headInput = document.querySelector('input[name="head_sha"], [data-head-sha]');
    if (baseInput && headInput) {
      return {
        base: baseInput.value || baseInput.getAttribute('data-base-sha'),
        head: headInput.value || headInput.getAttribute('data-head-sha'),
      };
    }

    const compareEl = document.querySelector('.commit-range, [data-commit-range]');
    if (compareEl) {
      const range = compareEl.textContent || compareEl.getAttribute('data-commit-range') || '';
      const parts = range.split('...');
      if (parts.length === 2) return { base: parts[0].trim(), head: parts[1].trim() };
      const parts2 = range.split('..');
      if (parts2.length === 2) return { base: parts2[0].trim(), head: parts2[1].trim() };
    }

    return null;
  }

  // Recursively search JSON data for base/head OIDs
  function findShasInData(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;

    if (obj.comparison && obj.comparison.baseOid && obj.comparison.headOid) {
      return { base: obj.comparison.baseOid, head: obj.comparison.headOid };
    }
    if (obj.fullDiff && obj.fullDiff.baseOid && obj.fullDiff.headOid) {
      return { base: obj.fullDiff.baseOid, head: obj.fullDiff.headOid };
    }
    if (obj.baseOid && obj.headOid) {
      return { base: obj.baseOid, head: obj.headOid };
    }
    if (Array.isArray(obj.diffContents) && obj.diffContents.length > 0) {
      const first = obj.diffContents[0];
      if (first && first.oldCommitOid && first.newCommitOid) {
        return { base: first.oldCommitOid, head: first.newCommitOid };
      }
    }

    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const result = findShasInData(obj[key], depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  // Fetch PR SHAs from GitHub API as last resort
  async function fetchPRShas(repo, prNumber) {
    try {
      const resp = await fetch('https://api.github.com/repos/' + repo + '/pulls/' + prNumber, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return { base: data.base.sha, head: data.head.sha };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Diff computation — simple line-level LCS diff
  // ---------------------------------------------------------------------------

  function computeLineDiff(oldLines, newLines) {
    // Myers-like LCS diff returning array of {type, oldLine, newLine, text}
    const oldLen = oldLines.length;
    const newLen = newLines.length;

    // Build LCS table (optimized for reasonable sizes)
    if (oldLen * newLen > 250000) {
      // Fallback for very large diffs: simple sequential comparison
      return simpleDiff(oldLines, newLines);
    }

    const dp = [];
    for (let i = 0; i <= oldLen; i++) {
      dp[i] = new Array(newLen + 1).fill(0);
    }
    for (let i = 1; i <= oldLen; i++) {
      for (let j = 1; j <= newLen; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to produce diff
    const result = [];
    let i = oldLen;
    let j = newLen;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        result.unshift({ type: 'equal', oldIdx: i, newIdx: j, text: oldLines[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift({ type: 'add', oldIdx: null, newIdx: j, text: newLines[j - 1] });
        j--;
      } else {
        result.unshift({ type: 'remove', oldIdx: i, newIdx: null, text: oldLines[i - 1] });
        i--;
      }
    }
    return result;
  }

  function simpleDiff(oldLines, newLines) {
    // For very large files, just mark everything as changed
    const result = [];
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
      if (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
        result.push({ type: 'equal', oldIdx: i + 1, newIdx: i + 1, text: oldLines[i] });
      } else {
        if (i < oldLines.length) {
          result.push({ type: 'remove', oldIdx: i + 1, newIdx: null, text: oldLines[i] });
        }
        if (i < newLines.length) {
          result.push({ type: 'add', oldIdx: null, newIdx: i + 1, text: newLines[i] });
        }
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Cell-level diff: match old cells to new cells and produce diff pairs
  // ---------------------------------------------------------------------------

  function matchCells(oldCells, newCells) {
    // Produce an array of {old, new, status} where status is
    // 'unchanged', 'modified', 'added', 'removed'
    // Use content-based matching with LCS on cell content signatures

    const oldSigs = oldCells.map(cellSignature);
    const newSigs = newCells.map(cellSignature);

    // LCS on cell signatures
    const oldLen = oldSigs.length;
    const newLen = newSigs.length;
    const dp = [];
    for (let i = 0; i <= oldLen; i++) {
      dp[i] = new Array(newLen + 1).fill(0);
    }
    for (let i = 1; i <= oldLen; i++) {
      for (let j = 1; j <= newLen; j++) {
        if (oldSigs[i - 1] === newSigs[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack
    const pairs = [];
    let i = oldLen;
    let j = newLen;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldSigs[i - 1] === newSigs[j - 1]) {
        // Content identical — check metadata
        const metaChanged = JSON.stringify(oldCells[i - 1].metadata) !== JSON.stringify(newCells[j - 1].metadata);
        pairs.unshift({
          old: oldCells[i - 1],
          new: newCells[j - 1],
          status: metaChanged ? 'meta-changed' : 'unchanged',
          oldIndex: i - 1,
          newIndex: j - 1,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        // Check if this is a modification (types match and content is similar)
        if (i > 0 && oldCells[i - 1].type === newCells[j - 1].type && contentSimilarity(oldCells[i - 1].content, newCells[j - 1].content) > 0.3) {
          pairs.unshift({
            old: oldCells[i - 1],
            new: newCells[j - 1],
            status: 'modified',
            oldIndex: i - 1,
            newIndex: j - 1,
          });
          i--;
          j--;
        } else {
          pairs.unshift({
            old: null,
            new: newCells[j - 1],
            status: 'added',
            oldIndex: null,
            newIndex: j - 1,
          });
          j--;
        }
      } else {
        pairs.unshift({
          old: oldCells[i - 1],
          new: null,
          status: 'removed',
          oldIndex: i - 1,
          newIndex: null,
        });
        i--;
      }
    }
    return pairs;
  }

  function cellSignature(cell) {
    return cell.type + '::' + cell.content;
  }

  function contentSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    // Quick Jaccard similarity on lines
    const aLines = new Set(a.split('\n'));
    const bLines = new Set(b.split('\n'));
    let intersection = 0;
    for (const line of aLines) {
      if (bLines.has(line)) intersection++;
    }
    const union = aLines.size + bLines.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // ---------------------------------------------------------------------------
  // Diff renderer — side-by-side per-cell diff cards
  // ---------------------------------------------------------------------------

  function renderDiffNotebook(oldNotebook, newNotebook) {
    const container = document.createElement('div');
    container.className = 'fabric-notebook fabric-diff-notebook';

    // Header
    const header = document.createElement('div');
    header.className = 'fabric-notebook-header';
    const title = document.createElement('span');
    title.className = 'fabric-notebook-title';
    title.textContent = 'Fabric Notebook Diff';
    header.appendChild(title);

    // Stats
    const stats = document.createElement('span');
    stats.className = 'fabric-notebook-badges';
    const oldCount = document.createElement('span');
    oldCount.className = 'fabric-badge';
    oldCount.textContent = (oldNotebook ? oldNotebook.cells.length : 0) + ' cells (base)';
    stats.appendChild(oldCount);
    const newCount = document.createElement('span');
    newCount.className = 'fabric-badge';
    newCount.textContent = (newNotebook ? newNotebook.cells.length : 0) + ' cells (head)';
    stats.appendChild(newCount);
    header.appendChild(stats);
    container.appendChild(header);

    // Notebook-level metadata diff
    if (oldNotebook && newNotebook && oldNotebook.metadata && newNotebook.metadata) {
      const oldMeta = JSON.stringify(oldNotebook.metadata, null, 2);
      const newMeta = JSON.stringify(newNotebook.metadata, null, 2);
      if (oldMeta !== newMeta) {
        container.appendChild(renderMetadataDiffCard(oldNotebook.metadata, newNotebook.metadata, 'Notebook Metadata'));
      }
    }

    // Handle cases where one side is null (new file / deleted file)
    const oldCells = oldNotebook ? oldNotebook.cells : [];
    const newCells = newNotebook ? newNotebook.cells : [];

    if (oldCells.length === 0 && newCells.length > 0) {
      // Entirely new file
      newCells.forEach(function (cell, idx) {
        container.appendChild(renderDiffCellCard(null, cell, 'added', null, idx));
      });
    } else if (newCells.length === 0 && oldCells.length > 0) {
      // Entirely deleted file
      oldCells.forEach(function (cell, idx) {
        container.appendChild(renderDiffCellCard(cell, null, 'removed', idx, null));
      });
    } else {
      // Match cells and render pairs
      const pairs = matchCells(oldCells, newCells);
      for (const pair of pairs) {
        container.appendChild(renderDiffCellCard(pair.old, pair.new, pair.status, pair.oldIndex, pair.newIndex));
      }
    }

    return container;
  }

  function renderMetadataDiffCard(oldMeta, newMeta, title) {
    const card = document.createElement('div');
    card.className = 'fabric-cell fabric-diff-cell fabric-diff-cell-meta-changed';

    const header = document.createElement('div');
    header.className = 'fabric-cell-header fabric-diff-cell-header-meta';
    header.style.cursor = 'pointer';

    const arrow = document.createElement('span');
    arrow.className = 'fabric-meta-arrow';
    arrow.textContent = '\u25B6';
    header.appendChild(arrow);

    const label = document.createElement('span');
    label.className = 'fabric-cell-type';
    label.textContent = title || 'Metadata Changed';
    header.appendChild(label);

    const body = document.createElement('div');
    body.className = 'fabric-cell-body fabric-meta-diff-body';
    body.style.display = 'none';

    const oldStr = JSON.stringify(oldMeta, null, 2);
    const newStr = JSON.stringify(newMeta, null, 2);
    const diffLines = computeLineDiff(oldStr.split('\n'), newStr.split('\n'));
    body.appendChild(renderSideBySideDiff(diffLines, 'json'));

    header.addEventListener('click', function () {
      const visible = body.style.display !== 'none';
      body.style.display = visible ? 'none' : '';
      arrow.textContent = visible ? '\u25B6' : '\u25BC';
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function renderDiffCellCard(oldCell, newCell, status, oldIndex, newIndex) {
    const card = document.createElement('div');
    card.className = 'fabric-cell fabric-diff-cell fabric-diff-cell-' + status;

    const header = document.createElement('div');
    header.className = 'fabric-cell-header';

    // Index labels
    const indexLabel = document.createElement('span');
    indexLabel.className = 'fabric-cell-index';
    if (oldIndex !== null && newIndex !== null) {
      indexLabel.textContent = '[' + (oldIndex + 1) + '] \u2192 [' + (newIndex + 1) + ']';
    } else if (newIndex !== null) {
      indexLabel.textContent = '[' + (newIndex + 1) + ']';
    } else if (oldIndex !== null) {
      indexLabel.textContent = '[' + (oldIndex + 1) + ']';
    }
    header.appendChild(indexLabel);

    // Cell type
    const cell = newCell || oldCell;
    const typeLabel = document.createElement('span');
    typeLabel.className = 'fabric-cell-type';
    if (cell.type === 'markdown') {
      typeLabel.textContent = 'Markdown';
    } else if (cell.type === 'run') {
      typeLabel.textContent = 'Run';
    } else if (cell.isParameters) {
      typeLabel.textContent = 'Parameters';
    } else {
      typeLabel.textContent = formatLanguage(cell.language);
    }
    header.appendChild(typeLabel);

    // Status badge
    const statusBadge = document.createElement('span');
    statusBadge.className = 'fabric-diff-status fabric-diff-status-' + status;
    const statusLabels = {
      unchanged: 'Unchanged',
      modified: 'Modified',
      added: 'Added',
      removed: 'Removed',
      'meta-changed': 'Metadata Changed',
    };
    statusBadge.textContent = statusLabels[status] || status;
    header.appendChild(statusBadge);

    // Collapse/expand toggle
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'fabric-diff-collapse-btn';
    collapseBtn.setAttribute('aria-label', 'Toggle cell');
    var startCollapsed = (status === 'unchanged') && _settings.collapseUnchanged;
    collapseBtn.textContent = startCollapsed ? '\u25B6' : '\u25BC';  // ▶ or ▼
    header.appendChild(collapseBtn);

    // Make entire header clickable for collapse
    header.style.cursor = 'pointer';
    header.addEventListener('click', function (e) {
      // Don't collapse if clicking other interactive elements inside header
      if (e.target.closest('a, input, select')) return;
      var isCollapsed = body.style.display === 'none';
      body.style.display = isCollapsed ? '' : 'none';
      collapseBtn.textContent = isCollapsed ? '\u25BC' : '\u25B6';
      card.classList.toggle('fabric-diff-cell-collapsed', !isCollapsed);
    });

    card.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'fabric-cell-body';

    // Unchanged cells start collapsed
    if (startCollapsed) {
      body.style.display = 'none';
      card.classList.add('fabric-diff-cell-collapsed');
    }

    if (status === 'unchanged') {
      // Render single version (no diff)
      if (cell.type === 'markdown') {
        const mdDiv = document.createElement('div');
        mdDiv.className = 'fabric-markdown-rendered';
        mdDiv.innerHTML = marked.parse(cell.content);
        body.appendChild(mdDiv);
      } else if (cell.type === 'run') {
        const runEl = document.createElement('div');
        runEl.className = 'fabric-run-ref';
        runEl.innerHTML = '<span class="fabric-run-icon">&#9654;</span> <code>' + escapeHtml(cell.content) + '</code>';
        body.appendChild(runEl);
      } else {
        body.appendChild(renderCodeBlock(cell.content, cell.language));
      }
    } else if (status === 'meta-changed') {
      // Content is the same, render it once; show metadata diff collapsible
      if (cell.type === 'markdown') {
        const mdDiv = document.createElement('div');
        mdDiv.className = 'fabric-markdown-rendered';
        mdDiv.innerHTML = marked.parse(cell.content);
        body.appendChild(mdDiv);
      } else {
        body.appendChild(renderCodeBlock(cell.content, cell.language));
      }
      // Collapsible metadata section
      if (oldCell && newCell && oldCell.metadata && newCell.metadata) {
        body.appendChild(renderMetadataDiffCard(oldCell.metadata, newCell.metadata, 'Cell Metadata'));
      }
    } else if (status === 'added') {
      // Show only new version, all green
      if (newCell.type === 'markdown') {
        const mdDiv = document.createElement('div');
        mdDiv.className = 'fabric-markdown-rendered fabric-diff-added-block';
        mdDiv.innerHTML = marked.parse(newCell.content);
        body.appendChild(mdDiv);
      } else {
        body.appendChild(renderDiffCodeBlockSingleSide(newCell.content, newCell.language, 'add'));
      }
    } else if (status === 'removed') {
      // Show only old version, all red
      if (oldCell.type === 'markdown') {
        const mdDiv = document.createElement('div');
        mdDiv.className = 'fabric-markdown-rendered fabric-diff-removed-block';
        mdDiv.innerHTML = marked.parse(oldCell.content);
        body.appendChild(mdDiv);
      } else {
        body.appendChild(renderDiffCodeBlockSingleSide(oldCell.content, oldCell.language, 'remove'));
      }
    } else if (status === 'modified') {
      // Side-by-side diff
      if (oldCell.type === 'markdown' && newCell.type === 'markdown') {
        // For markdown, show rendered old/new side by side and also a code diff
        const diffLines = computeLineDiff(
          oldCell.content.split('\n'),
          newCell.content.split('\n')
        );
        body.appendChild(renderSideBySideDiff(diffLines, oldCell.language || 'markdown'));
      } else {
        const diffLines = computeLineDiff(
          (oldCell.content || '').split('\n'),
          (newCell.content || '').split('\n')
        );
        body.appendChild(renderSideBySideDiff(diffLines, newCell.language || oldCell.language));
      }
      // Metadata diff if metadata also changed
      if (oldCell.metadata && newCell.metadata && JSON.stringify(oldCell.metadata) !== JSON.stringify(newCell.metadata)) {
        body.appendChild(renderMetadataDiffCard(oldCell.metadata, newCell.metadata, 'Cell Metadata'));
      }
    }

    card.appendChild(body);
    return card;
  }

  // Render a single-side code block (all added or all removed)
  function renderDiffCodeBlockSingleSide(content, language, diffType) {
    const lines = content.split('\n');
    const container = document.createElement('div');
    container.className = 'fabric-code-block fabric-diff-single-side';

    const table = document.createElement('table');
    table.className = 'fabric-code-table';
    const tbody = document.createElement('tbody');

    lines.forEach(function (lineText, i) {
      const tr = document.createElement('tr');
      tr.className = 'fabric-code-row fabric-diff-line-' + diffType;

      const tdMarker = document.createElement('td');
      tdMarker.className = 'fabric-diff-marker';
      tdMarker.textContent = diffType === 'add' ? '+' : '-';
      tr.appendChild(tdMarker);

      const tdNum = document.createElement('td');
      tdNum.className = 'fabric-line-num';
      tdNum.textContent = i + 1;
      tr.appendChild(tdNum);

      const tdCode = document.createElement('td');
      tdCode.className = 'fabric-line-code';
      tdCode.innerHTML = highlightCode(lineText, language);
      tr.appendChild(tdCode);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
    return container;
  }

  // Split side-by-side rows into visible/collapsed segments.
  // Keeps `context` lines above and below each changed region; collapses
  // long runs of unchanged lines in between.
  // These are re-read from _settings on each call to segmentRows so the
  // options page takes effect without a page reload.
  function getDiffContextLines() { return _settings.contextLines || 3; }
  function getDiffMinCollapse() { return 2 * getDiffContextLines() + 2; }

  function segmentRows(rows) {
    // 1. Mark each row as changed or equal
    var isChanged = rows.map(function (r) {
      var lt = r.left ? r.left.type : null;
      var rt = r.right ? r.right.type : null;
      return lt !== 'equal' || rt !== 'equal';
    });

    // 2. For each row, compute whether it's within CONTEXT lines of a change
    var keep = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) keep[i] = false;

    for (var i = 0; i < rows.length; i++) {
      if (isChanged[i]) {
        // Mark context window around this change
        var lo = Math.max(0, i - getDiffContextLines());
        var hi = Math.min(rows.length - 1, i + getDiffContextLines());
        for (var j = lo; j <= hi; j++) keep[j] = true;
      }
    }

    // If there are no changes at all, keep all rows
    var hasAnyChange = isChanged.some(function (c) { return c; });
    if (!hasAnyChange) {
      return [{ type: 'visible', rows: rows }];
    }

    // 3. Build segments
    var segments = [];
    var currentVisible = [];
    var currentCollapsed = [];

    for (var i = 0; i < rows.length; i++) {
      if (keep[i]) {
        if (currentCollapsed.length > 0) {
          // Only actually collapse if enough lines; otherwise just show them
          if (currentCollapsed.length >= getDiffMinCollapse()) {
            segments.push({ type: 'collapsed', rows: currentCollapsed, count: currentCollapsed.length });
          } else {
            // Too few to collapse — merge into visible
            currentVisible = currentVisible.concat(currentCollapsed);
          }
          currentCollapsed = [];
        }
        currentVisible.push(rows[i]);
      } else {
        if (currentVisible.length > 0) {
          segments.push({ type: 'visible', rows: currentVisible });
          currentVisible = [];
        }
        currentCollapsed.push(rows[i]);
      }
    }
    // Flush remaining
    if (currentCollapsed.length > 0) {
      if (currentCollapsed.length >= getDiffMinCollapse()) {
        segments.push({ type: 'collapsed', rows: currentCollapsed, count: currentCollapsed.length });
      } else {
        currentVisible = currentVisible.concat(currentCollapsed);
      }
    }
    if (currentVisible.length > 0) {
      segments.push({ type: 'visible', rows: currentVisible });
    }

    return segments;
  }

  // Render a single diff table row (shared by visible and collapsed sections)
  function renderDiffTableRow(row, language) {
    var tr = document.createElement('tr');
    tr.className = 'fabric-code-row';

    // Left side (old)
    var tdNumL = document.createElement('td');
    tdNumL.className = 'fabric-line-num fabric-diff-num-left';
    var tdCodeL = document.createElement('td');
    tdCodeL.className = 'fabric-line-code fabric-diff-code-left';

    if (row.left) {
      tdNumL.textContent = row.left.lineNum;
      tdCodeL.innerHTML = highlightCode(row.left.text, language);
      if (row.left.type === 'remove') {
        tr.classList.add('fabric-diff-row-has-remove');
        tdNumL.classList.add('fabric-diff-num-remove');
        tdCodeL.classList.add('fabric-diff-code-remove');
      }
    } else {
      tdNumL.classList.add('fabric-diff-empty');
      tdCodeL.classList.add('fabric-diff-empty');
    }
    tr.appendChild(tdNumL);
    tr.appendChild(tdCodeL);

    // Gutter
    var gutter = document.createElement('td');
    gutter.className = 'fabric-diff-gutter';
    tr.appendChild(gutter);

    // Right side (new)
    var tdNumR = document.createElement('td');
    tdNumR.className = 'fabric-line-num fabric-diff-num-right';
    var tdCodeR = document.createElement('td');
    tdCodeR.className = 'fabric-line-code fabric-diff-code-right';

    if (row.right) {
      tdNumR.textContent = row.right.lineNum;
      tdCodeR.innerHTML = highlightCode(row.right.text, language);
      if (row.right.type === 'add') {
        tr.classList.add('fabric-diff-row-has-add');
        tdNumR.classList.add('fabric-diff-num-add');
        tdCodeR.classList.add('fabric-diff-code-add');
      }
    } else {
      tdNumR.classList.add('fabric-diff-empty');
      tdCodeR.classList.add('fabric-diff-empty');
    }
    tr.appendChild(tdNumR);
    tr.appendChild(tdCodeR);

    return tr;
  }

  // Render side-by-side diff table with collapsible unchanged regions.
  // Uses a single <tbody> to avoid table layout quirks with multiple tbody elements.
  function renderSideBySideDiff(diffLines, language) {
    const container = document.createElement('div');
    container.className = 'fabric-diff-side-by-side';

    const table = document.createElement('table');
    table.className = 'fabric-code-table fabric-diff-table';

    // Explicit <colgroup> so table-layout:fixed respects column widths
    // even when the first row is an expand-row with uniform cells.
    var colgroup = document.createElement('colgroup');
    var colWidths = ['42px', '', '4px', '42px', ''];  // numL, codeL, gutter, numR, codeR
    for (var ci = 0; ci < colWidths.length; ci++) {
      var col = document.createElement('col');
      if (colWidths[ci]) col.style.width = colWidths[ci];
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const tbody = document.createElement('tbody');

    const rows = buildSideBySideRows(diffLines);
    const segments = segmentRows(rows);

    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];

      if (seg.type === 'visible') {
        for (var r = 0; r < seg.rows.length; r++) {
          tbody.appendChild(renderDiffTableRow(seg.rows[r], language));
        }
      } else {
        // Expand-row button — uses same 5-column structure to preserve
        // table-layout:fixed column widths (colspan breaks fixed layout)
        var expandTr = document.createElement('tr');
        expandTr.className = 'fabric-diff-expand-row';
        for (var c = 0; c < 5; c++) {
          var td = document.createElement('td');
          td.className = 'fabric-diff-expand-cell';
          if (c === 1) {
            // Put the label in the left code column, spanning visually across
            td.textContent = '\u22EF Show ' + seg.count + ' unchanged lines \u22EF';
            td.classList.add('fabric-diff-expand-label');
          }
          expandTr.appendChild(td);
        }
        tbody.appendChild(expandTr);

        // Hidden rows (individual <tr> with display:none)
        var hiddenRows = [];
        for (var r = 0; r < seg.rows.length; r++) {
          var tr = renderDiffTableRow(seg.rows[r], language);
          tr.style.display = 'none';
          tr.classList.add('fabric-diff-collapsed-row');
          tbody.appendChild(tr);
          hiddenRows.push(tr);
        }

        // Click handler — show hidden rows, remove the expand button
        (function (expRow, hidden) {
          expRow.addEventListener('click', function () {
            for (var i = 0; i < hidden.length; i++) {
              hidden[i].style.display = '';
            }
            expRow.remove();
          });
        })(expandTr, hiddenRows);
      }
    }

    table.appendChild(tbody);
    container.appendChild(table);
    return container;
  }

  function buildSideBySideRows(diffLines) {
    const rows = [];
    let i = 0;

    while (i < diffLines.length) {
      const line = diffLines[i];

      if (line.type === 'equal') {
        rows.push({
          left: { text: line.text, lineNum: line.oldIdx, type: 'equal' },
          right: { text: line.text, lineNum: line.newIdx, type: 'equal' },
        });
        i++;
      } else {
        // Collect consecutive removes and adds
        const removes = [];
        const adds = [];
        while (i < diffLines.length && diffLines[i].type === 'remove') {
          removes.push(diffLines[i]);
          i++;
        }
        while (i < diffLines.length && diffLines[i].type === 'add') {
          adds.push(diffLines[i]);
          i++;
        }
        // Pair them up side by side
        const maxLen = Math.max(removes.length, adds.length);
        for (let k = 0; k < maxLen; k++) {
          const row = { left: null, right: null };
          if (k < removes.length) {
            row.left = { text: removes[k].text, lineNum: removes[k].oldIdx, type: 'remove' };
          }
          if (k < adds.length) {
            row.right = { text: adds[k].text, lineNum: adds[k].newIdx, type: 'add' };
          }
          rows.push(row);
        }
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // PR Diff orchestrator — replaces GitHub's diff with notebook cell diff
  // ---------------------------------------------------------------------------

  let _diffInjectRunning = false;

  async function injectDiffs() {
    if (!location.pathname.match(/\/pull\/\d+\/(files|changes)/)) return;
    if (_diffInjectRunning) return;
    _diffInjectRunning = true;

    try {
      await _doInjectDiffs();
    } finally {
      _diffInjectRunning = false;
    }
  }

  // Cache for getPRDiffFiles — cleared on URL change
  var _cachedDiffFiles = null;
  var _cachedDiffFilesUrl = null;

  // Cache rendered notebook views by file path (survives React DOM re-renders
  // which destroy and recreate diff elements, losing any data stored on them).
  var _notebookViewCache = {};

  async function _doInjectDiffs() {
    const prInfo = parsePRUrl();
    if (!prInfo) return;

    // Cache getPRDiffFiles result per URL to avoid re-parsing JSON on every call.
    // Invalidate on URL change or if the cache was empty (JSON may not have loaded yet).
    var currentUrl = location.href;
    if (_cachedDiffFilesUrl !== currentUrl || !_cachedDiffFiles || _cachedDiffFiles.length === 0) {
      var freshFiles = getPRDiffFiles();
      if (freshFiles.length > 0) {
        _cachedDiffFiles = freshFiles;
        _cachedDiffFilesUrl = currentUrl;
      } else if (_cachedDiffFilesUrl !== currentUrl) {
        // New URL, no files found yet — clear stale cache
        _cachedDiffFiles = null;
        _cachedDiffFilesUrl = null;
        return;
      } else {
        return; // still no files on this URL
      }
    }
    const diffFiles = _cachedDiffFiles;

    // Pre-query all diff elements once (avoid re-querying per file)
    var allDiffEntries = document.querySelectorAll(
      '[id^="diff-"]:not(#diff-comparison-viewer-container):not(#diff-file-tree-filter):not(#diff-placeholder)'
    );

    // First pass: handle cached re-insertions and identify files that need fetching
    var toFetch = [];
    for (var fi = 0; fi < diffFiles.length; fi++) {
      var fileInfo = diffFiles[fi];
      var filePath = fileInfo.path;

      var diffEl = findDiffElementForFileCached(filePath, allDiffEntries);
      if (!diffEl) continue;
      if (diffEl.querySelector('.fabric-diff-notebook')) continue;

      // Re-use cached view if available (React may have destroyed & recreated
      // the diff element, so check path-based cache, not DOM properties)
      var cachedView = _notebookViewCache[filePath];
      if (cachedView) {
        // Remove any stale toggle from a previous diff element
        var staleToggle = diffEl.querySelector('.fabric-diff-toggle');
        if (staleToggle) staleToggle.remove();
        // Re-insert cached view and create fresh toggle
        var native = findNativeDiffBody(diffEl);
        if (native) {
          native.style.display = 'none';
          native.parentElement.insertBefore(cachedView, native);
        } else {
          var body = diffEl.children.length >= 2 ? diffEl.children[1] : diffEl;
          body.appendChild(cachedView);
        }
        cachedView.style.display = '';
        insertToggleButton(diffEl, cachedView, true);
        hookCollapseChevron(diffEl);
        continue;
      }
      // Remove any stale toggle left from a destroyed element
      var staleToggle2 = diffEl.querySelector('.fabric-diff-toggle');
      if (staleToggle2) staleToggle2.remove();
      toFetch.push({ fileInfo: fileInfo, diffEl: diffEl });
    }

    if (toFetch.length === 0) return;

    // Resolve SHAs once for all files that need them
    var fallbackShas = null;
    for (var i = 0; i < toFetch.length; i++) {
      var fi2 = toFetch[i].fileInfo;
      if (!fi2.oldOid || !fi2.newOid) {
        if (!fallbackShas) {
          fallbackShas = getPRShas();
          if (!fallbackShas) fallbackShas = await fetchPRShas(prInfo.repo, prInfo.prNumber);
        }
        break;
      }
    }

    // Parallel fetch: kick off ALL file fetches concurrently (max 6 parallel)
    var fetchPromises = toFetch.map(function (item) {
      var baseRef = item.fileInfo.oldOid || (fallbackShas && fallbackShas.base);
      var headRef = item.fileInfo.newOid || (fallbackShas && fallbackShas.head);
      if (!baseRef && !headRef) return Promise.resolve(null);

      return Promise.all([
        baseRef ? fetchRawFile(prInfo.repo, item.fileInfo.path, baseRef) : Promise.resolve(null),
        headRef ? fetchRawFile(prInfo.repo, item.fileInfo.path, headRef) : Promise.resolve(null),
      ]).then(function (results) {
        return { item: item, oldText: results[0], newText: results[1] };
      });
    });

    var fetched = await Promise.all(fetchPromises);

    // Render all fetched notebooks (sequential DOM operations, but data is ready)
    for (var r = 0; r < fetched.length; r++) {
      var result = fetched[r];
      if (!result) continue;

      var diffEl = result.item.diffEl;
      var filePath = result.item.fileInfo.path;
      var oldText = result.oldText;
      var newText = result.newText;

      // Re-check guard (another run may have injected while we were fetching)
      if (diffEl.querySelector('.fabric-diff-notebook')) continue;

      var oldIsNotebook = oldText && isFabricNotebook(oldText);
      var newIsNotebook = newText && isFabricNotebook(newText);
      if (!oldIsNotebook && !newIsNotebook) continue;

      var oldNotebook = oldIsNotebook ? parseNotebook(oldText) : null;
      var newNotebook = newIsNotebook ? parseNotebook(newText) : null;

      var diffView = renderDiffNotebook(oldNotebook, newNotebook);
      _notebookViewCache[filePath] = diffView;

      // Insert notebook, toggle button, and collapse hook
      var showNotebook = _settings.defaultView !== 'raw';
      var nativeDiffBody = findNativeDiffBody(diffEl);
      if (nativeDiffBody) {
        nativeDiffBody.style.display = showNotebook ? 'none' : '';
        nativeDiffBody.parentElement.insertBefore(diffView, nativeDiffBody);
      } else {
        var bodyContainer = diffEl.children.length >= 2 ? diffEl.children[1] : diffEl;
        bodyContainer.appendChild(diffView);
      }
      if (!showNotebook) diffView.style.display = 'none';
      insertToggleButton(diffEl, diffView, showNotebook);
      hookCollapseChevron(diffEl);

      _hasInjected = true;
      console.log('[Fabric Notebook] Rendered diff for ' + filePath + ' (' +
        (oldNotebook ? oldNotebook.cells.length : 0) + ' old cells, ' +
        (newNotebook ? newNotebook.cells.length : 0) + ' new cells)');
    }
  }

  // Create and insert a toggle button into the diff element's file header
  function insertToggleButton(diffEl, diffView, active) {
    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'fabric-diff-toggle';
    toggleBtn.innerHTML = '<span class="fabric-diff-toggle-icon">&#128211;</span> Notebook';
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggleBtn.title = 'Toggle between Notebook view and raw diff';
    if (active) toggleBtn.classList.add('fabric-diff-toggle-active');

    (function (theDiffEl, theView, theBtn) {
      theBtn.addEventListener('click', function () {
        var native = findNativeDiffBody(theDiffEl);
        var isShowingNotebook = theView.style.display !== 'none';
        if (isShowingNotebook) {
          theView.style.display = 'none';
          if (native) native.style.display = '';
          theBtn.setAttribute('aria-pressed', 'false');
          theBtn.classList.remove('fabric-diff-toggle-active');
        } else {
          theView.style.display = '';
          if (native) native.style.display = 'none';
          theBtn.setAttribute('aria-pressed', 'true');
          theBtn.classList.add('fabric-diff-toggle-active');
        }
      });
    })(diffEl, diffView, toggleBtn);

    var actionsBar = findFileActionsBar(diffEl);
    if (actionsBar) {
      actionsBar.insertBefore(toggleBtn, actionsBar.firstChild);
    } else {
      diffView.querySelector('.fabric-notebook-header').appendChild(toggleBtn);
    }
  }

  // Hook into GitHub's file collapse chevron so it still works after our DOM
  // modifications break React's internal state.
  function hookCollapseChevron(diffEl) {
    if (diffEl._fabricCollapseHooked) return;
    // The chevron is the first button inside the diff header wrapper
    var headerWrapper = diffEl.querySelector('[class*="diffHeaderWrapper"]');
    if (!headerWrapper) return;
    var chevronBtn = headerWrapper.querySelector('button:first-of-type');
    if (!chevronBtn || !chevronBtn.querySelector('svg')) return;

    diffEl._fabricCollapseHooked = true;
    var bodyContainer = diffEl.children.length >= 2 ? diffEl.children[1] : null;
    if (!bodyContainer) return;

    chevronBtn.addEventListener('click', function (e) {
      // Toggle the body container
      var isCollapsed = bodyContainer.style.display === 'none';
      bodyContainer.style.display = isCollapsed ? '' : 'none';
      // Rotate the chevron icon to indicate state
      var svg = chevronBtn.querySelector('svg');
      if (svg) {
        svg.style.transition = 'transform 0.15s';
        svg.style.transform = isCollapsed ? '' : 'rotate(-90deg)';
      }
      e.stopPropagation();
      e.preventDefault();
    }, true); // capture phase to run before React's handler
  }

  // Find GitHub's native diff body content (the table/container with the actual diff lines).
  // Must NOT match our own injected elements.
  function findNativeDiffBody(diffEl) {
    // React-based views: table with DiffLines or tab-size class
    var tables = diffEl.querySelectorAll('table.tab-size, table[class*="DiffLines"]');
    for (var i = 0; i < tables.length; i++) {
      if (!tables[i].closest('.fabric-notebook')) return tables[i];
    }
    // Classic GitHub: .js-file-content
    var jsContent = diffEl.querySelector('.js-file-content');
    if (jsContent && !jsContent.closest('.fabric-notebook')) return jsContent;
    // React diff element
    var reactDiff = diffEl.querySelector('.react-diff-element');
    if (reactDiff && !reactDiff.closest('.fabric-notebook')) return reactDiff;
    // Last resort: second direct child (first is header, second is body)
    if (diffEl.children.length >= 2) {
      var secondChild = diffEl.children[1];
      if (!secondChild.classList.contains('fabric-notebook') && !secondChild.classList.contains('fabric-diff-notebook')) {
        return secondChild;
      }
    }
    return null;
  }

  // Find the native GitHub button/actions area inside a diff file header.
  // Returns the container where we can insert a toggle button.
  function findFileActionsBar(diffEl) {
    // Classic GitHub
    var bar = diffEl.querySelector('.file-actions');
    if (bar) return bar;

    // React-based PR views (2024+): the file header has a DiffFileHeader child
    // with three sections: [collapse] [filename] [right-actions].
    // We want the right-actions container (d-flex flex-row flex-justify-end)
    // so we can prepend our button at a visible position.
    var diffFileHeader = diffEl.querySelector('[class*="DiffFileHeader-module"]');
    if (diffFileHeader) {
      // The right-side actions area is typically the last direct child
      var children = diffFileHeader.children;
      for (var i = children.length - 1; i >= 0; i--) {
        var child = children[i];
        if (child.querySelector('button') && child.className.includes('flex')) {
          return child;
        }
      }
    }

    // Fallback: find the sticky file header's last flex container with buttons
    var fileHeader = diffEl.querySelector('.file-header, [class*="file-header"], .js-file-header, [class*="diffHeaderWrapper"]');
    if (fileHeader) {
      var btns = fileHeader.querySelectorAll('button');
      if (btns.length > 0) {
        // Return the outermost flex container that holds the actions
        var parent = btns[0].parentElement;
        while (parent && parent !== fileHeader && parent.parentElement !== fileHeader) {
          parent = parent.parentElement;
        }
        return parent;
      }
    }

    return null;
  }

  // Like findDiffElementForFile but uses a pre-queried NodeList to avoid re-scanning DOM
  function findDiffElementForFileCached(filePath, diffEntries) {
    // Try data-tagsearch-path first (fast, exact match)
    var tagEl = document.querySelector('[data-tagsearch-path="' + CSS.escape(filePath) + '"]');
    if (tagEl) {
      var diffEl = tagEl.closest('[id^="diff-"]') || tagEl.closest('.file');
      if (diffEl) return diffEl;
    }
    // Search pre-queried elements
    for (var i = 0; i < diffEntries.length; i++) {
      var de = diffEntries[i];
      if (de.closest('.fabric-notebook')) continue;
      var pathEls = de.querySelectorAll(
        'a[title], [data-tagsearch-path], a[href*="#diff-"], .file-info a, [class*="file-name"] a, [class*="file-path"] a, a.Link--primary'
      );
      for (var j = 0; j < pathEls.length; j++) {
        var el = pathEls[j];
        if (el.closest('.fabric-notebook')) continue;
        var raw = el.getAttribute('title') || el.getAttribute('data-tagsearch-path') || el.textContent;
        var p = stripInvisibleChars(raw);
        if (p === filePath || p.endsWith('/' + filePath) || filePath.endsWith('/' + p)) {
          return de;
        }
      }
    }
    return null;
  }

  // Strip zero-width / bidi control chars that GitHub injects into file path text
  function stripInvisibleChars(str) {
    return str.replace(/[\u200e\u200f\u200b\u200c\u200d\u2060\ufeff]/g, '').trim();
  }

  function findDiffElementForFile(filePath) {
    // Try data-tagsearch-path
    const tagEl = document.querySelector('[data-tagsearch-path="' + CSS.escape(filePath) + '"]');
    if (tagEl) {
      const diffEl = tagEl.closest('[id^="diff-"]') || tagEl.closest('.file');
      if (diffEl) return diffEl;
    }

    // Search per-file diff elements — skip the top-level comparison container
    // and any elements inside our own injected notebooks
    const diffEntries = document.querySelectorAll('[id^="diff-"]:not(#diff-comparison-viewer-container):not(#diff-file-tree-filter):not(#diff-placeholder)');
    for (const diffEl of diffEntries) {
      // Skip elements that are inside our own rendered notebooks
      if (diffEl.closest('.fabric-notebook')) continue;

      const pathEls = diffEl.querySelectorAll(
        'a[title], [data-tagsearch-path], a[href*="#diff-"], .file-info a, [class*="file-name"] a, [class*="file-path"] a, a.Link--primary'
      );
      for (const el of pathEls) {
        // Skip elements inside our injected content
        if (el.closest('.fabric-notebook')) continue;
        const raw = el.getAttribute('title') || el.getAttribute('data-tagsearch-path') || el.textContent;
        const p = stripInvisibleChars(raw);
        if (p === filePath || p.endsWith('/' + filePath) || filePath.endsWith('/' + p)) {
          return diffEl;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Main injection dispatcher
  // ---------------------------------------------------------------------------

  function inject() {
    if (location.pathname.includes('/blob/')) {
      injectBlob();
    }
    if (location.pathname.match(/\/pull\/\d+\/(files|changes)/)) {
      injectDiffs();
    }
  }

  // ---------------------------------------------------------------------------
  // SPA Navigation handling
  // ---------------------------------------------------------------------------

  function cleanup() {
    // Only clean up blob-view notebooks, not diff notebooks
    const existing = document.querySelector('.fabric-notebook:not(.fabric-diff-notebook)');
    if (existing) {
      if (originalContent) {
        originalContent.style.display = '';
      }
      existing.remove();
      originalContent = null;
      injectedUrl = null;
    }
  }

  function cleanupDiffAnnotations() {
    // Remove toggle buttons from GitHub's native headers
    document.querySelectorAll('.fabric-diff-toggle').forEach(function (btn) {
      btn.remove();
    });
    // Remove injected diff notebooks and restore hidden native diff bodies
    document.querySelectorAll('.fabric-diff-notebook').forEach(function (el) {
      // The native diff body is the next sibling (we inserted before it)
      const next = el.nextElementSibling;
      if (next && next.style.display === 'none') {
        next.style.display = '';
      }
      // Also check previous sibling in case layout differs
      const prev = el.previousElementSibling;
      if (prev && prev.style.display === 'none') {
        prev.style.display = '';
      }
      el.remove();
    });
  }

  // Track whether we've successfully injected at least once on this page
  var _hasInjected = false;

  function tryInject() {
    if (tryInject._timer) clearTimeout(tryInject._timer);
    tryInject._timer = setTimeout(function () {
      inject();
    }, 600);
  }

  // Initial injection with progressive retries.
  // GitHub's React app hydrates asynchronously — the diff elements and JSON
  // payloads may not exist in the DOM until several seconds after page load.
  inject();
  setTimeout(inject, 1000);
  setTimeout(inject, 2500);
  setTimeout(function () { if (!_hasInjected) inject(); }, 5000);

  // Watch for GitHub SPA navigation (turbo events)
  document.addEventListener('turbo:load', function () {
    _cachedDiffFiles = null; _notebookViewCache = {};
    _hasInjected = false;
    cleanup();
    cleanupDiffAnnotations();
    setTimeout(inject, 500);
  });
  document.addEventListener('turbo:render', function () {
    _cachedDiffFiles = null; _notebookViewCache = {};
    _hasInjected = false;
    cleanup();
    cleanupDiffAnnotations();
    setTimeout(inject, 500);
  });

  // Fallback: MutationObserver for React hydration and SPA transitions.
  // Uses shorter coalescing window when we haven't injected yet (waiting for
  // React to render), longer window once injection is done (just watching
  // for collapse/expand events).
  let lastUrl = location.href;
  var _observerTimer = null;
  const observer = new MutationObserver(function () {
    if (location.href !== lastUrl) {
      const oldUrl = lastUrl;
      lastUrl = location.href;
      _cachedDiffFiles = null;
      _hasInjected = false;
      cleanup();
      const oldPR = oldUrl.match(/\/pull\/(\d+)\/(files|changes)/);
      const newPR = lastUrl.match(/\/pull\/(\d+)\/(files|changes)/);
      if (oldPR && (!newPR || oldPR[1] !== newPR[1])) {
        _notebookViewCache = {};
        cleanupDiffAnnotations();
      }
    }
    // Shorter coalescing when waiting for initial injection, longer once done
    var delay = _hasInjected ? 1500 : 500;
    if (!_observerTimer) {
      _observerTimer = setTimeout(function () {
        _observerTimer = null;
        tryInject();
      }, delay);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
