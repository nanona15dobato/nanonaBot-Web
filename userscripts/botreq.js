//<nowiki>
/*
 * Bot作業依頼 補助スクリプト（nanonaBot 用）
 *
 * Wikipedia:Bot作業依頼 の各依頼の見出し（[編集] の横）に操作を追加する。
 * 見出しの状態から次の操作（着手 → 完了 → 解決）を表示し、▼ のメニュー（または右クリック）からはどの操作も選べる。
 *   着手: 利用者:nanonaBot/依頼/（依頼の年）年 に作業記録の節を追加する（{{../head}} の件数も1つ増やす）
 *   完了: 作業記録に着手・終了時刻と、その間の nanonaBot の投稿記録リンクを書き込む
 *   解決: 依頼の節に {{解決済み}} を貼る
 * どの操作も、保存前にプレビュー・差分・ウィキテキストで確認・修正できる（Wikimedia OOUI のダイアログ）。
 * 依頼の節へのコメント（{{BOTREQ|着手}} など）は、コピーするか、保存と同時に依頼者への返信として投稿できる。
 */
(function () {
	'use strict';

	const CONFIG = {
		requestPage: 'Wikipedia:Bot作業依頼',
		botUser: 'nanonaBot',
		operator: 'nanona15dobato',
		logPrefix: '利用者:nanonaBot/依頼/',
		contribsPerLink: 5000 // {{利用者の投稿記録リンク}} 1つあたりの編集数
	};

	// 保存時に署名へ置き換わったり、このページの <nowiki> が閉じたりしないよう分けて書く
	const SIG = '~~' + '~~';
	const NOWIKI_CLOSE = '</' + 'nowiki>';
	// 作業記録の <!--sec 節ID|編集回数--> では、節IDの「-」をこの文字（U+FFFD）に置き換える（コメント内の「--」を避けるため）
	const SEC_ID_SEP = '�';
	const HEAD_COUNT_RE = /\{\{\.\.\/head([^}]*\|\s*件数\s*=\s*)(\d*)/;

	const ACTION_LABELS = { start: '着手', complete: '完了', resolve: '解決' };
	const NEXT_ACTION = { open: 'start', started: 'complete', completed: 'resolve', resolved: null };
	const STATUS_AFTER = { start: 'started', complete: 'completed', resolve: 'resolved' };

	if (
		mw.config.get('wgPageName').replace(/_/g, ' ') !== CONFIG.requestPage ||
		mw.config.get('wgAction') !== 'view' ||
		mw.config.get('wgRevisionId') !== mw.config.get('wgCurRevisionId') // 古い版の表示では使わない
	) {
		return;
	}

	mw.loader
		.using(['mediawiki.api', 'mediawiki.util', 'mediawiki.Title', 'mediawiki.diff.styles', 'oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows'])
		.then(function () {
			$(main);
		});

	function main() {
		const api = new mw.Api();

		/* ---------- 共通の小物 ---------- */

		/** mw.Api の jQuery Promise を、失敗時に code つきの Error を返す Promise にする。 */
		function call(jqPromise) {
			return new Promise(function (resolve, reject) {
				jqPromise.then(resolve, function (code, data) {
					const err = new Error((data && data.error && data.error.info) || (data && data.textStatus) || code);
					err.code = code;
					reject(err);
				});
			});
		}

		/** OOUI の Process に渡せるよう、Promise を jQuery Promise にする。 */
		function toJq(promise) {
			const d = $.Deferred();
			promise.then(d.resolve, d.reject);
			return d.promise();
		}

		function errorText(err) {
			const known = {
				editconflict: '編集が競合しました。キャンセルして、もう一度操作してください。',
				articleexists: '作業記録のページが既に作成されていました。キャンセルして、もう一度操作してください。',
				missingtitle: 'ページが見つかりません。',
				'assertuserfailed': 'ログインしていません。ログインしてからもう一度操作してください。',
				badtoken: 'セッションが切れました。ページを再読み込みしてください。',
				http: '通信に失敗しました。'
			};
			return (err && err.code && known[err.code]) || (err && err.message) || String(err);
		}

		const JST = new Intl.DateTimeFormat('ja-JP', {
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			timeZone: 'Asia/Tokyo'
		});

		function jstParts(date) {
			return Object.fromEntries(JST.formatToParts(new Date(date)).map(function (p) {
				return [p.type, p.value];
			}));
		}

		/** 例: 2026年1月3日 (土) 15:27 (JST) */
		function formatJst(date) {
			const p = jstParts(date);
			return p.year + '年' + p.month + '月' + p.day + '日 (' + p.weekday + ') ' + p.hour + ':' + p.minute + ' (JST)';
		}

		/** 投稿記録の offset 形式（YYYYMMDDHHMMSS、UTC） */
		function contribsOffset(date) {
			return new Date(date).toISOString().replace(/[-:TZ]/g, '').split('.')[0];
		}

		function copyToClipboard(text, quiet) {
			return navigator.clipboard.writeText(text).then(
				function () {
					if (!quiet) mw.notify('コピーしました。', { tag: 'botreq-copy' });
					return true;
				},
				function () {
					if (!quiet) mw.notify('クリップボードへのコピーに失敗しました。', { type: 'error', tag: 'botreq-copy' });
					return false;
				}
			);
		}

		function logTitleFor(timestamp) {
			return CONFIG.logPrefix + jstParts(timestamp).year + '年';
		}

		/* ---------- API ---------- */

		/** ページ（または節）の本文と、編集競合の検出に使う時刻を取得する。 */
		async function getPage(title, section) {
			const params = {
				action: 'query',
				prop: 'revisions',
				titles: title,
				rvprop: 'content|timestamp',
				rvslots: 'main',
				curtimestamp: 1,
				formatversion: 2
			};
			if (section !== undefined) params.rvsection = section;
			const data = await call(api.get(params));
			const page = data.query.pages[0];
			if (page.missing) return { missing: true, startTimestamp: data.curtimestamp };
			const rev = page.revisions[0];
			return { missing: false, content: rev.slots.main.content, baseTimestamp: rev.timestamp, startTimestamp: data.curtimestamp };
		}

		async function getEditCount(user) {
			const data = await call(api.get({ action: 'query', list: 'users', ususers: user, usprop: 'editcount', formatversion: 2 }));
			return data.query.users[0].editcount;
		}

		/** 利用者の最近の投稿（新しい順）を n 件まで取得する。 */
		async function getRecentContribs(user, n, onProgress) {
			const list = [];
			let cont = {};
			while (list.length < n) {
				const data = await call(api.get(Object.assign({
					action: 'query',
					list: 'usercontribs',
					ucuser: user,
					ucprop: 'timestamp',
					uclimit: 'max',
					formatversion: 2
				}, cont)));
				list.push.apply(list, data.query.usercontribs);
				if (onProgress) onProgress(Math.min(list.length, n), n);
				if (!data.continue) break;
				cont = data.continue;
			}
			return list.slice(0, n);
		}

		/**
		 * 依頼の節の情報（依頼者・依頼時刻・依頼のコメントID）。
		 * 依頼のコメントは、節の中のコメント（入れ子も含む）のうち最も古いもの。
		 */
		async function getThreadInfo(threadId) {
			const data = await call(api.get({
				action: 'discussiontoolspageinfo',
				page: CONFIG.requestPage,
				prop: 'threaditemshtml',
				excludesignatures: 1,
				formatversion: 2
			}));
			const heading = findItem(data.discussiontoolspageinfo.threaditemshtml, threadId);
			if (!heading) throw new Error('この依頼の節が見つかりません。ページを再読み込みしてください。');
			const comments = [];
			collectComments(heading.replies || [], comments);
			if (!comments.length) throw new Error('この依頼の節に署名つきのコメントがありません。');
			comments.sort(function (a, b) {
				return Date.parse(a.timestamp) - Date.parse(b.timestamp);
			});
			const first = comments[0];
			return { timestamp: first.timestamp, user: first.author, username: first.displayName || first.author, commentId: first.id };
		}

		function findItem(items, id) {
			for (const item of items) {
				if (item.id === id) return item;
				const found = findItem(item.replies || [], id);
				if (found) return found;
			}
			return null;
		}

		/** コメントを集める（小見出しの中は、その小見出しの依頼なので含めない）。 */
		function collectComments(items, out) {
			for (const item of items) {
				if (item.type === 'heading') continue;
				if (item.type === 'comment') out.push(item);
				collectComments(item.replies || [], out);
			}
		}

		async function editPage(params) {
			const req = {
				action: 'edit',
				title: params.title,
				text: params.text,
				summary: params.summary,
				starttimestamp: params.startTimestamp,
				assert: 'user',
				watchlist: 'nochange',
				formatversion: 2
			};
			if (params.section !== undefined) req.section = params.section;
			if (params.createOnly) {
				req.createonly = 1;
			} else {
				req.nocreate = 1;
				req.basetimestamp = params.baseTimestamp;
			}
			const data = await call(api.postWithEditToken(req));
			if (!data.edit || data.edit.result !== 'Success') {
				throw new Error('保存できませんでした（' + JSON.stringify(data.edit || data) + '）');
			}
			return data.edit;
		}

		/** 依頼の節に、依頼のコメントへの返信としてコメントを投稿する（DiscussionTools）。 */
		function postComment(commentId, wikitext) {
			return call(api.postWithEditToken({
				action: 'discussiontoolsedit',
				paction: 'addcomment',
				page: CONFIG.requestPage,
				commentid: commentId,
				wikitext: wikitext,
				assert: 'user',
				formatversion: 2
			}));
		}

		/* ---------- 依頼の節から読み取る ---------- */

		function detectStatus(text) {
			if (text.includes('解決済み')) return 'resolved';
			if (text.includes('完了')) return 'completed';
			if (text.includes('着手します')) return 'started';
			return 'open';
		}

		/** 見出しの下の本文（Parsoid の <section> と、従来の HTML の両方に対応）。 */
		function sectionContent($headingWrap, level) {
			const $section = $headingWrap.parent('section');
			if ($section.length) return $section.children().not($headingWrap);
			const stop = level === 2 ? 'h2, .mw-heading2' : 'h2, h3, .mw-heading2, .mw-heading3';
			return $headingWrap.nextUntil(stop);
		}

		/** 節の中のリンクを、議論場所の候補（ウィキテキスト）にする。署名などの利用者ページは除く。 */
		function discussionLinks($content) {
			const seen = new Set();
			const links = [];
			$content.find('a[href]').each(function () {
				if ($(this).is('.ext-discussiontools-init-timestamplink, .mw-file-description')) return; // 署名の時刻・画像
				if ($(this).closest('.mw-editsection, .mw-heading, .ext-discussiontools-init-section-bar, .ext-discussiontools-init-replylink-buttons').length) return;
				const link = linkToWikitext(this);
				if (link && !seen.has(link.wikitext)) {
					seen.add(link.wikitext);
					links.push(link);
				}
			});
			// ノートやプロジェクト関連の名前空間を先に
			return links.map(function (l, i) {
				return { l: l, i: i };
			}).sort(function (a, b) {
				return (a.l.priority - b.l.priority) || (a.i - b.i);
			}).map(function (x) {
				return x.l;
			});
		}

		function linkToWikitext(a) {
			const text = a.textContent.trim();
			if (!text) return null;
			let url;
			try {
				url = new URL(a.href, location.href);
			} catch (e) {
				return null;
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
			if (url.host !== location.host) {
				return { label: url.href, wikitext: '[' + url.href + ' ' + text + ']', priority: 2 };
			}
			// 「非転送」「履歴」などの操作リンクは除く（赤リンクの編集リンクは残す）
			const params = Array.from(url.searchParams.keys()).filter(function (k) {
				return k !== 'title';
			});
			if (params.length && !(url.searchParams.get('redlink') === '1' && url.searchParams.get('action') === 'edit')) return null;
			let name = null;
			try {
				if (url.pathname.indexOf('/wiki/') === 0) name = decodeURIComponent(url.pathname.slice(6));
				else if (url.pathname === mw.config.get('wgScript')) name = url.searchParams.get('title');
			} catch (e) {
				return null;
			}
			const title = name && mw.Title.newFromText(name);
			if (!title) return null;
			const ns = title.getNamespaceId();
			if (ns === -1 || ns === 2 || ns === 3 || ns === 6 || ns === 10) return null; // 特別・利用者（署名）・ファイル・テンプレート
			if (title.getPrefixedText() === CONFIG.requestPage) return null; // この依頼ページ自身
			let fragment = '';
			try {
				fragment = url.hash ? decodeURIComponent(url.hash.slice(1)).replace(/_/g, ' ') : '';
			} catch (e) {
				fragment = '';
			}
			const target = title.getPrefixedText() + (fragment ? '#' + fragment : '');
			const same = text.replace(/_/g, ' ') === target;
			const link = (ns === 14 ? ':' : '') + target; // カテゴリはリンクにする（記録ページを分類しない）
			return {
				label: same ? target : target + '（' + text + '）',
				wikitext: same ? '[[' + link + ']]' : '[[' + link + '|' + text + ']]',
				// ノート・Wikipedia・プロジェクトなど、議論の場になる名前空間を先に
				priority: ns % 2 === 1 || ns === 4 || ns >= 100 ? 0 : 1
			};
		}

		/* ---------- 各操作の準備（保存する内容を作る） ---------- */
		/*
		 * どの操作も同じ形の「計画」を返し、ダイアログはそれを表示・保存するだけにする。
		 *   title     編集するページ
		 *   text      ダイアログで編集するウィキテキスト（追加・変更する節）
		 *   oldText   差分の比較元
		 *   build(t)  編集したウィキテキストから、保存する本文を作る
		 *   edit      editPage に渡す追加の引数（section・時刻・createOnly）
		 *   summary   要約欄
		 *   fields    ダイアログに追加する入力欄（任意）
		 *   copy      コピー用の文字列（任意。保存時にも自動でコピーする）
		 *   comment   依頼の節へのコメント（任意。{ text, commentId, help }）
		 *   notes     ダイアログ上部に出す注意（任意）
		 */

		async function prepareStart(req) {
			const info = await getThreadInfo(req.threadId);
			const logTitle = logTitleFor(info.timestamp);
			const results = await Promise.all([getEditCount(CONFIG.botUser), getPage(logTitle)]);
			const editCount = results[0];
			const log = results[1];
			const notes = [];
			const year = jstParts(info.timestamp).year;
			const current = log.missing ? '{{../head\n|y=' + year + '\n|運用者=' + CONFIG.operator + '\n|件数=0\n}}' : log.content;
			if (log.missing) notes.push({ type: 'notice', text: logTitle + ' はまだありません。保存すると、このページを作成します。' });
			const match = current.match(HEAD_COUNT_RE);
			if (!match) throw new Error(logTitle + ' に {{../head|件数=…}} が見つかりません。');
			const num = Number(match[2] || 0) + 1;
			const withCount = current.replace(HEAD_COUNT_RE, function (all, mid) {
				return '{{../head' + mid + num;
			});
			if (!log.missing && log.content.indexOf('<!--sec ' + encodeSecId(req.threadId) + '|') !== -1) {
				notes.push({ type: 'warning', text: 'この依頼の作業記録は既にあります。続けると、もう1つ追加します。' });
			}

			const botSummary = 'Bot:[[' + logTitle + '#botreq-n-' + num + '|作業依頼]] - ' + req.name;
			const links = discussionLinks(req.$content);
			const text = [
				'== <span class="anchor" id="botreq-n-' + num + '"></span>' + req.name + ' ==',
				'<!--sec ' + encodeSecId(req.threadId) + '|' + editCount + '-->',
				'* 要約欄 - <code><nowiki>' + botSummary + NOWIKI_CLOSE + '</code>',
				'* 依頼 - [[特別:GoToComment/' + req.threadId + '|§ ' + req.name + ']]',
				'* 議論場所 - ' + (links.length ? links[0].wikitext : ''),
				'* 依頼者 - [[User:' + info.user + '|' + info.username + ']] さん',
				'* 依頼時刻 - ' + formatJst(info.timestamp),
				'* 着手(準備)時刻 - ' + formatJst(mw.now()),
				'* 終了時刻 - ',
				'* 作業 - '
			].join('\n');

			return {
				title: logTitle,
				text: text,
				oldText: log.missing ? '' : log.content,
				build: function (t) {
					return withCount.replace(/\s+$/, '') + '\n\n' + t.trim() + '\n';
				},
				edit: { createOnly: log.missing, baseTimestamp: log.baseTimestamp, startTimestamp: log.startTimestamp },
				summary: '+依頼 /* ' + req.name + ' */ 着手',
				fields: function (dialog) {
					if (!links.length) return [];
					const dropdown = new OO.ui.DropdownInputWidget({
						options: links.map(function (l, i) {
							return { data: String(i), label: l.label };
						}).concat([{ data: '', label: '（なし・ウィキテキストで入力）' }]),
						value: '0', // 既定の値 '' だと「なし」が選ばれてしまう
						$overlay: dialog.$overlay
					});
					dropdown.on('change', function (value) {
						dialog.replaceLine(/^\* 議論場所 - .*$/m, '* 議論場所 - ' + (value === '' ? '' : links[Number(value)].wikitext));
					});
					return [new OO.ui.FieldLayout(dropdown, {
						label: '議論場所',
						align: 'top',
						help: '依頼の節にあるリンクから選びます。ウィキテキストで直接書き換えることもできます。',
						helpInline: true
					})];
				},
				copy: { label: 'Bot の編集の要約', value: botSummary },
				comment: { text: '{{BOTREQ|着手}}--' + SIG, commentId: info.commentId },
				notes: notes
			};
		}

		async function prepareComplete(req) {
			const info = await getThreadInfo(req.threadId);
			const logTitle = logTitleFor(info.timestamp);
			const results = await Promise.all([getEditCount(CONFIG.botUser), getPage(logTitle)]);
			const editCount = results[0];
			const log = results[1];
			if (log.missing) throw new Error(logTitle + ' がありません。先に「着手」を保存してください。');

			const marker = '<!--sec ' + encodeSecId(req.threadId) + '|';
			const at = log.content.indexOf(marker);
			if (at === -1) throw new Error(logTitle + ' に、この依頼の作業記録が見つかりません。先に「着手」を保存してください。');
			const startCount = Number((log.content.slice(at + marker.length).match(/^\s*(\d+)\s*-->/) || [])[1]);
			if (!Number.isFinite(startCount)) throw new Error('作業記録の <!--sec …--> から着手時点の編集回数を読み取れません。');
			const bounds = logSectionBounds(log.content, at);
			const section = log.content.slice(bounds.start, bounds.end);
			const sectionCore = section.replace(/\s+$/, '');
			const sectionTail = section.slice(sectionCore.length);

			const count = editCount - startCount;
			if (count <= 0) throw new Error('着手してから ' + CONFIG.botUser + ' の編集が増えていません。');
			const contribs = await getRecentContribs(CONFIG.botUser, count, function (done, total) {
				mw.notify('投稿記録を取得しています（' + done + ' / ' + total + '件）…', { tag: 'botreq' });
			});
			if (!contribs.length) throw new Error(CONFIG.botUser + ' の投稿記録を取得できません。');
			const notes = [];
			if (contribs.length < count) {
				notes.push({ type: 'warning', text: '編集回数の差は ' + count + ' 件ですが、投稿記録には ' + contribs.length + ' 件しかありません（削除された編集など）。' + contribs.length + ' 件で記録します。' });
			}
			const work = contributionLinks(CONFIG.botUser, contribs);
			const newest = contribs[0].timestamp;
			const oldest = contribs[contribs.length - 1].timestamp;

			const text = sectionCore
				.replace(/^\* 着手(?:\(準備\))?時刻 - .*$/m, function () {
					return '* 着手時刻 - ' + formatJst(oldest);
				})
				.replace(/^\* 終了時刻 -.*$/m, function () {
					return '* 終了時刻 - ' + formatJst(newest);
				})
				.replace(/^\* 作業 -.*$/m, function () {
					return '* 作業 - ' + work;
				});

			return {
				title: logTitle,
				text: text,
				oldText: log.content,
				build: function (t) {
					return log.content.slice(0, bounds.start) + t.replace(/\s+$/, '') + sectionTail + log.content.slice(bounds.end);
				},
				edit: { baseTimestamp: log.baseTimestamp, startTimestamp: log.startTimestamp },
				summary: '/* ' + req.name + ' */ 完了 更新',
				comment: {
					text: '{{at|' + info.user + '}}:{{BOTREQ|完了}} Botにて' + work + '行いました。が0項目のため、完了とします。問題等なければ{{tl|確認}}の貼付をお願いします。--' + SIG,
					commentId: info.commentId,
					help: '「…が0項目のため」の部分は、必要に応じて書き換えてください。'
				},
				notes: notes
			};
		}

		async function prepareResolve(req) {
			const page = await getPage(CONFIG.requestPage, req.sectionIndex);
			if (page.missing) throw new Error(CONFIG.requestPage + ' が見つかりません。');
			const lines = page.content.split('\n');
			const notes = [];
			if (!/^=/.test(lines[0]) || plainHeading(lines[0]).indexOf(req.name) === -1) {
				notes.push({ type: 'warning', text: '取得した節の見出しが「' + req.name + '」と一致しません。節の位置が変わった可能性があります。差分をよく確認してください。' });
			}
			if (/\{\{\s*解決済み/.test(page.content)) {
				notes.push({ type: 'warning', text: 'この節には既に {{解決済み}} があります。' });
			}
			lines.splice(1, 0, '{{解決済み|' + SIG + '}}');
			return {
				title: CONFIG.requestPage,
				text: lines.join('\n'),
				oldText: page.content,
				build: function (t) {
					return t;
				},
				edit: { section: req.sectionIndex, baseTimestamp: page.baseTimestamp, startTimestamp: page.startTimestamp },
				summary: '/* ' + req.name + ' */ + 解決済み',
				notes: notes
			};
		}

		const PREPARE = { start: prepareStart, complete: prepareComplete, resolve: prepareResolve };

		function encodeSecId(threadId) {
			return threadId.replace(/-/g, SEC_ID_SEP);
		}

		/** 作業記録の節の範囲（marker を含む見出しの行から、次の見出しの手前まで）。 */
		function logSectionBounds(content, markerAt) {
			const markerLine = content.lastIndexOf('\n', markerAt - 1) + 1;
			const prevLine = markerLine > 0 ? content.lastIndexOf('\n', markerLine - 2) + 1 : 0;
			const start = markerLine > 0 && content.charAt(prevLine) === '=' ? prevLine : markerLine;
			const next = /\n=/g;
			next.lastIndex = markerAt;
			const m = next.exec(content);
			return { start: start, end: m ? m.index + 1 : content.length };
		}

		/** {{利用者の投稿記録リンク}} を、新しい順に contribsPerLink 件ずつ並べる。 */
		function contributionLinks(user, contribs) {
			const links = [];
			for (let i = 0; i < contribs.length; i += CONFIG.contribsPerLink) {
				const chunk = contribs.slice(i, i + CONFIG.contribsPerLink);
				const offset = contribsOffset(Date.parse(chunk[0].timestamp) + 1000);
				links.push('{{利用者の投稿記録リンク|' + user + '|' + chunk.length + '|' + offset + '|text=' + chunk.length + '編集}}');
			}
			return links.join(',') + (links.length > 1 ? 'の計' + contribs.length + '編集' : '');
		}

		function plainHeading(line) {
			return line
				.replace(/^=+|=+\s*$/g, '')
				.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
				.replace(/'{2,}/g, '')
				.replace(/<[^>]+>/g, '')
				.trim();
		}

		/* ---------- ダイアログ ---------- */

		function BotreqDialog(config) {
			BotreqDialog.super.call(this, config);
		}
		OO.inheritClass(BotreqDialog, OO.ui.ProcessDialog);
		BotreqDialog.static.name = 'botreqDialog';
		BotreqDialog.static.size = 'larger';
		BotreqDialog.static.actions = [
			{ action: 'save', label: '保存', flags: ['primary', 'progressive'] },
			{ label: 'キャンセル', flags: ['safe', 'close'] }
		];

		BotreqDialog.prototype.initialize = function () {
			BotreqDialog.super.prototype.initialize.apply(this, arguments);
			this.content = new OO.ui.PanelLayout({ padded: true, expanded: false });
			this.$body.append(this.content.$element);
			this.$element.addClass('botreq-dialog');
		};

		BotreqDialog.prototype.getSetupProcess = function (data) {
			return BotreqDialog.super.prototype.getSetupProcess.call(this, data).next(function () {
				this.plan = data.plan;
				this.onSaved = data.onSaved;
				this.build();
			}, this);
		};

		BotreqDialog.prototype.getReadyProcess = function (data) {
			return BotreqDialog.super.prototype.getReadyProcess.call(this, data).next(function () {
				this.summaryInput.focus();
			}, this);
		};

		BotreqDialog.prototype.build = function () {
			const plan = this.plan;
			const self = this;
			const $c = this.content.$element.empty();

			(plan.notes || []).forEach(function (note) {
				$c.append(new OO.ui.MessageWidget({ type: note.type, label: note.text, inline: true, classes: ['botreq-note'] }).$element);
			});

			this.textInput = new OO.ui.MultilineTextInputWidget({ value: plan.text, rows: 14, classes: ['botreq-wikitext'] });
			this.summaryInput = new OO.ui.TextInputWidget({ value: plan.summary });
			this.dirty = { preview: true, diff: true };
			this.textInput.on('change', function () {
				self.dirty = { preview: true, diff: true };
			});

			const fields = [
				new OO.ui.FieldLayout(new OO.ui.LabelWidget({
					label: $('<a>').attr({ href: mw.util.getUrl(plan.title), target: '_blank' }).text(plan.title)
				}), { label: '編集するページ', align: 'left' })
			].concat(plan.fields ? plan.fields(this) : []);
			fields.push(new OO.ui.FieldLayout(this.summaryInput, { label: '要約', align: 'top' }));
			$c.append(new OO.ui.FieldsetLayout({ items: fields }).$element);

			this.previewPanel = new OO.ui.TabPanelLayout('preview', { label: 'プレビュー', expanded: false });
			this.diffPanel = new OO.ui.TabPanelLayout('diff', { label: '差分', expanded: false });
			const textPanel = new OO.ui.TabPanelLayout('text', { label: 'ウィキテキスト', expanded: false });
			this.$preview = $('<div>').addClass('botreq-render mw-body-content').appendTo(this.previewPanel.$element);
			this.$diff = $('<div>').addClass('botreq-render').appendTo(this.diffPanel.$element);
			textPanel.$element.append(this.textInput.$element);
			this.tabs = new OO.ui.IndexLayout({ expanded: false, autoFocus: false, classes: ['botreq-tabs'] });
			this.tabs.addTabPanels([this.previewPanel, this.diffPanel, textPanel]);
			this.tabs.on('set', function (panel) {
				self.refresh(panel.getName());
			});
			$c.append(this.tabs.$element);

			const extra = [];
			if (plan.copy) {
				extra.push(this.copyField(new OO.ui.TextInputWidget({ value: plan.copy.value, readOnly: true }), plan.copy.label, '保存するときにも自動でコピーします。'));
			}
			if (plan.comment) {
				this.commentInput = new OO.ui.MultilineTextInputWidget({ value: plan.comment.text, rows: 3, autosize: true });
				this.postCheckbox = new OO.ui.CheckboxInputWidget({ selected: false });
				extra.push(this.copyField(this.commentInput, '依頼の節へのコメント', plan.comment.help));
				extra.push(new OO.ui.FieldLayout(this.postCheckbox, {
					label: '保存と同時に、依頼のコメントへの返信として投稿する',
					align: 'inline',
					help: '投稿しない場合は、保存するときにコメントをコピーします。',
					helpInline: true
				}));
			}
			if (extra.length) $c.append(new OO.ui.FieldsetLayout({ items: extra, classes: ['botreq-extra'] }).$element);

			this.refresh('preview');
		};

		/** 入力欄の横に「コピー」ボタンを付けた行。 */
		BotreqDialog.prototype.copyField = function (input, label, help) {
			const button = new OO.ui.ButtonWidget({ label: 'コピー' });
			button.on('click', function () {
				copyToClipboard(input.getValue());
			});
			return new OO.ui.ActionFieldLayout(input, button, { label: label, align: 'top', help: help, helpInline: true });
		};

		/** ウィキテキストの1行を置き換える（議論場所の選択など）。 */
		BotreqDialog.prototype.replaceLine = function (re, line) {
			const value = this.textInput.getValue();
			this.textInput.setValue(re.test(value) ? value.replace(re, function () {
				return line;
			}) : value + '\n' + line);
			this.refresh(this.tabs.getCurrentTabPanelName());
		};

		BotreqDialog.prototype.refresh = function (name) {
			if (!this.dirty[name]) return;
			this.dirty[name] = false;
			const self = this;
			const text = this.textInput.getValue();
			const $box = name === 'preview' ? this.$preview : this.$diff;
			const token = (this.token = (this.token || 0) + 1);
			$box.empty().append(new OO.ui.ProgressBarWidget({ progress: false }).$element);
			this.updateSize();
			const request = name === 'preview' ? renderPreview(this.plan.title, text) : renderDiff(this.plan, text);
			request.then(function ($html) {
				if (token === self.token) $box.empty().append($html);
			}, function (err) {
				if (token === self.token) {
					$box.empty().append(new OO.ui.MessageWidget({ type: 'error', inline: true, label: '表示できませんでした: ' + errorText(err) }).$element);
				}
				self.dirty[name] = true;
			}).then(function () {
				self.updateSize();
			});
		};

		BotreqDialog.prototype.getBodyHeight = function () {
			return this.content.$element.outerHeight(true);
		};

		BotreqDialog.prototype.getActionProcess = function (action) {
			if (action !== 'save') return BotreqDialog.super.prototype.getActionProcess.call(this, action);
			const plan = this.plan;
			const text = this.textInput.getValue();
			const summary = this.summaryInput.getValue();
			const post = Boolean(this.postCheckbox && this.postCheckbox.isSelected());
			const commentText = this.commentInput ? this.commentInput.getValue().trim() : '';
			// クリックの直後でないとコピーできないため、保存の前にコピーする
			const copyText = plan.copy ? plan.copy.value : !post ? commentText : '';
			if (copyText) copyToClipboard(copyText, true);
			const self = this;
			return new OO.ui.Process(function () {
				return toJq(self.save(text, summary, post ? commentText : ''));
			});
		};

		BotreqDialog.prototype.save = async function (text, summary, commentText) {
			const plan = this.plan;
			let result;
			try {
				result = await editPage(Object.assign({ title: plan.title, text: plan.build(text), summary: summary }, plan.edit));
			} catch (err) {
				throw new OO.ui.Error(errorText(err), { recoverable: err.code !== 'editconflict' && err.code !== 'articleexists' });
			}
			let commentError = null;
			if (commentText) {
				try {
					await postComment(plan.comment.commentId, commentText);
				} catch (err) {
					commentError = err;
				}
			}
			this.close({ action: 'save' });

			const $msg = $('<span>').text('「' + plan.title + '」を保存しました。');
			if (result.newrevid) {
				$msg.append(' ', $('<a>').attr('href', mw.util.getUrl('Special:Diff/' + result.newrevid)).text('差分'));
			}
			if (result.nochange) $msg.text('「' + plan.title + '」に変更はありませんでした。');
			mw.notify($msg, { type: 'success', tag: 'botreq' });
			if (commentError) {
				mw.notify('コメントの投稿に失敗しました: ' + errorText(commentError) + '（コメントは手動で投稿してください）', { type: 'error', autoHide: false });
				copyToClipboard(commentText, true);
			} else if (commentText) {
				mw.notify('依頼の節にコメントを投稿しました。', { type: 'success', tag: 'botreq-comment' });
			}
			if (this.onSaved) this.onSaved();
		};

		function renderPreview(title, text) {
			return call(api.post({
				action: 'parse',
				title: title,
				text: text,
				contentmodel: 'wikitext',
				pst: true,
				preview: true,
				prop: 'text',
				disableeditsection: true,
				disablelimitreport: true,
				formatversion: 2
			})).then(function (data) {
				return $($.parseHTML(data.parse.text));
			});
		}

		function renderDiff(plan, text) {
			return call(api.post({
				action: 'compare',
				fromtitle: plan.title,
				fromslots: 'main',
				'fromtext-main': plan.oldText,
				'fromcontentmodel-main': 'wikitext',
				totitle: plan.title,
				toslots: 'main',
				'totext-main': plan.build(text),
				'tocontentmodel-main': 'wikitext',
				prop: 'diff',
				difftype: 'table',
				formatversion: 2
			})).then(function (data) {
				const body = data.compare && data.compare.body;
				if (!body) return $('<p>').text('差分はありません。');
				return $('<table>').addClass('diff').append(
					$('<colgroup>').append(
						$('<col>').addClass('diff-marker'),
						$('<col>').addClass('diff-content'),
						$('<col>').addClass('diff-marker'),
						$('<col>').addClass('diff-content')
					),
					$('<tbody>').html(body)
				);
			});
		}

		/* ---------- 見出しへの操作の追加 ---------- */

		let busy = false;

		async function runAction(kind, req) {
			if (busy) return;
			busy = true;
			const label = ACTION_LABELS[kind];
			mw.notify(label + 'の準備をしています…', { tag: 'botreq' });
			try {
				const plan = await PREPARE[kind](req);
				mw.notify(label + 'の内容を確認してください。', { tag: 'botreq' });
				const manager = new OO.ui.WindowManager();
				$(document.body).append(manager.$element);
				const dialog = new BotreqDialog();
				manager.addWindows([dialog]);
				const instance = manager.openWindow(dialog, {
					title: label + ': ' + req.name,
					plan: plan,
					onSaved: function () {
						req.setStatus(STATUS_AFTER[kind]);
					}
				});
				await instance.closed;
				manager.destroy();
			} catch (err) {
				mw.notify(label + 'できませんでした: ' + errorText(err), { type: 'error', tag: 'botreq' });
			} finally {
				busy = false;
			}
		}

		function addTools($heading) {
			const threadId = $heading.attr('data-mw-thread-id');
			// 依頼の節だけ（冒頭の案内など、署名つきコメントの無い節は ID が時刻で終わらない）
			if (!threadId || !/-\d{14}$/.test(threadId)) return;
			const level = $heading.is('h2') ? 2 : 3;
			const $wrap = $heading.parent('.mw-heading').length ? $heading.parent() : $heading;
			const $editsection = $wrap.find('.mw-editsection').first();
			const editHref = $editsection.find('a[href*="section="]').attr('href') || '';
			const sectionMatch = /[?&]section=(\d+)(?:&|$)/.exec(editHref);
			if (!sectionMatch) return; // 読み込まれた別ページの節（section=T-…）は除く

			const req = {
				threadId: threadId,
				name: $heading.text().trim(),
				sectionIndex: sectionMatch[1],
				$content: sectionContent($wrap, level)
			};
			req.status = detectStatus(req.$content.text());

			const $main = $('<a>').attr({ href: '#', role: 'button' }).addClass('botreq-main');
			const menu = new OO.ui.ButtonMenuSelectWidget({
				framed: false,
				icon: null,
				indicator: 'down',
				label: 'Bot作業依頼の操作',
				invisibleLabel: true,
				title: 'Bot作業依頼の操作（着手・完了・解決）',
				classes: ['botreq-menu'],
				$overlay: true,
				menu: {
					horizontalPosition: 'end',
					items: Object.keys(ACTION_LABELS).map(function (kind) {
						return new OO.ui.MenuOptionWidget({ data: kind, label: ACTION_LABELS[kind] });
					})
				}
			});
			menu.getMenu().on('choose', function (item) {
				runAction(item.getData(), req);
			});

			req.setStatus = function (status) {
				req.status = status;
				const next = NEXT_ACTION[status];
				$main
					.text(next ? ACTION_LABELS[next] : '解決済み')
					.attr('title', next ? ACTION_LABELS[next] + 'する（右クリックで他の操作）' : '解決済みです（右クリックで他の操作）')
					.toggleClass('botreq-main-done', !next);
			};
			req.setStatus(req.status);

			$main.on('click', function (e) {
				e.preventDefault();
				const next = NEXT_ACTION[req.status];
				if (next) runAction(next, req);
				else menu.getMenu().toggle(true);
			});
			$main.on('contextmenu', function (e) {
				e.preventDefault();
				menu.getMenu().toggle(true);
			});

			// 次の操作のリンクは [編集] と同じ括弧の中に、▼ のメニューはその外に置く
			// （Vector 2022 は .mw-editsection 内のリンクそれぞれに括弧を付けるため）
			const $tools = $('<span>').addClass('botreq-tools').append($('<span>').addClass('mw-editsection-bracket').text('|'), $main);
			const $close = $editsection.children('.mw-editsection-bracket').last();
			if ($close.length) $close.before($tools);
			else $editsection.append($tools);
			$editsection.after(menu.$element);
		}

		mw.util.addCSS([
			'.botreq-tools { white-space: nowrap; }',
			'.botreq-main-done { color: var(--color-subtle, #54595d) !important; }',
			'.botreq-menu.oo-ui-buttonElement-frameless { margin: 0; vertical-align: middle; }',
			'.botreq-menu.oo-ui-buttonElement-frameless > .oo-ui-buttonElement-button { min-width: 0; min-height: 0; padding: 0 0 0 16px; }',
			'.botreq-dialog .botreq-note { margin-bottom: 8px; }',
			'.botreq-dialog .botreq-tabs { margin-top: 12px; }',
			'.botreq-dialog .botreq-render { max-height: 45vh; overflow: auto; padding: 8px; border: 1px solid var(--border-color-base, #a2a9b1); border-top: 0; }',
			'.botreq-dialog .botreq-wikitext textarea { font-family: monospace, monospace; font-size: 90%; }',
			'.botreq-dialog .botreq-extra { margin-top: 12px; }'
		].join('\n'));

		$('#mw-content-text').find('h2[data-mw-thread-id], h3[data-mw-thread-id]').each(function () {
			addTools($(this));
		});
	}
}());
//</nowiki>
