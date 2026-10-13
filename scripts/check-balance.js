// Regression checks for review evidence, action budgets and situational recovery.
'use strict';
const assert = require('node:assert/strict');
const { runtime, keys } = require('./simulate.js');
const r = runtime();
const exam = (week = 1) => ({ week, score: 48, subjects: { chinese: 45, math: 80, english: 30, physics: 70, chemistry: 40, biology: 25 } });
const before = () => JSON.stringify({ energy: r.s.energy, actions: r.s.actionsThisWeek, subjects: r.s.subjects, relationships: r.s.relationships, reviews: r.s.totalReviews, groups: r.s.totalStudyGroups });

r.reset(1);
r.s.mental = 85; const capped = r.efficiency();
r.s.mental = 100; assert.equal(r.efficiency(), capped);
r.s.mental = 80; assert(r.efficiency() < capped);
r.s.mental = 85;
let previous = Infinity;
for (let stress = 45; stress <= 75; stress++) {
    r.s.stress = stress; const value = r.efficiency();
    assert(value <= previous, 'more pressure must never raise efficiency');
    if (stress === 51) assert(previous - value < 0.01, 'no discontinuity at pressure 50');
    previous = value;
}

r.reset(2); let unchanged = before();
r.review(0); assert.equal(before(), unchanged, 'no fabricated exam');
r.review(); r.node('story-choices').children.at(-1).onclick();
assert.equal(before(), unchanged, 'opening/cancelling review is free');
r.s.examHistory.push(exam()); r.s.energy = 19; unchanged = before();
r.review(0); assert.equal(before(), unchanged, 'failed payment is atomic');
r.s.energy = 100;
const ability = { ...r.s.subjects };
r.review(0);
assert.equal(r.s.energy, 80); assert.equal(r.s.actionsThisWeek, 1);
assert.deepEqual(Array.from(r.s.reviewPlan.subjects), ['biology', 'english']);
for (const k of keys) assert.equal(r.s.subjects[k], ability[k] + (['biology', 'english'].includes(k) ? 3 : 0));
assert.equal(r.s.reviewPlan.remaining, 2); assert.equal(r.s.reviewPlan.expiresWeek, 4);
assert(r.rule({ type: 'reviewLatestExam' }));
unchanged = before(); r.review(0); assert.equal(before(), unchanged, 'one review per exam');
r.s.examHistory.push(exam()); r.review(1);
assert.equal(r.s.reviewPlan.remaining, 2, 'credits replace rather than stack');
assert.equal(r.s.totalReviews, 2);
r.s.examHistory.push(exam(1)); r.s.week = 5; r.s.actionsThisWeek = 0;
unchanged = before(); r.review(2); assert.equal(before(), unchanged, 'expired exam is ineligible');
assert(!r.rule({ type: 'reviewLatestExam' }), 'old review cannot unlock this week event');

// Same random stream and identical starting state isolate the review bonus.
const plain = runtime(); const helped = runtime();
plain.reset(3); helped.reset(3);
helped.s.reviewPlan = { subjects: ['english', 'biology'], remaining: 2, expiresWeek: 4 };
for (const k of ['math', 'english', 'biology']) {
    const base = plain.s.subjects[k], assisted = helped.s.subjects[k];
    plain.study(k); helped.study(k);
    const gain = plain.s.subjects[k] - base;
    assert(Math.abs((helped.s.subjects[k] - assisted) - gain * (k === 'math' ? 1 : 1.2)) < 1e-9);
    if (k === 'math') assert.equal(helped.s.reviewPlan.remaining, 2, 'off-topic study keeps credits');
}
assert.equal(helped.s.reviewPlan.remaining, 0);
plain.s.week = helped.s.week = 2; plain.s.actionsThisWeek = helped.s.actionsThisWeek = 0;
plain.s.energy = helped.s.energy = 100;
const p = plain.s.subjects.chemistry, h = helped.s.subjects.chemistry;
plain.study('chemistry'); helped.study('chemistry');
assert.equal(plain.s.subjects.chemistry - p, helped.s.subjects.chemistry - h);
helped.s.reviewPlan = { subjects: ['english', 'biology'], remaining: 2, expiresWeek: 1 };
const p2 = plain.s.subjects.biology, h2 = helped.s.subjects.biology;
plain.study('biology'); helped.study('biology');
// Existing subject levels differ, so compare growth divided by diminishing-return factor.
assert(Math.abs((plain.s.subjects.biology - p2) / (1 - p2 / 200) - (helped.s.subjects.biology - h2) / (1 - h2 / 200)) < 1e-9);
assert.equal(helped.s.reviewPlan.remaining, 2, 'expired plan supplies no bonus');

r.reset(4);
assert.equal(r.partners().includes('parents'), false);
assert.deepEqual(Array.from(r.groupSubjects('mathTeacher')), ['math']);
assert.deepEqual(Array.from(r.groupSubjects('teacher')), ['physics']);
assert.deepEqual(Array.from(r.groupSubjects('chemistryTeacher')), []);
r.s.relationships.classmateA = 59; unchanged = before();
r.group('classmateA', 'english'); assert.equal(before(), unchanged);
r.s.relationships.classmateA = 60; r.s.relationships.parents = 100; r.s.relationships.mathTeacher = 100;
unchanged = before();
r.group('parents', 'english'); r.group('mathTeacher', 'biology');
assert.equal(before(), unchanged, 'unsupported partner/subject is free');
r.group(); r.node('story-choices').children.at(-1).onclick();
assert.equal(before(), unchanged, 'cancelling group is free');
for (const [energy, health] of [[19, 100], [100, 49]]) {
    r.s.energy = energy; r.s.health = health; unchanged = before();
    r.group('classmateA', 'english'); assert.equal(before(), unchanged);
}
r.s.energy = 100; r.s.health = 100;
r.s.reviewPlan = { subjects: ['english'], remaining: 2, expiresWeek: 4 };
const start = r.s.subjects.english;
r.group('classmateA', 'english');
assert.equal(r.s.energy, 80); assert.equal(r.s.actionsThisWeek, 1);
assert(r.s.subjects.english > start); assert.equal(r.s.relationships.classmateA, 62);
assert.equal(r.s.reviewPlan.remaining, 2, 'group does not spend independent-study credits');
unchanged = before(); r.group('mathTeacher', 'math'); assert.equal(before(), unchanged, 'once per week across partners');
r.s.week = 2; r.s.actionsThisWeek = 0; r.group('mathTeacher', 'math');
assert.equal(r.s.totalStudyGroups, 2);
r.save();
const restored = runtime('new', r.storage); restored.init();
assert.equal(restored.s.studyGroupWeek, 2); assert.equal(restored.s.reviewPlan.remaining, 2);
const restoredBefore = restored.s.actionsThisWeek;
restored.group('classmateA', 'english'); assert.equal(restored.s.actionsThisWeek, restoredBefore);

// Old release saves migrate without losing history or inventing new records.
r.reset(5); r.takeExam(); r.save();
const old = JSON.parse(r.storage.get('afo-save-3.0.0')); old.version = '3.0.0';
for (const k of ['reviewedExams', 'reviewPlan', 'studyGroupWeek', 'totalReviews', 'totalStudyGroups']) delete old.state[k];
for (const log of old.state.logHistory) delete log.time;
r.storage.set('afo-save-3.0.0', JSON.stringify(old));
const migrated = runtime('new', r.storage); migrated.init();
assert.equal(migrated.s.examHistory.length, 1); assert.equal(migrated.s.actionsThisWeek, 1);
assert.equal(migrated.s.totalReviews, 0); assert.equal(migrated.s.totalStudyGroups, 0);
assert.equal(migrated.s.reviewPlan, null); assert.equal(migrated.reviews().length, 1);
assert.equal(migrated.node('event-log').children[0].children[0].textContent, '此前记录');
migrated.review(0); assert.equal(migrated.s.totalReviews, 1);
const lastLog = migrated.s.logHistory[0];
assert.equal(lastLog.time, 'W1 三');
const logRestore = runtime('new', migrated.storage); logRestore.init();
assert.equal(logRestore.s.logHistory[0].time, lastLog.time);
assert.equal(logRestore.node('event-log').children[0].children[0].textContent, lastLog.time);
const frozen = JSON.stringify({ score: 75, subjects: { ...migrated.s.subjects } });
migrated.s.finalSnapshot = JSON.parse(frozen); migrated.s.phase = 'postExam';
const finalCount = migrated.s.actionsThisWeek;
migrated.review(0); migrated.group('classmateA', 'english');
assert.equal(migrated.s.actionsThisWeek, finalCount); assert.equal(JSON.stringify(migrated.s.finalSnapshot), frozen);
console.log('Balance checks passed: capped mental bonus, continuous pressure, real exam targets, atomic/free cancellation, review uniqueness/expiry/credits, partner scope, weekly group limit, save/log migration and frozen final grades.');
