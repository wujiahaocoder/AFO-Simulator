/* Loaded only by debug-server.cjs, never by the distributed player page. */
"use strict";
(() => {
    const boot = window.AFODebugBoot;
    if (!boot?.enabled || location.hostname !== '127.0.0.1' || !boot.token) return;
    const copy = value => JSON.parse(JSON.stringify(value, (_, v) => v instanceof Set ? [...v] : v));
    const originalMain = document.querySelector('.main').innerHTML;
    const journal = [];
    let randomState = 1, sessionId = null;
    Math.random = () => {
        randomState = (randomState + 0x6D2B79F5) >>> 0;
        let t = randomState; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    function checkJSON(value, depth = 0) {
        if (depth > 40) throw new Error('State nesting exceeds 40');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Numbers must be finite');
        if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Reserved state key: ' + key);
            checkJSON(child, depth + 1);
        }
    }
    function merge(target, patch, prefix = '') {
        if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new Error('state must be an object');
        for (const [key, value] of Object.entries(patch)) {
            const field = prefix + key;
            if (!prefix && !Object.hasOwn(initialState, key)) throw new Error('Unknown state field: ' + field);
            const previous = target[key];
            if (key === 'achievements' && !prefix) {
                if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('achievements must be a string array');
                target[key] = new Set(value); continue;
            }
            if (typeof previous === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(field + ' must be finite');
            if (typeof previous === 'boolean' && typeof value !== 'boolean') throw new Error(field + ' must be boolean');
            if (typeof previous === 'string' && typeof value !== 'string') throw new Error(field + ' must be text');
            if (Array.isArray(previous) && !Array.isArray(value)) throw new Error(field + ' must be an array');
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                if (previous !== null && previous !== undefined && (typeof previous !== 'object' || Array.isArray(previous))) throw new Error('Invalid object: ' + field);
                if (['subjects', 'relationships', 'homework'].includes(key) && !prefix) {
                    for (const child of Object.keys(value)) if (!Object.hasOwn(previous, child)) throw new Error('Unknown field: ' + field + '.' + child);
                }
                target[key] = previous && typeof previous === 'object' ? previous : {};
                merge(target[key], value, field + '.');
            } else target[key] = copy(value);
        }
    }
    function validate(state) {
        if (!Number.isInteger(state.week) || state.week < 1 || state.week > 52) throw new Error('week must be an integer from 1 to 52');
        if (!['playing', 'postExam', 'ending'].includes(state.phase)) throw new Error('Unknown phase');
        if (state.phase !== 'playing' && !state.finalSnapshot) throw new Error('Post-exam state needs finalSnapshot');
        for (const field of ['subjects', 'relationships']) for (const value of Object.values(state[field])) {
            if (!Number.isFinite(value)) throw new Error(field + ' values must be finite');
        }
        if (!Number.isInteger(state.actionsThisWeek) || state.actionsThisWeek < 0 || state.actionsThisWeek > 3) throw new Error('actionsThisWeek must be 0—3');
        if (!Array.isArray(state.events) || state.events.some(id => !findNarrative(id))) throw new Error('Unknown narrative event in events');
    }
    function assign(state) {
        for (const key of Object.keys(gameState)) delete gameState[key];
        Object.assign(gameState, state, { achievements: new Set(state.achievements) });
    }
    function closeWindows() {
        for (const modal of document.querySelectorAll('.modal')) modal.style.display = 'none';
        elements.notification.classList.remove('show');
        buttonCooldown = false;
    }
    function render({ resume = false } = {}) {
        closeWindows();
        if (gameState.phase === 'playing') {
            document.querySelector('.container').classList.remove('post-exam');
            document.querySelector('.actions').style.display = '';
            document.getElementById('actionCounter').style.display = '';
            if (!document.getElementById('event-log')) {
                document.querySelector('.main').innerHTML = originalMain;
                for (const [key, node] of Object.entries(elements)) if (node?.id) elements[key] = document.getElementById(node.id);
            }
        }
        // Loading a fixture must not collect rewards or clamp requested boundary values.
        const claim = claimStageGoal;
        try {
            claimStageGoal = () => {};
            checkStageGoals(); updateUI();
            if (gameState.phase !== 'playing') renderPostExam();
            if (elements.eventLog?.isConnected) {
                elements.eventLog.innerHTML = '';
                for (const row of gameState.logHistory.slice(0, 20).reverse()) legacyLog(row.text, row.type, row.time);
            }
            if (gameState.schedule.length) updateScheduleUI();
        } finally { claimStageGoal = claim; }
        if (resume) {
            if (gameState.narrativeFeedback || gameState.activeNarrative || gameState.narrativeQueue.length) pumpNarrative();
            else if (gameState.weekEnding && gameState.homeworkSettledWeek !== gameState.week) showWeekendHomework();
        }
        saveGame();
    }
    function load(command) {
        const state = copy(initialState);
        state.achievements = new Set();
        const week = command.week ?? command.state?.week ?? 1;
        Object.assign(state, { week, completedWeeks: week - 1, daysLeft: (53 - week) * 7,
            season: Math.floor((week - 1) / 13), currentWeather: { ...weathers[0], id: 'sun' } });
        merge(state, command.state || {}); validate(state);
        if (command.seed !== undefined && (!Number.isInteger(command.seed) || command.seed < 0 || command.seed > 0xffffffff)) throw new Error('seed must be uint32');
        randomState = command.seed ?? 1;
        assign(state); generateSchedule(); render();
        if (elements.randomEvent?.isConnected) elements.randomEvent.textContent = '暂无事件';
    }
    function freezeForDebug() {
        gameState.finalSnapshot ||= { score: Math.round(stageAverage(gameState)), subjects: { ...gameState.subjects },
            health: gameState.health, mental: gameState.mental, anxiety: gameState.anxiety, stress: gameState.stress };
        gameState.gameOver = true; gameState.phase = 'postExam';
    }
    function enter(command) {
        const id = command.scene;
        const node = findNarrative(id), ending = narrativeData.endings[id];
        const panels = ['@home', '@homework', '@bluebook', '@rest', '@exam', '@postExam'];
        if (!node && !ending && !panels.includes(id)) throw new Error('Unknown scene: ' + id);
        if (command.reset !== false) load({ ...command, week: command.week ?? node?.week ?? 1 });
        else if (command.state || command.week !== undefined) {
            const state = copy(gameState);
            merge(state, { ...(command.state || {}), ...(command.week === undefined ? {} : { week: command.week }) });
            validate(state); assign(state); render();
        }
        gameState.narrativeQueue = []; gameState.activeNarrative = null; gameState.narrativeFeedback = null;
        gameState.weekEnding = false;
        closeWindows();
        if (node) {
            if (node.id === 'S36') freezeForDebug();
            else if (gameState.phase !== 'playing') throw new Error('Use playing phase for non-final story scenes');
            gameState.events = gameState.events.filter(value => value !== id);
            gameState.randomSeen = gameState.randomSeen.filter(value => value !== id);
            if (node.kind === 'main') delete gameState.storyChoices[id];
            gameState.storyProgress = narrativeData.stories.filter(n => n.kind === 'main' && gameState.events.includes(n.id)).length;
            // Forced entry bypasses discovery/scheduling only. Real choice handlers still apply effects and records.
            gameState.activeNarrative = id; pumpNarrative();
        } else if (ending) {
            freezeForDebug(); renderPostExam();
            if (Object.hasOwn(routePlanOptions, id)) renderPostExam(id);
            else showMenu(ending.title, /^E\d/.test(id) ? mainEndingContent(id) : epilogueContent(id),
                [{ text: '继续', action: () => closeModal('story-modal') }]);
        } else if (id === '@homework') {
            gameState.weekEnding = true; gameState.homeworkSettledWeek = null; showWeekendHomework();
        } else if (id === '@bluebook') showPromiseLedger();
        else if (id === '@rest') openModal('rest-modal');
        else if (id === '@exam') showExamMenu();
        else if (id === '@postExam') { freezeForDebug(); renderPostExam(); }
        saveGame();
        return { scene: id, entryMode: node ? 'forced-scene' : ending ? 'ending-preview' : 'panel',
            note: 'Entry does not prove natural eligibility or create prerequisite choices.' };
    }
    function numericDelta(before, after, prefix = '') {
        const result = {};
        for (const [key, value] of Object.entries(after)) {
            const name = prefix + key;
            if (typeof value === 'number' && typeof before?.[key] === 'number' && value !== before[key]) result[name] = value - before[key];
            else if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(result, numericDelta(before?.[key], value, name + '.'));
        }
        return result;
    }
    function snapshot() {
        return { state: copy(gameState), randomState, storageKey: saveKey, sceneNote: elements.randomEvent?.textContent || '暂无事件',
            visible: [...document.querySelectorAll('.modal')].filter(e => getComputedStyle(e).display !== 'none')
                .map(e => ({ id: e.id, text: e.innerText })),
            log: copy(gameState.logHistory), mainText: document.querySelector('.main').innerText };
    }
    function catalog() {
        return { stories: [...narrativeData.stories, ...narrativeData.random].map(n => ({ id: n.id, kind: n.kind,
            title: n.title, week: n.week, until: n.until, requires: n.requires, condition: n.condition,
            choices: n.choices.map(c => ({ key: c.key, text: c.text, target: c.target })) })),
            endings: Object.entries(narrativeData.endings).map(([id, n]) => ({ id, title: n.title })),
            panels: ['@home', '@homework', '@bluebook', '@rest', '@exam', '@postExam'],
            stateFields: Object.keys(initialState) };
    }
    function run(command) {
        checkJSON(command);
        const before = snapshot(), oldRandom = randomState;
        let detail;
        try {
            switch (command.op) {
                case 'catalog': return catalog();
                case 'snapshot': return snapshot();
                case 'load': load(command); break;
                case 'patch': {
                    const state = copy(gameState); merge(state, command.state); validate(state); assign(state); render({ resume: true }); break;
                }
                case 'enter': detail = enter(command); break;
                case 'restore': {
                    checkJSON(command.snapshot);
                    const state = copy(initialState); state.achievements = new Set();
                    merge(state, command.snapshot.state); validate(state);
                    if (!Number.isInteger(command.snapshot.randomState)) throw new Error('Snapshot needs randomState');
                    assign(state); randomState = command.snapshot.randomState >>> 0; render({ resume: true });
                    if (elements.randomEvent?.isConnected) elements.randomEvent.textContent = typeof command.snapshot.sceneNote === 'string' ? command.snapshot.sceneNote : '暂无事件';
                    break;
                }
                case 'respond': {
                    if (command.key) {
                        const node = findNarrative(gameState.activeNarrative);
                        if (!node) throw new Error('No scene awaiting a choice');
                        const choice = resolveChoices(node).find(c => c.key === command.key &&
                            (!command.targets || JSON.stringify(c.targets) === JSON.stringify(command.targets)));
                        if (!choice || !commitNarrativeChoice(node, choice)) throw new Error('Choice is unavailable');
                    } else {
                        const buttons = [...document.querySelectorAll('#story-choices button')];
                        if (!Number.isInteger(command.index) || !buttons[command.index] || buttons[command.index].disabled ||
                            getComputedStyle(document.getElementById('story-modal')).display === 'none') throw new Error('No available button at index');
                        buttons[command.index].click();
                    }
                    break;
                }
                case 'act': {
                    const actions = { study: () => { if (!Object.hasOwn(subjectNames, command.value)) throw new Error('Unknown subject'); study(command.value); },
                        rest: () => { if (!['sleep', 'nap', 'relax', 'music', 'counseling'].includes(command.value)) throw new Error('Unknown rest'); rest(command.value); },
                        social: () => { if (!Object.hasOwn(relationshipNames, command.value)) throw new Error('Unknown person'); social(command.value); },
                        exam: takeExam, homework: () => homework(command.value), continue: continueNarrative,
                        endWeek, exercise, bluebook: showPromiseLedger };
                    if (!Object.hasOwn(actions, command.action)) throw new Error('Unknown action');
                    actions[command.action](); break;
                }
                case 'route': {
                    if (!Object.hasOwn(routePlanOptions, command.route)) throw new Error('Unknown route');
                    if (command.field && !setRoutePlan(command.route, command.field, command.value)) throw new Error('Unavailable route field');
                    if (command.confirm) { if (!confirmRoute(command.route)) throw new Error('Route cannot be confirmed'); }
                    else renderPostExam(command.route);
                    break;
                }
                default: throw new Error('Unknown debug operation: ' + command.op);
            }
            const after = snapshot();
            const entry = { op: command.op, week: gameState.week, scene: command.scene, delta: numericDelta(before.state, after.state) };
            journal.push(entry); if (journal.length > 100) journal.shift();
            return { ...after, detail, delta: entry.delta, debugLog: copy(journal) };
        } catch (error) {
            assign(before.state); randomState = oldRandom;
            try { render({ resume: true }); } catch (_) { /* Keep the original diagnostic error. */ }
            if (elements.randomEvent?.isConnected) elements.randomEvent.textContent = before.sceneNote;
            throw error;
        }
    }
    async function request(url, body) {
        const response = await fetch(url, { method: body ? 'POST' : 'GET',
            headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || response.statusText); return data;
    }
    const api = Object.freeze({ run, get sessionId() { return sessionId; }, version: 1 });
    Object.defineProperty(window, 'AFODebug', { value: api });
    async function connect() {
        try { sessionId = (await request('/__debug__/sessions', {})).id; }
        catch (error) { console.error('AFO debug connection:', error.message); return; }
        while (sessionId) {
            try {
                const job = await request('/__debug__/sessions/' + sessionId + '/next');
                if (job.jobId) {
                    let result;
                    try { result = { ok: true, result: run(job.command) }; }
                    catch (error) { result = { ok: false, error: error.message }; }
                    await request('/__debug__/jobs/' + job.jobId, { ...result, sessionId });
                }
            } catch (error) { console.error('AFO debug transport:', error.message); break; }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }
    window.addEventListener('load', connect, { once: true });
})();
