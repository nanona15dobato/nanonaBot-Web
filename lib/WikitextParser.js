/**
 * nanonaBot2 wikitext パーサー（parse2）
 *
 * 1. コメントと <nowiki> などの保護領域を見つける
 * 2. 括弧の記号（{{ }} {{{ }}} [[ ]] [url ] {| |} <ref> </ref>）を1回だけ走査し、スタックで入れ子の木を作る
 * 3. 子から順に各要素を解釈する（子は「マスク」と呼ぶ記号に置き換えて扱うので、子の中の | や = に惑わされない）
 *
 * 出力の形は旧版（内側から正規表現で探して置き換えるのを繰り返す方式）と同じ。
 * nanonaBot2 の parse2 を移植したもの。旧版はマッチのたびに本文全体を作り直していたため、本文の大きさの2乗程度の
 * 時間・メモリがかかり、大きなページでワーカーがメモリ不足で落ちていた（実際の記事で約70倍速、結果は同じ）。
 * 旧版との違い: {{DEFAULTSORT:よみ}} などのマジックワードの値を引数 1 として返す（旧版は引数なし）。
 * protectRegions（置換前の保護）は旧版から移植。
 */

'use strict';

const MASK_RE = /\x01[A-Z_]+_\d+\x02/g;
const TOKEN_RE = /\{\{\{|\{\{|\}\}\}|\}\}|\[\[|\]\]|\{\||\|\}|\[(?=(?:https?|ftp):\/\/[^\s\]\x00])|\]|<ref(?=[\s>\/])|<\/ref\s*>/gi;
const EXTLINK_RE = /^\[((?:https?|ftp):\/\/[^\s\]]+)(?:\s+([^\]]*?))?\]$/i;
// 閉じ記号を探すとき、閉じられていなくても読み飛ばしてよい要素（リンク内の閉じ忘れなど）
const DISCARDABLE = ['link', 'ext'];

class WikitextParser {
    constructor() {
        this.masks = new Map();
        this.maskLengths = new Map();
        this.unmaskCache = new Map();
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

        // siteinfo を読み込む前の既定値（日本語版ウィキペディアの名前に合わせる）
        this.namespaces.set(0, '');
        this.namespaceAliases.set('', 0);
        this.namespaces.set(6, 'ファイル');
        for (const alias of ['file', 'image', 'ファイル', '画像']) this.namespaceAliases.set(alias, 6);
        this.namespaces.set(10, 'Template');
        this.namespaceAliases.set('template', 10);
        this.namespaceAliases.set('テンプレート', 10);
        this.namespaces.set(14, 'Category');
        for (const alias of ['category', 'カテゴリ']) this.namespaceAliases.set(alias, 14);
    }

    setSiteInfo(siteInfo) {
        if (!siteInfo) return;
        if (siteInfo.namespaces) {
            Object.values(siteInfo.namespaces).forEach(ns => {
                if (ns.id !== 0 && ns.name) {
                    this.namespaces.set(ns.id, ns.name);
                    this.namespaceAliases.set(ns.name.toLowerCase(), ns.id);
                    if (ns.canonical) this.namespaceAliases.set(ns.canonical.toLowerCase(), ns.id);
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

    // ==========================================
    // マスク
    // ==========================================

    /** 元テキスト上の [start, end) を表すマスクを作る（中身は元の文字列そのもの） */
    maskRange(prefix, start, end) {
        const id = `\x01${prefix}_${this.maskCounter++}\x02`;
        this.masks.set(id, this.source.slice(start, end));
        this.maskLengths.set(id, end - start);
        return id;
    }

    // 旧版との互換用（任意の文字列をマスクにする）
    mask(text, prefix) {
        const id = `\x01${prefix}_${this.maskCounter++}\x02`;
        this.masks.set(id, text);
        this.maskLengths.set(id, this.originalLength(text));
        return id;
    }

    // マスク内のマスクも展開する(展開結果はキャッシュ)
    unmask(text) {
        if (typeof text !== 'string' || text.indexOf('\x01') === -1) return text;
        return text.replace(MASK_RE, (id) => this.masks.has(id) ? this.unmaskId(id) : id);
    }

    // 深い入れ子でもコールスタックを使わないよう、明示的なスタックで内側から展開する
    unmaskId(rootId) {
        if (this.unmaskCache.has(rootId)) return this.unmaskCache.get(rootId);
        const stack = [rootId];
        while (stack.length > 0) {
            const id = stack[stack.length - 1];
            if (this.unmaskCache.has(id)) { stack.pop(); continue; }
            const content = this.masks.get(id);
            const pending = (content.match(MASK_RE) || []).filter(child => this.masks.has(child) && !this.unmaskCache.has(child));
            if (pending.length > 0) {
                for (const child of pending) stack.push(child);
                continue;
            }
            this.unmaskCache.set(id, content.replace(MASK_RE, child => this.masks.has(child) ? this.unmaskCache.get(child) : child));
            stack.pop();
        }
        return this.unmaskCache.get(rootId);
    }

    // unmask(text).length を展開せずに求める
    originalLength(text) {
        if (text.indexOf('\x01') === -1) return text.length;
        let len = text.length;
        let match;
        MASK_RE.lastIndex = 0;
        while ((match = MASK_RE.exec(text)) !== null) {
            if (this.maskLengths.has(match[0])) len += this.maskLengths.get(match[0]) - match[0].length;
        }
        return len;
    }

    // マスク済みテキスト上の位置 → 元テキスト上の位置(昇順に呼ぶと差分だけ計算する)
    createIndexMapper(text) {
        let cursorMasked = 0;
        let cursorOriginal = 0;
        return (maskedIndex) => {
            if (maskedIndex < cursorMasked) { cursorMasked = 0; cursorOriginal = 0; }
            cursorOriginal += this.originalLength(text.substring(cursorMasked, maskedIndex));
            cursorMasked = maskedIndex;
            return cursorOriginal;
        };
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

    // ==========================================
    // 1. 保護領域
    // ==========================================

    /** コメントと <nowiki> などの範囲（位置順、重なりなし） */
    findProtectedRanges(text) {
        const comments = [];
        for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
            comments.push({ start: m.index, end: m.index + m[0].length, prefix: 'COMMENT' });
        }
        // コメントの中のタグは対象にしない（旧版と同じく、コメントを先に隠してから探す）
        const hidden = comments.length > 0 ? blankRanges(text, comments) : text;
        const tagRegex = new RegExp(`<(${this.escapeTags.join('|')})(?:\\s[^>]*?)?(?:\\/>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'gi');
        const escapes = [];
        for (const m of hidden.matchAll(tagRegex)) {
            escapes.push({ start: m.index, end: m.index + m[0].length, prefix: 'ESCAPE' });
        }
        if (escapes.length === 0) return comments;
        // コメントも nowiki 等も位置順で重ならないので、1回なめるだけで「nowiki 等の中のコメント」を除ける
        // （コメントと nowiki 等が大量にあるページで、組み合わせを全部調べると遅くなるため）
        const kept = [];
        let ei = 0;
        for (const c of comments) {
            while (ei < escapes.length && escapes[ei].end <= c.start) ei++;
            const e = escapes[ei];
            if (!(e && e.start <= c.start && c.end <= e.end)) kept.push(c);
        }
        return [...kept, ...escapes].sort((a, b) => a.start - b.start);
    }

    // ==========================================
    // 2. 構造の走査
    // ==========================================

    /**
     * 括弧の対応をとって木を作る
     * 各要素: { type, start, end, items }。items は子要素と保護領域（位置順）
     */
    buildTree(text, protectedRanges) {
        const scan = protectedRanges.length > 0 ? blankRanges(text, protectedRanges) : text;
        const root = { type: 'root', start: 0, end: text.length, items: [] };
        const stack = [root];
        let pi = 0;
        const attachProtected = (upTo) => {
            while (pi < protectedRanges.length && protectedRanges[pi].start < upTo) {
                stack[stack.length - 1].items.push(protectedRanges[pi++]);
            }
        };
        const open = (type, start, extra) => stack.push({ type, start, end: -1, items: [], ...extra });
        // 閉じられなかった要素は、中身を親に移して捨てる
        const discardTop = () => {
            const node = stack.pop();
            const parent = stack[stack.length - 1];
            for (const item of node.items) parent.items.push(item);
        };
        const closeAt = (depth, end) => {
            while (stack.length - 1 > depth) discardTop();
            const node = stack.pop();
            node.end = end;
            stack[stack.length - 1].items.push(node);
            return node;
        };
        const findOpen = (types) => {
            for (let i = stack.length - 1; i > 0; i--) {
                if (types.includes(stack[i].type)) return i;
                if (!DISCARDABLE.includes(stack[i].type)) return -1;
            }
            return -1;
        };

        const tokenRe = new RegExp(TOKEN_RE.source, 'gi');
        let m;
        while ((m = tokenRe.exec(scan)) !== null) {
            const idx = m.index;
            const tok = m[0];
            attachProtected(idx);
            const top = stack[stack.length - 1];

            if (tok === '{{{') open('param', idx);
            else if (tok === '{{') open('tpl', idx);
            else if (tok === '[[') open('link', idx);
            else if (tok === '[') open('ext', idx);
            else if (tok === '{|') open('table', idx);
            else if (tok === '}}}') {
                const depth = findOpen(['param', 'tpl']);
                if (depth === -1) continue;
                if (stack[depth].type === 'param') {
                    closeAt(depth, idx + 3);
                } else {
                    // "}}}" が "}}" + "}" の場合
                    closeAt(depth, idx + 2);
                    tokenRe.lastIndex = idx + 2;
                }
            } else if (tok === '}}') {
                const depth = findOpen(['tpl']);
                if (depth !== -1) closeAt(depth, idx + 2);
            } else if (tok === ']]') {
                if (top.type === 'ext') {
                    closeAt(stack.length - 1, idx + 1);
                    tokenRe.lastIndex = idx + 1;
                } else {
                    const depth = findOpen(['link']);
                    if (depth !== -1) closeAt(depth, idx + 2);
                }
            } else if (tok === ']') {
                if (top.type === 'ext') closeAt(stack.length - 1, idx + 1);
            } else if (tok === '|}') {
                if (top.type === 'table') closeAt(stack.length - 1, idx + 2);
                else tokenRe.lastIndex = idx + 1;
            } else if (tok.charAt(1) === '/') {
                // </ref>
                const depth = findOpen(['ref']);
                if (depth !== -1) closeAt(depth, idx + tok.length).contentEnd = idx;
            } else {
                // <ref …> または <ref … />
                const gt = scan.indexOf('>', idx + 4);
                if (gt === -1) continue;
                const attrs = text.slice(idx + 4, gt);
                if (attrs.endsWith('/')) {
                    top.items.push({ type: 'ref', start: idx, end: gt + 1, items: [], selfClosing: true, attrs: attrs.slice(0, -1) });
                } else {
                    open('ref', idx, { attrs, contentStart: gt + 1 });
                }
                tokenRe.lastIndex = gt + 1;
            }
        }
        attachProtected(Infinity);
        // 最後まで閉じられなかった要素は、中身をまとめて root に移す。
        // 各段の items は次の段が開く前のものなので、下の段から順に並べれば位置順になる
        for (let i = 1; i < stack.length; i++) {
            for (const item of stack[i].items) root.items.push(item);
        }
        return root;
    }

    // ==========================================
    // 3. 要素の解釈
    // ==========================================

    /** 子要素・保護領域のマスク（初めて要るときに作る） */
    maskIdOf(item) {
        if (!item.maskId) item.maskId = this.maskRange(item.prefix || 'RAW', item.start, item.end);
        return item.maskId;
    }

    /** node の [start, end) を、子要素・保護領域をマスクに置き換えた文字列にする */
    maskedRange(node, start, end) {
        const text = this.source;
        let out = '';
        let cursor = start;
        for (const item of node.items) {
            if (item.end <= start || item.start < cursor) continue;
            if (item.start >= end) break;
            out += text.slice(cursor, item.start) + this.maskIdOf(item);
            cursor = item.end;
        }
        return out + text.slice(cursor, end);
    }

    /**
     * maskedRange と同じ文字列に加え、マスク済みの位置 → 元の位置 の変換関数を返す
     * （区切りごとの対応表を持つので、何度呼んでも全体を読み直さない）
     */
    maskedRangeWithIndex(node, start, end) {
        const text = this.source;
        const maskedStarts = [];
        const originalStarts = [];
        const maskLength = [];
        let out = '';
        let cursor = start;
        const push = (piece, originalStart, isMaskOf) => {
            maskedStarts.push(out.length);
            originalStarts.push(originalStart);
            maskLength.push(isMaskOf);
            out += piece;
        };
        for (const item of node.items) {
            if (item.end <= start || item.start < cursor) continue;
            if (item.start >= end) break;
            if (item.start > cursor) push(text.slice(cursor, item.start), cursor, 0);
            push(this.maskIdOf(item), item.start, item.end - item.start);
            cursor = item.end;
        }
        if (end > cursor || maskedStarts.length === 0) push(text.slice(cursor, end), cursor, 0);

        const toOriginal = (maskedIndex) => {
            let lo = 0;
            let hi = maskedStarts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (maskedStarts[mid] <= maskedIndex) lo = mid; else hi = mid - 1;
            }
            const offset = maskedIndex - maskedStarts[lo];
            // マスクの途中を指すことは無いが、指したらマスクの後ろとみなす
            if (maskLength[lo] > 0) return originalStarts[lo] + (offset === 0 ? 0 : maskLength[lo]);
            return originalStarts[lo] + offset;
        };
        return { masked: out, toOriginal };
    }

    /**
     * node の [start, end) を区切り | ごとに分ける（子要素・保護領域の中の | は数えない）
     * 各部分には、その中で最初の（子要素の外の）= の位置 eq を付ける
     */
    splitParts(node, start, end) {
        const text = this.source;
        const parts = [];
        let part = { start, end, eq: undefined };
        let cursor = start;
        const scanTo = (limit) => {
            for (let i = cursor; i < limit; i++) {
                const c = text.charCodeAt(i);
                if (c === 124) { // |
                    part.end = i;
                    parts.push(part);
                    part = { start: i + 1, end, eq: undefined };
                } else if (c === 61 && part.eq === undefined) { // =
                    part.eq = i;
                }
            }
        };
        for (const item of node.items) {
            if (item.end <= start || item.start < cursor) continue;
            if (item.start >= end) break;
            scanTo(item.start);
            cursor = item.end;
        }
        scanTo(end);
        parts.push(part);
        return parts;
    }

    /** 前後の空白を除いた範囲 */
    trimRange(start, end) {
        const text = this.source;
        while (start < end && /\s/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
        return { start, end };
    }

    parse(wikitext, options = {}) {
        this.masks = new Map();
        this.maskLengths = new Map();
        this.unmaskCache = new Map();
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
                        if (Array.isArray(v) && v.length > 0) targetTemplates = v.map(t => this.templateName(String(t).trim()));
                        else if (typeof v === 'string' && v !== "" && v !== "true") targetTemplates = [this.templateName(v.trim())];
                    }
                }
            }
        }
        const targetTemplateSet = new Set(targetTemplates);

        const results = {
            templates: [], variables: [], wikilinks: [], extlinks: [], tables: [], headings: [],
            files: [], categories: [], references: [], lists: [], warnings: []
        };

        const text = String(wikitext ?? '');
        this.source = text;
        const protectedRanges = this.findProtectedRanges(text);
        const root = this.buildTree(text, protectedRanges);

        // 子 → 親の順に処理する（親を組み立てるときに子のマスクが要る）
        const order = [];
        const walk = [root];
        while (walk.length > 0) {
            const node = walk.pop();
            order.push(node);
            for (const item of node.items) if (item.type) walk.push(item);
        }

        for (let i = order.length - 1; i > 0; i--) {
            const node = order[i];
            const position = { start: node.start, end: node.end };
            const original = text.slice(node.start, node.end);
            let prefix = 'RAW';

            if (node.type === 'param') {
                if (config.variables) {
                    const inner = this.maskedRange(node, node.start + 3, node.end - 3);
                    const parts = inner.split('|');
                    const varName = parts.shift().trim();
                    const varDefault = parts.length > 0 ? parts.join('|') : null;
                    results.variables.push({ name: this.unmask(varName), default: varDefault !== null ? this.unmask(varDefault) : null, position, original });
                    prefix = 'VAR';
                }
            } else if (node.type === 'tpl') {
                const template = this.parseTemplateNode(node, position, original);
                const filtered = (template.type === 'template' || template.type === 'substTemplate') &&
                    targetTemplateSet.size > 0 && !targetTemplateSet.has(template.name);
                if (config.templates && !filtered) {
                    results.templates.push(template);
                    prefix = 'TMPL';
                }
            } else if (node.type === 'link') {
                prefix = this.parseLinkNode(node, position, original, config, results);
            } else if (node.type === 'ext') {
                const m = EXTLINK_RE.exec(this.maskedRange(node, node.start, node.end));
                if (config.extlinks && m) {
                    results.extlinks.push({ url: this.unmask(m[1]), text: m[2] ? this.unmask(m[2].trim()) : '', position, original });
                    prefix = 'ELINK';
                }
            } else if (node.type === 'table') {
                if (config.tables) {
                    results.tables.push({ ...this.parseTableContent(this.maskedRange(node, node.start + 2, node.end - 2)), position, original });
                    prefix = 'TABLE';
                }
            } else if (node.type === 'ref') {
                if (config.references) {
                    const raw = node.selfClosing ? '' : this.maskedRange(node, node.contentStart, node.contentEnd);
                    const content = raw ? this.unmask(raw).trim() : null;
                    results.references.push({ attributes: node.attrs.trim(), content, position, original });
                    prefix = 'REF';
                }
            }
            node.prefix = prefix;
        }

        // 見出し・箇条書きは、すべての要素をマスクにした文書で行単位に探す
        if (config.headings || config.lists) {
            const { masked, toOriginal } = this.maskedRangeWithIndex(root, 0, text.length);
            if (config.headings) this.collectHeadings(masked, toOriginal, results);
            if (config.lists) this.collectLists(masked, toOriginal, results);
        }

        ['templates', 'variables', 'wikilinks', 'extlinks', 'files', 'categories', 'references', 'lists', 'tables'].forEach(key => {
            results[key].sort((a, b) => a.position.start - b.position.start);
        });
        results.headings.sort((a, b) => a.position.header.start - b.position.header.start);

        this.source = null;
        return results;
    }

    parseTemplateNode(node, position, original) {
        const text = this.source;
        const parts = this.splitParts(node, node.start + 2, node.end - 2);
        const first = parts.shift();
        const nameRange = this.trimRange(first.start, first.end);
        const rawFirstPart = this.maskedRange(node, nameRange.start, nameRange.end);
        let type;
        let name;
        const args = {};
        const argsOrdered = [];
        let unnamedIndex = 1;

        const addPositional = (start, end) => {
            const value = this.trimRange(start, end);
            const key = String(unnamedIndex++);
            args[key] = text.slice(value.start, value.end);
            argsOrdered.push({ key, value: args[key], named: false, position: { start, end }, keyPosition: null, valuePosition: value });
        };

        const colonIndex = rawFirstPart.indexOf(':');
        const prefix = colonIndex !== -1 ? rawFirstPart.substring(0, colonIndex).trim() : rawFirstPart.trim();
        const lowerPrefix = prefix.toLowerCase();
        // マスクを含まない限り、マスク済みの位置 = 元の位置
        const colonPos = colonIndex !== -1 ? nameRange.start + this.originalLength(rawFirstPart.substring(0, colonIndex)) : -1;

        if (rawFirstPart.startsWith('#')) {
            type = 'parser_function';
            name = colonIndex !== -1 ? rawFirstPart.substring(0, colonIndex).trim().toLowerCase() : rawFirstPart.toLowerCase();
            name = this.unmask(name);
            if (colonIndex !== -1) addPositional(colonPos + 1, first.end);
        } else if (lowerPrefix === 'subst' || lowerPrefix === 'safesubst') {
            type = 'substTemplate';
            name = this.templateName(colonIndex !== -1 ? rawFirstPart.substring(colonIndex + 1).trim() : '');
        } else if (this.magicWords.has(lowerPrefix)) {
            type = 'magic_word';
            name = prefix.toUpperCase();
            if (colonIndex !== -1) addPositional(colonPos + 1, first.end);
        } else {
            type = 'template';
            name = this.templateName(rawFirstPart);
        }

        for (const part of parts) {
            const eq = part.eq;
            if (eq === undefined) {
                addPositional(part.start, part.end);
                continue;
            }
            const keyRange = this.trimRange(part.start, eq);
            const valueRange = this.trimRange(eq + 1, part.end);
            const key = text.slice(keyRange.start, keyRange.end).trim();
            args[key] = text.slice(valueRange.start, valueRange.end);
            argsOrdered.push({ key, value: args[key], named: true, position: { start: part.start, end: part.end }, keyPosition: keyRange, valuePosition: valueRange });
        }

        return { type, name, args, argsOrdered, namePosition: nameRange, position, original };
    }

    /** {{名前}} の名前を、名前空間を補って正規化する */
    templateName(raw) {
        const cIdx = raw.indexOf(':');
        const pfx = cIdx !== -1 ? raw.substring(0, cIdx).trim().toLowerCase() : '';
        if (cIdx === -1 || (!this.namespaceAliases.has(pfx) && !this.interwikiMap.has(pfx))) raw = 'Template:' + raw;
        return this.normalizeTitle(raw);
    }

    parseLinkNode(node, position, original, config, results) {
        const text = this.source;
        // 子要素・保護領域の中の | では区切らない。値は元の文字列から位置で切り出す（マスクを展開し直さない）
        const parts = this.splitParts(node, node.start + 2, node.end - 2);
        const first = parts.shift();
        const rawTarget = text.slice(first.start, first.end).trim();
        const rest = parts.length > 0 ? text.slice(parts[0].start, node.end - 2) : null;
        const target = this.normalizeTitle(rawTarget);
        // [[:Category:X]] [[:File:X]] は分類・画像ではなく、そのページへのリンク
        const colon = rawTarget.startsWith(':');

        if (!colon && /^(file|image|ファイル|画像):/i.test(target)) {
            if (!config.files) return 'RAW';
            results.files.push({ file: target.substring(target.indexOf(':') + 1).trim(), target, options: parts.map(p => text.slice(p.start, p.end).trim()), position, original });
            return 'FILE';
        }
        if (!colon && /^(category|カテゴリ):/i.test(target)) {
            if (!config.categories) return 'RAW';
            // sortKey は旧版どおり空なら null。空白だけのソートキー（[[Category:X| ]]）を区別したいときは sortKeyRaw を使う
            const sortKey = parts.length > 0 ? text.slice(parts[0].start, parts[0].end).trim() || null : null;
            results.categories.push({ category: target.substring(target.indexOf(':') + 1).trim(), target, sortKey, sortKeyRaw: rest, position, original });
            return 'CATEGORY';
        }
        if (!config.wikilinks) return 'RAW';
        const link = { target, text: (rest !== null ? rest.trim() : '') || rawTarget, position, original };
        if (colon) link.colon = true;
        results.wikilinks.push(link);
        return 'WLINK';
    }

    parseTableContent(tableContent) {
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

        const uCap = caption ? { attributes: caption.attributes, text: this.unmask(caption.text).trim() } : null;
        const uRows = rows.map(r => ({ attributes: r.attributes, cells: r.cells.map(c => ({ isHeader: c.isHeader, attributes: c.attributes, text: this.unmask(c.text).trim() })) }));
        return { attributes: this.unmask(tableAttrs.trim()).trim(), caption: uCap, rows: uRows };
    }

    collectHeadings(text, toOriginal, results) {
        const headingMatches = [];
        const headingRegex = /^(={1,6})\s*(.+?)\s*\1\s*$/gm;
        let match;
        while ((match = headingRegex.exec(text)) !== null) {
            headingMatches.push({
                level: match[1].length, title: match[2].trim(),
                position: { start: toOriginal(match.index), end: toOriginal(headingRegex.lastIndex) }
            });
        }
        const textOriginalLength = this.source.length;
        const hierarchyStack = []; const idCounters = new Map();
        for (let i = 0; i < headingMatches.length; i++) {
            let current = headingMatches[i];
            let title = this.unmask(current.title);
            let anchorBase = title.trim().replace(/\s+/g, '_');
            let count = idCounters.get(anchorBase) || 0; count++; idCounters.set(anchorBase, count);
            let headingId = count === 1 ? anchorBase : `${anchorBase}_${count}`;
            while (hierarchyStack.length > 0 && hierarchyStack[hierarchyStack.length - 1].level >= current.level) hierarchyStack.pop();
            let currentParents = hierarchyStack.map(h => ({ id: h.id, level: h.level, title: h.title }));
            let contentEndOriginalIndex = null;
            for (let j = i + 1; j < headingMatches.length; j++) {
                if (headingMatches[j].level <= current.level) { contentEndOriginalIndex = headingMatches[j].position.start; break; }
            }
            if (contentEndOriginalIndex === null) contentEndOriginalIndex = textOriginalLength;
            results.headings.push({
                id: headingId, level: current.level, title, parents: currentParents,
                position: { header: { start: current.position.start, end: current.position.end }, content: { start: current.position.end, end: contentEndOriginalIndex } },
                content: this.source.slice(current.position.end, contentEndOriginalIndex).trim(),
                original: this.source.slice(current.position.start, current.position.end)
            });
            hierarchyStack.push({ id: headingId, level: current.level, title });
        }
    }

    collectLists(text, toOriginal, results) {
        const listRegex = /^([\*\#\:\;]+)\s*(.*)$/gm;
        let match;
        while ((match = listRegex.exec(text)) !== null) {
            const start = toOriginal(match.index);
            const end = toOriginal(listRegex.lastIndex);
            results.lists.push({
                markers: match[1], level: match[1].length, content: this.source.slice(toOriginal(listRegex.lastIndex - match[2].length), end).trim(),
                position: { start, end }, original: this.source.slice(start, end)
            });
        }
    }

    // ==========================================
    // 補助
    // ==========================================

    /**
     * Bot等が正規表現でwikitextを一括置換する前に使うユーティリティ（nanonaBot-Web の旧パーサーから移植）。
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
            let rounds = 0;
            do {
                prev = s;
                s = s.replace(maskRegex, (mm) => localMasks.has(mm) ? localMasks.get(mm) : mm);
                rounds++;
                // 入れ子の保護は数段で戻り切る。戻した文字列に同じ印が残り続ける（自己参照）場合に止まらなくなるのを防ぐ
            } while (s !== prev && rounds < 20);
            return s;
        };

        return { masked: text, restore };
    }

    /**
     * 重ならない編集 { start, end, replacement } をまとめて適用する（後ろから適用するので位置はずれない）
     * @param {string} text
     * @param {{start: number, end: number, replacement: string}[]} edits
     * @returns {string}
     */
    static applyEdits(text, edits) {
        const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
        let result = text;
        let limit = Infinity;
        for (const e of sorted) {
            if (e.end > limit) throw new Error('applyEdits: 編集範囲が重なっています');
            result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
            limit = e.start;
        }
        return result;
    }
}

/** ranges の文字を \x00 に置き換える（長さは変えない） */
function blankRanges(text, ranges) {
    let out = '';
    let cursor = 0;
    for (const r of ranges) {
        if (r.start < cursor) continue;
        out += text.slice(cursor, r.start) + '\x00'.repeat(r.end - r.start);
        cursor = r.end;
    }
    return out + text.slice(cursor);
}

module.exports = WikitextParser;
