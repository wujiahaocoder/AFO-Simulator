// Seeded comparisons of existing and mixed play styles. No browser automation.
// node scripts/balance-simulate.js --seeds=300 --out=analysis/3.0.1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sim = require('./simulate.js');
const root = path.resolve(__dirname, '..');
const seeds = Number(process.argv.find(a => a.startsWith('--seeds='))?.split('=')[1] || 300);
assert(Number.isInteger(seeds) && seeds > 1, 'seeds must be an integer greater than one');
const out = path.resolve(root, process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || 'analysis/3.0.1');
fs.mkdirSync(out, { recursive: true });
const policies = ['weak', 'gain', 'homework', 'social', 'exams', 'wellbeing', 'hard', 'fixed',
    'moderate40', 'wellbeingGain', 'adaptive', 'socialSmart', 'group', 'groupStrong', 'groupSmart', 'examReview', 'homeworkReview', 'hybrid', 'hybridSmart', 'maxState', 'musicOnly'];
function preferredSubject(r, policy) {
    const plan = r.s.reviewPlan;
    if (['examReview', 'homeworkReview', 'hybrid', 'hybridSmart'].includes(policy) && plan?.remaining > 0 && r.s.week <= plan.expiresWeek) {
        return plan.subjects.filter(k => r.s.subjects[k] < 100).sort((a, b) => r.s.subjects[a] - r.s.subjects[b])[0] || sim.weakest(r);
    }
    return policy === 'wellbeingGain' ? sim.gainSubject(r) : sim.weakest(r);
}
function extendedStep(r, policy, meta) {
    if (['weak', 'gain', 'homework', 'social', 'exams', 'wellbeing', 'hard', 'fixed'].includes(policy)) return sim.step(r, policy, meta);
    const s = r.s;
    const subject = preferredSubject(r, policy);
    const strong = ['wellbeingGain', 'groupStrong', 'maxState'].includes(policy);
    const adaptive = ['adaptive', 'group', 'groupStrong', 'groupSmart', 'examReview', 'homeworkReview', 'hybrid', 'hybridSmart'].includes(policy);
    if (policy === 'musicOnly') { r.rest('music'); return true; }
    const energyGate = policy === 'maxState' ? 90 : strong ? Math.max(50, sim.costs[subject]) : sim.costs[subject];
    const healthGate = policy === 'maxState' ? 95 : strong ? 75 : 45;
    if (s.energy < energyGate || s.health < healthGate) {
        r.rest(adaptive && s.health >= 65 && s.anxiety >= 12 && s.stress <= 40 && s.energy + 20 >= energyGate ? 'nap' : 'sleep'); return true;
    }
    const anxietyGate = policy === 'maxState' ? 10 : strong ? 20 : policy === 'moderate40' ? 40 : 30;
    const mentalGate = policy === 'maxState' ? 90 : strong ? 60 : 45;
    if (s.anxiety >= anxietyGate || s.mental < mentalGate) {
        if (adaptive && s.mental >= 65 && s.anxiety < 38 && s.stress <= 35) r.rest('music');
        else if (s.money >= 100) r.rest('counseling');
        else if (s.energy >= 30) r.economy('part-time');
        else r.rest('sleep');
        return true;
    }
    if (s.stress > (strong ? 35 : 55)) { r.rest('relax'); return true; }
    if (['examReview', 'homeworkReview', 'hybrid', 'hybridSmart'].includes(policy)) {
        if (r.reviews && r.reviews().length) {
            if (s.energy < 20) r.rest('nap'); else r.review(r.reviews().at(-1).index);
            return true;
        }
        if ([8, 20, 32, 40, 48].includes(s.week) && !meta.exam) {
            if (s.energy < 40 || s.health < 60) r.rest('sleep');
            else { r.takeExam(); meta.exam = true; }
            return true;
        }
    }
    if ((['homeworkReview', 'hybrid'].includes(policy) || policy === 'hybridSmart' && s.week % 2 === 1) && Object.values(s.homework).some(v => !v)) {
        if (s.energy < 30) r.rest('nap'); else r.homework('complete-all'); return true;
    }
    if (['group', 'groupStrong', 'groupSmart', 'hybrid', 'hybridSmart'].includes(policy)) {
        if (s.relationships.classmateA < 60) {
            if (s.health < 50) r.rest('sleep'); else r.social('classmateA'); return true;
        }
        if (r.group && s.studyGroupWeek !== s.week && (!['groupSmart', 'hybridSmart'].includes(policy) || s.anxiety >= 12 || s.stress >= 25)) {
            const partners = r.partners().filter(k => r.groupSubjects(k).includes(subject));
            if (partners.length) {
                if (s.energy < 20 || s.health < 50) r.rest('sleep'); else r.group(partners[0], subject);
                return true;
            }
        }
    }
    if (policy === 'socialSmart' && s.relationships.classmateA < 80) {
        if (s.health < 50) r.rest('sleep'); else r.social('classmateA'); return true;
    }
    r.study(subject); return true;
}
function run(r, policy, seed) {
    r.reset(seed);
    let actions = 0;
    const actionCounts = {};
    for (let guard = 0; !r.s.gameOver && guard < 60; guard++) {
        const week = r.s.week, meta = {};
        while (r.s.actionsThisWeek < 3 && !r.s.gameOver) {
            const count = r.s.actionsThisWeek, history = r.s.actionHistory.length;
            extendedStep(r, policy, meta);
            const increment = r.s.actionsThisWeek - count;
            assert.equal(increment, 1, `${policy}, week ${week}: action not completed`);
            actions += increment;
            for (const a of r.s.actionHistory.slice(history)) {
                if (a.kind === 'view') continue;
                const key = a.kind === 'rest' ? `rest:${a.detail}` : a.kind;
                actionCounts[key] = (actionCounts[key] || 0) + 1;
            }
            sim.drain(r);
        }
        for (const node of r.sides()) { r.triggerStoryEvent(node); sim.drain(r); }
        while (!r.s.gameOver && r.s.week === week) { r.endWeek(); sim.drain(r); }
    }
    assert.equal(r.s.completedWeeks, 52); assert.equal(actions, 156); assert.equal(r.s.storyProgress, 36);
    const final = JSON.stringify(r.s.finalSnapshot);
    r.confirmRoute('C01'); assert.equal(JSON.stringify(r.s.finalSnapshot), final);
    for (const key of ['energy', 'health', 'stress', 'anxiety', 'mental']) assert(Number.isFinite(r.s[key]) && r.s[key] >= 0 && r.s[key] <= 100);
    for (const group of ['subjects', 'relationships']) for (const v of Object.values(r.s[group])) assert(Number.isFinite(v) && v >= 0 && v <= 100);
    const f = r.s.finalSnapshot;
    return { seed, score: f.score, actions, weeks: 52, stories: 36, random: r.s.randomSeen.length,
        study: r.s.totalStudyHours, rest: r.s.totalRestHours, social: r.s.totalSocialHours, exams: r.s.examCount,
        health: f.health, mental: f.mental, anxiety: f.anxiety, stress: f.stress, subjects: { ...r.s.subjects },
        lowest: Math.min(...Object.values(r.s.subjects)), all85: Object.values(r.s.subjects).every(v => v >= 85),
        money: r.s.money, friends80: r.s.relationships.classmateA >= 80, relationships: { ...r.s.relationships },
        goals: { ...r.s.goalResults }, reviews: r.s.totalReviews || 0, groups: r.s.totalStudyGroups || 0, actionCounts };
}
function summary(rows) {
    const s = sim.summarize(rows);
    for (const k of ['lowest', 'money', 'reviews', 'groups']) s[k] = rows.reduce((a, r) => a + r[k], 0) / rows.length;
    s.all85 = rows.filter(r => r.all85).length / rows.length;
    s.friends80 = rows.filter(r => r.friends80).length / rows.length;
    const kinds = [...new Set(rows.flatMap(r => Object.keys(r.actionCounts)))];
    s.actionCounts = Object.fromEntries(kinds.map(k => [k, rows.reduce((a, r) => a + (r.actionCounts[k] || 0), 0) / rows.length]));
    return s;
}
const modes = fs.existsSync(path.join(root, 'analysis', '3.0.1', 'baseline-index.html')) ? ['snapshot300', 'new'] : ['new'];
const results = {}, records = [];
for (const mode of modes) {
    const r = sim.runtime(mode);
    results[mode] = {};
    for (const policy of policies) {
        const rows = [];
        for (let seed = 1; seed <= seeds; seed++) rows.push(run(r, policy, seed));
        results[mode][policy] = summary(rows);
        records.push(...rows.map(row => ({ mode, policy, ...row })));
        console.log(`${mode}/${policy}: ${results[mode][policy].mean.toFixed(2)}, reviews ${results[mode][policy].reviews.toFixed(2)}, groups ${results[mode][policy].groups.toFixed(2)}`);
    }
}
fs.writeFileSync(path.join(out, 'balance-comparison.json'), JSON.stringify({ seeds, policies, modes, totalGames: records.length, results }, null, 2));
fs.writeFileSync(path.join(out, 'balance-games.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`Completed ${records.length} seeded games; output: ${out}`);
