// Runs the actual offline game functions in a seeded VM; UI nodes are lightweight stubs.
// node scripts/simulate.js --check | node scripts/simulate.js --seeds=500
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || path.join('analysis', '3.0.1'));
fs.mkdirSync(output, { recursive: true });

class Node {
    constructor() { this.style = {}; this.children = []; this.textContent = ''; this._html = ''; this.scrollTop = 0; this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} }; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html; }
    appendChild(child) { this.children.push(child); return child; }
    insertBefore(child) { this.children.unshift(child); return child; }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children.at(-1) || null; }
    get childNodes() { return this.children; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    addEventListener() {}
    querySelectorAll() { return this.children; }
    querySelector() { return new Node(); }
}
function seeded(seed) {
    let value = seed >>> 0;
    const random = () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    random.reset = seed => { value = seed >>> 0; };
    return random;
}
function runtime(mode = 'new', storage = new Map()) {
    const nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
    const random = seeded(1);
    const math = Object.create(Math); math.random = random;
    const context = vm.createContext({
        Math: math, console, window: { addEventListener() {} }, document: { getElementById: node, querySelector: node,
            querySelectorAll: () => [...nodes.values()], createElement: () => new Node(), createTextNode: text => ({ textContent: text }), addEventListener() {} },
        localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        location: { reload() {} }, confirm: () => true, alert() {}, setTimeout: () => 0, clearTimeout() {}
    });
    const filename = mode === 'new' ? 'index.html' : mode === 'snapshot300' ? path.join('analysis', '3.0.1', 'baseline-index.html') : path.join('analysis', '3.0.0', 'baseline.html');
    const html = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const script of html.matchAll(/<script(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/g)) {
        const scriptPath = script[1] && mode === 'snapshot300' ? path.join('analysis', '3.0.1', 'baseline-' + script[1]) : script[1];
        vm.runInContext(script[1] ? fs.readFileSync(path.join(root, scriptPath), 'utf8') : script[2], context, { filename: script[1] || filename });
    }
    if (mode === 'timeFixed') vm.runInContext('advanceTime = function(){gameState.period=(gameState.period+1)%4;};', context);
    const api = vm.runInContext(`({ s: gameState, init: initGame, update: updateUI, study, rest, social, takeExam, homework, activity, economy, exercise,
        endWeek, applyEffect, checkAchievements, triggerStoryEvent, save: typeof saveGame === 'function' ? saveGame : null,
        review: typeof reviewExam === 'function' ? reviewExam : null,
        reviews: typeof availableReviews === 'function' ? availableReviews : null,
        group: typeof studyTogether === 'function' ? studyTogether : null,
        partners: typeof availableStudyPartners === 'function' ? availableStudyPartners : null,
        groupSubjects: typeof groupSubjects === 'function' ? groupSubjects : null,
        efficiency: calculateStudyEfficiency,
        restore: typeof restoreGame === 'function' ? restoreGame : null,
        data: typeof narrativeData !== 'undefined' ? narrativeData : null,
        find: typeof findNarrative === 'function' ? findNarrative : null,
        resolve: typeof resolveChoices === 'function' ? resolveChoices : null,
        commit: typeof commitNarrativeChoice === 'function' ? commitNarrativeChoice : null,
        proceed: typeof continueNarrative === 'function' ? continueNarrative : null,
        random: typeof availableRandomEvents === 'function' ? availableRandomEvents : null,
        rule: typeof matchesRule === 'function' ? matchesRule : null,
        sides: typeof availableSideStories === 'function' ? availableSideStories : null,
        confirmRoute: typeof confirmRoute === 'function' ? confirmRoute : null,
        mainEnding: typeof mainEndingId === 'function' ? mainEndingId : null,
        epilogues: typeof chooseEpilogues === 'function' ? chooseEpilogues : null,
        renderContent: typeof renderStoryContent === 'function' ? renderStoryContent : null,
        originalStories: typeof storyEvents !== 'undefined' ? storyEvents : null })`, context);
    const initial = JSON.stringify(api.s, (_, val) => val instanceof Set ? [...val] : val);
    return { ...api, context, node, storage, reset(seed) {
        const fresh = JSON.parse(initial); fresh.achievements = new Set();
        Object.assign(api.s, fresh); storage.clear(); random.reset(seed);
        for (const n of nodes.values()) { n.innerHTML = ''; n.style.display = 'none'; }
        api.init(); node('welcome-modal').style.display = 'none';
    } };
}
const costs = { chinese: 25, math: 35, english: 25, physics: 35, chemistry: 20, biology: 20 };
const coefficients = { chinese: 7.5, math: 18.9, english: 7.5, physics: 18.9, chemistry: 9, biology: 9 };
const keys = Object.keys(costs);
const mean = s => Object.values(s.subjects).reduce((a, b) => a + b, 0) / 6;
function narrativeValue(choice, state) {
    let value = 0;
    for (const [key, amount] of Object.entries(choice.effect || {})) {
        if (key === 'subjects') value += Object.entries(amount).reduce((n, [sub, v]) => n + (sub === 'all' ? keys : [sub]).reduce((p, k) => p + Math.min(v, 100 - state.subjects[k]), 0), 0) * 5;
        else if (keys.includes(key)) value += Math.min(amount, 100 - state.subjects[key]) * 5;
        else if (key === 'anxiety') value -= amount * (state.anxiety > 20 ? 1.5 : 0.3);
        else if (key === 'energy') value += amount * (state.energy < 60 ? 0.3 : 0.05);
        else if (key === 'mental') value += amount * (state.mental < 60 ? 0.6 : 0.1);
        else if (key === 'health') value += amount * (state.health < 60 ? 1 : 0.2);
        else if (key === 'stress') value -= amount * (state.stress > 35 ? 0.5 : 0.1);
        else if (key === 'money') value += amount * 0.005;
        else value += amount * 0.1;
    }
    return value;
}
function choose(choices, state) {
    return choices.filter(c => (c.effect?.money || 0) >= -state.money).sort((a, b) => narrativeValue(b, state) - narrativeValue(a, state))[0];
}
function drain(r) {
    let guard = 0;
    while (guard++ < 150) {
        if (r.data) {
            if (r.s.narrativeFeedback) { r.proceed(); continue; }
            if (r.s.activeNarrative) {
                const node = r.find(r.s.activeNarrative);
                const choice = choose(r.resolve(node), r.s);
                assert(choice, node.id);
                assert(r.commit(node, choice), node.id);
                continue;
            }
            return;
        }
        const modal = r.node('story-modal');
        if (modal.style.display !== 'flex') return;
        const buttons = r.node('story-choices').children;
        assert(buttons.length, 'baseline scene has no choices');
        const title = r.node('story-title').textContent;
        const story = r.originalStories.find(n => n.title === title);
        const best = story ? choose(story.choices, r.s) : null;
        const index = best ? story.choices.indexOf(best) : buttons.length - 1;
        buttons[index].onclick();
    }
    throw new Error('Narrative queue did not drain');
}
function gainSubject(r) {
    return keys.slice().sort((a, b) => {
        const expected = k => Math.min(100 - r.s.subjects[k], coefficients[k] * (1 - r.s.subjects[k] / 200));
        return expected(b) - expected(a);
    })[0];
}
function weakest(r) { return keys.slice().sort((a, b) => r.s.subjects[a] - r.s.subjects[b])[0]; }
function step(r, policy, meta) {
    const s = r.s;
    const subject = policy === 'gain' || policy === 'hard' ? gainSubject(r) : policy === 'mathPhysics' ?
        ['math', 'physics'].find(k => s.subjects[k] < 90) || weakest(r) : weakest(r);
    if (policy === 'plotOnly') return false;
    if (policy === 'fixed') {
        const actions = [() => s.energy < costs[subject] || s.health < 30 ? r.rest('sleep') : r.study(subject), () => r.rest('sleep'), () => r.rest('relax')];
        actions[s.actionsThisWeek](); return true;
    }
    if (policy === 'hard') {
        if (s.energy < (r.data ? costs[subject] : 15) || s.health < 30) r.rest('sleep'); else r.study(subject);
        return true;
    }
    const strong = policy === 'wellbeing';
    if (s.health < (strong ? 75 : 45) || s.energy < (strong ? Math.max(50, costs[subject]) : costs[subject])) { r.rest('sleep'); return true; }
    if (s.anxiety >= (strong ? 20 : 30) || strong && s.mental < 60) {
        if (s.money >= 100) r.rest('counseling'); else if (s.energy >= 30) r.economy('part-time'); else r.rest('sleep');
        return true;
    }
    if (s.stress > (strong ? 35 : 55)) { r.rest('relax'); return true; }
    if (policy === 'homework' && Object.values(s.homework).some(v => !v)) {
        if (s.energy < 30) r.rest('sleep'); else r.homework('complete-all'); return true;
    }
    if (policy === 'social' && !meta.social) {
        if (s.health < 50) r.rest('sleep'); else { r.social('classmateA'); meta.social = true; } return true;
    }
    if (policy === 'exams' && [8, 20, 32, 40, 48].includes(s.week) && !meta.exam) {
        if (s.energy < 40 || s.health < 60) r.rest('sleep'); else { r.takeExam(); meta.exam = true; } return true;
    }
    r.study(subject); return true;
}
function run(r, policy, seed) {
    r.reset(seed);
    let actions = 0, guard = 0;
    while (!r.s.gameOver && guard++ < 60) {
        const week = r.s.week;
        const meta = {};
        while (r.s.actionsThisWeek < 3) {
            const count = r.s.actionsThisWeek;
            if (!step(r, policy, meta)) break;
            actions += r.s.actionsThisWeek - count;
            drain(r);
            assert(r.s.gameOver || r.s.actionsThisWeek > count, `action failed: ${policy}, week ${week}`);
            if (r.s.gameOver) break;
        }
        if (r.data) {
            for (const node of r.sides()) { r.triggerStoryEvent(node); drain(r); }
        }
        while (!r.s.gameOver && r.s.week === week) { r.endWeek(); drain(r); }
    }
    assert(r.s.gameOver, 'game did not end');
    if (r.data) {
        drain(r);
        assert.equal(r.s.storyProgress, 36);
        assert(r.s.achievements.has('story-36'));
        assert.equal(r.s.completedWeeks, 52);
        assert.equal(r.s.daysLeft, 0);
        assert.equal(r.s.actionHistory.filter(a => ['study', 'rest', 'social', 'exam', 'homework', 'activity', 'economy', 'exercise', 'memory', 'review', 'studyGroup'].includes(a.kind)).length, actions);
        assert(actions === (policy === 'plotOnly' ? 0 : 156), 'incorrect yearly budget');
        assert.equal(new Set(r.s.randomSeen).size, r.s.randomSeen.length);
        const final = JSON.stringify(r.s.finalSnapshot);
        r.confirmRoute('C01');
        assert.equal(JSON.stringify(r.s.finalSnapshot), final);
    }
    for (const group of ['subjects', 'relationships']) for (const value of Object.values(r.s[group])) {
        if (r.data) assert(Number.isFinite(value) && value >= 0 && value <= 100, 'attribute bounds');
    }
    const f = r.s.finalSnapshot || r.s;
    return { seed, score: r.s.finalSnapshot?.score ?? Math.round(mean(r.s)), actions,
        weeks: r.s.completedWeeks ?? r.s.week - 1, stories: r.s.storyProgress,
        random: r.s.randomSeen?.length ?? null, study: r.s.totalStudyHours, rest: r.s.totalRestHours,
        social: r.s.totalSocialHours, exams: r.s.examCount,
        health: f.health, mental: f.mental, anxiety: f.anxiety, stress: f.stress,
        subjects: { ...r.s.subjects }, goals: r.s.goalResults || {} };
}
function checks() {
    const r = runtime(); r.reset(7);
    assert(!r.s.achievements.has('first-week'));
    assert.equal(r.data.stories.length, 46); assert.equal(r.data.random.length, 360);
    assert.equal(Object.keys(r.data.endings).length, 37);
    const learning = new Set(['S02', 'S05', 'S06', 'S07', 'S09', 'S10', 'S11', 'S15', 'S16', 'S18', 'S19', 'S20', 'S22', 'S25', 'S26', 'S29', 'S32']);
    for (const n of r.data.stories.filter(n => learning.has(n.id))) {
        for (const c of r.resolve(n)) {
            const total = Object.entries(c.effect).reduce((sum, [k, v]) => sum + (k === 'subjects' ? v.all * 6 : keys.includes(k) ? v : 0), 0);
            assert(Math.abs(total - 1.2) < 1e-9, `${n.id}/${c.key}: growth budget ${total}`);
        }
    }
    assert.throws(() => r.applyEffect({ chemistryTeacher: 5 }), /未知/);
    const before = JSON.stringify(r.s.subjects); r.s.money = 1;
    assert.equal(r.applyEffect({ money: -4, math: 20 }), false);
    assert.equal(JSON.stringify(r.s.subjects), before);
    r.s.energy = 25; const count = r.s.actionsThisWeek; r.study('math'); assert.equal(r.s.actionsThisWeek, count);
    r.reset(8); r.s.week = 52; r.s.energy = 100; r.s.health = 100; r.takeExam();
    assert.equal(r.s.gameOver, false); assert.equal(r.s.examHistory.length, 1); assert.equal(r.s.actionsThisWeek, 1);
    r.reset(9); const m = r.find('M01'); r.triggerStoryEvent(m); assert.equal(r.s.memoryCount, 0);
    const c = r.resolve(m)[0]; assert(r.commit(m, c)); assert.equal(r.s.memoryCount, 1); assert.equal(r.s.actionsThisWeek, 1);
    assert.equal(r.commit(m, c), false); drain(r);
    r.reset(10); r.s.actionsThisWeek = 3; r.endWeek();
    assert.equal(r.s.week, 1); assert.equal(r.s.activeNarrative, 'S01');
    r.save(); const restored = runtime('new', r.storage); restored.init();
    assert.equal(restored.s.activeNarrative, 'S01'); assert.equal(restored.s.actionsThisWeek, 3); drain(restored);
    assert.equal(restored.s.week, 2); assert.equal(restored.s.storyProgress, 1);
    const schedule = JSON.stringify(restored.s.schedule); restored.save();
    const scheduleRestore = runtime('new', restored.storage); scheduleRestore.init();
    assert.equal(JSON.stringify(scheduleRestore.s.schedule), schedule);
    const corrupt = runtime('new', new Map([['afo-save-3.0.0', '{"version":"3.0.0","state":{}}']]));
    corrupt.init(); assert.equal(corrupt.s.week, 1); assert.equal(corrupt.s.storyProgress, 0);
    const byWeek = [5, 10, 15, 25, 35, 45];
    const sample = run(r, 'wellbeing', 112);
    assert.deepEqual(Object.keys(sample.goals).map(Number), byWeek);
    const frozen = JSON.stringify(r.s.finalSnapshot);
    assert.equal(r.applyEffect({ math: 5, health: 10 }), false);
    assert.equal(JSON.stringify(r.s.finalSnapshot), frozen);
    for (const [route, ending] of [['C02', 'E07'], ['C03', 'E08'], ['C04', 'E09']]) {
        r.s.phase = 'postExam'; r.s.finalRoute = null;
        r.confirmRoute(route);
        assert.equal(r.s.finalRoute, route);
        assert.equal(r.s.phase, 'ending');
        assert(r.node('.main').innerHTML.includes(r.data.endings[ending].title));
        assert.equal(JSON.stringify(r.s.finalSnapshot), frozen);
    }
    for (let score = 0; score <= 100; score++) {
        for (const route of ['C01', 'C02', 'C03', 'C04']) assert(r.data.endings[r.mainEnding(route, score)]);
    }
    r.s.storyChoices = {}; r.s.romance = '明确互相喜欢'; r.s.mutualAffirmation = false;
    assert.equal(r.epilogues()[3], 'PEER04');
    r.s.storyChoices = { S34: { key: 'A' }, S28: { key: 'C' }, S14: { key: 'B' }, S30: { key: 'B' } };
    r.s.romance = '朋友'; const lower = r.epilogues(); r.s.finalSnapshot.score = 96;
    assert.deepEqual(r.epilogues(), lower);
    r.reset(22); r.s.stress = 90; r.s.anxiety = 90; r.s.health = 20; r.s.mental = 20;
    for (const e of r.random()) for (const x of e.choices) {
        assert((x.effect.stress || 0) <= 0 && (x.effect.anxiety || 0) <= 0 && (x.effect.health || 0) >= 0 && (x.effect.mental || 0) >= 0);
    }
    r.s.randomCountThisWeek = 1; assert.equal(r.random().length, 0);
    r.reset(23); r.s.actionHistory.push({ week: 1, kind: 'study', detail: 'math' });
    assert(r.rule({ type: 'action', values: ['study:math'], min: 1, weeks: 1 }));
    assert(!r.rule({ type: 'action', values: ['study:english'], min: 1, weeks: 1 }));
    assert(!r.rule({ type: 'subjectThreshold', op: '≥', value: 35 }));
    r.s.subjects.math = 40;
    assert(r.rule({ type: 'subjectThreshold', op: '≥', value: 35 }));
    const discussion = r.data.random.find(e => e.id === 'RAND-L51');
    const discussionChoices = r.resolve(discussion);
    assert.equal(discussionChoices.length, 1);
    assert.equal(discussionChoices[0].targets[0], 'math');
    assert.equal(discussionChoices[0].effect.math, 0.5);
    const lastStudy = r.resolve(r.data.random.find(e => e.id === 'RAND-L59'));
    assert.equal(lastStudy[0].targets[0], 'math');
    assert.equal(lastStudy[0].effect.math, 0.5);
    assert(r.data.random.find(e => e.id === 'RAND-L49').disabledReason);
    r.s.lastNegativeWeek.L = 1; r.s.week = 4;
    assert(r.random().filter(e => e.category === 'L').every(e => e.choices.every(c => !Object.entries(c.effect).some(([k, v]) => ['stress', 'anxiety'].includes(k) ? v > 0 : typeof v === 'number' && v < 0))));
    const once = run(r, 'weak', 456); const twice = run(r, 'weak', 456); assert.deepEqual(once, twice);
    console.log('Checks passed: growth budgets, unknown fields, atomic fees, action costs, final-week exam, recall counts, save/resume, 52-week flow, all route boundaries, epilogues, event protection/cooldown, deterministic replay.');
    return r.data;
}
function summarize(rows) {
    const scores = rows.map(r => r.score).sort((a, b) => a - b);
    const n = scores.length, avg = scores.reduce((a, b) => a + b, 0) / n;
    const result = { n, mean: avg, sd: Math.sqrt(scores.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (n - 1)),
        p10: scores[Math.floor((n - 1) * 0.1)], median: scores[Math.floor((n - 1) * 0.5)], p90: scores[Math.floor((n - 1) * 0.9)], min: scores[0], max: scores.at(-1) };
    for (const threshold of [60, 70, 80, 90, 95]) result['at' + threshold] = scores.filter(s => s >= threshold).length / n;
    for (const key of ['actions', 'weeks', 'stories', 'random', 'study', 'rest', 'social', 'exams', 'health', 'mental', 'anxiety', 'stress']) {
        result[key] = rows.reduce((sum, r) => sum + (r[key] || 0), 0) / n;
    }
    result.subjects = Object.fromEntries(keys.map(k => [k, rows.reduce((sum, r) => sum + r.subjects[k], 0) / n]));
    result.goals = Object.fromEntries([5, 10, 15, 25, 35, 45].map(w => [w, rows.filter(r => r.goals[w]).length / n]));
    return result;
}
module.exports = { runtime, run, drain, step, choose, weakest, gainSubject, summarize, checks, costs, keys };
if (require.main === module) {
const data = checks();
if (process.argv.includes('--check')) process.exit(0);
const seeds = Number(process.argv.find(a => a.startsWith('--seeds='))?.split('=')[1] || 500);
assert(Number.isInteger(seeds) && seeds > 1);
const requestedMode = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1];
assert(!requestedMode || ['baseline', 'timeFixed', 'new', 'snapshot300'].includes(requestedMode));
const allModes = fs.existsSync(path.join(output, 'baseline.html')) ? ['baseline', 'timeFixed', 'new'] : ['new'];
const modes = requestedMode ? [requestedMode] : allModes;
const policies = ['weak', 'gain', 'mathPhysics', 'homework', 'social', 'exams', 'wellbeing', 'hard', 'fixed', 'plotOnly'];
const previous = requestedMode && fs.existsSync(path.join(output, 'monte-carlo.json')) ? JSON.parse(fs.readFileSync(path.join(output, 'monte-carlo.json'), 'utf8')) : null;
if (previous) assert.equal(previous.seeds, seeds, 'cannot mix sample sizes');
const raw = previous ? fs.readFileSync(path.join(output, 'games.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.mode !== requestedMode) : [];
const summaries = previous?.summaries || {};
for (const mode of modes) {
    const r = runtime(mode);
    summaries[mode] = {};
    for (const policy of policies) {
        const rows = [];
        for (let seed = 1; seed <= seeds; seed++) rows.push(run(r, policy, seed));
        summaries[mode][policy] = summarize(rows);
        raw.push(...rows.map(row => ({ mode, policy, ...row })));
        console.log(`${mode}/${policy}: ${seeds} games, mean ${summaries[mode][policy].mean.toFixed(2)}`);
    }
}
const retainedModes = previous ? [...new Set([...previous.modes, ...modes])] : modes;
const simulationRuns = (previous ? previous.simulationRuns || previous.modes.length * seeds * policies.length : 0) + modes.length * seeds * policies.length;
fs.writeFileSync(path.join(output, 'monte-carlo.json'), JSON.stringify({ seeds, policies, modes: retainedModes, simulationRuns, summaries, disabledEvents: data.random.filter(e => e.disabledReason).map(e => ({ id: e.id, reason: e.disabledReason })) }, null, 2));
fs.writeFileSync(path.join(output, 'games.jsonl'), raw.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log(`Executed ${modes.length * seeds * policies.length} seeded games; retained ${raw.length} comparison records. Results: ${output}`);
}
