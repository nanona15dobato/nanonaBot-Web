class WikitextParser {
    constructor() {
        this.masks = new Map();
        this.maskCounter = 0;
        this.magicWords = new Set([
            'currentyear', 'currentmonth', 'currentmonth1', 'currentmonthname', 'currentday', 'currentday2',
            'currentdow', 'currenttime', 'currenthour', 'currentweek', 'currenttimestamp',
            'pagename', 'pagenamee', 'fullpagename', 'fullpagenamee', 'subpagename', 'subpagenamee',
            'basepagename', 'basepagenamee', 'talkpagename', 'talkpagenamee', 'subjectpagename', 'subjectpagenamee',
            'namespace', 'namespacee', 'articlepath', 'scriptpath', 'servername', 'server', 'sitename',
            'revisionid', 'revisionday', 'revisionday2', 'revisionmonth', 'revisionyear', 'revisiontimestamp', 'revisionuser',
            'int', 'ns', 'urlencode', 'lc', 'uc', 'lcfirst', 'ucfirst', 'formatnum', 'padleft', 'padright',
            'plural', 'grammar', 'gender', 'bidi', 'filepath', 'localurl', 'fullurl', 'canonicalurl',
            'msg', 'raw', 'msgnw', '!', 'defaultsort', 'defaultsortkey'
        ]);
        this.escapeTags = ['nowiki', 'pre', 'math', 'syntaxhighlight', 'source', 'score', 'chem', 'ce'];

        this.namespaces = new Map();
        this.namespaceAliases = new Map();
        this.interwikiMap = new Set();

        this.namespaces.set(0, '');
        this.namespaceAliases.set('', 0);
        this.namespaces.set(10, 'Template');
        this.namespaceAliases.set('template', 10);
        this.namespaceAliases.set('テンプレート', 10);
    }

    setSiteInfo(siteInfo) {
        if (!siteInfo) return;
        if (siteInfo.namespaces) {
            Object.values(siteInfo.namespaces).forEach(ns => {
                if (ns.id !== 0 && ns.name) {
                    this.namespaces.set(ns.id, ns.name);
                    this.namespaceAliases.set(ns.name.toLowerCase(), ns.id);
                }
            });
        }
        if (siteInfo.namespacealiases) {
            siteInfo.namespacealiases.forEach(alias => {
                const aliasName = alias.alias || alias['*'];
                if (aliasName) {
                    this.namespaceAliases.set(aliasName.toLowerCase(), alias.id);
                }
            });
        }
        if (siteInfo.interwikimap) {
            siteInfo.interwikimap.forEach(iw => {
                if (iw.prefix) {
                    this.interwikiMap.add(iw.prefix.toLowerCase());
                }
            });
        }
    }

    /**
     * Bot等が正規表現でwikitextを一括置換する前に使うユーティリティ。
     * <nowiki>/<pre>/<math>/<syntaxhighlight> 等のリテラル領域やHTMLコメントを
     * 一時的にマスクし、意図しない箇所への誤爆を防ぐ。
     * インスタンスの this.masks とは完全に独立したローカルなmapを使うため、
     * parse()呼び出しと並行/入れ子で使っても状態が衝突しない。
     *
     * @param {string} wikitext
     * @param {object} [options]
     * @param {boolean} [options.comments=true] HTMLコメント <!-- --> を保護するか
     * @param {boolean} [options.refs=false] <ref>...</ref> を保護するか
     *        （既定はfalse: リンク置換等はref内の出典記述も書き換えたいケースが多いため）
     * @param {string[]} [options.escapeTags] 保護するタグ名一覧
     * @returns {{masked: string, restore: (s: string) => string}}
     */
    static protectRegions(wikitext, options = {}) {
        const escapeTags = options.escapeTags || ['nowiki', 'pre', 'math', 'syntaxhighlight', 'source', 'score', 'chem', 'ce'];
        const protectComments = options.comments !== false;
        const protectRefs = !!options.refs;

        const localMasks = new Map();
        let counter = 0;
        const mask = (s, prefix) => {
            const id = `\x01${prefix}_${counter++}\x02`;
            localMasks.set(id, s);
            return id;
        };

        let text = wikitext;
        if (protectComments) {
            text = text.replace(/<!--[\s\S]*?-->/g, m => mask(m, 'COMMENT'));
        }
        const tagRegex = new RegExp(`<(${escapeTags.join('|')})(?:\\s[^>]*?)?(?:\\/>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'gi');
        text = text.replace(tagRegex, m => mask(m, 'ESCAPE'));
        if (protectRefs) {
            const refRegex = /<ref(?:\s[^>]*?)?>[\s\S]*?<\/ref\s*>|<ref(?:\s[^>]*?)?\/>/gi;
            text = text.replace(refRegex, m => mask(m, 'REF'));
        }

        const restore = (s) => {
            if (typeof s !== 'string') return s;
            const maskRegex = /\x01([A-Z_]+_\d+)\x02/g;
            let prev;
            do {
                prev = s;
                s = s.replace(maskRegex, (mm) => localMasks.has(mm) ? localMasks.get(mm) : mm);
            } while (s !== prev);
            return s;
        };

        return { masked: text, restore };
    }

    mask(text, prefix) {
        const id = `\x01${prefix}_${this.maskCounter++}\x02`;
        this.masks.set(id, text);
        return id;
    }

    unmask(text) {
        if (typeof text !== 'string') return text;
        const maskRegex = /\x01([A-Z_]+_\d+)\x02/g;
        let prev;
        do {
            prev = text;
            text = text.replace(maskRegex, (match) => {
                return this.masks.has(match) ? this.masks.get(match) : match;
            });
        } while (text !== prev);
        return text;
    }

    normalizeTitle(title) {
        title = this.unmask(title);
        title = title.trim().replace(/_+/g, ' ').replace(/\s+/g, ' ');
        if (!title) return '';

        let colonIdx = title.indexOf(':');
        if (colonIdx !== -1) {
            let prefix = title.substring(0, colonIdx).trim();
            let suffix = title.substring(colonIdx + 1).trim();
            let lowerPrefix = prefix.toLowerCase();

            if (this.namespaceAliases.has(lowerPrefix)) {
                let nsId = this.namespaceAliases.get(lowerPrefix);
                let canonicalPrefix = this.namespaces.get(nsId);
                if (suffix) suffix = suffix.charAt(0).toUpperCase() + suffix.slice(1);

                if (nsId === 0) return suffix;
                return `${canonicalPrefix}:${suffix}`;
            }

            if (this.interwikiMap.has(lowerPrefix)) {
                prefix = prefix.charAt(0).toUpperCase() + prefix.slice(1);
                if (suffix) suffix = suffix.charAt(0).toUpperCase() + suffix.slice(1);
                return `${prefix}:${suffix}`;
            }
        }

        return title.charAt(0).toUpperCase() + title.slice(1);
    }

    parse(wikitext, options = {}) {
        this.masks = new Map();
        this.maskCounter = 0;

        let config = {
            templates: true, variables: true, wikilinks: true, extlinks: true, tables: true,
            headings: true, files: true, categories: true, references: true, lists: true
        };
        let targetTemplates = [];

        if (options && typeof options === 'object' && !Array.isArray(options)) {
            const hasPositive = Object.entries(options).some(([k, v]) => !k.startsWith('!') && v !== false);
            if (hasPositive) {
                for (let k in config) config[k] = false;
            }
            for (const [k, v] of Object.entries(options)) {
                let keyName = k.toLowerCase();
                if (keyName.startsWith('!')) config[keyName.substring(1)] = false;
                else if (v === false) config[keyName] = false;
                else {
                    config[keyName] = true;
                    if (keyName === 'templates') {
                        if (Array.isArray(v) && v.length > 0) targetTemplates = v.map(t => this.normalizeTitle(t));
                        else if (typeof v === 'string' && v !== "" && v !== "true") targetTemplates = [this.normalizeTitle(v)];
                    }
                }
            }
        }

        const parsedData = {
            templates: [], variables: [], wikilinks: [], extlinks: [], tables: [], headings: [],
            files: [], categories: [], references: [], lists: [], warnings: []
        };

        let text = wikitext;
        text = text.replace(/<!--[\s\S]*?-->/g, m => this.mask(m, 'COMMENT'));
        const tagRegex = new RegExp(`<(${this.escapeTags.join('|')})(?:\\s[^>]*?)?(?:\\/>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'gi');
        text = text.replace(tagRegex, m => this.mask(m, 'ESCAPE'));

        const unifiedRegex = /\{\{\{([\s\S]*?)\}\}\}|\{\{([\s\S]*?)\}\}|\[\[([\s\S]*?)\]\]|\[((?:https?|ftp):\/\/[^\s\]]+)(?:[\s]+([^\]]*?))?\]|\{\|([\s\S]*?)\|\}|<ref((?:\s[^>]*?)?)>([\s\S]*?)<\/ref\s*>|<ref((?:\s[^>]*?)?)\/>/gi;
        const openTagsRegex = /\{\{\{|\{\{|\[\[|\[(?=https?:\/\/|ftp:\/\/)|\{\||<ref(?!\s*\/>)/i;

        let prev;
        let loopCount = 0;
        const MAX_LOOP = 50000;

        do {
            prev = text;
            if (++loopCount > MAX_LOOP) {
                parsedData.warnings.push('警告: パースの最大ループ回数を超過したため中断しました。');
                break;
            }

            let match;
            unifiedRegex.lastIndex = 0;

            while ((match = unifiedRegex.exec(text)) !== null) {
                const m = match[0];
                const [_, varContent, tmplContent, wlinkContent, elinkUrl, elinkText, tableContent, refAttrs1, refContent, refAttrs2] = match;
                const offset = match.index;

                let innerContent = varContent ?? tmplContent ?? wlinkContent ?? (elinkUrl ? elinkUrl + " " + (elinkText || "") : undefined) ?? tableContent ?? refContent ?? "";
                if (openTagsRegex.test(innerContent)) {
                    unifiedRegex.lastIndex = offset + 1;
                    continue;
                }

                const startIndex = this.unmask(text.substring(0, offset)).length;
                const position = { start: startIndex, end: startIndex + this.unmask(m).length };
                let maskId = "";

                if (varContent !== undefined) {
                    if (!config.variables) maskId = this.mask(m, 'RAW');
                    else {
                        let parts = varContent.split('|');
                        let varName = parts.shift().trim();
                        let varDefault = parts.length > 0 ? parts.join('|') : null;
                        parsedData.variables.push({ name: varName, default: varDefault, position, original: m });
                        maskId = this.mask(m, 'VAR');
                    }
                }
                else if (tmplContent !== undefined) {
                    // NOTE: allPartsForOffset は split() の生の断片（トリム前）を保持する。
                    // rawFirstPart はここから .trim() して作るが、配列自体（先頭要素含む）は
                    // 変更しないため、各引数の絶対位置を後段で正確に逆算できる。
                    let allPartsForOffset = tmplContent.split('|');
                    let parts = allPartsForOffset.slice(1);
                    let rawFirstPart = allPartsForOffset[0].trim();
                    let type = 'template';
                    let name = '';
                    let parsedArgs = {};
                    let argsOrdered = [];
                    let unnamedIndex = 1;
                    // tmplContent は元テキスト text 上で "{{" の直後から始まる
                    const tmplContentBase = offset + 2;
                    // 最初の断片（テンプレート名/parser function名部分）+ "|" の分だけ後ろから開始
                    let rollingOffset = allPartsForOffset[0].length + 1;

                    let colonIndex = rawFirstPart.indexOf(':');
                    let prefix = colonIndex !== -1 ? rawFirstPart.substring(0, colonIndex).trim() : rawFirstPart.trim();
                    let lowerPrefix = prefix.toLowerCase();

                    if (rawFirstPart.startsWith('#')) {
                        type = 'parser_function';
                        name = colonIndex !== -1 ? rawFirstPart.substring(0, colonIndex).trim().toLowerCase() : rawFirstPart.toLowerCase();
                        if (colonIndex !== -1) { parsedArgs[unnamedIndex.toString()] = rawFirstPart.substring(colonIndex + 1).trim(); unnamedIndex++; }
                    } else if (lowerPrefix === 'subst' || lowerPrefix === 'safesubst') {
                        type = 'substTemplate';
                        let targetNameRaw = colonIndex !== -1 ? rawFirstPart.substring(colonIndex + 1).trim() : '';
                        let cIdx = targetNameRaw.indexOf(':');
                        let pfx = cIdx !== -1 ? targetNameRaw.substring(0, cIdx).trim().toLowerCase() : '';
                        if (cIdx === -1 || (!this.namespaceAliases.has(pfx) && !this.interwikiMap.has(pfx))) {
                            targetNameRaw = 'Template:' + targetNameRaw;
                        }
                        name = this.normalizeTitle(targetNameRaw);
                    } else if (this.magicWords.has(lowerPrefix)) {
                        type = 'magic_word';
                        name = prefix.toUpperCase();
                        if (colonIndex !== -1) { parsedArgs[unnamedIndex.toString()] = rawFirstPart.substring(colonIndex + 1).trim(); unnamedIndex++; }
                    } else {
                        type = 'template';
                        let targetNameRaw = rawFirstPart;
                        let cIdx = targetNameRaw.indexOf(':');
                        let pfx = cIdx !== -1 ? targetNameRaw.substring(0, cIdx).trim().toLowerCase() : '';
                        if (cIdx === -1 || (!this.namespaceAliases.has(pfx) && !this.interwikiMap.has(pfx))) {
                            targetNameRaw = 'Template:' + targetNameRaw;
                        }
                        name = this.normalizeTitle(targetNameRaw);
                    }

                    // 引数名の完全一致だけでなく、マジックワード・パーサー関数も
                    // ホワイトリストが指定されている場合は一律で対象外にする
                    // （テンプレート名を指定して抽出する際に無関係な {{PAGENAME}} 等が
                    // 紛れ込まないようにするため）。
                    if (!config.templates || (targetTemplates.length > 0 && !targetTemplates.includes(name))) {
                        maskId = this.mask(m, 'RAW');
                    } else {
                        for (let part of parts) {
                            const partAbsStart = this.unmask(text.substring(0, tmplContentBase + rollingOffset)).length;
                            const partAbsEnd = partAbsStart + this.unmask(part).length;

                            let eqIndex = part.indexOf('=');
                            let argKey, rawValue;
                            if (eqIndex !== -1) {
                                argKey = this.unmask(part.substring(0, eqIndex).trim()).trim();
                                rawValue = part.substring(eqIndex + 1).trim();
                                parsedArgs[argKey] = rawValue;
                            } else {
                                argKey = unnamedIndex.toString();
                                rawValue = part.trim();
                                parsedArgs[argKey] = rawValue;
                                unnamedIndex++;
                            }
                            // position は "part" 全体（named引数なら "key = value" 全体、
                            // unnamed引数なら値全体）の絶対位置。事後の書き換え（例: 番号の
                            // 振り直しや特定引数だけの置換）に安全に使える。
                            argsOrdered.push({ key: argKey, rawValue, position: { start: partAbsStart, end: partAbsEnd } });

                            rollingOffset += part.length + 1; // +1 は区切りの "|" 分
                        }
                        parsedData.templates.push({ type, name, args: parsedArgs, argsOrdered, position, original: m });
                        maskId = this.mask(m, 'TMPL');
                    }
                }
                else if (wlinkContent !== undefined) {
                    let parts = wlinkContent.split('|');
                    let rawTarget = parts.shift().trim();
                    let target = this.normalizeTitle(rawTarget);
                    let lowerTarget = target.toLowerCase();

                    if (/^(file|image|ファイル|画像):/i.test(lowerTarget)) {
                        if (!config.files) { maskId = this.mask(m, 'RAW'); } else {
                            parsedData.files.push({ file: target.substring(target.indexOf(':') + 1).trim(), target, options: parts.map(p => this.unmask(p.trim())), position, original: m });
                            maskId = this.mask(m, 'FILE');
                        }
                    } else if (/^(category|カテゴリ):/i.test(lowerTarget)) {
                        if (!config.categories) { maskId = this.mask(m, 'RAW'); } else {
                            parsedData.categories.push({ category: target.substring(target.indexOf(':') + 1).trim(), target, sortKey: parts.length > 0 ? this.unmask(parts[0].trim()) : null, position, original: m });
                            maskId = this.mask(m, 'CATEGORY');
                        }
                    } else {
                        if (!config.wikilinks) { maskId = this.mask(m, 'RAW'); } else {
                            parsedData.wikilinks.push({ target, text: parts.join('|').trim() || rawTarget, position, original: m });
                            maskId = this.mask(m, 'WLINK');
                        }
                    }
                }
                else if (elinkUrl !== undefined) {
                    if (!config.extlinks) { maskId = this.mask(m, 'RAW'); } else {
                        parsedData.extlinks.push({ url: elinkUrl, text: elinkText ? elinkText.trim() : '', position, original: m });
                        maskId = this.mask(m, 'ELINK');
                    }
                }
                else if (tableContent !== undefined) {
                    if (!config.tables) { maskId = this.mask(m, 'RAW'); } else {
                        let tableAttrs = ""; let caption = null; let rows = []; let currentRow = { attributes: "", cells: [] };
                        let lines = tableContent.split('\n'); let inTableAttrs = true; let currentCell = null; let currentContent = [];
                        const flushCell = () => {
                            if (currentCell) {
                                currentCell.text = currentContent.join('\n');
                                if (currentCell !== caption) currentRow.cells.push(currentCell);
                                currentCell = null; currentContent = [];
                            }
                        };
                        const splitCell = (str) => {
                            let pipeIndex = str.indexOf('|');
                            return pipeIndex !== -1 ? { attributes: this.unmask(str.substring(0, pipeIndex).trim()).trim(), text: str.substring(pipeIndex + 1) } : { attributes: '', text: str };
                        };
                        for (let line of lines) {
                            let trimmed = line.trimStart();
                            if (inTableAttrs) {
                                if (!/^(\|\+|\|-|!|\|)/.test(trimmed)) { tableAttrs += line + " "; continue; }
                                inTableAttrs = false;
                            }
                            if (trimmed.startsWith('|+')) {
                                flushCell(); let capParts = splitCell(trimmed.substring(2));
                                caption = { attributes: capParts.attributes, text: '' }; currentCell = caption; currentContent.push(capParts.text);
                            } else if (trimmed.startsWith('|-')) {
                                flushCell(); if (currentRow.cells.length > 0 || rows.length > 0) rows.push(currentRow);
                                currentRow = { attributes: this.unmask(trimmed.substring(2).trim()).trim(), cells: [] };
                            } else if (trimmed.startsWith('!') || trimmed.startsWith('|')) {
                                flushCell(); let isHeader = trimmed.startsWith('!'); let lineContent = trimmed.substring(1);
                                let inlineTokens = isHeader ? lineContent.split('!!') : lineContent.split('||');
                                for (let j = 0; j < inlineTokens.length; j++) {
                                    let cellParts = splitCell(inlineTokens[j]); let newCell = { isHeader, attributes: cellParts.attributes, text: cellParts.text };
                                    if (j === inlineTokens.length - 1) { currentCell = newCell; currentContent.push(newCell.text); }
                                    else { newCell.text = newCell.text.trim(); currentRow.cells.push(newCell); }
                                }
                            } else { currentContent.push(line); }
                        }
                        flushCell(); if (currentRow.cells.length > 0 || currentRow.attributes) rows.push(currentRow);
                        parsedData.tables.push({ attributes: this.unmask(tableAttrs.trim()).trim(), caption: caption, rows: rows, position, original: m });
                        maskId = this.mask(m, 'TABLE');
                    }
                }
                else if (refContent !== undefined || refAttrs2 !== undefined) {
                    if (!config.references) { maskId = this.mask(m, 'RAW'); } else {
                        parsedData.references.push({ attributes: this.unmask((refAttrs1 || refAttrs2 || "").trim()), content: refContent !== undefined ? refContent : null, position, original: m });
                        maskId = this.mask(m, 'REF');
                    }
                }

                text = text.substring(0, offset) + maskId + text.substring(offset + m.length);
                unifiedRegex.lastIndex = offset + maskId.length;
            }
        } while (text !== prev);

        if (config.headings) {
            const headingMatches = [];
            const headingRegex = /^(={1,6})\s*(.+?)\s*\1\s*$/gm;
            let match;
            while ((match = headingRegex.exec(text)) !== null) {
                let startIndex = this.unmask(text.substring(0, match.index)).length;
                headingMatches.push({
                    level: match[1].length, title: match[2].trim(), original: match[0],
                    maskedStartIndex: match.index, maskedEndIndex: headingRegex.lastIndex,
                    position: { start: startIndex, end: startIndex + this.unmask(match[0]).length }
                });
            }
            const hierarchyStack = []; const idCounters = new Map();
            for (let i = 0; i < headingMatches.length; i++) {
                let current = headingMatches[i];
                let anchorBase = this.unmask(current.title).trim().replace(/\s+/g, '_');
                let count = idCounters.get(anchorBase) || 0; count++; idCounters.set(anchorBase, count);
                let headingId = count === 1 ? anchorBase : `${anchorBase}_${count}`;
                while (hierarchyStack.length > 0 && hierarchyStack[hierarchyStack.length - 1].level >= current.level) hierarchyStack.pop();
                let currentParents = hierarchyStack.map(h => ({ id: h.id, level: h.level, title: h.title }));
                let contentEndMaskedIndex = text.length;
                for (let j = i + 1; j < headingMatches.length; j++) {
                    if (headingMatches[j].level <= current.level) { contentEndMaskedIndex = headingMatches[j].maskedStartIndex; break; }
                }
                let contentStartOriginalIndex = current.position.end;
                parsedData.headings.push({
                    id: headingId, level: current.level, title: current.title, original: current.original, parents: currentParents,
                    position: { header: { start: current.position.start, end: current.position.end }, content: { start: contentStartOriginalIndex, end: this.unmask(text.substring(0, contentEndMaskedIndex)).length } },
                    contentRaw: text.substring(current.maskedEndIndex, contentEndMaskedIndex)
                });
                hierarchyStack.push({ id: headingId, level: current.level, title: current.title });
            }
        }

        if (config.lists) {
            const listRegex = /^([\*\#\:\;]+)\s*(.*)$/gm;
            let match;
            while ((match = listRegex.exec(text)) !== null) {
                let startIndex = this.unmask(text.substring(0, match.index)).length;
                parsedData.lists.push({
                    markers: match[1], level: match[1].length, contentRaw: match[2].trim(),
                    position: { start: startIndex, end: startIndex + this.unmask(match[0]).length }, original: match[0]
                });
            }
        }

        const results = {
            templates: [], variables: [], wikilinks: [], extlinks: [], tables: [], headings: [],
            files: [], categories: [], references: [], lists: [], warnings: parsedData.warnings
        };

        for (let t of parsedData.templates) {
            let unmaskedArgs = {};
            for (let key in t.args) unmaskedArgs[key] = this.unmask(t.args[key]);
            let unmaskedArgsOrdered = (t.argsOrdered || []).map(a => ({
                key: a.key,
                value: this.unmask(a.rawValue).trim(),
                position: a.position
            }));
            results.templates.push({ type: t.type, name: t.name, args: unmaskedArgs, argsOrdered: unmaskedArgsOrdered, position: t.position, original: this.unmask(t.original) });
        }
        for (let v of parsedData.variables) {
            results.variables.push({ name: this.unmask(v.name), default: v.default !== null ? this.unmask(v.default) : null, position: v.position, original: this.unmask(v.original) });
        }
        for (let w of parsedData.wikilinks) results.wikilinks.push({ target: this.unmask(w.target), text: this.unmask(w.text), position: w.position, original: this.unmask(w.original) });
        for (let e of parsedData.extlinks) results.extlinks.push({ url: this.unmask(e.url), text: this.unmask(e.text), position: e.position, original: this.unmask(e.original) });
        for (let f of parsedData.files) results.files.push({ file: this.unmask(f.file), target: this.unmask(f.target), options: f.options.map(o => this.unmask(o)), position: f.position, original: this.unmask(f.original) });
        for (let c of parsedData.categories) results.categories.push({ category: this.unmask(c.category), target: this.unmask(c.target), sortKey: c.sortKey ? this.unmask(c.sortKey) : null, position: c.position, original: this.unmask(c.original) });
        for (let r of parsedData.references) results.references.push({ attributes: this.unmask(r.attributes), content: r.content ? this.unmask(r.content).trim() : null, position: r.position, original: this.unmask(r.original) });
        for (let l of parsedData.lists) results.lists.push({ markers: l.markers, level: l.level, content: this.unmask(l.contentRaw).trim(), position: l.position, original: this.unmask(l.original) });
        for (let tbl of parsedData.tables) {
            let uCap = tbl.caption ? { attributes: tbl.caption.attributes, text: this.unmask(tbl.caption.text).trim() } : null;
            let uRows = tbl.rows.map(r => ({ attributes: r.attributes, cells: r.cells.map(c => ({ isHeader: c.isHeader, attributes: c.attributes, text: this.unmask(c.text).trim() })) }));
            results.tables.push({ attributes: tbl.attributes, caption: uCap, rows: uRows, position: tbl.position, original: this.unmask(tbl.original) });
        }
        for (let h of parsedData.headings) {
            results.headings.push({ id: h.id, level: h.level, title: this.unmask(h.title), parents: h.parents.map(p => ({ id: p.id, level: p.level, title: this.unmask(p.title) })), position: h.position, content: this.unmask(h.contentRaw).trim(), original: this.unmask(h.original) });
        }

        ['templates', 'variables', 'wikilinks', 'extlinks', 'files', 'categories', 'references', 'lists', 'tables'].forEach(key => {
            results[key].sort((a, b) => a.position.start - b.position.start);
        });
        results.headings.sort((a, b) => a.position.header.start - b.position.header.start);

        return results;
    }
}

module.exports = WikitextParser;